// Aperçu du G-code (onglet Aperçu) : lecture du G-code produit par Orca, affichage couche
// par couche en "tubes" de la largeur réelle des lignes, couleurs par type / filament / vitesse.
import * as THREE from 'three';
import { bedDecor } from './bed.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { esc, fmtDuration } from './api.js';
const themeBg = () => { try { const e = document.createElement('div'); e.style.background = 'var(--bg2)'; document.body.appendChild(e);
  const c = getComputedStyle(e).backgroundColor; e.remove(); const m = c.match(/[\d.]+/g), k = c.startsWith('color(') ? 255 : 1; return m && m.length >= 3 ? new THREE.Color(`rgb(${Math.round(m[0] * k)},${Math.round(m[1] * k)},${Math.round(m[2] * k)})`) : new THREE.Color(0x2b2e33); } catch { return new THREE.Color(0x2b2e33); } };

// Couleurs des types de ligne, reprises de l'aperçu d'Orca
// Couleurs des types de ligne : libvgcode/src/ViewerImpl.cpp (DEFAULT_EXTRUSION_ROLES_COLORS) d'Orca 2.5
export const TYPE_COLORS = {
  'Inner wall': '#FFE64D', 'Outer wall': '#FF7D38', 'Overhang wall': '#1F1FFF', 'Sparse infill': '#B03029',
  'Internal solid infill': '#9654CC', 'Top surface': '#F04040', 'Bottom surface': '#665CC7', 'Bridge': '#4D80BA',
  'Internal Bridge': '#4D80BA', 'Gap infill': '#FFFFFF', 'Skirt': '#00876E', 'Brim': '#003B6E',
  'Support': '#00FF00', 'Support interface': '#008000', 'Support transition': '#004000', 'Prime tower': '#B3E3AB',
  'Ironing': '#FF8C69', 'Custom': '#5ED194', 'Floating vertical shell': '#FFB3FF', 'Wipe': '#FFFF00', 'Mixed': '#808080',
};
// Options (DEFAULT_OPTIONS_COLORS)
export const OPTION_COLORS = { travel: '#38489B', wipe: '#FFFF00', retract: '#CD22D6', unretract: '#49ADCF', seam: '#E6E6E6',
  toolchange: '#C1BE63', colorchange: '#DA948B', pause: '#52F083', custom: '#E2D243' };
const TYPE_FR = {
  'Inner wall': 'Paroi intérieure', 'Outer wall': 'Paroi extérieure', 'Overhang wall': 'Paroi en surplomb',
  'Sparse infill': 'Remplissage', 'Internal solid infill': 'Remplissage plein interne', 'Top surface': 'Surface supérieure',
  'Bottom surface': 'Surface inférieure', 'Bridge': 'Pont', 'Internal Bridge': 'Pont interne', 'Gap infill': 'Remplissage d\'espace',
  'Skirt': 'Jupe', 'Brim': 'Bordure', 'Support': 'Support', 'Support interface': 'Interface de support',
  'Support transition': 'Transition de support', 'Prime tower': 'Tour de purge', 'Ironing': 'Lissage', 'Custom': 'Personnalisé',
  'Floating vertical shell': 'Coque verticale flottante', 'Wipe': 'Essuyage', 'Travel': 'Déplacement',
};
export const typeLabel = (t) => TYPE_FR[t] || t;

function parseOrcaDuration(s) {
  let t = 0;
  for (const m of String(s).matchAll(/([\d.]+)\s*([dhms])/g)) t += +m[1] * { d: 86400, h: 3600, m: 60, s: 1 }[m[2]];
  return t;
}

