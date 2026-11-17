// Virtual Pipeline dashboard: data -> prediction -> warning, for nine wells in northern Kenya.
import * as M from './model.js';
import { createStage } from './scene3d.js';

const $ = (s) => document.querySelector(s);
const DAY0 = Date.UTC(2019, 0, 1);
const dateOf = (t) => new Date(DAY0 + t * 864e5);
const fmt = (t, o = { day: 'numeric', month: 'short', year: 'numeric' }) => dateOf(t).toLocaleDateString('en-GB', { timeZone: 'UTC', ...o });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const STATUS = [{ key: 'ok', label: 'OK', icon: '●' }, { key: 'watch', label: 'Watch', icon: '▲' }, { key: 'act', label: 'Act', icon: '◆' }, { key: 'dry', label: 'Dry', icon: '✕' }];
const SITE = { Mandera: 'Mandera', Wajir: 'Wajir', NorthHorr: 'North Horr' };
const KIND = ['hand-dug well', 'borehole'];
const LIVE_START = 1235;                       // 20 May 2022, seven weeks before W12 really ran dry
const LIVE_WELL = 'W12';
const SPEEDS = { replay: [[7, '1 week a second'], [14, '2 weeks a second'], [30, '1 month a second']], live: [[0.5, 'Half speed'], [1, '1 day a second'], [2, '2 days a second']] };

const S = { t: 1215, p: 0.25, playing: false, speed: 14, mode: 'replay', site: 'Mandera', sel: 'W12', view: 'region', tab: 'phone',
  lang: 'en', reveal: false, ver: 0, replies: {}, smsStatus: '', live: null, pitop: { fresh: false, ok: false, frac: 0, cm: null, ever: false }, hist: [], buzz: false };
let stage, planCache = new Map(), chartCtx = null;

// ---------- engine ----------
const climOf = (w) => S.world.sites[w.site].features;
const fc = (w, t, extra = 0) => M.forecast(w, w.st, t, climOf(w)[t], extra);

function computeWell(w, only) {
  w.st = M.wellState(w);
  const N = S.N, clim = climOf(w);
  if (!w.p28) { w.p28 = new Float64Array(N); w.p42 = new Float64Array(N); w.base = new Float64Array(N); w.mode = new Array(N); }
  for (let t = only ?? 0; t <= (only ?? N - 1); t++) {
    const f = M.forecast(w, w.st, t, clim[t]);
    w.p28[t] = f.p28; w.p42[t] = f.p42; w.base[t] = f.base; w.mode[t] = f.mode;
  }
  w.alerts = M.alertLevels(w.p28, w.p42, w.base, S.p);
}

function planAt(site, t) {
  const key = `${site}|${t}|${S.p}|${S.ver}`;
  if (planCache.has(key)) return planCache.get(key);
  const cluster = S.wells.filter((w) => w.site === site).map((w) => ({ id: w.id, x: w.x, y: w.y, herds: w.st.h7[t], fc: fc(w, t), status: w.alerts[t], w }));
  // A neighbour can take extra herds only if (1) the model still sees no warning with them and
  // (2) its likely level in 4 weeks, minus a planning allowance of 3 cm of water per extra herd, keeps a 30 cm margin.
  const whatIf = (d, extra) => {
    const f = fc(d.w, t, extra);
    return (f.p28 >= S.p || f.p42 >= 0.6 * S.p || f.q[3][1] - M.DRAWDOWN_PER_HERD * extra < M.H_FAIL + 0.3) ? 1 : 0;
  };
  const plan = M.planPipeline(cluster, whatIf);
  if (planCache.size > 500) planCache = new Map();
  planCache.set(key, plan);
  return plan;
}

const rd = (d) => (d == null ? null : Math.max(0, Math.round(d)));
function daysText(f) {
  const [lo, med, hi] = f.days.map(rd);
  if (f.base < M.H_FAIL) return { big: 'Too low to draw', range: 'The water is below what a bucket or pump can reach' };
  if (lo == null) return { big: '6+ weeks of water', range: 'Even the worst case stays usable for 6 weeks' };
  if (med == null) return { big: `${lo} days at worst`, range: 'More likely it lasts longer than 6 weeks' };
  return { big: `Likely dry in ${med} days`, range: `Range ${lo} to ${hi ?? '42+'} days` };
}
const shortDays = (f) => { const [lo, med] = f.days.map(rd); return f.base < M.H_FAIL ? 'dry' : med != null ? `${med} days left` : lo != null ? `${lo}+ days left` : '6+ weeks left'; };

