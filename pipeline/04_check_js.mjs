// Checks that the browser engine (web/model.js) reproduces the Python replay numbers.
// Run: node pipeline/04_check_js.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as M from '../web/model.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const load = (p) => JSON.parse(readFileSync(root + p, 'utf8'));
const model = load('web/data/model.json'), world = load('web/data/world.json');
const evalj = load('web/data/eval.json'), check = load('data/processed/js_check.json');
M.setModel(model);

let worst = 0, n = 0, alertMismatch = 0, alertDays = 0;
for (const well of world.wells) {
  const st = M.wellState(well), clim = world.sites[well.site].features;
  const N = world.days, p28 = new Float64Array(N), p42 = new Float64Array(N), base = new Float64Array(N);
  for (let t = 0; t < N; t++) { const f = M.forecast(well, st, t, clim[t]); p28[t] = f.p28; p42[t] = f.p42; base[t] = f.base; }
  for (const c of check.filter((c) => c.well === well.id)) {
    if (c.alerts) {
      const a = M.alertLevels(p28, p42, base, evalj.p_default);
      c.alerts.forEach((v, t) => { alertDays++; if (v !== a[t]) alertMismatch++; });
      continue;
    }
    const f = M.forecast(well, st, c.t, clim[c.t]);
    if (f.mode !== c.mode) throw new Error(`mode mismatch ${well.id} t=${c.t}: ${f.mode} vs ${c.mode}`);
    f.q.forEach((qq, i) => qq.forEach((v, k) => { worst = Math.max(worst, Math.abs(v - c.q[i][k])); }));
    worst = Math.max(worst, Math.abs(f.p28 - c.p28), Math.abs(f.p42 - c.p42));
    n++;
  }
}
console.log(`forecasts compared: ${n}, worst difference: ${worst.toExponential(2)}`);
console.log(`alert days compared: ${alertDays}, mismatches: ${alertMismatch}`);
if (worst > 1e-3 || alertMismatch > alertDays * 0.002) { console.error('FAIL'); process.exit(1); }
console.log('OK: browser engine matches the Python replay');