// ---------- lecture du G-code ----------
export function parseGcode(text, onProgress) {
  const types = [], typeIdx = new Map();
  const tid = (t) => { if (!typeIdx.has(t)) { typeIdx.set(t, types.length); types.push(t); } return typeIdx.get(t); };
  const seg = { pos: [], type: [], tool: [], layer: [], speed: [], width: [], height: [], fan: [], temp: [], accel: [], jerk: [], pa: [], flow: [], time: [] };
  const marks = { retract: [], unretract: [], seam: [], toolchange: [], colorchange: [], pause: [], custom: [], wipe: [] };   // [x, y, z, couche]
  let fan = 0, accel = 0, jerk = 0, pa = 0, inWipe = false, lastType = -1;
  const temps = [];
  let filArea = Math.PI * 1.75 * 1.75 / 4, densities = [];
  const eUse = new Map();   // « outil|catégorie » -> longueur de filament (mm)
  const markAt = (k) => marks[k].push(x, y, z, Math.max(layer, 0));
  const trav = { pos: [], layer: [] };
  const layers = []; // {z, height, start, end, tstart, tend}
  let x = 0, y = 0, z = 0, e = 0, f = 3000, absPos = true, absE = false, totalTime = 0;
  let type = tid('Custom'), tool = 0, width = 0.45, height = 0.2, layer = -1;
  const toolsUsed = new Set();
  const typeTime = new Map(), typeLen = new Map();

  // Les extrusions du G-code de démarrage (ligne de purge…) sont rattachées à la 1re couche
  let implicit = false;
  const newLayer = (zz, fromMarker = true) => {
    if (fromMarker && implicit) { layers[layer].z = zz; layers[layer].height = height; implicit = false; return; }
    if (!fromMarker) implicit = true;
    if (layer >= 0) { layers[layer].end = seg.type.length; layers[layer].tend = trav.layer.length; }
    layer++;
    layers.push({ z: zz, height, start: seg.type.length, end: seg.type.length, tstart: trav.layer.length, tend: trav.layer.length });
  };
  // durée d'un mouvement : profil trapézoïdal (départ et arrivée à l'arrêt) ; les durées sont ensuite recalées sur le temps total d'Orca
  const moveTime = (len, v) => { const a = accel > 0 ? accel : 5000; const d = v * v / a; return len >= d ? len / v + v / a : 2 * Math.sqrt(len / a); };
  let travTime = 0;
  // tous les mouvements dans l'ordre (extrusions et déplacements) pour la vue « vitesse réelle »
  const mv = { len: [], v: [], a: [], scv: [], d: [], seg: [] };
  const addSeg = (x0, y0, z0, x1, y1, z1, extr, de = 0) => {
    if (layer < 0) newLayer(z1, false);
    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const v = Math.max(f / 60, 1);
    if (len > 1e-6) {
      mv.len.push(len); mv.v.push(v); mv.a.push(accel > 0 ? accel : 5000); mv.scv.push(jerk > 0 ? jerk : 5);
      mv.d.push((x1 - x0) / len, (y1 - y0) / len, (z1 - z0) / len); mv.seg.push(extr ? seg.type.length : -1);
    }
    if (extr) {
      seg.pos.push(x0, y0, z0 - height / 2, x1, y1, z1 - height / 2);
      seg.type.push(type); seg.tool.push(tool); seg.layer.push(layer); seg.speed.push(f / 60);
      seg.width.push(width); seg.height.push(height);
      seg.fan.push(fan); seg.temp.push(temps[tool] || 0); seg.accel.push(accel); seg.jerk.push(jerk); seg.pa.push(pa);
      seg.flow.push(len > 0 ? de * filArea * v / len : 0);
      { const tn = types[type]; const cat = /Prime tower|Wipe/.test(tn) ? 'tower' : /Support/.test(tn) ? 'support' : 'model'; const kk = tool + '|' + cat; eUse.set(kk, (eUse.get(kk) || 0) + de); }
      seg.time.push(moveTime(len, v));
      if (type !== lastType && types[type] === 'Outer wall') marks.seam.push(x0, y0, z0, layer);
      lastType = type;
      typeTime.set(type, (typeTime.get(type) || 0) + len / Math.max(f / 60, 1));
      typeLen.set(type, (typeLen.get(type) || 0) + len);
      toolsUsed.add(tool);
    } else if (len > 0.01) {
      trav.pos.push(x0, y0, z0, x1, y1, z1);
      trav.layer.push(layer);
      trav.time = (trav.time || 0);
      travTime += moveTime(len, v);
      if (layers[layer]) layers[layer].ttime = (layers[layer].ttime || 0) + moveTime(len, v);
      if (inWipe) marks.wipe.push(x1, y1, z1, layer);
    }
  };

  const lines = text.split('\n');
  const n = lines.length;
  let pendingZ = null;
  for (let i = 0; i < n; i++) {
    let line = lines[i];
    if (onProgress && (i & 0x3ffff) === 0) onProgress(i / n);
    if (line.charCodeAt(0) === 59) { // ';'
      if (line.startsWith(';TYPE:')) type = tid(line.slice(6).trim());
      else if (line.startsWith('; FEATURE:')) type = tid(line.slice(10).trim());
      else if (line.startsWith(';WIDTH:')) width = parseFloat(line.slice(7)) || width;
      else if (line.startsWith(';HEIGHT:')) height = parseFloat(line.slice(8)) || height;
      else if (line.startsWith(';Z:')) { pendingZ = parseFloat(line.slice(3)); }
      else if (line.startsWith(';LAYER_CHANGE')) pendingZ = pendingZ ?? z;
      else if (line.startsWith(';WIPE_START')) inWipe = true;
      else if (line.startsWith(';WIPE_END')) inWipe = false;
      else if (line.startsWith('; filament_density')) densities = line.split(/[:=]/)[1].split(',').map(Number);
      else if (line.startsWith('; filament_diameter')) { const d = parseFloat(line.split(/[:=]/)[1]); if (d > 0) filArea = Math.PI * d * d / 4; }
      else if (line.startsWith('; estimated printing time') && !totalTime) totalTime = parseOrcaDuration(line.split('=')[1] || '');
      continue;
    }
    const sc = line.indexOf(';');
    if (sc >= 0) line = line.slice(0, sc);
    line = line.trim();
    if (!line) continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 84) { // 'T'
      const t = parseInt(line.slice(1));
      if (!isNaN(t) && /^T\d+$/.test(line)) { if (t !== tool && layer >= 0) markAt('toolchange'); tool = t; }
      continue;
    }
    if (line.startsWith('SET_VELOCITY_LIMIT')) {
      const ma = /ACCEL=([\d.]+)/.exec(line), mj = /SQUARE_CORNER_VELOCITY=([\d.]+)/.exec(line);
      if (ma) accel = +ma[1]; if (mj) jerk = +mj[1];
      continue;
    }
    if (line.startsWith('SET_PRESSURE_ADVANCE')) { const m = /ADVANCE=([\d.]+)/.exec(line); if (m) pa = +m[1]; continue; }
    if (line === 'PAUSE' || line.startsWith('PAUSE ') || line.startsWith('M601')) { markAt('pause'); continue; }
    if (c0 !== 71 && c0 !== 77) continue; // G / M
    if (c0 === 77) {
      const pp = line.split(/\s+/), cmd = pp[0];
      const arg = (k) => { const q = pp.find((x) => x[0] === k); return q ? parseFloat(q.slice(1)) : null; };
      if (cmd === 'M106') { const P = arg('P'); if (P === null || P === 0) fan = (arg('S') ?? 255) / 255 * 100; continue; }
      if (cmd === 'M107') { const P = arg('P'); if (P === null || P === 0) fan = 0; continue; }
      if (cmd === 'M104' || cmd === 'M109') { const S = arg('S'), T = arg('T'); if (S !== null) temps[T ?? tool] = S; continue; }
      if (cmd === 'M204') { const S = arg('S') ?? arg('P'); if (S !== null) accel = S; continue; }
      if (cmd === 'M205') { const X = arg('X'); if (X !== null) jerk = X; continue; }
      if (cmd === 'M900') { const K = arg('K'); if (K !== null) pa = K; continue; }
      if (cmd === 'M600') { markAt('colorchange'); continue; }
    }
    const parts = line.split(/\s+/);
    const cmd = parts[0];
    if (cmd === 'G1' || cmd === 'G0' || cmd === 'G2' || cmd === 'G3') {
      let nx = x, ny = y, nz = z, ne = null, I = 0, J = 0;
      for (let k = 1; k < parts.length; k++) {
        const p = parts[k], v = parseFloat(p.slice(1));
        switch (p.charCodeAt(0)) {
          case 88: nx = absPos ? v : x + v; break;      // X
          case 89: ny = absPos ? v : y + v; break;      // Y
          case 90: nz = absPos ? v : z + v; break;      // Z
          case 69: ne = v; break;                        // E
          case 70: f = v; break;                         // F
          case 73: I = v; break;                         // I
          case 74: J = v; break;                         // J
        }
      }
      const de = ne === null ? 0 : (absE ? ne - e : ne);
      const extr = de > 0 && (nx !== x || ny !== y || nz !== z);
      if (ne !== null && de !== 0 && nx === x && ny === y && nz === z && layer >= 0) markAt(de < 0 ? 'retract' : 'unretract');
      if (ne !== null) e = absE ? ne : e + ne;
      if (pendingZ !== null && nz !== z && extr === false) { /* le changement de Z se fait au déplacement */ }
      if (pendingZ !== null && (extr || nz !== z)) {
        newLayer(pendingZ);
        pendingZ = null;
      }
      if (cmd === 'G2' || cmd === 'G3') {
        const cx = x + I, cy = y + J;
        let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
        const r = Math.hypot(x - cx, y - cy);
        if (cmd === 'G2') { if (a1 >= a0) a1 -= 2 * Math.PI; } else if (a1 <= a0) a1 += 2 * Math.PI;
        const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / 0.8));
        let px = x, py = y, pz = z;
        for (let s = 1; s <= steps; s++) {
          const a = a0 + (a1 - a0) * s / steps;
          const qx = s === steps ? nx : cx + r * Math.cos(a), qy = s === steps ? ny : cy + r * Math.sin(a);
          const qz = z + (nz - z) * s / steps;
          addSeg(px, py, pz, qx, qy, qz, extr, de / steps);
          px = qx; py = qy; pz = qz;
        }
      } else if (nx !== x || ny !== y || nz !== z) {
        addSeg(x, y, z, nx, ny, nz, extr, de);
      }
      x = nx; y = ny; z = nz;
    } else if (cmd === 'G90') absPos = true;
    else if (cmd === 'G91') absPos = false;
    else if (cmd === 'M82') absE = true;
    else if (cmd === 'M83') absE = false;
    else if (cmd === 'G92') {
      for (let k = 1; k < parts.length; k++) if (parts[k][0] === 'E') e = parseFloat(parts[k].slice(1)) || 0;
    }
  }
  if (layer >= 0) { layers[layer].end = seg.type.length; layers[layer].tend = trav.layer.length; }
  // supprime les couches sans extrusion (ex. déplacements de fin)
  const kept = layers.filter((l) => l.end > l.start);
  // temps de couche : somme des mouvements, recalée pour que le total corresponde à l'estimation d'Orca
  const segTime = Float32Array.from(seg.time);
  const L = kept.length ? kept : layers;
  for (const l of layers) { let t = l.ttime || 0; for (let i = l.start; i < l.end; i++) t += segTime[i]; l.time = t; }
  const raw = layers.reduce((a, l) => a + l.time, 0) || 1;
  const k = totalTime > 0 ? totalTime / raw : 1;
  for (const l of layers) l.time *= k;
  for (let i = 0; i < segTime.length; i++) segTime[i] *= k;
  const actual = actualSpeeds(mv, seg.type.length);
  const layerTime = new Float32Array(seg.layer.length);
  for (let i = 0; i < seg.layer.length; i++) layerTime[i] = layers[seg.layer[i]]?.time || 0;
  return {
    use: [...eUse].map(([kk, mm]) => { const [t, cat] = kk.split('|'); return { tool: +t, cat, mm, g: mm * filArea / 1000 * (densities[+t] || 1.24) }; }),
    marks: Object.fromEntries(Object.entries(marks).map(([kk, v]) => [kk, new Float32Array(v)])), totalTime,
    types, layers: kept.length ? kept : layers, toolsUsed: [...toolsUsed].sort((a, b) => a - b),
    seg: {
      pos: new Float32Array(seg.pos), type: Uint8Array.from(seg.type), tool: Uint8Array.from(seg.tool),
      layer: Uint32Array.from(seg.layer), speed: Float32Array.from(seg.speed), width: Float32Array.from(seg.width),
      height: Float32Array.from(seg.height), fan: Float32Array.from(seg.fan), temp: Float32Array.from(seg.temp),
      accel: Float32Array.from(seg.accel), jerk: Float32Array.from(seg.jerk), pa: Float32Array.from(seg.pa), flow: Float32Array.from(seg.flow),
      time: segTime, layerTime, actual,
    },
    trav: { pos: new Float32Array(trav.pos), layer: Uint32Array.from(trav.layer) },
    typeTime, typeLen,
  };
}