// ---------- SMS ----------
// Swahili and Somali drafts need a native-speaker check before real use (see README).
const SMS = {
  en: {
    watch: (v) => `WATCH ${v.id} ${v.name}: water may run out in ${v.lo}-${v.hi} days. Ration now: 1/3 less per animal. Send rope colour: ${v.id} G/Y/O/R`,
    act: (v) => `ACT ${v.id} ${v.name}: likely dry in ${v.med} days (${v.lo}-${v.hi}). Move herds to ${v.dest}, ${v.km} km, ${v.walk} days walk, before ${v.by}. Reply 1=OK 2=wrong`,
    actNo: (v) => `ACT ${v.id} ${v.name}: likely dry in ${v.med} days (${v.lo}-${v.hi}). No nearby well has room. Water trucks requested. Ration now. Reply 1=OK 2=wrong`,
    dry: (v) => `${v.id} ${v.name} is too low to draw. Go to ${v.dest} (${v.km} km).`,
    dryNo: (v) => `${v.id} ${v.name} is too low to draw. Water trucks requested.`,
    clear: (v) => `${v.id} ${v.name}: water is rising again. Warning lifted.`,
    ask: (v) => `No reading from ${v.id} for ${v.n} days. Please send rope colour: ${v.id} G, Y, O or R.`,
    unsure: ' LESS CERTAIN: sensor down.',
  },
  sw: {
    watch: (v) => `ANGALIZO ${v.id} ${v.name}: maji yanaweza kuisha ndani ya siku ${v.lo}-${v.hi}. Punguza matumizi sasa: theluthi moja kwa kila mnyama. Tuma rangi ya kamba: ${v.id} G/Y/O/R`,
    act: (v) => `HATUA ${v.id} ${v.name}: huenda kikauke ndani ya siku ${v.med} (${v.lo}-${v.hi}). Hamisha mifugo hadi ${v.dest}, km ${v.km}, siku ${v.walk} kwa miguu, kabla ya ${v.by}. Jibu 1=Sawa 2=Si kweli`,
    actNo: (v) => `HATUA ${v.id} ${v.name}: huenda kikauke ndani ya siku ${v.med} (${v.lo}-${v.hi}). Hakuna kisima cha karibu chenye nafasi. Malori ya maji yameombwa. Jibu 1=Sawa 2=Si kweli`,
    dry: (v) => `${v.id} ${v.name}: maji yako chini mno. Nenda ${v.dest} (km ${v.km}).`,
    dryNo: (v) => `${v.id} ${v.name}: maji yako chini mno. Malori ya maji yameombwa.`,
    clear: (v) => `${v.id} ${v.name}: maji yanaongezeka tena. Tahadhari imeondolewa.`,
    ask: (v) => `Hatujapata kipimo cha ${v.id} kwa siku ${v.n}. Tafadhali tuma rangi ya kamba: ${v.id} G, Y, O au R.`,
    unsure: ' UHAKIKA MDOGO: kipimo hakifanyi kazi.',
  },
  so: {
    watch: (v) => `FEEJIGNAAN ${v.id} ${v.name}: biyuhu waxay dhammaan karaan ${v.lo}-${v.hi} maalmood gudahood. Hadda yaree isticmaalka: saddex meelood meel. Soo dir midabka xadhigga: ${v.id} G/Y/O/R`,
    act: (v) => `TALLAABO ${v.id} ${v.name}: waxaa laga yaabaa inuu qallalo ${v.med} maalmood (${v.lo}-${v.hi}). Xoolaha u rar ${v.dest}, ${v.km} km, ${v.walk} maalmood socod, ka hor ${v.by}. Jawaab 1=Haa 2=Khalad`,
    actNo: (v) => `TALLAABO ${v.id} ${v.name}: waxaa laga yaabaa inuu qallalo ${v.med} maalmood (${v.lo}-${v.hi}). Ceel dhow oo boos leh ma jiro. Booyado biyo ah waa la codsaday. Jawaab 1=Haa 2=Khalad`,
    dry: (v) => `${v.id} ${v.name}: biyuhu aad bay u hooseeyaan. Tag ${v.dest} (${v.km} km).`,
    dryNo: (v) => `${v.id} ${v.name}: biyuhu aad bay u hooseeyaan. Booyado biyo ah waa la codsaday.`,
    clear: (v) => `${v.id} ${v.name}: biyuhu way soo kordhayaan. Digniintii waa la qaaday.`,
    ask: (v) => `${v.id} wax cabbir ah kama helin ${v.n} maalmood. Fadlan soo dir midabka xadhigga: ${v.id} G, Y, O ama R.`,
    unsure: ' HUBAAL YAR: qalabkii cabbirka ma shaqeynayo.',
  },
};

function smsText(w, d, kind, lang) {
  const f = fc(w, d), [lo, med, hi] = f.days.map(rd);
  const move = planAt(w.site, d).moves.find((m) => m.from === w.id);
  const dest = move ? S.byId[move.to] : null;
  const walk = move ? move.walkDays : 0;
  const by = dateOf(d + Math.max(1, (lo ?? med ?? 14) - walk - 2));
  const v = { id: w.id, name: w.name.split(' ')[0], lo: lo ?? 28, hi: hi ?? '42+', med: med ?? lo ?? 28,
    dest: dest ? `${dest.id} ${dest.name.split(' ')[0]}` : '', km: move?.km, walk, by: lang === 'en' ? by.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }) : `${by.getUTCDate()}/${by.getUTCMonth() + 1}`,
    n: Math.min(120, d - Math.max(w.st.lastS[d], w.st.lastR[d])) };
  const L = SMS[lang];
  let k = kind;
  if ((kind === 'act' || kind === 'dry') && !dest) k += 'No';
  return L[k](v) + ((kind === 'watch' || kind === 'act') && f.mode !== 'A' ? L.unsure : '');
}

function messagesFor(w, t) {
  const out = [], from = Math.max(1, S.mode === 'live' && w.id === LIVE_WELL ? LIVE_START : t - 150);
  for (let d = from; d <= t; d++) {
    const a = w.alerts[d], b = w.alerts[d - 1];
    let kind = null;
    if (a === b) { if (w.mode[d] === 'C' && w.mode[d - 1] !== 'C') kind = 'ask'; }
    else if (a === 1 && b === 0) kind = 'watch';
    else if (a === 2) kind = 'act';
    else if (a === 3) kind = 'dry';
    else if (a === 0 && b >= 1) kind = 'clear';
    if (kind) out.push({ d, kind });
  }
  return out.slice(-4);
}

async function sendReal(text) {
  try {
    const r = await (await fetch('/api/sms', { method: 'POST', body: JSON.stringify({ text }) })).json();
    S.smsStatus = r.sent ? `Sent as a real SMS to ${r.to}` : `Not sent: ${r.reason}`;
  } catch { S.smsStatus = 'Not sent: start server.py to send real texts'; }
  renderTab();
}

// ---------- banners and sound ----------
let audio = null, toastTimer = 0;
function beep(kind) {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const notes = { watch: [660], act: [880, 660, 880], dry: [330, 220], info: [520], ok: [520, 780] }[kind] ?? [520];
    notes.forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain(), t0 = audio.currentTime + i * 0.16;
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
      o.connect(g).connect(audio.destination); o.start(t0); o.stop(t0 + 0.16);
    });
  } catch { /* no sound available */ }
}
function toast(kind, text) {
  const el = $('#toast');
  el.className = `toast ${kind}`; el.textContent = text; el.hidden = false;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
  beep(kind);
}

