"""Step 2. SIMULATE wells on top of the REAL climate record.

Public water-level records for pastoral wells in northern Kenya do not exist, so the wells
are simulated with a daily water balance driven by the real rainfall / heat / GRACE data:

  level += recharge(lagged real rain) + aquifer inflow(GRACE) - pumping(herds, heat) - seepage

Herds are coupled inside a cluster: when a well fails, its herds walk to the neighbours and
drain them faster (the "herd pressure" effect). Each well also produces what the field would
really give us: a noisy level sensor (with outages), herders' painted-rope reports
(R/O/Y/G bands, sometimes wrong) and rough herd counts.

Three groups of wells:
  train  45 random wells, used to fit the model
  test   45 other random wells, never seen in training, used for the replay test
  demo    9 named wells shown on the dashboard (also never seen in training)
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PROC = ROOT / "data" / "processed"
SITES = ["Mandera", "Wajir", "NorthHorr"]
H_FAIL = 0.5                      # metres of water above the pump intake / bucket reach
BANDS = [0.12, 0.30, 0.55]        # rope bands as a fraction of full: R < .12 <= O < .30 <= Y < .55 <= G
BAND_MID = [0.06, 0.21, 0.425, 0.775]


def band_of(frac):
    return int(np.searchsorted(BANDS, frac, side="right"))


def random_well(rng, kind):
    if kind == "shallow":
        return dict(kind=0, hmax=rng.uniform(5, 9), tau=rng.uniform(8, 20), k_r=rng.uniform(0.022, 0.04),
                    inflow=rng.uniform(0.0, 0.006), g=0.2, use=rng.uniform(0.0009, 0.0015),
                    herds=rng.uniform(14, 30), leak=rng.uniform(0.002, 0.005))
    return dict(kind=1, hmax=rng.uniform(10, 14), tau=rng.uniform(60, 120), k_r=rng.uniform(0.02, 0.035),
                inflow=rng.uniform(0.012, 0.024), g=0.5, use=rng.uniform(0.0005, 0.0008),
                herds=rng.uniform(22, 40), leak=rng.uniform(0.0006, 0.0015))


def simulate_cluster(clim, wells, rng):
    """wells: list of parameter dicts. Returns a list of per-well DataFrames (one row per day)."""
    n, k = len(clim), len(wells)
    rain, tmax14, grace = clim["rain"].values, clim["tmax14"].values, clim["grace"].values
    gz = (grace - grace.mean()) / (grace.std() + 1e-9)
    rain60 = clim["rain"].rolling(60, min_periods=1).sum().values
    dryness = np.clip(1 - rain60 / 60.0, 0, 1)           # surface pans are dry -> herds crowd the wells
    hmax = np.array([w["hmax"] for w in wells])
    h = hmax * rng.uniform(0.5, 0.8, k)
    store = np.full(k, 1.0)
    displaced = np.zeros(k)
    failed = np.zeros(k, bool)
    level, herds_out = np.zeros((n, k)), np.zeros((n, k))
    for t in range(n):
        eff = max(0.0, rain[t] - 2.0)
        own = np.array([w["herds"] * (0.6 + 0.8 * dryness[t]) for w in wells]) * rng.normal(1, 0.04, k)
        failed = np.where(failed, h < 0.3 * hmax, h < H_FAIL)   # herds only return after a real recovery
        displaced += 0.25 * (np.where(failed, own, 0.0) - displaced)
        open_wells = ~failed
        share = displaced.sum() / open_wells.sum() if open_wells.any() else 0.0
        herds = np.where(open_wells, own - displaced + share, own - displaced)
        for i, w in enumerate(wells):
            store[i] += (eff - store[i]) / w["tau"]
            recharge = w["k_r"] * store[i]
            inflow = max(0.0, w["inflow"] * (1 + w["g"] * gz[t]))
            heat = 1 + 0.03 * (tmax14[t] - 34)
            pump = w["use"] * herds[i] * heat * min(1.0, h[i] / 0.4)
            h[i] = np.clip(h[i] + recharge + inflow - pump - w["leak"] * h[i] + rng.normal(0, 0.01), 0, w["hmax"])
        level[t], herds_out[t] = h, herds
    out = []
    for i, w in enumerate(wells):
        d = pd.DataFrame({"t": np.arange(n), "level": level[:, i], "herds_true": herds_out[:, i]})
        d["obs"] = d["level"] + rng.normal(0, 0.03, n)                     # level sensor
        d["herds"] = np.maximum(0, np.round(d["herds_true"] * rng.normal(1, 0.10, n)))  # herders' counts
        frac = d["level"].values / w["hmax"]
        rope = np.full(n, -1)
        for t in range(n):
            if rng.random() < 0.45:
                b = band_of(frac[t])
                if rng.random() < 0.08:
                    b = int(np.clip(b + rng.choice([-1, 1]), 0, 3))        # a mis-read rope
                rope[t] = b
        d["rope"] = rope
        out.append(d)
    return out


def random_group(seed, tag):
    rng = np.random.default_rng(seed)
    rows, meta = [], []
    for site in SITES:
        clim = pd.read_csv(PROC / f"climate_{site}.csv", index_col=0, parse_dates=True)
        for c in range(5):
            wells = [random_well(rng, k) for k in ("shallow", "shallow", "borehole")]
            for i, d in enumerate(simulate_cluster(clim, wells, rng)):
                wid = f"{tag}-{site[:2]}{c}{i}"
                d.insert(0, "well", wid)
                rows.append(d)
                meta.append(dict(id=wid, site=site, cluster=f"{site}{c}", **wells[i]))
    return pd.concat(rows, ignore_index=True), meta


DEMO = {
    # id, name, kind, x_km, y_km (offset from the cluster centre) and hand-set parameters
    "Mandera": [
        dict(id="W12", name="Rhamu wells", x=-14, y=6, kind=0, hmax=6.5, tau=11, k_r=0.030, inflow=0.003, g=0.2, use=0.0010, herds=24, leak=0.0028),
        dict(id="W09", name="Khalalio well", x=9, y=-12, kind=0, hmax=7.5, tau=16, k_r=0.030, inflow=0.005, g=0.2, use=0.0010, herds=20, leak=0.0030),
        dict(id="W07", name="Fino borehole", x=11, y=13, kind=1, hmax=13, tau=90, k_r=0.030, inflow=0.020, g=0.5, use=0.0007, herds=30, leak=0.0010),
    ],
    "Wajir": [
        dict(id="W03", name="Tarbaj well", x=-10, y=-9, kind=0, hmax=6.0, tau=10, k_r=0.028, inflow=0.002, g=0.2, use=0.0011, herds=22, leak=0.0032),
        dict(id="W04", name="Griftu well", x=13, y=-4, kind=0, hmax=8.0, tau=18, k_r=0.032, inflow=0.005, g=0.2, use=0.0011, herds=18, leak=0.0025),
        dict(id="W05", name="Wajir Bor borehole", x=-2, y=14, kind=1, hmax=12, tau=80, k_r=0.028, inflow=0.018, g=0.5, use=0.0007, herds=34, leak=0.0010),
    ],
    "NorthHorr": [
        dict(id="W15", name="Kalacha spring", x=-12, y=3, kind=0, hmax=5.5, tau=14, k_r=0.038, inflow=0.006, g=0.3, use=0.0010, herds=16, leak=0.0030),
        dict(id="W18", name="Dukana well", x=8, y=-13, kind=0, hmax=7.0, tau=12, k_r=0.036, inflow=0.004, g=0.3, use=0.0011, herds=18, leak=0.0030),
        dict(id="W16", name="Gas borehole", x=10, y=11, kind=1, hmax=11, tau=100, k_r=0.034, inflow=0.016, g=0.5, use=0.0008, herds=26, leak=0.0012),
    ],
}
# Field problems we stage in the replay so the fallbacks are visible
OUTAGES = {"W09": [("2021-09-01", "2023-12-31")],     # sensor died and was never replaced
           "W03": [("2022-01-10", "2022-06-30")],     # sensor down for half a year
           "W18": [("2019-01-01", "2023-12-31")]}     # never had a sensor: rope reports only
ROPE_GAPS = {"W18": [("2022-02-01", "2022-03-15")]}   # herders away -> satellite-only stretch


def demo_group(seed=7):
    rng = np.random.default_rng(seed)
    days = pd.date_range("2019-01-01", "2023-12-31", freq="D")
    rows, meta = [], []
    for site, wells in DEMO.items():
        clim = pd.read_csv(PROC / f"climate_{site}.csv", index_col=0, parse_dates=True)
        params = [{k: v for k, v in w.items() if k not in ("id", "name", "x", "y")} for w in wells]
        for w, d in zip(wells, simulate_cluster(clim, params, rng)):
            for a, b in OUTAGES.get(w["id"], []):
                d.loc[(days >= a) & (days <= b), "obs"] = np.nan
            for a, b in ROPE_GAPS.get(w["id"], []):
                d.loc[(days >= a) & (days <= b), "rope"] = -1
            d.insert(0, "well", w["id"])
            rows.append(d)
            meta.append(dict(site=site, cluster=site, **w))
    return pd.concat(rows, ignore_index=True), meta


def failure_events(level):
    """Start index of each failure: level under H_FAIL for 3 straight days, after 14+ days above it."""
    low = level < H_FAIL
    events, last_low = [], -999
    for t in range(2, len(level)):
        if low[t] and low[t - 1] and low[t - 2]:
            if t - last_low > 14:
                events.append(t - 2)
            last_low = t
        elif low[t]:
            last_low = t if t - last_low <= 14 else last_low
    return events


if __name__ == "__main__":
    summary = {}
    for tag, (df, meta) in {"train": random_group(11, "tr"), "test": random_group(23, "te"), "demo": demo_group()}.items():
        df.to_csv(PROC / f"wells_{tag}.csv", index=False, float_format="%.3f")
        (PROC / f"wells_{tag}_meta.json").write_text(json.dumps(meta, indent=1))
        ev = {m["id"]: failure_events(df[df.well == m["id"]]["level"].values) for m in meta}
        summary[tag] = dict(wells=len(meta), failures=sum(len(v) for v in ev.values()),
                            shallow=sum(len(ev[m["id"]]) for m in meta if m["kind"] == 0),
                            borehole=sum(len(ev[m["id"]]) for m in meta if m["kind"] == 1))
        if tag == "demo":
            days = pd.date_range("2019-01-01", "2023-12-31", freq="D")
            for m in meta:
                lv = df[df.well == m["id"]]["level"]
                print(m["id"], m["name"], "min %.2f mean %.2f" % (lv.min(), lv.mean()),
                      "fails:", [str(days[e].date()) for e in ev[m["id"]]])
    print(json.dumps(summary))