// Vitesse réelle (vue « Actual speed » d'Orca) : vitesse moyenne effective de chaque extrusion, d'après un profil
// trapézoïdal avec anticipation, comme le planificateur de Klipper : vitesse de jonction limitée par la déviation
// d'angle (square_corner_velocity = jerk), puis passes arrière et avant (v² ≤ v₀² + 2·a·d).
function actualSpeeds(mv, nSeg) {
  const n = mv.len.length, out = new Float32Array(nSeg);
  if (!n) return out;
  const vj = new Float64Array(n + 1);          // vitesse au début du mouvement i (vj[n] = fin, arrêt)
  for (let i = 1; i < n; i++) {
    const a = mv.a[i], scv = mv.scv[i];
    const cos = -(mv.d[3 * i - 3] * mv.d[3 * i] + mv.d[3 * i - 2] * mv.d[3 * i + 1] + mv.d[3 * i - 1] * mv.d[3 * i + 2]);
    let v2;
    if (cos > 0.999999) v2 = 0;                   // demi-tour
    else if (cos < -0.999999) v2 = Infinity;      // tout droit
    else {
      const jd = scv * scv * (Math.SQRT2 - 1) / a;
      const sh = Math.sqrt((1 - cos) / 2);
      v2 = a * jd * sh / (1 - sh);
    }
    vj[i] = Math.sqrt(Math.min(v2, mv.v[i - 1] * mv.v[i - 1], mv.v[i] * mv.v[i]));
  }
  vj[0] = 0; vj[n] = 0;
  for (let i = n - 1; i >= 0; i--) vj[i] = Math.min(vj[i], Math.sqrt(vj[i + 1] * vj[i + 1] + 2 * mv.a[i] * mv.len[i]));
  for (let i = 0; i < n; i++) vj[i + 1] = Math.min(vj[i + 1], Math.sqrt(vj[i] * vj[i] + 2 * mv.a[i] * mv.len[i]));
  for (let i = 0; i < n; i++) {
    const s = mv.seg[i]; if (s < 0) continue;
    const L = mv.len[i], a = mv.a[i], v0 = vj[i], v1 = vj[i + 1];
    let vc = mv.v[i];
    let da = (vc * vc - v0 * v0) / (2 * a), dd = (vc * vc - v1 * v1) / (2 * a);
    if (da + dd > L) {                            // pas de palier : pic de vitesse
      vc = Math.sqrt((2 * a * L + v0 * v0 + v1 * v1) / 2);
      da = (vc * vc - v0 * v0) / (2 * a); dd = (vc * vc - v1 * v1) / (2 * a);
    }
    const t = (vc - v0) / a + (vc - v1) / a + Math.max(0, L - da - dd) / vc;
    out[s] = t > 0 ? L / t : vc;
  }
  return out;
}

