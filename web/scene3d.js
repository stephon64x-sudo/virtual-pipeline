// 3D stage: a region view (wells as water columns, herd moves as arcs) and a cutaway of one well.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

export const STATUS_COLOR = ['#2F8F5B', '#E2A800', '#D9601A', '#B3261E'];
const ROPE_COLOR = ['#B3261E', '#D9601A', '#E2A800', '#2F8F5B'];
const INK = '#0F2A3A', WATER = '#1E7B9A', FONT = '600 44px "Avenir Next", "Segoe UI", system-ui, sans-serif';
const COL_H = 9;

function makeLabel(scale = 1) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(8 * scale, 2 * scale, 1);
  sp.renderOrder = 10;
  let last = '';
  sp.setText = (text, fg = INK, bg = 'rgba(255,255,255,.94)') => {
    const key = text + fg + bg;
    if (key === last) return;
    last = key;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 512, 128);
    g.font = FONT;
    const w = Math.min(504, g.measureText(text).width + 48), x = (512 - w) / 2;
    g.fillStyle = bg;
    g.beginPath(); g.roundRect(x, 22, w, 84, 16); g.fill();
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 256, 66, 470);
    tex.needsUpdate = true;
  };
  return sp;
}

const ground = (x, z) => 1.1 * Math.sin(x * 0.09 + 1.3) * Math.cos(z * 0.07) + 0.5 * Math.sin(x * 0.23 + z * 0.17);
const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...extra });