// ---------- live demo ----------
function enterLive() {
  const w = S.byId[LIVE_WELL];
  S.hist = [];
  S.live = { orig: { level: [...w.level], obs: [...w.obs], rope: [...w.rope] }, level: w.level[LIVE_START], unplugged: false, auto: true, pending: null, usedPitop: false };
  Object.assign(S, { mode: 'live', site: w.site, sel: w.id, view: 'well', t: LIVE_START, speed: 1, playing: true, reveal: false });
}
function exitLive() {
  const w = S.byId[LIVE_WELL];
  Object.assign(w, S.live.orig);
  S.live = null; S.ver++;
  computeWell(w);
  Object.assign(S, { mode: 'replay', speed: 14, playing: false, view: 'region' });
}
function liveOnline() {
  const L = S.live, P = S.pitop;
  if (P.fresh) return P.ok;
  return L.usedPitop ? false : !L.unplugged;
}
function liveTick(t) {
  const w = S.byId[LIVE_WELL], L = S.live, P = S.pitop;
  if (P.fresh) { L.usedPitop = true; if (P.ok) L.level = P.frac * w.hmax; }
  else if (!L.usedPitop) L.level = clamp(L.level + (L.orig.level[t] - L.orig.level[t - 1]), 0, w.hmax);
  const online = liveOnline();
  w.level[t] = Math.round(L.level * 100) / 100;
  w.obs[t] = online ? w.level[t] : null;
  let rope = -1;
  if (L.pending != null) { rope = L.pending; L.pending = null; }
  else if (L.auto && (online || !L.usedPitop) && Math.random() < 0.6) rope = M.bandOf(L.level / w.hmax);
  w.rope[t] = rope;
  S.ver++;
  computeWell(w, t);
  const a = w.alerts[t], b = w.alerts[t - 1], f = fc(w, t);
  if (a !== b) {
    const move = planAt(w.site, t).moves.find((m) => m.from === w.id);
    if (a === 2) { toast('act', move ? `ACT on W12: SMS sent. Move the herd to ${move.to}, ${move.km} km` : 'ACT on W12: SMS sent. Water trucks requested'); sendReal(smsText(w, t, 'act', S.lang)); }
    else if (a === 1 && b === 0) toast('watch', 'WATCH on W12: SMS sent. Start rationing');
    else if (a === 3) toast('dry', 'W12 is too low to draw water');
    else if (a === 0) toast('ok', 'W12 has recovered. Warning lifted');
    S.buzz = true;
  } else if (w.mode[t] !== w.mode[t - 1]) {
    if (w.mode[t] === 'A') toast('ok', 'Sensor back online');
    else if (w.mode[t] === 'B') toast('info', 'Sensor offline. Now forecasting from herders\' rope texts');
    else { toast('info', 'No ground data. Satellite only: herders asked for a rope reading'); S.buzz = true; }
  }
  fetch('/api/status', { method: 'POST', body: JSON.stringify({ well: w.id, status: STATUS[a].label.toUpperCase(), detail: shortDays(f), level: online ? w.level[t] : null }) }).catch(() => {});
}

async function pollPitop() {
  const P = S.pitop;
  try {
    const r = await (await fetch('/api/sensor')).json();
    P.fresh = r.age_s != null && r.age_s < 3;
    P.ok = P.fresh && r.ok;
    if (P.ok) { P.cm = r.distance_cm; P.frac = clamp((r.empty_cm - r.distance_cm) / (r.empty_cm - r.full_cm), 0, 1); }
    if (P.ok && S.live) { S.live.usedPitop = true; S.live.level = P.frac * S.byId[LIVE_WELL].hmax; }
    if (P.fresh) P.ever = true;
    P.smsReady = r.sms_ready;
  } catch { P.fresh = false; P.ok = false; }
  if (S.mode === 'live') {
    S.hist.push(liveOnline() ? S.live.level / S.byId[LIVE_WELL].hmax : null);
    if (S.hist.length > 240) S.hist.shift();
    renderLivePanel(); if (S.sel === LIVE_WELL) renderStage();
  }
}

// ---------- rendering ----------
const chip = (s) => `<span class="chip ${STATUS[s].key}">${STATUS[s].icon} ${STATUS[s].label}</span>`;
const selWell = () => S.byId[S.sel];

function renderHeader() {
  $('#date').textContent = fmt(S.t);
  $('#dateNote').textContent = S.mode === 'live' ? 'Live demo: one second is one day' : 'Real climate record, simulated wells';
  $('#play').textContent = S.playing ? 'Pause' : 'Play';
  document.querySelector('.key').hidden = S.view === 'well';
  for (const b of document.querySelectorAll('#modeSeg button')) b.setAttribute('aria-pressed', b.dataset.mode === S.mode);
  for (const b of document.querySelectorAll('#viewSeg button')) b.setAttribute('aria-pressed', b.dataset.view === S.view);
  for (const b of document.querySelectorAll('#siteSeg button')) b.setAttribute('aria-pressed', b.dataset.site === S.site);
}

function renderTiles() {
  let prev = null;
  $('#tiles').innerHTML = S.wells.map((w) => {
    const s = w.alerts[S.t], first = w.site !== prev; prev = w.site;
    return `<button class="tile${first ? ' site-start' : ''}" data-id="${w.id}" aria-pressed="${w.id === S.sel}">
      <b>${w.id}</b><span class="st ${STATUS[s].key}">${STATUS[s].icon} ${STATUS[s].label}</span>
      <small>${shortDays(fc(w, S.t))}</small></button>`;
  }).join('');
}

function sourcesHTML(w, t, f) {
  const c = climOf(w)[t], s2age = c[9], cloud = S.world.sites[w.site].s2_cloud[t];
  const sOn = w.obs[t] != null, r = w.st.lastR[t], rAge = r >= 0 ? t - r : null;
  const sensor = sOn ? `Reading ${w.obs[t].toFixed(2)} m` : (w.st.lastS[t] < 0 ? 'None fitted here' : `Offline for ${t - w.st.lastS[t]} days`);
  const rope = r < 0 ? 'No reports yet' : `${M.BAND_NAME[w.rope[r]]}, ${rAge === 0 ? 'today' : rAge + ' days ago'}`;
  const sat = s2age <= 5 ? `Clear image ${Math.round(s2age)} days ago` : `${cloud > 0.3 ? 'Cloudy today. ' : ''}Last clear image ${Math.round(s2age)} days ago, using 16-day composite`;
  return `<div class="sources">
    <div class="src ${f.mode === 'A' ? 'on' : ''} ${sOn ? '' : 'down'}"><b>Level sensor</b>${sensor}</div>
    <div class="src ${f.mode === 'B' ? 'on' : ''}"><b>Painted rope texts</b>${rope}</div>
    <div class="src ${f.mode === 'C' ? 'on' : ''}"><b>Satellite and rain</b>${sat}</div></div>`;
}

