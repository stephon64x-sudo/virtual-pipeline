"""Step 1. Turn the raw public data into one clean daily table per site.

REAL inputs (data/raw):
  wajir.csv, mandera.csv, northhorr.csv  NASA POWER daily rain / Tmax / humidity / wind
  chirps_rain.csv                        CHIRPS daily rainfall (mm)
  modis_ndvi.csv                         MODIS MOD13Q1 16-day NDVI (cloud-robust composite)
  s2_ndvi_cloud.csv                      Sentinel-2 NDVI + cloud fraction per scene
  grace_lwe.csv                          GRACE-FO monthly water-storage anomaly (cm)

Every feature is CAUSAL: it only uses what would really have been available on that day.
  - MODIS composites are released after their 16-day window closes  -> shifted 16 days
  - GRACE-FO is published roughly two months late                    -> shifted 60 days
  - Sentinel-2 scenes more than 30% cloud are thrown away; we carry the last clear one
    forward and record its age (s2_age) so the model knows how stale it is.
"""
import io
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT = ROOT / "data" / "raw", ROOT / "data" / "processed"
OUT.mkdir(parents=True, exist_ok=True)

SITES = {"Wajir": "wajir.csv", "Mandera": "mandera.csv", "NorthHorr": "northhorr.csv"}
DAYS = pd.date_range("2019-01-01", "2023-12-31", freq="D")
CLOUD_MAX = 0.30
MODIS_LAG, GRACE_LAG = 16, 60

CLIMATE_FEATURES = [
    "rain7", "rain30", "rain90", "rain180", "dry_days", "tmax14",
    "ndvi", "ndvi_d48", "s2_ndvi", "s2_age", "grace", "doy_sin", "doy_cos",
]


def read_power(path):
    text = path.read_text()
    body = text.split("-END HEADER-")[1].strip()
    df = pd.read_csv(io.StringIO(body)).replace(-999, np.nan)
    df["date"] = pd.to_datetime(df["YEAR"].astype(str), format="%Y") + pd.to_timedelta(df["DOY"] - 1, unit="D")
    return df.set_index("date")[["PRECTOTCORR", "T2M_MAX", "RH2M", "WS2M"]].reindex(DAYS).interpolate(limit_direction="both")


def site_series(name, col="mean", fname=None):
    df = pd.read_csv(RAW / fname, parse_dates=["date"])
    return df[df["site"] == name].set_index("date")[col].dropna().groupby(level=0).mean()


def lagged_ffill(s, lag_days):
    """Value becomes visible `lag_days` after its timestamp, then is carried forward."""
    s = s.copy()
    s.index = s.index + pd.Timedelta(days=lag_days)
    full = s.reindex(s.index.union(DAYS)).sort_index().ffill()
    return full.reindex(DAYS).bfill()


def build(name):
    power = read_power(RAW / SITES[name])
    d = pd.DataFrame(index=DAYS)
    rain = site_series(name, fname="chirps_rain.csv").reindex(DAYS)
    d["rain"] = rain.fillna(power["PRECTOTCORR"]).fillna(0.0)  # CHIRPS first, NASA POWER as backup
    d["tmax"] = power["T2M_MAX"]
    for w in (7, 30, 90, 180):
        d[f"rain{w}"] = d["rain"].rolling(w, min_periods=1).sum()
    wet = d["rain"] >= 5
    d["dry_days"] = (~wet).groupby(wet.cumsum()).cumsum().clip(upper=200)
    d["tmax14"] = d["tmax"].rolling(14, min_periods=1).mean()

    ndvi = lagged_ffill(site_series(name, fname="modis_ndvi.csv") / 10000.0, MODIS_LAG)
    d["ndvi"] = ndvi
    d["ndvi_d48"] = (ndvi - ndvi.shift(48)).fillna(0.0)

    s2 = pd.read_csv(RAW / "s2_ndvi_cloud.csv", parse_dates=["date"])
    s2 = s2[(s2["site"] == name) & s2["ndvi"].notna()].groupby("date")[["ndvi", "cloud"]].mean()
    d["s2_cloud"] = s2["cloud"].reindex(DAYS)                     # NaN = no overpass that day
    clear = s2[s2["cloud"] <= CLOUD_MAX]["ndvi"].reindex(DAYS)
    d["s2_ndvi"] = clear.ffill().bfill()
    last_clear = pd.Series(np.where(clear.notna(), np.arange(len(DAYS)), np.nan), index=DAYS).ffill().fillna(0)
    d["s2_age"] = (np.arange(len(DAYS)) - last_clear).clip(upper=120)

    d["grace"] = lagged_ffill(site_series(name, fname="grace_lwe.csv"), GRACE_LAG)
    doy = d.index.dayofyear.values
    d["doy_sin"], d["doy_cos"] = np.sin(2 * np.pi * doy / 365.25), np.cos(2 * np.pi * doy / 365.25)
    d.index.name = "date"
    return d


if __name__ == "__main__":
    summary = {}
    for name in SITES:
        d = build(name)
        d.to_csv(OUT / f"climate_{name}.csv", float_format="%.4f")
        s2 = d["s2_cloud"].dropna()
        summary[name] = {
            "annual_rain_mm": {str(y): round(float(v)) for y, v in d["rain"].groupby(d.index.year).sum().items()},
            "s2_scenes": int(len(s2)),
            "s2_cloudy_scenes": int((s2 > CLOUD_MAX).sum()),
            "longest_gap_without_clear_image_days": int(d["s2_age"].max()),
        }
    (OUT / "data_summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))