// ---------- rendu ----------
export class Preview {
  constructor(container, hooks = {}) {
    this.container = container;
    this.hooks = hooks;
    this.data = null;
    this.scheme = 'type';
    this.hiddenTypes = new Set();
    this.showTravel = false;
    this.toolColours = [];
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setClearColor(themeBg());
    container.appendChild(r.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.15; this.controls.screenSpacePanning = true;
    this.bedGroup = new THREE.Group(); this.scene.add(this.bedGroup);
    this.layerGroup = new THREE.Group(); this.scene.add(this.layerGroup);
    this.travelGroup = new THREE.Group(); this.scene.add(this.travelGroup);
    this.ghostGroup = new THREE.Group(); this.scene.add(this.ghostGroup);
    this.ghostGroup.visible = false;
    this.marker = new THREE.Mesh(new THREE.ConeGeometry(1.2, 4, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.marker.rotation.x = -Math.PI / 2; this.marker.visible = false; this.scene.add(this.marker);
    this.materials = [];
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => { requestAnimationFrame(loop); if (this.container.offsetParent) { this.controls.update(); r.render(this.scene, this.camera); } };
    loop();
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    for (const m of this.materials) m.resolution.set(w, h);
  }

  setBed(area, height) {
    this.bedGroup.clear();
    const xs = area.map((p) => p[0]), ys = area.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    this.bedBox = { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, h: height };
    const shape = new THREE.Shape(area.map(([x, y]) => new THREE.Vector2(x, y)));
    const plate = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: 0x3a3f45 }));
    plate.position.z = -0.3;
    this.bedArea = area; this.bedHeight = height;
    if (this.bedAssets?.geometry) {
      // modèle constructeur : décalé de -0,3 comme la plaque, éclairé par ses propres lumières (le G-code n'en utilise pas)
      const d = bedDecor(area, this.bedAssets);
      d.position.z = -0.26;
      d.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6));
      const dl = new THREE.DirectionalLight(0xffffff, 1.2); dl.position.set(-1, -2, 3); d.add(dl);
      this.bedGroup.add(d);
    } else {
      this.bedGroup.add(plate);
      if (this.bedAssets?.texture) this.bedGroup.add(bedDecor(area, { texture: this.bedAssets.texture }));
    }
    const arr = [];
    for (let x = Math.ceil(minX / 10) * 10; x <= maxX; x += 10) arr.push(x, minY, -0.2, x, maxY, -0.2);
    for (let y = Math.ceil(minY / 10) * 10; y <= maxY; y += 10) arr.push(minX, y, -0.2, maxX, y, -0.2);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    this.bedGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x555b63 })));
  }

  setBedAssets(assets) {
    this.bedAssets = assets;
    if (this.bedArea) this.setBed(this.bedArea, this.bedHeight);
  }

  // offset : origine du plateau dans la grille (le G-code est en coordonnées locales du plateau)
  setGhost(objects, offset = [0, 0]) {
    this.ghostGroup.clear();
    for (const o of objects) {
      const m = new THREE.Mesh(o.mesh.geometry, new THREE.MeshBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.12, depthWrite: false }));
      o.group.updateMatrixWorld(true);
      m.applyMatrix4(o.group.matrixWorld);
      m.position.x -= offset[0]; m.position.y -= offset[1];
      this.ghostGroup.add(m);
    }
  }

  clear() {
    this.data = null;
    this.layerGroup.clear();
    this.ghostGroup.clear();
  }

  view(name = 'iso') {
    const b = this.bedBox || { cx: 0, cy: 0, minX: -100, maxX: 100, minY: -100, maxY: 100, h: 200 };
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    const d = span * 1.4;
    let t = new THREE.Vector3(b.cx, b.cy, 0);
    if (this.data?.bbox) { const c = new THREE.Vector3(); this.data.bbox.getCenter(c); t = c; t.z *= 0.5; }
    const pos = { iso: [t.x - d * 0.4, t.y - d * 0.7, d * 0.55], top: [t.x, t.y - 0.001, d] }[name] || [t.x - d * 0.4, t.y - d * 0.7, d * 0.55];
    this.camera.position.set(...pos);
    this.controls.target.copy(t);
    this.controls.update();
  }

  load(data) {
    this.data = data;
    const p = data.seg.pos;
    const bb = new THREE.Box3();
    for (let i = 0; i < p.length; i += 3) bb.expandByPoint(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
    data.bbox = bb;
    // vitesses/largeurs/hauteurs min-max pour les dégradés
    const range = (arr) => { let lo = Infinity, hi = -Infinity; for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; } return lo <= hi ? [lo, hi] : [0, 0]; };
    data.ranges = {};
    for (const k of ['speed', 'actual', 'width', 'height', 'fan', 'temp', 'accel', 'jerk', 'pa', 'flow', 'layerTime']) data.ranges[k] = range(data.seg[k]);
    data.speedRange = data.ranges.speed; data.widthRange = data.ranges.width; data.heightRange = data.ranges.height;
    this.top = data.layers.length - 1; this.bottom = 0; this.moveEnd = null;
    this.rebuild();
    this.view('iso');
  }

  colourFor(i) {
    const s = this.data.seg, R = this.data.ranges;
    const sc = this.scheme;
    if (sc === 'tool' || sc === 'colorprint') return this.toolColours[s.tool[i]] || '#cccccc';
    if (sc === 'layerTimeLog') return gradient(Math.log(Math.max(s.layerTime[i], 1e-3)), R.layerTime.map((v) => Math.log(Math.max(v, 1e-3))));
    const k = SCHEMES[sc]?.field;
    if (k) return gradient(s[k][i], R[k]);
    return TYPE_COLORS[this.data.types[s.type[i]]] || '#cccccc';
  }

  rebuild() {
    for (const c of this.layerGroup.children) { c.geometry.dispose(); }
    this.layerGroup.clear();
    this.travelGroup.clear();
    this.materials.forEach((m) => m.dispose());
    this.materials = [];
    if (!this.data) return;
    const { seg, layers, types } = this.data;
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    // un matériau par largeur arrondie (LineMaterial en unités monde = largeur réelle de la ligne)
    const matCache = new Map();
    const mat = (width) => {
      const k = Math.round(width * 20) / 20 || 0.45;
      if (!matCache.has(k)) {
        const m = new LineMaterial({ linewidth: k, worldUnits: true, vertexColors: true });
        m.resolution.set(w, h);
        matCache.set(k, m); this.materials.push(m);
      }
      return matCache.get(k);
    };
    const col = new THREE.Color();
    this.layerObjs = layers.map((L, li) => {
      const byW = new Map();
      for (let i = L.start; i < L.end; i++) {
        if (this.hiddenTypes.has(types[seg.type[i]])) continue;
        const k = Math.round(seg.width[i] * 20) / 20;
        if (!byW.has(k)) byW.set(k, []);
        byW.get(k).push(i);
      }
      const objs = [];
      for (const [k, idxs] of byW) {
        const pos = new Float32Array(idxs.length * 6), cols = new Float32Array(idxs.length * 6);
        idxs.forEach((i, j) => {
          pos.set(seg.pos.subarray(i * 6, i * 6 + 6), j * 6);
          col.set(this.colourFor(i));
          cols[j * 6] = cols[j * 6 + 3] = col.r; cols[j * 6 + 1] = cols[j * 6 + 4] = col.g; cols[j * 6 + 2] = cols[j * 6 + 5] = col.b;
        });
        const g = new LineSegmentsGeometry();
        g.setPositions(pos); g.setColors(cols);
        const o = new LineSegments2(g, mat(k));
        o.userData = { layer: li, idxs };
        this.layerGroup.add(o);
        objs.push(o);
      }
      return objs;
    });
    if (this.showTravel) {
      const t = this.data.trav;
      this.travelObjs = layers.map((L) => {
        const arr = t.pos.subarray(L.tstart * 6, L.tend * 6);
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const o = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x5ab4ff, transparent: true, opacity: 0.5 }));
        this.travelGroup.add(o);
        return o;
      });
    } else this.travelObjs = null;
    // options d'Orca : coutures, rétractions, changements de filament, essuyages…
    this.markGroup ||= new THREE.Group();
    if (!this.markGroup.parent) this.scene.add(this.markGroup);
    this.markGroup.clear();
    this.markObjs = [];
    for (const [k, on] of Object.entries(this.options || {})) {
      if (!on || k === 'travel') continue;
      const arr = this.data.marks?.[k];
      if (!arr || !arr.length) continue;
      const n = arr.length / 4, pos = new Float32Array(n * 3), lay = new Uint32Array(n);
      for (let j = 0; j < n; j++) { pos[3 * j] = arr[4 * j]; pos[3 * j + 1] = arr[4 * j + 1]; pos[3 * j + 2] = arr[4 * j + 2]; lay[j] = arr[4 * j + 3]; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const o = new THREE.Points(g, new THREE.PointsMaterial({ color: OPTION_COLORS[k], size: k === 'seam' ? 0.8 : 1.2, sizeAttenuation: true, depthTest: true }));
      o.userData = { lay };
      this.markGroup.add(o); this.markObjs.push(o);
    }
    this.applyRange();
  }

  setRange(bottom, top, moveEnd = null) {
    this.bottom = bottom; this.top = top; this.moveEnd = moveEnd;
    this.applyRange();
  }

  applyRange() {
    if (!this.layerObjs) return;
    this.marker.visible = false;
    this.layerObjs.forEach((objs, li) => {
      const vis = li >= this.bottom && li <= this.top;
      for (const o of objs) {
        o.visible = vis;
        o.geometry.instanceCount = o.userData.idxs.length;
      }
      if (this.travelObjs) this.travelObjs[li].visible = vis;
    });
    for (const o of this.markObjs || []) {
      // points visibles seulement pour les couches affichées (draw range sur des couches triées)
      const lay = o.userData.lay;
      let a = 0; while (a < lay.length && lay[a] < this.bottom) a++;
      let b = a; while (b < lay.length && lay[b] <= this.top) b++;
      o.geometry.setDrawRange(a, b - a);
    }
    // déplacement dans la couche du haut : on n'affiche que les segments jusqu'à moveEnd
    if (this.moveEnd !== null) {
      const L = this.data.layers[this.top];
      const limit = L.start + this.moveEnd;
      let last = null;
      for (const o of this.layerObjs[this.top] || []) {
        const idxs = o.userData.idxs;
        let n = 0;
        while (n < idxs.length && idxs[n] < limit) n++;
        o.geometry.instanceCount = n;
        if (n && (!last || idxs[n - 1] > last)) last = idxs[n - 1];
      }
      if (last !== null) {
        const p = this.data.seg.pos;
        this.marker.position.set(p[last * 6 + 3], p[last * 6 + 4], p[last * 6 + 5] + 2.2);
        this.marker.visible = true;
      }
    }
  }

  setScheme(s) { this.scheme = s; this.rebuild(); }
  toggleType(t) { this.hiddenTypes.has(t) ? this.hiddenTypes.delete(t) : this.hiddenTypes.add(t); this.rebuild(); }
  setTravel(v) { this.showTravel = v; this.options = { ...(this.options || {}), travel: v }; this.rebuild(); }
  setOption(k, v) { this.options = { ...(this.options || {}), [k]: v }; if (k === 'travel') this.showTravel = v; this.rebuild(); }

  legend() {
    if (!this.data) return '';
    const d = this.data;
    if (this.scheme === 'type') {
      const total = [...d.typeTime.values()].reduce((a, b) => a + b, 0) || 1;
      return d.types.filter((t) => d.typeLen.get(d.types.indexOf(t))).map((t) => {
        const i = d.types.indexOf(t);
        const tt = d.typeTime.get(i) || 0;
        return `<div class="legend-item ${this.hiddenTypes.has(t) ? 'off' : ''}" data-type="${esc(t)}">
          <span class="swatch" style="background:${TYPE_COLORS[t] || '#ccc'}"></span><span>${esc(typeLabel(t))}</span>
          <span class="v">${fmtDuration(tt)}</span><span class="v">${(tt / total * 100).toFixed(1)}%</span></div>`;
      }).join('');
    }
    if (this.scheme === 'tool') {
      return d.toolsUsed.map((t) => `<div class="legend-item"><span class="swatch" style="background:${this.toolColours[t] || '#ccc'}"></span>
        <span>Filament ${t + 1}</span><span></span><span></span></div>`).join('');
    }
    if (this.scheme === 'colorprint') {
      return d.toolsUsed.map((t) => `<div class="legend-item"><span class="swatch" style="background:${this.toolColours[t] || '#ccc'}"></span>
        <span>Filament ${t + 1}</span><span></span><span></span></div>`).join('');
    }
    const S = SCHEMES[this.scheme];
    const log = this.scheme === 'layerTimeLog';
    const [lo0, hi0] = d.ranges[S.field];
    const [lo, hi] = log ? [Math.log(Math.max(lo0, 1e-3)), Math.log(Math.max(hi0, 1e-3))] : [lo0, hi0];
    // 11 paliers, comme la légende d'Orca (une teinte par palier)
    return Array.from({ length: 11 }, (_, k) => {
      const t = hi - (hi - lo) * k / 10;
      const v = log ? Math.exp(t) : t;
      return `<div class="legend-item"><span class="swatch" style="background:${gradient(t, [lo, hi])}"></span>
        <span>${S.fmt(v)}</span><span></span><span></span></div>`;
    }).join('');
  }
}