function chartSVG(w, t, f) {
  const W = 530, H = 160, m = { l: 40, r: 12, t: 8, b: 20 }, x0 = -56, x1 = 42;
  const X = (d) => m.l + (d - x0) / (x1 - x0) * (W - m.l - m.r);
  let ymax = 1.6;
  for (let d = x0; d <= 0; d++) { const v = t + d >= 0 ? w.obs[t + d] : null; if (v != null) ymax = Math.max(ymax, v); }
  ymax = Math.max(ymax, f.base, ...f.q.map((q) => q[2]));
  const showActual = S.reveal && S.mode === 'replay';
  if (showActual) for (let d = 0; d <= 42 && t + d < S.N; d++) ymax = Math.max(ymax, w.level[t + d]);
  ymax = Math.min(w.hmax, ymax * 1.15);
  const Y = (v) => H - m.b - clamp(v, 0, ymax) / ymax * (H - m.t - m.b);
  chartCtx = { w, t, f, X0: m.l, X1: W - m.r, x0, x1, W };
  const p = [];
  const step = ymax > 6 ? 2 : ymax > 3 ? 1 : 0.5;
  for (let v = 0; v <= ymax; v += step) p.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#E3E9E8"/><text x="${m.l - 12}" y="${Y(v) + 3.5}" text-anchor="end">${v}</text>`);
  const edges = [0, ...M.BAND_EDGES, 1], rc = ['#B3261E', '#D9601A', '#E2A800', '#2F8F5B'];
  for (let i = 0; i < 4; i++) {
    const a = edges[i] * w.hmax, b = Math.min(edges[i + 1] * w.hmax, ymax);
    if (a < ymax) p.push(`<rect x="${m.l - 8}" width="5" y="${Y(b)}" height="${Math.max(0, Y(a) - Y(b) - 1)}" fill="${rc[i]}" rx="1"/>`);
  }
  p.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${Y(M.H_FAIL)}" y2="${Y(M.H_FAIL)}" stroke="#B3261E" stroke-dasharray="4 3"/>
    <text x="${m.l + 4}" y="${Y(M.H_FAIL) - 4}" fill="#B3261E" style="fill:#B3261E">too low to draw</text>`);
  p.push(`<line x1="${X(0)}" x2="${X(0)}" y1="${m.t}" y2="${H - m.b}" stroke="#7C8E98"/>`);
  const fan = [[0, f.base], ...M.HORIZONS.map((h, i) => [h, f.q[i][2]]), ...M.HORIZONS.map((h, i) => [h, f.q[i][0]]).reverse()];
  p.push(`<polygon points="${fan.map(([d, v]) => `${X(d)},${Y(v)}`).join(' ')}" fill="#1E7B9A" opacity=".22"/>`);
  p.push(`<polyline points="${[[0, f.base], ...M.HORIZONS.map((h, i) => [h, f.q[i][1]])].map(([d, v]) => `${X(d)},${Y(v)}`).join(' ')}" fill="none" stroke="#1E7B9A" stroke-width="2"/>`);
  M.HORIZONS.forEach((h, i) => p.push(`<circle cx="${X(h)}" cy="${Y(f.q[i][1])}" r="3" fill="#1E7B9A" stroke="#FBFCFB" stroke-width="1.5"/>`));
  p.push(`<rect x="${W - m.r - 150}" y="${m.t + 1}" width="10" height="8" fill="#1E7B9A" opacity=".3"/><text x="${W - m.r}" y="${m.t + 9}" text-anchor="end">8 in 10 outcomes land here</text>`);
  let seg = [];
  const flush = () => { if (seg.length > 1) p.push(`<polyline points="${seg.join(' ')}" fill="none" stroke="#0F2A3A" stroke-width="2"/>`); seg = []; };
  for (let d = x0; d <= 0; d++) {
    const i = t + d, v = i >= 0 ? w.obs[i] : null;
    if (v != null) seg.push(`${X(d)},${Y(v)}`);
    else { flush(); if (i >= 0 && w.rope[i] >= 0) p.push(`<rect x="${X(d) - 2.5}" y="${Y(M.BAND_MID[w.rope[i]] * w.hmax) - 2.5}" width="5" height="5" fill="${rc[w.rope[i]]}" stroke="#FBFCFB" stroke-width=".8"/>`); }
  }
  flush();
  if (showActual) {
    const pts = [];
    for (let d = 0; d <= 42 && t + d < S.N; d++) pts.push(`${X(d)},${Y(w.level[t + d])}`);
    p.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#0F2A3A" stroke-width="1.5" stroke-dasharray="2 3"/>`);
  }
  for (const [d, l] of [[-56, '8 weeks ago'], [-28, '4 weeks ago'], [0, 'today'], [14, '+2 weeks'], [28, '+4 weeks'], [42, '+6']]) {
    p.push(`<text x="${X(d)}" y="${H - 5}" text-anchor="${d === -56 ? 'start' : d === 42 ? 'end' : 'middle'}">${l}</text>`);
  }
  return `<svg class="chart" id="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Water level in metres: past eight weeks and forecast for six weeks">${p.join('')}</svg>`;
}

function actionText(w, t, f) {
  const s = w.alerts[t], plan = planAt(w.site, t);
  const move = plan.moves.find((m) => m.from === w.id), truck = plan.trucks.find((k) => k.to === w.id);
  const taking = plan.moves.filter((m) => m.to === w.id);
  if (move) { const d = S.byId[move.to]; return `Move ${move.herds} herds to ${d.id} ${d.name}: ${move.km} km, ${move.walkDays} days' walk.${truck ? ` Trucks for the other ${truck.herds} herds.` : ''}`; }
  if (truck) return `No neighbour can take these herds without being drained. Request ${truck.litresPerDay.toLocaleString('en-GB')} litres a day by truck.`;
  if (s === 1) return 'Start rationing now: a third less water per animal. Herders are asked to text the rope colour every day.';
  if (taking.length) return `Has water to spare: can take ${taking.map((m) => `${m.herds} herds from ${m.from}`).join(' and ')} without being pushed into a warning.`;
  return s === 0 ? 'No action needed.' : 'Herds have already left. Waiting for the water to recover.';
}

