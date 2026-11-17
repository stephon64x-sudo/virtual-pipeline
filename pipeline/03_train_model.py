"""Step 3. Train the forecast model, run the replay test, export everything the dashboard needs.

Model: gradient-boosted trees with quantile loss. For each data mode (A sensor / B rope /
C satellite-only) and each horizon (7..42 days) we fit three models: the 10%, 50% and 90%
quantile of the future water level. The 10-90 spread IS the stated confidence.

Replay test: on 45 wells the model has never seen, walk through 2019-2023 day by day,
fire alerts exactly as the dashboard would, and count failures caught vs false alarms.
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from joblib import Parallel, delayed
from sklearn.ensemble import GradientBoostingRegressor

sys.path.insert(0, str(Path(__file__).parent))
import features as F  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PROC, WEB = ROOT / "data" / "processed", ROOT / "web" / "data"
WEB.mkdir(parents=True, exist_ok=True)
SITES = ["Mandera", "Wajir", "NorthHorr"]
DAYS = pd.date_range("2019-01-01", "2023-12-31", freq="D")
N = len(DAYS)
P_DEFAULT_GRID = [round(float(x), 2) for x in np.arange(0.10, 0.91, 0.05)]
GBR = dict(n_estimators=60, max_depth=3, learning_rate=0.12, subsample=0.7, min_samples_leaf=40, random_state=0)

clim = {s: pd.read_csv(PROC / f"climate_{s}.csv", index_col=0, parse_dates=True) for s in SITES}
clim_arr = {s: np.round(clim[s][F.CLIMATE].values, 4) for s in SITES}   # same rounding as the dashboard gets


def load(tag):
    df = pd.read_csv(PROC / f"wells_{tag}.csv")
    meta = json.loads((PROC / f"wells_{tag}_meta.json").read_text())
    wells = []
    for m in meta:
        d = df[df.well == m["id"]]
        w = dict(meta=m, level=d["level"].values, obs=np.round(d["obs"].values.astype(float), 2),
                 rope=d["rope"].values.astype(int), herds=d["herds"].values.astype(float))
        w["lvf"], w["last_s"], w["last_r"] = F.well_state(w["obs"], w["rope"], m["hmax"])
        w["h7"], w["hd14"] = F.herd_features(w["herds"])
        wells.append(w)
    return wells


def rows_for(w, mode, t, rng=None):
    """Feature row + base level for one well-day in a forced mode (None if that mode has no data)."""
    m, c = w["meta"], clim_arr[w["meta"]["site"]][t]
    if mode == "A":
        if np.isnan(w["obs"][t]):
            return None
        return F.feat_A(t, w["obs"], w["lvf"], w["h7"], w["hd14"], m["hmax"], m["kind"], c)
    if mode == "B":
        if w["last_r"][t] < 0 or t - w["last_r"][t] > F.ROPE_FRESH:
            return None
        return F.feat_B(t, w["rope"], w["last_r"], w["h7"], w["hd14"], m["hmax"], m["kind"], c)
    if rng is None:                                   # mode C at run time: whatever was last known
        return F.feat_C(*F.last_known(t, w["obs"], w["rope"], w["last_s"], w["last_r"], m["hmax"]), m["hmax"], m["kind"], c)
    age = int(rng.integers(11, 91))                   # mode C in training: pretend the ground went silent `age` days ago
    if t - age < 0:
        return None
    if rng.random() < 0.5:
        last, src = w["obs"][t - age], 0
    else:
        b = int(np.searchsorted([0.12, 0.30, 0.55], w["level"][t - age] / m["hmax"], side="right"))
        last, src = F.BAND_MID[b] * m["hmax"], 1
    if np.isnan(last):
        return None
    return F.feat_C(last, age, src, m["hmax"], m["kind"], c)


def matrix(wells, mode, rng, step=1):
    X, base, Y = [], [], []
    hmax_h = max(F.HORIZONS)
    for w in wells:
        for t in range(30, N - hmax_h, step):
            r = rows_for(w, mode, t, rng if mode == "C" else None)
            if r is None:
                continue
            X.append(r[0]); base.append(r[1]); Y.append([w["level"][t + h] for h in F.HORIZONS])
    return np.array(X), np.array(base), np.array(Y)


def fit_one(X, y, q):
    return GradientBoostingRegressor(loss="quantile", alpha=q, **GBR).fit(X, y)


def export(est):
    trees = []
    for e in est.estimators_[:, 0]:
        t = e.tree_
        trees.append([t.feature.tolist(), [float(x) for x in t.threshold], t.children_left.tolist(),
                      t.children_right.tolist(), [float(v) for v in t.value[:, 0, 0]]])
    return dict(init=float(est.init_.constant_[0][0]), lr=est.learning_rate, trees=trees)


def predict_all(models, mode, X, base):
    """-> array [rows, horizons, 3] of future level quantiles (sorted, clipped at 0)."""
    out = np.zeros((len(X), len(F.HORIZONS), 3))
    for i, h in enumerate(F.HORIZONS):
        for j, q in enumerate(F.QUANTILES):
            out[:, i, j] = base + models[mode][h][q].predict(X)
    return np.clip(np.sort(out, axis=2), 0, None)


def series_for(w, models, forced=None):
    """Daily forecasts for one well. forced=None uses whichever mode the live data allows."""
    feats, base, modes, idx = [], [], [], []
    for t in range(N):
        mode = forced or F.mode_at(w["obs"], w["last_r"], t)
        r = rows_for(w, mode, t)
        if r is None:                                  # forced mode unavailable today -> fall back down the chain
            mode = "B" if (mode == "A" and rows_for(w, "B", t)) else "C"
            r = rows_for(w, mode, t)
        feats.append(r[0]); base.append(r[1]); modes.append(mode); idx.append(t)
    base, modes = np.array(base), np.array(modes)
    q = np.zeros((N, len(F.HORIZONS), 3))
    for mode in "ABC":
        sel = modes == mode
        if sel.any():
            q[sel] = predict_all(models, mode, np.array([feats[i] for i in np.where(sel)[0]]), base[sel])
    p28, p42 = np.zeros(N), np.zeros(N)
    for t in range(N):
        p28[t], p42[t], _ = F.risk(base[t], {h: q[t, i] for i, h in enumerate(F.HORIZONS)})
    return dict(base=base, modes=modes, q=q, p28=p28, p42=p42)


def runs_of(mask):
    runs, start = [], None
    for t, v in enumerate(mask):
        if v and start is None:
            start = t
        if not v and start is not None:
            runs.append((start, t - 1)); start = None
    if start is not None:
        runs.append((start, len(mask) - 1))
    merged = []
    for a, b in runs:                                  # alerts less than 5 days apart are one alert
        if merged and a - merged[-1][1] <= 5:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    return merged


def score_alerts(level, act_mask):
    events = [e for e in F.failure_events(level) if e >= 60]
    runs = runs_of(act_mask)
    leads, false = [], 0
    for e in events:
        lead = 0
        for a, b in runs:
            if a < e and b >= e - 7:
                lead = e - a
        leads.append(lead)
    for a, b in runs:
        if a < 60:
            continue
        hi = min(N - 1, b + 14)
        if not any(a <= e <= hi for e in events) and level[a:hi + 1].min() >= F.H_FAIL:
            false += 1
    return leads, false, len(runs)


def summarise(leads, false, alerts, wells):
    leads = np.array(leads)
    n = len(leads)
    return dict(failures=n, caught_21d=int((leads >= 21).sum()), caught_14d=int((leads >= 14).sum()),
                caught_any=int((leads >= 3).sum()), missed=int((leads < 3).sum()),
                median_lead_days=float(np.median(leads[leads >= 3])) if (leads >= 3).any() else 0.0,
                false_alarms=int(false), alerts=int(alerts),
                false_alarms_per_well_year=round(false / (wells * 5), 2))


def evaluate(wells, series, p):
    L, Fa, Al, WL = [], 0, 0, []
    for w, s in zip(wells, series):
        lv = F.alert_levels(s["p28"], s["p42"], s["base"], p)
        leads, false, alerts = score_alerts(w["level"], lv == 2)
        L += leads; Fa += false; Al += alerts
        WL += score_alerts(w["level"], (lv == 1) | (lv == 2))[0]
    out = summarise(L, Fa, Al, len(wells))
    WL = np.array(WL)                                  # lead time counting the earlier "Watch" stage too
    out["watch_or_act_21d"] = int((WL >= 21).sum())
    out["watch_or_act_median_lead_days"] = float(np.median(WL[WL >= 3])) if (WL >= 3).any() else 0.0
    return out


def naive_baseline(wells):
    """Straight-line extrapolation of the last 14 days of sensor data: Act if it hits the floor within 28 days."""
    L, Fa, Al = [], 0, 0
    for w in wells:
        lvl = w["lvf"]
        slope = (lvl - np.roll(lvl, 14)) / 14.0
        slope[:14] = 0
        days = np.where(slope < -1e-4, (lvl - F.H_FAIL) / -slope, 999)
        raw = (days <= 28) & (lvl >= F.H_FAIL)
        act = raw & np.roll(raw, 1)
        leads, false, alerts = score_alerts(w["level"], act)
        L += leads; Fa += false; Al += alerts
    return summarise(L, Fa, Al, len(wells))


if __name__ == "__main__":
    t0 = time.time()
    rng = np.random.default_rng(0)
    train, test, demo = load("train"), load("test"), load("demo")

    # ---- fit ----
    models, data = {}, {}
    for mode in "ABC":
        X, base, Y = matrix(train, mode, rng)
        keep = rng.choice(len(X), min(len(X), 30000), replace=False)
        data[mode] = (X[keep], base[keep], Y[keep])
    jobs = [(m, i, h, q) for m in "ABC" for i, h in enumerate(F.HORIZONS) for q in F.QUANTILES]
    fitted = Parallel(n_jobs=2)(delayed(fit_one)(data[m][0], data[m][2][:, i] - data[m][1], q) for m, i, h, q in jobs)
    for (m, i, h, q), est in zip(jobs, fitted):
        models.setdefault(m, {}).setdefault(h, {})[q] = est
    print("fit done", round(time.time() - t0), "s")

    # ---- accuracy of the ranges on unseen wells ----
    ev = {"by_mode": {}}
    for mode in "ABC":
        X, base, Y = matrix(test, mode, np.random.default_rng(1), step=3)
        q = predict_all(models, mode, X, base)
        rows = {}
        for i, h in enumerate(F.HORIZONS):
            inside = (Y[:, i] >= q[:, i, 0]) & (Y[:, i] <= q[:, i, 2])
            rows[str(h)] = dict(coverage_80=round(float(inside.mean()), 3),
                                mean_width_m=round(float((q[:, i, 2] - q[:, i, 0]).mean()), 2),
                                median_abs_err_m=round(float(np.median(np.abs(Y[:, i] - q[:, i, 1]))), 2))
        ev["by_mode"][mode] = rows

    # ---- replay test: alerts on unseen wells ----
    series = {mode: [series_for(w, models, forced=mode) for w in test] for mode in "ABC"}
    ev["curve"] = [dict(p=p, **evaluate(test, series["A"], p)) for p in P_DEFAULT_GRID]
    # default threshold: fewest false alarms while missing at most 3% and giving 2+ weeks notice on 85%
    ok = [c for c in ev["curve"] if c["missed"] <= 0.03 * c["failures"] and c["caught_14d"] >= 0.85 * c["failures"]]
    best = min(ok, key=lambda c: (c["false_alarms"], -c["p"])) if ok else ev["curve"][0]
    ev["p_default"] = best["p"]
    ev["replay"] = {mode: evaluate(test, series[mode], best["p"]) for mode in "ABC"}
    ev["naive_baseline"] = naive_baseline(test)
    ev["test_wells"], ev["train_wells"] = len(test), len(train)

    # ---- harder check: leave one site out (train on two regions, test on the third) ----
    loso = {}
    i28 = F.HORIZONS.index(28)
    for site in SITES:
        tr = [w for w in train if w["meta"]["site"] != site]
        te = [w for w in test if w["meta"]["site"] == site]
        X, base, Y = matrix(tr, "A", rng, step=4)
        Xt, bt, Yt = matrix(te, "A", rng, step=3)
        ests = Parallel(n_jobs=2)(delayed(fit_one)(X, Y[:, i28] - base, q) for q in F.QUANTILES)
        q = np.sort(np.stack([bt + e.predict(Xt) for e in ests], axis=1), axis=1)
        loso[site] = dict(coverage_80=round(float(((Yt[:, i28] >= q[:, 0]) & (Yt[:, i28] <= q[:, 2])).mean()), 3),
                          median_abs_err_m=round(float(np.median(np.abs(Yt[:, i28] - q[:, 1]))), 2))
    ev["leave_one_site_out_28d"] = loso

    imp = models["A"][28][0.5].feature_importances_
    ev["top_features_28d"] = [dict(name=n, weight=round(float(v), 3)) for n, v in sorted(zip(F.FEATURES["A"], imp), key=lambda x: -x[1])[:8]]

    # ---- demo wells: same scoring, for the dashboard story ----
    dser = [series_for(w, models) for w in demo]
    ev["demo_replay"] = evaluate(demo, dser, best["p"])
    print(json.dumps({k: v for k, v in ev.items() if k != "curve"}, indent=1))
    for c in ev["curve"]:
        print(c)

    # ---- export ----
    (WEB / "eval.json").write_text(json.dumps(ev))
    (WEB / "model.json").write_text(json.dumps(dict(
        horizons=F.HORIZONS, quantiles=F.QUANTILES, features=F.FEATURES, h_fail=F.H_FAIL, band_mid=F.BAND_MID,
        models={m: {str(h): [export(models[m][h][q]) for q in F.QUANTILES] for h in F.HORIZONS} for m in "ABC"}),
        separators=(",", ":")))
    r = lambda a, k=2: [None if (isinstance(x, float) and np.isnan(x)) else round(float(x), k) for x in a]
    world = dict(start="2019-01-01", days=N, climate_features=F.CLIMATE, sites={}, wells=[])
    for s in SITES:
        c = clim[s]
        world["sites"][s] = dict(rain=r(c["rain"], 1), tmax=r(c["tmax"], 1), s2_cloud=r(c["s2_cloud"], 2),
                                 features=[r(row, 4) for row in clim_arr[s]])
    for w in demo:
        world["wells"].append(dict(**w["meta"], level=r(w["level"]), obs=r(w["obs"]), rope=w["rope"].tolist(),
                                   herds_obs=[int(x) for x in w["herds"]]))
    (WEB / "world.json").write_text(json.dumps(world, separators=(",", ":")))
    # sample for the JS-vs-Python check
    chk = []
    for w, s in zip(demo, dser):
        for t in range(40, N, 97):
            chk.append(dict(well=w["meta"]["id"], t=t, mode=str(s["modes"][t]), base=float(s["base"][t]),
                            q=s["q"][t].tolist(), p28=float(s["p28"][t]), p42=float(s["p42"][t])))
        s_lv = F.alert_levels(s["p28"], s["p42"], s["base"], best["p"])
        chk.append(dict(well=w["meta"]["id"], alerts=s_lv.tolist()))
    (PROC / "js_check.json").write_text(json.dumps(chk))
    print("total", round(time.time() - t0), "s;", {f.name: f"{f.stat().st_size/1e6:.1f}MB" for f in WEB.glob("*.json")})
