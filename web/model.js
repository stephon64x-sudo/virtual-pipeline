// Forecast engine that runs in the browser. Mirror of pipeline/features.py
// (pipeline/04_check_js.mjs verifies both give identical numbers).

export const H_FAIL = 0.5;
const DRY_CLEAR = 0.25;
export const BAND_MID = [0.06, 0.21, 0.425, 0.775];
export const BAND_EDGES = [0.12, 0.30, 0.55];
export const BAND_CODE = ['R', 'O', 'Y', 'G'];
export const BAND_NAME = ['Red', 'Orange', 'Yellow', 'Green'];
export const HORIZONS = [7, 14, 21, 28, 42];
const ROPE_FRESH = 10, MAX_AGE = 120;

let MODEL = null;
export function setModel(m) { MODEL = m; }

export const bandOf = (frac) => (frac < BAND_EDGES[0] ? 0 : frac < BAND_EDGES[1] ? 1 : frac < BAND_EDGES[2] ? 2 : 3);

function runTree(tree, x) {
  const [feature, threshold, left, right, value] = tree;
  let n = 0;
  while (left[n] !== -1) n = Math.fround(x[feature[n]]) <= threshold[n] ? left[n] : right[n];
  return value[n];
}
function runModel(m, x) {
  let s = 0;
  for (const t of m.trees) s += runTree(t, x);
  return m.init + m.lr * s;
}

// Per-day bookkeeping for one well. obs: numbers or null. rope: -1 or band 0..3.
export function wellState(well) {
  const { obs, rope, herds_obs: herds, hmax } = well, n = obs.length;
  const lvf = new Float64Array(n), lastS = new Int32Array(n), lastR = new Int32Array(n);
  let cur = NaN, ls = -1, lr = -1, first = NaN;
  for (let t = 0; t < n; t++) {
    if (obs[t] != null) { cur = obs[t]; ls = t; if (Number.isNaN(first)) first = cur; }
    if (rope[t] >= 0) lr = t;
    lvf[t] = cur; lastS[t] = ls; lastR[t] = lr;
  }
  if (Number.isNaN(first)) first = 0.4 * hmax;
  for (let t = 0; t < n && Number.isNaN(lvf[t]); t++) lvf[t] = first;
  const c = new Float64Array(n + 1);
  for (let t = 0; t < n; t++) c[t + 1] = c[t] + herds[t];
  const h7 = new Float64Array(n), hd14 = new Float64Array(n);
  for (let t = 0; t < n; t++) { const a = Math.max(0, t - 6); h7[t] = (c[t + 1] - c[a]) / (t + 1 - a); }
  for (let t = 0; t < n; t++) hd14[t] = h7[t] - h7[Math.max(0, t - 14)];
  return { lvf, lastS, lastR, h7, hd14 };
}

export function modeAt(well, st, t) {
  if (well.obs[t] != null) return 'A';
  if (st.lastR[t] >= 0 && t - st.lastR[t] <= ROPE_FRESH) return 'B';
  return 'C';
}

function features(well, st, t, clim, mode, extraHerds) {
  const { obs, rope, hmax, kind } = well;
  const h7 = st.h7[t] + extraHerds, hd14 = st.hd14[t] + extraHerds;
  if (mode === 'A') {
    const lvl = obs[t];
    return [[lvl, lvl / hmax, lvl - st.lvf[Math.max(0, t - 7)], lvl - st.lvf[Math.max(0, t - 14)],
      lvl - st.lvf[Math.max(0, t - 30)], h7, hd14, hmax, kind, ...clim], lvl];
  }
  if (mode === 'B') {
    const r = st.lastR[t], mid = BAND_MID[rope[r]];
    const recent = [];
    for (let j = r; j >= 0 && t - j <= ROPE_FRESH && recent.length < 3; j--) if (rope[j] >= 0) recent.push(BAND_MID[rope[j]]);
    const mean3 = recent.reduce((a, b) => a + b, 0) / recent.length * hmax;
    let d14 = 0;
    for (let j = t - 14; j >= 0 && t - j <= 45; j--) if (rope[j] >= 0) { d14 = (mid - BAND_MID[rope[j]]) * hmax; break; }
    return [[mid * hmax, mean3, mid, t - r, d14, h7, hd14, hmax, kind, ...clim], mean3];
  }
  const s = st.lastS[t], r = st.lastR[t];
  let last, age, src;
  if (s < 0 && r < 0) { last = 0.4 * hmax; age = MAX_AGE; src = 1; }
  else if (s >= r) { last = obs[s]; age = Math.min(MAX_AGE, t - s); src = 0; }
  else { last = BAND_MID[rope[r]] * hmax; age = Math.min(MAX_AGE, t - r); src = 1; }
  return [[last, last / hmax, age, src, hmax, kind, ...clim], last];
}