function renderWell() {
  const w = selWell(), t = S.t, f = fc(w, t), s = w.alerts[t], d = daysText(f);
  const unsure = f.mode === 'B' ? 'Less certain: sensor is down, using herders\' rope reports' : f.mode === 'C' ? 'Least certain: no ground reading, satellite and rain only. Herders asked for a rope reading' : '';
  $('#wellCard').innerHTML = `
    <div class="well-head"><h2>${w.id} ${w.name}</h2><small>${SITE[w.site]}, ${KIND[w.kind]}</small>${chip(s)}</div>
    ${sourcesHTML(w, t, f)}
    ${chartSVG(w, t, f)}
    <div class="verdict"><div class="big">${d.big}</div>
      <p>${d.range}</p>
      <p><b>${Math.round(f.p28 * 100)}%</b> chance it runs dry within 4 weeks${unsure ? `. <b>${unsure}</b>` : ''}</p></div>
    <p class="action">${actionText(w, t, f)}</p>
    ${S.mode === 'replay' ? `<label class="reveal"><input type="checkbox" id="reveal" ${S.reveal ? 'checked' : ''}> Show what actually happened next (dotted line)</label>` : ''}`;
}

function renderPhone() {
  const w = selWell(), msgs = messagesFor(w, S.t);
  const last = msgs.filter((m) => m.kind === 'act' || m.kind === 'watch').pop();
  const bubbles = msgs.map((m) => {
    const text = smsText(w, m.d, m.kind, S.lang), rep = S.replies[`${w.id}|${m.d}`];
    return `<div class="sms">${text}<small>${fmt(m.d, { day: 'numeric', month: 'short' })}, ${text.length} characters${text.length > 160 ? ' (2 SMS)' : ''}</small></div>
      ${rep ? `<div class="sms out">${rep}</div>` : ''}`;
  }).join('');
  const sent = (S.live?.sentRope ?? []).filter((r) => r.id === w.id).slice(-2).map((r) => `<div class="sms out">${r.text}</div>`).join('');
  const reps = Object.entries(S.replies).filter(([k]) => k.startsWith(w.id + '|'));
  const canRope = S.mode === 'live' && w.id === LIVE_WELL;
  return `<div class="phone-wrap">
    <div class="phone"><div class="screen" id="screen">${bubbles || sent ? bubbles + sent : `<p class="empty">No warnings for ${w.id} in the last 5 months</p>`}</div></div>
    <div class="phone-side">
      <div><h3>Language</h3><div class="seg" id="langSeg">${[['en', 'English'], ['sw', 'Kiswahili'], ['so', 'Soomaali']].map(([k, l]) => `<button data-lang="${k}" aria-pressed="${S.lang === k}">${l}</button>`).join('')}</div></div>
      <div><h3>Herder replies to the warning</h3><div class="row">
        <button data-reply="1" ${last ? '' : 'disabled'}>1 It is right</button><button data-reply="2" ${last ? '' : 'disabled'}>2 It is wrong</button></div>
        <p class="hint">${reps.length ? `${reps.filter(([, v]) => v === '1').length} confirmed, ${reps.filter(([, v]) => v === '2').length} disputed for ${w.id}. Disputed warnings go to a person for review.` : 'Replies tell us which warnings were right.'}</p></div>
      <div><h3>Herder texts the rope colour at the waterline</h3><div class="row">
        ${[3, 2, 1, 0].map((b) => `<button class="rope-btn" data-b="${b}" ${canRope ? '' : 'disabled'}>${w.id} ${M.BAND_CODE[b]}</button>`).join('')}</div>
        <p class="hint">${canRope ? 'Counts as a level reading when the sensor is down.' : `Try this in the live demo on ${LIVE_WELL}.`}</p></div>
      <div><button id="sendReal" ${last ? '' : 'disabled'}>Send latest warning to a real phone</button>
        <p class="hint">${S.smsStatus || (S.pitop.smsReady ? 'SMS gateway connected.' : 'Works when the SMS gateway is set up (see README).')}</p></div>
    </div></div>`;
}

function renderAid() {
  const t = S.t, rows = S.wells.map((w) => ({ w, f: fc(w, t), s: w.alerts[t] }))
    .sort((a, b) => (b.s - a.s) || ((a.f.days[1] ?? 99) - (b.f.days[1] ?? 99)));
  let litres = 0, n = 0;
  for (const site of Object.keys(SITE)) for (const k of planAt(site, t).trucks) { litres += k.litresPerDay; n++; }
  return `<p class="hint" style="margin-bottom:8px">${n ? `<b>${n} wells need trucks today: ${litres.toLocaleString('en-GB')} litres a day in total.</b> Send to the top of the list first.` : 'No trucks needed today. Wells are ranked by urgency.'}</p>
    <table><thead><tr><th>Well</th><th>Status</th><th class="num">Herds</th><th>What to do</th></tr></thead><tbody>
    ${rows.map(({ w, f, s }) => `<tr class="${w.id === S.sel ? 'sel' : ''}"><td><b>${w.id}</b><br>${SITE[w.site]}</td>
      <td><span class="st ${STATUS[s].key}">${STATUS[s].icon} ${STATUS[s].label}</span><br>${shortDays(f)}</td>
      <td class="num">${Math.round(w.st.h7[t])}</td><td>${actionText(w, t, f)}</td></tr>`).join('')}</tbody></table>`;
}