// Vues de l'aperçu d'Orca (libvgcode EViewType) : champ lu et format de la légende
const fmtT = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s` : `${s.toFixed(1)} s`);
export const SCHEMES = {
  type: { label: 'Type de ligne' }, colorprint: { label: 'Impression couleur' },
  speed: { label: 'Vitesse', field: 'speed', fmt: (v) => `${v.toFixed(0)} mm/s` },
  actual: { label: 'Vitesse réelle', field: 'actual', fmt: (v) => `${v.toFixed(0)} mm/s` },
  accel: { label: 'Accélération', field: 'accel', fmt: (v) => `${v.toFixed(0)} mm/s²` },
  jerk: { label: 'Jerk', field: 'jerk', fmt: (v) => `${v.toFixed(1)} mm/s` },
  height: { label: 'Hauteur de couche', field: 'height', fmt: (v) => `${v.toFixed(2)} mm` },
  width: { label: 'Largeur de ligne', field: 'width', fmt: (v) => `${v.toFixed(2)} mm` },
  flow: { label: 'Débit volumétrique', field: 'flow', fmt: (v) => `${v.toFixed(1)} mm³/s` },
  layerTime: { label: 'Temps de couche (linéaire)', field: 'layerTime', fmt: fmtT },
  layerTimeLog: { label: 'Temps de couche (logarithmique)', field: 'layerTime', fmt: fmtT },
  fan: { label: 'Vitesse du ventilateur', field: 'fan', fmt: (v) => `${v.toFixed(0)} %` },
  temp: { label: 'Température', field: 'temp', fmt: (v) => `${v.toFixed(0)} °C` },
  pa: { label: 'Pressure advance', field: 'pa', fmt: (v) => v.toFixed(3) },
  tool: { label: 'Filament' },
};

function gradient(v, [lo, hi]) {
  const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
  // palette d'Orca : libvgcode/include/ColorRange.hpp (DEFAULT_RANGES_COLORS), du bleu au rouge
  const stops = [[11, 44, 122], [19, 89, 133], [28, 136, 145], [4, 214, 15], [170, 242, 0], [252, 249, 3], [245, 206, 10], [227, 136, 32], [209, 104, 48], [194, 82, 60], [148, 38, 22]];
  const x = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x), f = x - i;
  const c = stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
