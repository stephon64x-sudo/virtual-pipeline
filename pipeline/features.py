"""Feature building, risk maths and the alert state machine.

web/model.js is a line-for-line mirror of this file (checked by pipeline/04_check_js.mjs),
so the dashboard computes exactly what the replay test measured.

Three data modes, chosen per well per day by what data is actually alive:
  A "sensor"     a level sensor is reporting
  B "rope"       sensor dead, but a herder sent a painted-rope report in the last 10 days
  C "satellite"  nothing from the ground: last known level + its age + satellite/climate only
"""
import math

import numpy as np

H_FAIL = 0.5
DRY_CLEAR = 0.25
BAND_MID = [0.06, 0.21, 0.425, 0.775]
HORIZONS = [7, 14, 21, 28, 42]
QUANTILES = [0.1, 0.5, 0.9]
CLIMATE = ["rain7", "rain30", "rain90", "rain180", "dry_days", "tmax14",
           "ndvi", "ndvi_d48", "s2_ndvi", "s2_age", "grace", "doy_sin", "doy_cos"]
FEATURES = {
    "A": ["lvl", "frac", "d7", "d14", "d30", "herds7", "herds_d14", "hmax", "kind"] + CLIMATE,
    "B": ["rope_lvl", "rope_mean3", "rope_frac", "rope_age", "rope_d14", "herds7", "herds_d14", "hmax", "kind"] + CLIMATE,
    "C": ["last_lvl", "last_frac", "age", "src", "hmax", "kind"] + CLIMATE,
}
ROPE_FRESH = 10      # days a rope report stays usable
MAX_AGE = 120


def herd_features(herds):
    n = len(herds)
    c = np.concatenate([[0.0], np.cumsum(herds)])
    h7 = np.array([(c[t + 1] - c[max(0, t - 6)]) / (t + 1 - max(0, t - 6)) for t in range(n)])
    d14 = np.array([h7[t] - h7[max(0, t - 14)] for t in range(n)])
    return h7, d14


def well_state(obs, rope, hmax):
    """Per-day bookkeeping shared by all modes. obs: float array with NaN gaps. rope: int array, -1 = none."""
    n = len(obs)
    lvf = np.zeros(n)            # sensor level, forward-filled
    last_s = np.full(n, -1)      # index of the last valid sensor reading
    last_r = np.full(n, -1)      # index of the last rope report
    cur, ls, lr = float("nan"), -1, -1
    for t in range(n):
        if not math.isnan(obs[t]):
            cur, ls = obs[t], t
        if rope[t] >= 0:
            lr = t
        lvf[t], last_s[t], last_r[t] = cur, ls, lr
    first = next((v for v in lvf if not math.isnan(v)), 0.4 * hmax)
    lvf = np.where(np.isnan(lvf), first, lvf)
    return lvf, last_s, last_r


def mode_at(obs, last_r, t):
    if not math.isnan(obs[t]):
        return "A"
    if last_r[t] >= 0 and t - last_r[t] <= ROPE_FRESH:
        return "B"
    return "C"


def feat_A(t, obs, lvf, h7, hd14, hmax, kind, clim_row):
    lvl = obs[t]
    return [lvl, lvl / hmax, lvl - lvf[max(0, t - 7)], lvl - lvf[max(0, t - 14)], lvl - lvf[max(0, t - 30)],
            h7[t], hd14[t], hmax, kind] + list(clim_row), lvl


def feat_B(t, rope, last_r, h7, hd14, hmax, kind, clim_row):
    r = last_r[t]
    mid = BAND_MID[rope[r]]
    recent, j = [], r
    while j >= 0 and t - j <= ROPE_FRESH and len(recent) < 3:
        if rope[j] >= 0:
            recent.append(BAND_MID[rope[j]])
        j -= 1
    mean3 = sum(recent) / len(recent) * hmax
    d14, j = 0.0, t - 14
    while j >= 0 and t - j <= 45:
        if rope[j] >= 0:
            d14 = (mid - BAND_MID[rope[j]]) * hmax
            break
        j -= 1
    return [mid * hmax, mean3, mid, t - r, d14, h7[t], hd14[t], hmax, kind] + list(clim_row), mean3


def last_known(t, obs, rope, last_s, last_r, hmax):
    s, r = last_s[t], last_r[t]
    if s < 0 and r < 0:
        return 0.4 * hmax, MAX_AGE, 1
    if s >= r:
        return obs[s], min(MAX_AGE, t - s), 0
    return BAND_MID[rope[r]] * hmax, min(MAX_AGE, t - r), 1


def feat_C(last_lvl, age, src, hmax, kind, clim_row):
    return [last_lvl, last_lvl / hmax, age, src, hmax, kind] + list(clim_row), last_lvl


# ---------- risk maths ----------
def norm_cdf(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def p_below(q10, q50, q90, x=H_FAIL):
    """P(level < x) from three quantiles, using a two-sided normal fitted to them."""
    sd = max(0.02, ((q50 - q10) if x < q50 else (q90 - q50)) / 1.2816)
    return norm_cdf((x - q50) / sd)


def risk(base, q):
    """q: {horizon: (q10, q50, q90)} in metres. Returns p28, p42 and days-left for each quantile path."""
    ph = {h: p_below(*q[h]) for h in HORIZONS}
    p28 = max(ph[h] for h in HORIZONS if h <= 28)
    p42 = max(ph.values())
    days = []
    for k in range(3):
        xs, ys = [0] + HORIZONS, [base] + [q[h][k] for h in HORIZONS]
        d = None
        if base < H_FAIL:
            d = 0.0
        else:
            for i in range(1, len(xs)):
                if ys[i] < H_FAIL:
                    d = xs[i - 1] + (ys[i - 1] - H_FAIL) / (ys[i - 1] - ys[i]) * (xs[i] - xs[i - 1])
                    break
        days.append(d)                      # None means "more than 42 days"
    return p28, p42, days


def alert_levels(p28, p42, base, p):
    """0 OK, 1 Watch, 2 Act, 3 Dry. A level needs 2 straight days to switch on and 5 quiet days to drop."""
    n = len(p28)
    out = np.zeros(n, int)
    lvl, up_a, up_w, quiet, dry = 0, 0, 0, 0, False
    for t in range(n):
        if base[t] < H_FAIL:
            dry = True
        elif dry and base[t] >= H_FAIL + DRY_CLEAR:      # stays "Dry" until it has clearly recovered
            dry = False
        if dry:
            out[t], lvl, up_a, up_w, quiet = 3, 0, 0, 0, 0
            continue
        a, w = p28[t] >= p, p42[t] >= 0.6 * p
        up_a = up_a + 1 if a else 0
        up_w = up_w + 1 if (w or a) else 0
        if up_a >= 2:
            lvl = 2
        elif up_w >= 2 and lvl < 1:
            lvl = 1
        still = a if lvl == 2 else (w or a)
        quiet = 0 if still else quiet + 1
        if lvl > 0 and quiet >= 5:
            lvl, quiet = (1 if (lvl == 2 and up_w >= 1) else 0), 0
        out[t] = lvl
    return out


def failure_events(level):
    low = level < H_FAIL
    events, last_low = [], -999
    for t in range(2, len(level)):
        if low[t] and low[t - 1] and low[t - 2]:
            if t - last_low > 14:
                events.append(t - 2)
            last_low = t
        elif low[t] and t - last_low <= 14:
            last_low = t
    return events