export function createStage(canvas) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch (e) {
    return { ok: false };
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const sky = new THREE.Color('#DDE8EA');

  // ---------- region scene ----------
  const region = new THREE.Scene();
  region.background = sky;
  region.fog = new THREE.Fog(sky, 70, 150);
  region.add(new THREE.HemisphereLight('#ffffff', '#b89b6a', 1.5));
  const sun = new THREE.DirectionalLight('#fff4dd', 2.0);
  sun.position.set(30, 50, 20);
  region.add(sun);
  const terrain = new THREE.PlaneGeometry(170, 170, 90, 90);
  terrain.rotateX(-Math.PI / 2);
  const pos = terrain.attributes.position, cols = [];
  const cA = new THREE.Color('#DCC08E'), cB = new THREE.Color('#C3A06B');
  for (let i = 0; i < pos.count; i++) {
    const y = ground(pos.getX(i), pos.getZ(i));
    pos.setY(i, y);
    const c = cA.clone().lerp(cB, THREE.MathUtils.clamp(0.5 - y / 3, 0, 1));
    cols.push(c.r, c.g, c.b);
  }
  terrain.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  terrain.computeVertexNormals();
  region.add(new THREE.Mesh(terrain, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true })));
  const camR = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
  camR.position.set(4, 34, 52);
  const ctlR = new OrbitControls(camR, canvas);
  ctlR.target.set(0, 3, 0);
  ctlR.maxPolarAngle = Math.PI / 2.15; ctlR.minDistance = 25; ctlR.maxDistance = 95; ctlR.enablePan = false;
  ctlR.update();

  const wellGroup = new THREE.Group(), flowGroup = new THREE.Group();
  region.add(wellGroup, flowGroup);
  const town = new THREE.Group();
  town.add(new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.2, 1.6), std('#F2EEE6')), new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 1.2), std('#E4DDD0')));
  town.children[1].position.set(1.9, -0.15, 0.6);
  town.position.set(0, ground(0, 0) + 0.6, 0);
  const townLabel = makeLabel(0.8);
  townLabel.position.set(0, 2.6, 0);
  town.add(townLabel);
  region.add(town);

  let regionKey = '', wellObjs = new Map(), pickables = [], flowKey = '', runners = [];
  const tubeGeo = new THREE.CylinderGeometry(1.3, 1.3, COL_H, 28, 1, true);
  const waterGeo = new THREE.CylinderGeometry(1.15, 1.15, 1, 28);
  const dotGeo = new THREE.SphereGeometry(0.3, 8, 6);
  const dotMat = std('#4B3A2A');

  function buildWells(wells) {
    wellGroup.clear();
    wellObjs = new Map(); pickables = [];
    for (const w of wells) {
      const g = new THREE.Group();
      const x = w.x, z = -w.y;
      g.position.set(x, ground(x, z), z);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.3, 12, 40), std(STATUS_COLOR[0]));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.25;
      const tube = new THREE.Mesh(tubeGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
      tube.position.y = COL_H / 2;
      const water = new THREE.Mesh(waterGeo, std(WATER, { roughness: 0.35 }));
      const sel = new THREE.Mesh(new THREE.RingGeometry(2.9, 3.3, 48), new THREE.MeshBasicMaterial({ color: INK, side: THREE.DoubleSide }));
      sel.rotation.x = -Math.PI / 2; sel.position.y = 0.12;
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, COL_H + 3, 12), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.y = COL_H / 2; hit.userData.id = w.id;
      const herd = new THREE.InstancedMesh(dotGeo, dotMat, 70);
      const m4 = new THREE.Matrix4();
      for (let i = 0; i < 70; i++) {
        const r = 3.8 + 0.34 * Math.sqrt(i) * 1.6, a = i * 2.39996;
        const px = Math.cos(a) * r, pz = Math.sin(a) * r;
        m4.setPosition(px, ground(x + px, z + pz) - ground(x, z) + 0.3, pz);
        herd.setMatrixAt(i, m4);
      }
      herd.count = 0;
      const label = makeLabel(0.95);
      label.position.y = COL_H + 2.1;
      g.add(ring, tube, water, sel, hit, herd, label);
      wellGroup.add(g);
      pickables.push(hit);
      wellObjs.set(w.id, { g, ring, water, sel, herd, label });
    }
  }

  function buildFlows(d) {
    flowGroup.clear(); runners = [];
    const at = (id, lift = 0) => { const p = wellObjs.get(id).g.position; return new THREE.Vector3(p.x, p.y + lift, p.z); };
    for (const m of d.moves) {
      const a = at(m.from, 1), b = at(m.to, 1), mid = a.clone().lerp(b, 0.5); mid.y += 11;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      flowGroup.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.2, 8), std(INK)));
      for (let i = 0; i < 5; i++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), std('#4B3A2A'));
        flowGroup.add(s); runners.push({ s, curve, off: i / 5, speed: 0.16 });
      }
      const l = makeLabel(0.9);
      l.setText(`${m.herds} herds walk ${m.km} km`, '#ffffff', INK);
      l.position.copy(curve.getPoint(0.5)); l.position.y += 1.6;
      flowGroup.add(l);
    }
    for (const t of d.trucks) {
      const a = new THREE.Vector3(0, ground(0, 0) + 0.7, 0), b = at(t.to, 0.7);
      const curve = new THREE.LineCurve3(a, b);
      flowGroup.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 2, 0.14, 6), std(WATER)));
      const truck = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.0, 1.0), std(WATER));
      flowGroup.add(truck); runners.push({ s: truck, curve, off: 0, speed: 0.12 });
      const l = makeLabel(0.8);
      l.setText('Water truck', '#ffffff', WATER);
      l.position.copy(curve.getPoint(0.5)); l.position.y += 2;
      flowGroup.add(l);
    }
  }

  // ---------- cutaway scene ----------
  const cut = new THREE.Scene();
  cut.background = sky;
  cut.add(new THREE.HemisphereLight('#ffffff', '#9c8a70', 1.7));
  const sun2 = new THREE.DirectionalLight('#ffffff', 1.6);
  sun2.position.set(8, 12, 20);
  cut.add(sun2);
  const camW = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
  camW.position.set(5.5, -1.2, 39);
  const ctlW = new OrbitControls(camW, canvas);
  ctlW.target.set(4.0, -3.4, 0);
  ctlW.minAzimuthAngle = -0.6; ctlW.maxAzimuthAngle = 0.6; ctlW.minPolarAngle = 1.1; ctlW.maxPolarAngle = 1.9;
  ctlW.minDistance = 18; ctlW.maxDistance = 52; ctlW.enablePan = false; ctlW.enabled = false;
  ctlW.update();

  const BOTTOM = -12, TOP = 0.9, SPAN = 9.5;       // shaft geometry; SPAN = height of a full water column
  const strata = [['Sand', '#DCC08E', 0, -2.2], ['Clay', '#B98F62', -2.2, -5], ['Weathered rock', '#8E7B6B', -5, -8], ['Aquifer rock', '#66777F', -8, -13]];
  for (const [name, color, y0, y1] of strata) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(26, y0 - y1, 5), std(color, { flatShading: true }));
    b.position.set(3, (y0 + y1) / 2, -4.5);
    cut.add(b);
    const l = makeLabel(0.7);
    l.setText(name, '#ffffff', 'rgba(15,42,58,.55)');
    l.position.set(-7.6, (y0 + y1) / 2, 0.2);
    cut.add(l);
  }
  const tableMat = new THREE.MeshBasicMaterial({ color: WATER, transparent: true, opacity: 0.3, depthWrite: false });
  const table = new THREE.Mesh(new THREE.BoxGeometry(26, 1, 5.05), tableMat);
  cut.add(table);

  function shaft(x, ghost) {
    const g = new THREE.Group();
    g.position.x = x;
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.75, TOP - BOTTOM, 36, 1, true, Math.PI / 2, Math.PI),
      new THREE.MeshStandardMaterial({ color: ghost ? '#F3EFE7' : '#EDE6DA', side: THREE.DoubleSide, roughness: 1 }));
    wall.position.y = (TOP + BOTTOM) / 2;
    const water = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 1, 36),
      new THREE.MeshStandardMaterial({ color: WATER, transparent: true, opacity: ghost ? 0.45 : 0.9, roughness: 0.3 }));
    g.add(wall, water);
    cut.add(g);
    return { g, water };
  }
  const now = shaft(0, false), later = shaft(8.2, true);
  const setWater = (mesh, metres, scale) => {
    const h = Math.max(0.02, metres * scale);
    mesh.scale.y = h; mesh.position.y = BOTTOM + h / 2;
  };
  // painted rope
  const ropeGroup = new THREE.Group();
  now.g.add(ropeGroup);
  const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.34, 0.6, 16), std('#4B3A2A'));
  bucket.position.set(0, 0, 1.0);
  now.g.add(bucket);
  // "too low to draw" line on both shafts
  for (const s of [now, later]) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(1.78, 0.07, 8, 48), new THREE.MeshBasicMaterial({ color: STATUS_COLOR[3] }));
    r.rotation.x = Math.PI / 2; r.name = 'fail';
    s.g.add(r);
  }
  // forecast range band on the "in 4 weeks" shaft
  const band = new THREE.Mesh(new THREE.CylinderGeometry(1.66, 1.66, 1, 36, 1, true),
    new THREE.MeshBasicMaterial({ color: '#E2A800', transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
  later.g.add(band);
  // ultrasonic sensor
  const sensorBox = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.4, 1.0), std(INK));
  sensorBox.position.y = TOP + 0.9;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(1.2, 3.2, 28, 1, true),
    new THREE.MeshBasicMaterial({ color: '#7FD3E8', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
  cone.position.y = TOP + 0.9 - 1.8;
  now.g.add(sensorBox, cone);
  const lbl = { sensor: makeLabel(0.8), level: makeLabel(0.95), fail: makeLabel(0.7), later: makeLabel(0.85), head1: makeLabel(0.85), head2: makeLabel(0.85) };
  lbl.sensor.position.set(0, TOP + 2.4, 0);
  lbl.head1.position.set(0, BOTTOM - 1.6, 1); lbl.head1.setText('Today', '#ffffff', INK);
  lbl.head2.position.set(8.2, BOTTOM - 1.6, 1); lbl.head2.setText('In 4 weeks', '#ffffff', INK);
  lbl.fail.position.set(-5.1, 0, 1.2);
  for (const l of Object.values(lbl)) cut.add(l);
  // sonar pulses from the sensor down to the water, and a ripple where they land
  const pulses = [0, 1, 2].map(() => {
    const r = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.05, 8, 40), new THREE.MeshBasicMaterial({ color: '#7FD3E8', transparent: true, opacity: 0.8, depthWrite: false }));
    r.rotation.x = Math.PI / 2;
    now.g.add(r);
    return r;
  });
  const surface = new THREE.Mesh(new THREE.CircleGeometry(1.59, 36), new THREE.MeshBasicMaterial({ color: '#8FD0E2' }));
  surface.rotation.x = -Math.PI / 2;
  const ripple = new THREE.Mesh(new THREE.RingGeometry(0.88, 1.0, 40), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
  ripple.rotation.x = -Math.PI / 2;
  now.g.add(surface, ripple);

  // digital twin of the bottle on the table: container, water, pi-top with its sensor, and a data link to the well
  const twin = new THREE.Group();
  twin.position.set(-8.0, 0, 1.6);
  cut.add(twin);
  // the real container: 29 cm long, 10 cm wide, 17 cm tall
  const JAR_H = 3.0, JAR_L = 5.1, JAR_W = 1.8;
  const jarGeo = new THREE.BoxGeometry(JAR_L, JAR_H, JAR_W);
  const jar = new THREE.Group();
  jar.add(new THREE.Mesh(jarGeo, new THREE.MeshBasicMaterial({ color: '#7FA9B8', transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false })),
    new THREE.LineSegments(new THREE.EdgesGeometry(jarGeo), new THREE.LineBasicMaterial({ color: '#4A6170' })));
  jar.position.y = JAR_H / 2 + 0.05;
  const jarWater = new THREE.Mesh(new THREE.BoxGeometry(JAR_L - 0.14, 1, JAR_W - 0.14), new THREE.MeshStandardMaterial({ color: WATER, transparent: true, opacity: 0.9, roughness: 0.3 }));
  const unit = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.55, 1.5), std('#16242C'));
  unit.position.y = JAR_H + 1.0;
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.57, 0.6), new THREE.MeshBasicMaterial({ color: '#35D07F' }));
  screen.position.set(-0.6, JAR_H + 1.0, 0.5);
  const eyes = [-0.28, 0.28].map((x) => { const e = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.3, 14), std('#C9D3D2')); e.position.set(x, JAR_H + 0.62, 0); return e; });
  const twinLabel = makeLabel(0.72);
  twinLabel.position.set(0, JAR_H + 2.2, 0);
  const jarBase = new THREE.Mesh(new THREE.BoxGeometry(JAR_L + 0.8, 0.12, JAR_W + 0.8), std('#8E7B6B'));
  jarBase.position.y = 0.02;
  twin.add(jar, jarWater, jarBase, unit, screen, ...eyes, twinLabel);
  const link = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-6.6, JAR_H + 1.1, 1.6), new THREE.Vector3(-3.4, 6.2, 0.8), new THREE.Vector3(-1.6, TOP + 1.0, 0.2));
  const linkTube = new THREE.Mesh(new THREE.TubeGeometry(link, 40, 0.045, 6), new THREE.MeshBasicMaterial({ color: WATER }));
  const packets = [0, 1, 2].map(() => new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), new THREE.MeshBasicMaterial({ color: '#35D07F' })));
  cut.add(linkTube, ...packets);

  let ropeKey = '';
  const V = { target: 1, shown: 1, s: 1, hasLevel: true, online: true, twin: null, twinShown: 0.5 };

  function applyLevel() {
    const y = BOTTOM + Math.max(0.02, V.shown * V.s);
    setWater(now.water, V.shown, V.s);
    now.water.visible = surface.visible = V.hasLevel;
    surface.position.y = y + 0.02;
    const t = Math.max(0.02, V.shown * V.s);
    table.scale.y = t; table.position.set(3, BOTTOM + t / 2, -4.5);
    bucket.position.y = y + 0.2;
    lbl.level.position.set(4.1, y, 1.2);
  }

  function setWell(d) {
    const s = SPAN / d.hmax;
    Object.assign(V, { target: d.level ?? d.estimate, s, hasLevel: d.level != null, online: d.sensorOnline, twin: d.twin });
    if (ropeKey !== String(d.hmax)) {
      ropeKey = String(d.hmax);
      V.shown = V.target;
      ropeGroup.clear();
      const edges = [0, ...d.bandEdges, 1];
      for (let i = 0; i < 4; i++) {
        const h = (edges[i + 1] - edges[i]) * SPAN;
        const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, h, 8), std(ROPE_COLOR[i]));
        seg.position.set(0, BOTTOM + edges[i] * SPAN + h / 2, 1.0);
        ropeGroup.add(seg);
      }
      const rest = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, TOP - (BOTTOM + SPAN) + 0.6, 6), std('#B8A27A'));
      rest.position.set(0, (TOP + 0.6 + BOTTOM + SPAN) / 2, 1.0);
      ropeGroup.add(rest);
    }
    for (const sh of [now, later]) sh.g.getObjectByName('fail').position.y = BOTTOM + d.fail * s;
    lbl.fail.position.y = BOTTOM + d.fail * s;
    lbl.fail.setText('Too low to draw', '#ffffff', STATUS_COLOR[3]);
    lbl.level.setText(d.level != null ? `${d.level.toFixed(2)} m` : `about ${d.estimate.toFixed(1)} m`, '#ffffff', d.level != null ? WATER : '#6B7C85');
    cone.visible = d.sensorOnline;
    sensorBox.material.color.set(d.sensorOnline ? INK : '#9AA5AA');
    lbl.sensor.setText(d.sensorOnline ? d.sensorText : 'Sensor offline', '#ffffff', d.sensorOnline ? INK : STATUS_COLOR[3]);
    const [lo, med, hi] = d.q28;
    setWater(later.water, med, s);
    const bh = Math.max(0.05, (hi - lo) * s);
    band.scale.y = bh; band.position.y = BOTTOM + lo * s + bh / 2;
    lbl.later.position.set(8.2 + 4.6, BOTTOM + med * s, 1.2);
    lbl.later.setText(`${lo.toFixed(1)} to ${hi.toFixed(1)} m`, INK, '#F6DE8C');
    twin.visible = linkTube.visible = !!d.twin;
    if (d.twin) {
      twinLabel.setText(d.twin.text, '#ffffff', INK);
      screen.material.color.set(d.twin.online ? '#35D07F' : STATUS_COLOR[3]);
    }
    applyLevel();
  }

  function setRegion(d) {
    if (d.key !== regionKey) { regionKey = d.key; buildWells(d.wells); flowKey = ''; townLabel.setText(d.town, INK); }
    for (const w of d.wells) {
      const o = wellObjs.get(w.id);
      const h = Math.max(0.03, w.frac * COL_H);
      o.water.scale.y = h; o.water.position.y = h / 2;
      o.ring.material.color.set(STATUS_COLOR[w.status]);
      o.sel.visible = w.selected;
      o.herd.count = Math.min(70, Math.round(w.herds));
      o.label.setText(w.label, '#ffffff', STATUS_COLOR[w.status] === '#E2A800' ? '#8A6500' : STATUS_COLOR[w.status]);
    }
    const key = JSON.stringify([d.moves, d.trucks.map((t) => t.to)]);
    if (key !== flowKey) { flowKey = key; buildFlows(d); }
  }

  let view = 'region', pickCb = null;
  function setView(v) { view = v; ctlR.enabled = v === 'region'; ctlW.enabled = v === 'well'; }
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || view !== 'region' || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    const r = canvas.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, camR);
    const hit = ray.intersectObjects(pickables)[0];
    if (hit && pickCb) pickCb(hit.object.userData.id);
  });

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    for (const c of [camR, camW]) { c.aspect = w / h; c.updateProjectionMatrix(); }
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clock = new THREE.Clock();
  (function frame() {
    const t = clock.getElapsedTime();
    if (view === 'region') {
      for (const r of runners) r.s.position.copy(r.curve.getPoint(still ? 0.5 : (t * r.speed + r.off) % 1));
      ctlR.update();
      renderer.render(region, camR);
    } else {
      V.shown += (V.target - V.shown) * (still ? 1 : 0.14);
      applyLevel();
      const surfY = BOTTOM + Math.max(0.02, V.shown * V.s), topY = TOP + 0.6;
      cone.material.opacity = 0.16;
      pulses.forEach((r, i) => {
        const ph = (t * 0.8 + i / 3) % 1;
        r.visible = V.online && !still;
        r.position.y = topY - ph * (topY - surfY);
        r.scale.setScalar(0.45 + ph * 1.05);
        r.material.opacity = 0.8 * (1 - ph * 0.7);
      });
      const rp = (t * 0.8) % 1;
      ripple.visible = V.online && V.hasLevel && !still;
      ripple.position.y = surfY + 0.04;
      ripple.scale.setScalar(0.3 + rp * 1.25);
      ripple.material.opacity = 0.7 * (1 - rp);
      if (V.twin) {
        V.twinShown += (V.twin.frac - V.twinShown) * (still ? 1 : 0.14);
        const h = Math.max(0.03, V.twinShown * (JAR_H - 0.15));
        jarWater.scale.y = h; jarWater.position.y = 0.05 + h / 2;
        packets.forEach((m, i) => { m.visible = V.twin.online && !still; m.position.copy(link.getPoint((t * 0.55 + i / 3) % 1)); });
      } else packets.forEach((m) => { m.visible = false; });
      ctlW.update();
      renderer.render(cut, camW);
    }
    requestAnimationFrame(frame);
  })();

  return { ok: true, setView, setRegion, setWell, onPick: (cb) => { pickCb = cb; } };
}