function renderTrust() {
  const ev = S.ev, c = ev.curve.reduce((a, b) => (Math.abs(b.p - S.p) < Math.abs(a.p - S.p) ? b : a));
  const W = 500, H = 120, m = { l: 30, r: 96, t: 8, b: 20 };
  const X = (p) => m.l + (p - 0.1) / 0.8 * (W - m.l - m.r), ymax = Math.max(...ev.curve.map((k) => Math.max(k.missed, k.false_alarms)));
  const Y = (v) => H - m.b - v / ymax * (H - m.t - m.b);
  const line = (key, col) => `<polyline points="${ev.curve.map((k) => `${X(k.p)},${Y(k[key])}`).join(' ')}" fill="none" stroke="${col}" stroke-width="2"/>`;
  const end = ev.curve[ev.curve.length - 1], first = ev.curve[0];
  const names = { A: 'Level sensor', B: 'Rope texts only', C: 'Satellite only' };
  return `<label for="pSlider"><b>How sure must we be before telling a herder to move?</b></label>
    <input type="range" id="pSlider" min="0.1" max="0.9" step="0.05" value="${S.p}">
    <div class="range-ends"><span>Warn early: more false alarms</span><span>${Math.round(S.p * 100)}% sure</span><span>Wait to be sure: more misses</span></div>
    <div class="trust-top">
      <div class="stat"><b>${c.caught_any} of ${c.failures}</b><span>failures warned before they happened</span></div>
      <div class="stat"><b>${c.watch_or_act_21d}</b><span>of those with 3 or more weeks' notice</span></div>
      <div class="stat"><b>${c.false_alarms}</b><span>false alarms in ${ev.test_wells * 5} well-years</span></div></div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:120px" role="img" aria-label="Missed failures and false alarms at each setting">
      ${[0, Math.round(ymax / 2), ymax].map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#E3E9E8"/><text x="${m.l - 5}" y="${Y(v) + 3.5}" text-anchor="end" font-size="10.5" fill="#4A6170">${v}</text>`).join('')}
      ${line('false_alarms', '#1E7B9A')}${line('missed', '#0F2A3A')}
      <line x1="${X(c.p)}" x2="${X(c.p)}" y1="${m.t}" y2="${H - m.b}" stroke="#7C8E98" stroke-dasharray="3 3"/>
      <circle cx="${X(c.p)}" cy="${Y(c.false_alarms)}" r="4" fill="#1E7B9A" stroke="#fff" stroke-width="2"/><circle cx="${X(c.p)}" cy="${Y(c.missed)}" r="4" fill="#0F2A3A" stroke="#fff" stroke-width="2"/>
      <text x="${X(first.p) + 6}" y="${Y(first.false_alarms) + 4}" font-size="11" fill="#0F2A3A">False alarms</text>
      <text x="${X(end.p) + 6}" y="${Y(end.missed) + 4}" font-size="11" fill="#0F2A3A">Missed failures</text>
      <text x="${X(0.1)}" y="${H - 5}" font-size="10.5" fill="#4A6170">10% sure</text><text x="${X(0.9)}" y="${H - 5}" font-size="10.5" fill="#4A6170" text-anchor="end">90% sure</text></svg>
    <p class="hint">Replay test on ${ev.test_wells} simulated wells the model never saw, driven by the real 2019 to 2023 climate record.
      A straight-line rule of thumb catches as many but raises <b>${ev.naive_baseline.false_alarms} false alarms</b>. The default (${Math.round(ev.p_default * 100)}%) is the setting with fewest false alarms that still misses under 3% of failures.</p>
    <table style="margin-top:8px"><thead><tr><th>Data available</th><th class="num">Range width, 4 weeks out</th><th class="num">Failures warned</th><th class="num">2+ weeks' notice</th></tr></thead><tbody>
    ${'ABC'.split('').map((k) => `<tr><td>${names[k]}</td><td class="num">${ev.by_mode[k]['28'].mean_width_m.toFixed(1)} m</td><td class="num">${ev.replay[k].caught_any} of ${ev.replay[k].failures}</td><td class="num">${ev.replay[k].caught_14d}</td></tr>`).join('')}</tbody></table>
    <p class="hint">The stated range is honest in every mode: about 8 in 10 real outcomes land inside it. With less data the range widens and the message says so.</p>`;
}

function renderTab() {
  for (const b of document.querySelectorAll('#tablist button')) b.setAttribute('aria-selected', b.dataset.tab === S.tab);
  const keep = $('#tabPanel').scrollTop;
  $('#tabPanel').innerHTML = S.tab === 'phone' ? renderPhone() : S.tab === 'aid' ? renderAid() : renderTrust();
  if (S.tab === 'phone') {
    const sc = $('#screen'); sc.scrollTop = sc.scrollHeight;
    if (S.buzz) { S.buzz = false; document.querySelector('.phone').classList.add('buzz'); }
  } else $('#tabPanel').scrollTop = keep;
}

let tlKey = '';
function renderTimeline() {
  const w = selWell(), N = S.N, upto = S.mode === 'live' && w.id === LIVE_WELL ? S.t : N - 1;
  const key = `${S.site}|${w.id}|${S.p}|${S.mode === 'live' ? S.t : S.ver}`;
  const X = (t) => t / (N - 1) * 1000;
  if (key !== tlKey) {
    tlKey = key;
    const rain = S.world.sites[S.site].rain, months = [];
    for (let t = 0; t < N; t++) {
      const d = dateOf(t), k = d.getUTCFullYear() * 12 + d.getUTCMonth();
      const mo = months[months.length - 1];
      if (mo && mo.k === k) { mo.sum += rain[t]; mo.b = t; } else months.push({ k, a: t, b: t, sum: rain[t] });
    }
    const mx = Math.max(...months.map((mo) => mo.sum)), p = [];
    for (const mo of months) { const h = mo.sum / mx * 42; p.push(`<rect x="${X(mo.a) + 0.8}" width="${X(mo.b + 1) - X(mo.a) - 1.6}" y="${48 - h}" height="${h}" fill="#9CC7D6"/>`); }
    const col = [null, '#E2A800', '#D9601A', '#B3261E'];
    let a = 0;
    for (let t = 1; t <= upto + 1; t++) {
      if (t > upto || w.alerts[t] !== w.alerts[a]) { if (w.alerts[a]) p.push(`<rect x="${X(a)}" width="${Math.max(1, X(t) - X(a))}" y="52" height="8" fill="${col[w.alerts[a]]}"/>`); a = t; }
    }
    for (let y = 2020; y <= 2023; y++) { const t = (Date.UTC(y, 0, 1) - DAY0) / 864e5; p.push(`<line x1="${X(t)}" x2="${X(t)}" y1="0" y2="64" stroke="#D3DBDA"/>`); }
    p.push('<g id="cursor"><line y1="0" y2="64" stroke="#0F2A3A" stroke-width="2" vector-effect="non-scaling-stroke"/></g>');
    $('#timeline').innerHTML = p.join('');
    $('#tlLabels').innerHTML = [2019, 2020, 2021, 2022, 2023].map((y) => `<span style="flex:1">${y}</span>`).join('') +
      `<span style="flex-basis:100%">Bars show rain each month at ${SITE[S.site]}. The coloured strip shows when ${w.id} was on Watch, Act or Dry. Drag to move through time.</span>`;
  }
  $('#cursor').setAttribute('transform', `translate(${X(S.t)},0)`);
  $('#timeline').setAttribute('aria-valuetext', fmt(S.t));
}

function renderLivePanel() {
  const on = S.mode === 'live';
  $('#livePanel').hidden = !on;
  document.querySelector('.stage').classList.toggle('live', on);
  if (!on) return;
  const P = S.pitop, L = S.live, online = liveOnline(), w = S.byId[LIVE_WELL], sim = !P.fresh && !L.usedPitop;
  const lvl = `${L.level.toFixed(2)} m in ${w.id}`;
  $('#stDot').className = `dot ${online ? 'on' : 'off'}`;
  $('#liveStatus').textContent = P.fresh ? (P.ok ? 'pi-top field station: live' : 'pi-top sensor unplugged') : L.usedPitop ? 'pi-top stopped reporting' : online ? 'Simulated sensor' : 'Sensor unplugged';
  $('#liveSub').textContent = P.fresh && P.ok ? `${P.cm.toFixed(1)} cm to the water, container ${Math.round(P.frac * 100)}% full, ${lvl}`
    : online ? `${lvl}. No pi-top connected` : 'Forecast is running on rope texts and satellite';
  const h = S.hist, n = h.length, pts = [];
  let d = '';
  h.forEach((v, i) => { if (v == null) { if (pts.length) d += `<polyline points="${pts.join(' ')}" fill="none" stroke="#1E7B9A" stroke-width="2"/>`; pts.length = 0; } else pts.push(`${(i / Math.max(1, 239) * 180).toFixed(1)},${(33 - v * 30).toFixed(1)}`); });
  if (pts.length) d += `<polyline points="${pts.join(' ')}" fill="none" stroke="#1E7B9A" stroke-width="2"/>`;
  $('#spark').innerHTML = d + (n && h[n - 1] != null ? `<circle cx="${((n - 1) / 239 * 180).toFixed(1)}" cy="${(33 - h[n - 1] * 30).toFixed(1)}" r="3" fill="#1E7B9A"/>` : '');
  $('#drain').hidden = $('#refill').hidden = $('#unplug').hidden = !sim;
  $('#unplug').textContent = L.unplugged ? 'Plug sensor back in' : 'Unplug sensor';
  $('#autoRope').checked = L.auto;
  $('#calRow').hidden = !(P.fresh && P.ok);
  $('#connect').hidden = P.fresh;
  if ($('#connectDlg').open) $('#dlgState').textContent = P.fresh ? 'pi-top connected. You can close this.' : 'Waiting for the pi-top to report...';
}

function renderStage() {
  if (!stage.ok) return;
  const t = S.t, plan = planAt(S.site, t), live = S.mode === 'live';
  stage.setView(S.view);
  stage.setRegion({ key: S.site, town: `${SITE[S.site]} town`, moves: plan.moves, trucks: plan.trucks,
    wells: S.wells.filter((w) => w.site === S.site).map((w) => ({ id: w.id, x: w.x, y: w.y, status: w.alerts[t], herds: w.st.h7[t], selected: w.id === S.sel,
      frac: clamp((live && w.id === LIVE_WELL ? S.live.level : w.base[t]) / w.hmax, 0, 1), label: `${w.id} ${STATUS[w.alerts[t]].label}` })) });
  const w = selWell(), f = fc(w, t), isLive = live && w.id === LIVE_WELL;
  const online = isLive ? liveOnline() : w.obs[t] != null;
  stage.setWell({ hmax: w.hmax, fail: M.H_FAIL, bandEdges: M.BAND_EDGES, estimate: f.base, q28: f.q[3], sensorOnline: online,
    level: online ? (isLive ? S.live.level : w.obs[t]) : null, sensorText: isLive && S.pitop.fresh ? 'pi-top ultrasonic sensor' : 'Level sensor',
    twin: isLive ? { frac: clamp(S.live.level / w.hmax, 0, 1), online, text: S.pitop.fresh ? 'Container on your table' : 'Simulated container' } : null });
}

function render() { renderHeader(); renderTiles(); renderWell(); renderTab(); renderTimeline(); renderLivePanel(); renderStage(); }

// ---------- time ----------
function step() {
  if (S.t >= S.N - 1) { S.playing = false; return; }
  S.t++;
  if (S.mode === 'live') liveTick(S.t);
}
let acc = 0, lastTs = 0;
function loop(ts) {
  const dt = Math.min(0.25, (ts - lastTs) / 1000); lastTs = ts;
  if (S.playing) {
    acc += dt * S.speed;
    let moved = false;
    while (acc >= 1 && S.playing) { acc -= 1; step(); moved = true; }
    if (moved) render();
  }
  requestAnimationFrame(loop);
}

function setSpeedOptions() {
  $('#speed').innerHTML = SPEEDS[S.mode].map(([v, l]) => `<option value="${v}" ${v === S.speed ? 'selected' : ''}>${l}</option>`).join('');
}
function select(id) { S.sel = id; S.site = S.byId[id].site; render(); }

function wire() {
  $('#siteSeg').innerHTML = Object.entries(SITE).map(([k, l]) => `<button data-site="${k}">${l}</button>`).join('');
  $('#modeSeg').onclick = (e) => {
    const m = e.target.dataset.mode;
    if (!m || m === S.mode) return;
    if (m === 'live') enterLive(); else exitLive();
    setSpeedOptions(); render();
  };
  $('#play').onclick = () => { S.playing = !S.playing; renderHeader(); };
  $('#speed').onchange = (e) => { S.speed = +e.target.value; };
  $('#siteSeg').onclick = (e) => { const s = e.target.dataset.site; if (s) select(S.wells.find((w) => w.site === s).id); };
  $('#viewSeg').onclick = (e) => { if (e.target.dataset.view) { S.view = e.target.dataset.view; renderHeader(); renderStage(); } };
  $('#tiles').onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) select(b.dataset.id); };
  $('#tablist').onclick = (e) => { if (e.target.dataset.tab) { S.tab = e.target.dataset.tab; renderTab(); } };
  $('#wellCard').onchange = (e) => { if (e.target.id === 'reveal') { S.reveal = e.target.checked; renderWell(); } };
  $('#tabPanel').oninput = (e) => {
    if (e.target.id !== 'pSlider') return;
    S.p = +e.target.value; S.ver++;
    for (const w of S.wells) w.alerts = M.alertLevels(w.p28, w.p42, w.base, S.p);
    render();
    $('#pSlider').focus();
  };
  $('#tabPanel').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const w = selWell();
    if (b.dataset.lang) { S.lang = b.dataset.lang; renderTab(); }
    else if (b.dataset.reply) {
      const last = messagesFor(w, S.t).filter((m) => m.kind === 'act' || m.kind === 'watch').pop();
      if (last) { S.replies[`${w.id}|${last.d}`] = b.dataset.reply; renderTab(); }
    } else if (b.dataset.b && S.live) {
      S.live.pending = +b.dataset.b;
      (S.live.sentRope ??= []).push({ id: w.id, text: `${w.id} ${M.BAND_CODE[+b.dataset.b]}` });
      renderTab();
    } else if (b.id === 'sendReal') {
      const last = messagesFor(w, S.t).filter((m) => m.kind === 'act' || m.kind === 'watch').pop();
      if (last) { S.smsStatus = 'Sending'; sendReal(smsText(w, last.d, last.kind, S.lang)); }
    }
  };
  $('#drain').onclick = () => { S.live.level = Math.max(0, S.live.level - 0.4); renderStage(); };
  $('#refill').onclick = () => { S.live.level = Math.min(selWell().hmax, S.live.level + 1.5); renderStage(); };
  $('#unplug').onclick = () => { S.live.unplugged = !S.live.unplugged; renderLivePanel(); renderStage(); };
  $('#autoRope').onchange = (e) => { S.live.auto = e.target.checked; };
  const cal = (k) => () => fetch('/api/calibrate', { method: 'POST', body: JSON.stringify({ [k]: S.pitop.cm }) });
  $('#calFull').onclick = cal('full_cm'); $('#calEmpty').onclick = cal('empty_cm');
  $('#connect').onclick = async () => {
    try { const i = await (await fetch('/api/info')).json(); $('#cmd').textContent = `python3 well_sensor.py ${i.ip}${i.port === 8000 ? '' : ' D3 ' + i.port}`; } catch { /* keep placeholder */ }
    $('#connectDlg').showModal();
  };
  $('#copyCmd').onclick = () => navigator.clipboard?.writeText($('#cmd').textContent);

  const tl = $('#timeline');
  const seek = (e) => {
    if (S.mode === 'live') return;
    const r = tl.getBoundingClientRect();
    S.t = clamp(Math.round((e.clientX - r.left) / r.width * (S.N - 1)), 60, S.N - 1);
    render();
  };
  tl.onpointerdown = (e) => { tl.setPointerCapture(e.pointerId); seek(e); };
  tl.onpointermove = (e) => { if (e.buttons) seek(e); };
  tl.onkeydown = (e) => {
    if (S.mode === 'live' || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    S.t = clamp(S.t + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 30 : 1), 60, S.N - 1); render();
  };

  const tip = $('#tip');
  $('#wellCard').onmousemove = (e) => {
    const svg = e.target.closest('#chart');
    if (!svg || !chartCtx) { tip.hidden = true; return; }
    const r = svg.getBoundingClientRect(), c = chartCtx, px = (e.clientX - r.left) / r.width * c.W;
    const d = Math.round(c.x0 + (px - c.X0) / (c.X1 - c.X0) * (c.x1 - c.x0));
    if (d < c.x0 || d > c.x1) { tip.hidden = true; return; }
    let text;
    if (d <= 0) {
      const i = c.t + d, v = i >= 0 ? c.w.obs[i] : null;
      text = `${fmt(i, { day: 'numeric', month: 'short' })}: ` + (v != null ? `sensor read ${v.toFixed(2)} m` : c.w.rope[i] >= 0 ? `herder texted ${M.BAND_NAME[c.w.rope[i]]}` : 'no reading');
    } else {
      const k = M.HORIZONS.reduce((b, h, i) => (Math.abs(h - d) < Math.abs(M.HORIZONS[b] - d) ? i : b), 0), q = c.f.q[k];
      text = `In ${M.HORIZONS[k]} days: likely ${q[1].toFixed(1)} m (8 in 10 chance between ${q[0].toFixed(1)} and ${q[2].toFixed(1)} m)`;
    }
    tip.textContent = text; tip.hidden = false;
    tip.style.left = `${Math.min(window.innerWidth - 250, e.clientX + 12)}px`; tip.style.top = `${e.clientY + 14}px`;
  };
  $('#wellCard').onmouseleave = () => { tip.hidden = true; };
}

async function boot() {
  const [model, world, ev] = await Promise.all(['model', 'world', 'eval'].map((n) => fetch(`data/${n}.json`).then((r) => r.json())));
  M.setModel(model);
  Object.assign(S, { world, ev, N: world.days, p: ev.p_default, wells: world.wells });
  S.byId = Object.fromEntries(S.wells.map((w) => [w.id, w]));
  for (const w of S.wells) computeWell(w);
  stage = createStage($('#gl'));
  if (!stage.ok) { $('#gl').hidden = true; $('#glFallback').hidden = false; }
  else stage.onPick((id) => select(id));
  wire(); setSpeedOptions(); render();
  window.__app = S;                           // handy for rehearsing from the console
  setInterval(pollPitop, 250);
  requestAnimationFrame(loop);
}
boot().catch((e) => { document.body.insertAdjacentHTML('beforeend', `<p style="padding:20px">Could not load: ${e.message}. Start it with <code>python3 server.py</code> and open http://localhost:8000</p>`); });