function erf(x) {  // Abramowitz-Stegun 7.1.26, |error| < 1.5e-7
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function pBelow([q10, q50, q90], x = H_FAIL) {
  const sd = Math.max(0.02, (x < q50 ? q50 - q10 : q90 - q50) / 1.2816);
  return normCdf((x - q50) / sd);
}

// Forecast for one well on day t. extraHerds lets us ask "what if N more herds arrive?"
export function forecast(well, st, t, clim, extraHerds = 0) {
  const mode = modeAt(well, st, t);
  const [x, base] = features(well, st, t, clim, mode, mode === 'C' ? 0 : extraHerds);
  const q = HORIZONS.map((h) => {
    const v = MODEL.models[mode][h].map((m) => Math.max(0, base + runModel(m, x)));
    return v.sort((a, b) => a - b);
  });
  const ph = q.map((qq) => pBelow(qq));
  const p28 = Math.max(...ph.slice(0, 4)), p42 = Math.max(...ph);
  const days = [0, 1, 2].map((k) => {
    if (base < H_FAIL) return 0;
    const xs = [0, ...HORIZONS], ys = [base, ...q.map((qq) => qq[k])];
    for (let i = 1; i < xs.length; i++) {
      if (ys[i] < H_FAIL) return xs[i - 1] + (ys[i - 1] - H_FAIL) / (ys[i - 1] - ys[i]) * (xs[i] - xs[i - 1]);
    }
    return null;                         // more than 42 days
  });
  return { mode, base, q, p28, p42, days };
}

// 0 OK, 1 Watch, 2 Act, 3 Dry. Two straight days to switch on, five quiet days to drop.
export function alertLevels(p28, p42, base, p, upto = p28.length) {
  const out = new Uint8Array(upto);
  let lvl = 0, upA = 0, upW = 0, quiet = 0, dry = false;
  for (let t = 0; t < upto; t++) {
    if (base[t] < H_FAIL) dry = true;
    else if (dry && base[t] >= H_FAIL + DRY_CLEAR) dry = false;   // stays "Dry" until clearly recovered
    if (dry) { out[t] = 3; lvl = 0; upA = 0; upW = 0; quiet = 0; continue; }
    const a = p28[t] >= p, w = p42[t] >= 0.6 * p;
    upA = a ? upA + 1 : 0;
    upW = (w || a) ? upW + 1 : 0;
    if (upA >= 2) lvl = 2; else if (upW >= 2 && lvl < 1) lvl = 1;
    const still = lvl === 2 ? a : (w || a);
    quiet = still ? 0 : quiet + 1;
    if (lvl > 0 && quiet >= 5) { lvl = (lvl === 2 && upW >= 1) ? 1 : 0; quiet = 0; }
    out[t] = lvl;
  }
  return out;
}

// ---- The virtual pipeline: match wells running short with wells that have water to spare ----
// wells: [{id, x, y, herds, level, fc, status, capacity}] for ONE cluster. Returns moves and truck requests.
export const WALK_KM_PER_DAY = 15;
export const LITRES_PER_HERD_DAY = 2500;      // ~50 animals x 50 L, a planning figure
export const DRAWDOWN_PER_HERD = 0.03;        // metres of water one extra herd costs a well over 4 weeks (planning figure)

export function planPipeline(cluster, whatIf) {
  const short = cluster.filter((w) => w.status >= 2).sort((a, b) => (a.fc.days[1] ?? 99) - (b.fc.days[1] ?? 99));
  const donors = cluster.filter((w) => w.status === 0);
  const taken = new Map(donors.map((d) => [d.id, 0]));
  const moves = [], trucks = [];
  for (const s of short) {
    let left = Math.round(s.herds);
    const options = donors.map((d) => ({ d, km: Math.hypot(d.x - s.x, d.y - s.y) })).sort((a, b) => a.km - b.km);
    for (const { d, km } of options) {
      if (left <= 0) break;
      // biggest group the donor can absorb without being pushed into a warning itself
      let n = 0;
      for (const tryN of [left, Math.round(left * 0.75), Math.round(left * 0.5), Math.round(left * 0.25)]) {
        if (tryN > 0 && whatIf(d, taken.get(d.id) + tryN) < 1) { n = tryN; break; }
      }
      if (n > 0) {
        taken.set(d.id, taken.get(d.id) + n);
        const walkDays = Math.max(1, Math.ceil(km / WALK_KM_PER_DAY));
        moves.push({ from: s.id, to: d.id, herds: n, km: Math.round(km), walkDays });
        left -= n;
      }
    }
    if (left > 0) trucks.push({ to: s.id, herds: left, litresPerDay: left * LITRES_PER_HERD_DAY, daysLeft: s.fc.days[1] });
  }
  trucks.sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99));
  return { moves, trucks };
}
