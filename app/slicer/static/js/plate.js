// Plateau 3D (onglet Préparer) : lit, objets, sélection, déplacement/rotation/échelle,
// disposition automatique, pose sur une face, miniatures pour l'imprimante.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { api } from './api.js';
import { PaintLayer, MODES } from './paint.js';
import { bedDecor } from './bed.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three/addons/three-mesh-bvh.js';

// Gros modèles : arbre de volumes englobants (three-mesh-bvh, MIT) pour le lancer de rayons (sélection, peinture, mesure).
// Mode « indirect » : l'ordre des triangles n'est pas modifié (les indices de peinture d'Orca en dépendent).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
const BVH_MIN_TRIANGLES = 5000;
const themeBg = () => { try { const e = document.createElement('div'); e.style.background = 'var(--bg2)'; document.body.appendChild(e);
  const c = getComputedStyle(e).backgroundColor; e.remove(); const m = c.match(/[\d.]+/g), k = c.startsWith('color(') ? 255 : 1; return m && m.length >= 3 ? new THREE.Color(`rgb(${Math.round(m[0] * k)},${Math.round(m[1] * k)},${Math.round(m[2] * k)})`) : new THREE.Color(0x2b2e33); } catch { return new THREE.Color(0x2b2e33); } };

// Normales par face (rendu « plat », comme OrcaSlicer) : chaque triangle a sa propre normale. Le lissage par sommet
// (computeVertexNormals) mélangeait les faces de part et d'autre des arêtes vives : traînées et bords baveux, surtout
// sur les filetages. L'ordre des triangles est conservé (triangle t = sommets 3t, 3t+1, 3t+2) : indices de peinture inchangés.
function flatGeometry(pos, idx, nf) {
  const P = new Float32Array(nf * 9), N = new Float32Array(nf * 9);
  for (let t = 0; t < nf; t++) {
    const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
    const o = 9 * t;
    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? a : k === 1 ? b : c;
      P[o + 3 * k] = pos[v]; P[o + 3 * k + 1] = pos[v + 1]; P[o + 3 * k + 2] = pos[v + 2];
      N[o + 3 * k] = x; N[o + 3 * k + 1] = y; N[o + 3 * k + 2] = z;
    }
  }
  const I = new Uint32Array(nf * 3);
  for (let i = 0; i < I.length; i++) I[i] = i;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setIndex(new THREE.BufferAttribute(I, 1));
  return g;
}

const geomCache = new Map();
let uid = 1;

export async function loadGeometry(modelId, index) {
  const key = `${modelId}/${index}`;
  if (geomCache.has(key)) return geomCache.get(key);
  const p = api(`/slicer/api/models/${modelId}/mesh/${index}`).then((buf) => {
    const dv = new DataView(buf);
    const nv = dv.getUint32(0, true), nf = dv.getUint32(4, true);
    const pos = new Float32Array(buf, 8, nv * 3);
    const idx = new Uint32Array(buf, 8 + nv * 12, nf * 3);
    const g = flatGeometry(pos, idx, nf);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    if (nf >= BVH_MIN_TRIANGLES) g.computeBoundsTree({ indirect: true });
    return g;
  });
  geomCache.set(key, p);
  return p;
}

export function parseArea(list) {
  return (list || []).map((s) => s.split('x').map(Number)).filter((p) => p.length === 2 && !p.some(isNaN));
}

// Enveloppe convexe (chaîne monotone d'Andrew), points [x, y] → polygone antihoraire
function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// Deux polygones convexes se chevauchent-ils ? (théorème de l'axe séparateur ; simple contact = pas de chevauchement)
function hullsOverlap(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      const nx = y2 - y1, ny = x1 - x2;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const [x, y] of a) { const d = x * nx + y * ny; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const [x, y] of b) { const d = x * nx + y * ny; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      const eps = 1e-6 * Math.hypot(nx, ny);
      if (maxA <= minB + eps || maxB <= minA + eps) return false;
    }
  }
  return true;
}

export class Plate {
  constructor(container, hooks = {}) {
    this.container = container;
    this.hooks = hooks;           // onSelect(obj), onChange(), colourOf(extruder)
    this.objects = [];
    this.selected = null;
    this.mode = 'translate';
    this.layFlat = false;
    this.bed = { area: [[0, 0], [256, 0], [256, 256], [0, 256]], height: 256, exclude: [] };
    this.plateCount = 1; this.current = 0; this.plateNames = [''];   // plateaux multiples, en grille comme Orca

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setClearColor(themeBg());
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.4);
    dl.position.set(-300, -500, 800);
    this.scene.add(dl);
    const dl2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dl2.position.set(400, 600, 300);
    this.scene.add(dl2);

    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;

    this.gizmo = new TransformControls(this.camera, r.domElement);
    this.gizmo.setSize(0.9);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      if (!e.value && this.selectedTower) { this._towerMoved(this.selectedTower); return; }
      if (!e.value) this._afterTransform(this.selected);
    });
    this.gizmo.addEventListener('objectChange', () => this.hooks.onTransform?.(this.selected));
    this.scene.add(this.gizmo);

    this.bedGroup = new THREE.Group();
    this.scene.add(this.bedGroup);
    this.objGroup = new THREE.Group();
    this.scene.add(this.objGroup);
    this.clearGroup = new THREE.Group();   // zones de dégagement de l'extrudeur (séquence « par objet »)
    this.scene.add(this.clearGroup);
    this._clearSig = '';
    this._hulls = new WeakMap();
    this.towerGroup = new THREE.Group();   // tours de purge (une par plateau multicolore)
    this.scene.add(this.towerGroup);
    this.towers = [];

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    let down = null;
    let painting = false;
    r.domElement.addEventListener('pointerdown', (e) => {
      down = [e.clientX, e.clientY];
      if (this.paint?.active && e.button === 0 && this.selected) {
        const hit = this._paintHit(e);
        if (hit) { painting = true; r.domElement.setPointerCapture(e.pointerId); this._paintAt(hit, e.shiftKey); }
      }
    });
    r.domElement.addEventListener('pointermove', (e) => {
      if (!this.paint?.active) return;
      const hit = this._paintHit(e);
      this._brushCursor(hit);
      if (painting && hit && this.paint.tool === 'brush') this._paintAt(hit, e.shiftKey);
    });
    r.domElement.addEventListener('pointerup', () => { if (painting) { painting = false; this.hooks.onPaint?.(this.selected); } });
    r.domElement.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0) return;
      if (this.gizmo.dragging) return;
      if (this.paint?.active) return;
      this._click(e);
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.setBed(this.bed);
    this.view('iso');
    const loop = () => { requestAnimationFrame(loop); this._syncClearance(); this.controls.update(); this.renderer.render(this.scene, this.camera); };
    loop();
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------- lit ----------
  setBed({ area, height, exclude }) {
    this._relayout(() => {
      this.bed = { area: area?.length ? area : this.bed.area, height: height || this.bed.height, exclude: exclude || [] };
      const pts = this.bed.area;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      this.base = { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
    });
  }

  // Modèle 3D + logo du plateau fournis par le profil constructeur (voir bed.js)
  setBedAssets(assets) {
    this.bedAssets = assets?.geometry || assets?.texture ? assets : null;
    this._drawBeds();
  }

  // Position d'un plateau dans la grille (même règle qu'Orca : colonnes = ceil(sqrt(n)), écart de 20 %)
  plateOrigin(i, count = this.plateCount) {
    if (!this.base) return [0, 0];
    const W = this.base.maxX - this.base.minX, D = this.base.maxY - this.base.minY;
    const cols = Math.ceil(Math.sqrt(count));
    return [(i % cols) * 1.2 * W, -Math.floor(i / cols) * 1.2 * D];
  }

  plateBox(i) {
    const [ox, oy] = this.plateOrigin(i), b = this.base;
    return { minX: b.minX + ox, maxX: b.maxX + ox, minY: b.minY + oy, maxY: b.maxY + oy, cx: b.cx + ox, cy: b.cy + oy };
  }

  // Exécute un changement de grille (taille du lit, nombre de plateaux) en gardant chaque objet sur son plateau.
  _relayout(change, remap = (i) => i) {
    const before = this.base ? this.objects.map((o) => [o, o.plate, o.plate >= 0 ? this.plateOrigin(o.plate) : null]) : [];
    change();
    for (const [o, pl, org] of before) {
      const np = pl >= 0 ? remap(pl) : -1;
      if (np < 0 || !org) continue;
      const [nx, ny] = this.plateOrigin(np);
      o.group.position.x += nx - org[0];
      o.group.position.y += ny - org[1];
      o.group.updateMatrixWorld(true);
    }
    this.current = Math.min(this.current, this.plateCount - 1);
    this.bedBox = this.plateBox(this.current);
    this._drawBeds();
    this.objects.forEach((o) => this._updateOutside(o));
  }

  setCurrent(i, quiet = false) {
    if (i < 0 || i >= this.plateCount || i === this.current) return;
    this.current = i;
    this.bedBox = this.plateBox(i);
    this._drawBeds();
    if (!quiet) this.hooks.onPlate?.(i);
  }

  setPlates(count, names = null, current = 0) {
    this._relayout(() => {
      this.plateCount = Math.max(1, count);
      this.plateNames = Array.from({ length: this.plateCount }, (_, i) => (names || this.plateNames)[i] || '');
      this.current = Math.min(Math.max(0, current), this.plateCount - 1);
    });
    this.hooks.onPlate?.(this.current);
  }

  addPlate() {
    this.setPlates(this.plateCount + 1, null, this.plateCount);
    this.view('iso');
    this.hooks.onChange?.();
  }

  removePlate(i) {
    if (this.plateCount <= 1) { for (const o of this.objects.filter((x) => x.plate === i)) this.remove(o); return; }
    for (const o of this.objects.filter((x) => x.plate === i)) this.remove(o);
    this._relayout(() => {
      this.plateCount -= 1;
      this.plateNames.splice(i, 1);
      if (this.current > i || this.current >= this.plateCount) this.current = Math.max(0, this.current - 1);
    }, (pl) => (pl > i ? pl - 1 : pl));
    this.view('iso');
    this.hooks.onPlate?.(this.current);
    this.hooks.onChange?.();
  }

  objectsOf(i) { return this.objects.filter((o) => o.plate === i); }

  // Déplace un objet sur un autre plateau (même position relative), puis range ce plateau si nécessaire.
  moveToPlate(obj, i) {
    if (!obj || i < 0 || i >= this.plateCount || obj.plate === i) return;
    const from = obj.plate >= 0 ? this.plateOrigin(obj.plate) : null, to = this.plateOrigin(i);
    if (from) { obj.group.position.x += to[0] - from[0]; obj.group.position.y += to[1] - from[1]; }
    else { const pb = this.plateBox(i); obj.group.position.x = pb.cx; obj.group.position.y = pb.cy; }
    this._afterTransform(obj, true);
    this.setCurrent(i);
    const b = this.worldBox(obj);
    if (obj.outside || this.objectsOf(i).some((o) => o !== obj && this.worldBox(o).intersectsBox(b))) this.arrange();
    this.hooks.onChange?.();
    this.hooks.onPlate?.(i);
  }

  _drawBeds() {
    const g = this.bedGroup;
    g.clear();
    const { minX, maxX, minY, maxY } = this.base;
    const pts = this.bed.area;
    const mkLines = (arr, color, opacity) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    };
    const fine = [], bold = [];
    for (let x = Math.ceil(minX / 10) * 10; x <= maxX; x += 10) (x % 50 === 0 ? bold : fine).push(x, minY, 0, x, maxY, 0);
    for (let y = Math.ceil(minY / 10) * 10; y <= maxY; y += 10) (y % 50 === 0 ? bold : fine).push(minX, y, 0, maxX, y, 0);
    for (let i = 0; i < this.plateCount; i++) {
      const cur = i === this.current;
      const sub = new THREE.Group();
      const [ox, oy] = this.plateOrigin(i);
      sub.position.set(ox, oy, 0);
      const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
      const plate = new THREE.Mesh(new THREE.ShapeGeometry(shape),
        new THREE.MeshStandardMaterial({ color: cur ? 0x3a3f45 : 0x2c3035, roughness: 0.9, metalness: 0.0 }));
      // avec un modèle de plateau constructeur, c'est lui qui sert de surface (Bed3D::render_custom) :
      // la plaque reste pour la sélection à la souris mais n'est plus dessinée
      if (this.bedAssets?.geometry) { plate.material.colorWrite = false; plate.material.depthWrite = false; }
      plate.position.z = -0.05;
      plate.name = 'bed';
      plate.userData.plate = i;
      sub.add(plate);
      if (this.bedAssets) sub.add(bedDecor(pts, this.bedAssets, { dim: !cur }));
      sub.add(mkLines(fine, 0x5a6068, cur ? 0.5 : 0.25));
      sub.add(mkLines(bold, 0x7a828b, cur ? 0.8 : 0.4));
      // zones exclues (ex. bac de purge de la Max 4)
      for (const poly of this.bed.exclude) {
        if (poly.length < 3) continue;
        const m = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y)))),
          new THREE.MeshBasicMaterial({ color: 0xb04040, transparent: true, opacity: cur ? 0.35 : 0.18, depthWrite: false }));
        m.position.z = 0.02;
        sub.add(m);
      }
      // volume d'impression (plateau actif) ou simple contour (autres plateaux)
      if (cur) {
        const helper = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(minX, minY, 0), new THREE.Vector3(maxX, maxY, this.bed.height)), 0x55606a);
        helper.material.transparent = true; helper.material.opacity = 0.35;
        sub.add(helper);
        const axes = new THREE.AxesHelper(20);
        axes.position.set(minX, minY, 0.1);
        sub.add(axes);
      }
      if (this.plateCount > 1) {
        sub.add(mkLines([minX, minY, 0.05, maxX, minY, 0.05, maxX, minY, 0.05, maxX, maxY, 0.05, maxX, maxY, 0.05, minX, maxY, 0.05, minX, maxY, 0.05, minX, minY, 0.05],
          cur ? 0xe08a57 : 0x55606a, cur ? 1 : 0.6));
        sub.add(this._plateLabel(i, cur, maxX, minY));
      }
      g.add(sub);
    }
  }

  // Numéro du plateau, posé à plat près du coin avant droit (comme le « 01 » d'Orca)
  _plateLabel(i, cur, maxX, minY) {
    const c = document.createElement('canvas'); c.width = 128; c.height = 64;
    const x = c.getContext('2d');
    x.font = 'bold 48px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = cur ? '#e08a57' : '#8a929b';
    x.fillText(String(i + 1).padStart(2, '0'), 64, 34);
    const tex = new THREE.CanvasTexture(c);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(40, 20), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    m.position.set(maxX + 24, minY + 12, 0.1);
    return m;
  }

  view(name) {
    const { cx, cy, maxX, minX, maxY, minY } = this.bedBox;
    const span = Math.max(maxX - minX, maxY - minY, this.bed.height);
    const t = new THREE.Vector3(cx, cy, 0);
    const d = span * 1.6;
    const pos = {
      iso: [cx - d * 0.45, cy - d * 0.75, d * 0.6], top: [cx, cy - 0.001, d * 1.1], bottom: [cx, cy + 0.001, -d],
      front: [cx, cy - d, span * 0.35], back: [cx, cy + d, span * 0.35], left: [cx - d, cy, span * 0.35], right: [cx + d, cy, span * 0.35],
    }[name] || null;
    if (!pos) return;
    this.camera.position.set(...pos);
    this.controls.target.copy(t);
    this.controls.update();
  }

  // ---------- objets ----------
  async addObject({ model_id, index, name, position, extruder = 1, settings = {}, matrix = null, parts = [], paint = {}, layer_profile = [], brim_points = [], layer_ranges = [] }) {
    const geo = await loadGeometry(model_id, index);
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geo, this._material(extruder));
    mesh.userData.main = true;
    group.add(mesh);
    const obj = { id: uid++, model_id, index, name, extruder, settings: { ...settings }, parts: [], group, mesh, paint: JSON.parse(JSON.stringify(paint || {})), layer_profile: [...(layer_profile || [])],
      brim_points: (brim_points || []).map((p) => [...p]), layer_ranges: JSON.parse(JSON.stringify(layer_ranges || [])) };
    mesh.userData.owner = obj;
    group.userData.obj = obj;
    if (matrix) {
      new THREE.Matrix4().fromArray(matrix).decompose(group.position, group.quaternion, group.scale);
    } else if (position) {
      group.position.set(position[0], position[1], 0);
    } else {
      group.position.set(this.bedBox.cx, this.bedBox.cy, 0);
    }
    this.objGroup.add(group);
    this.objects.push(obj);
    for (const p of parts) await this.addPart(obj, p);
    this._afterTransform(obj, true);
    if (Object.keys(obj.paint || {}).length || parts.some((pt) => Object.keys(pt.paint || {}).length)) this.refreshPaint(obj);
    if (obj.brim_points.length) this.refreshBrim(obj);
    return obj;
  }

  async addPart(obj, { model_id, index, name, subtype = 'modifier_part', settings = {}, matrix = null, extruder = 0, paint = {} }) {
    const geo = await loadGeometry(model_id, index);
    const colors = { modifier_part: 0xffc107, support_blocker: 0xe53935, support_enforcer: 0x43a047, negative_part: 0x9e9e9e };
    // pièce « normale » d'un objet à plusieurs pièces : solide, couleur de son filament (0 = celui de l'objet)
    const mesh = new THREE.Mesh(geo, subtype === 'normal_part' ? this._material(extruder || obj.extruder)
      : new THREE.MeshStandardMaterial({ color: colors[subtype] || 0xffc107, transparent: true, opacity: 0.45, depthWrite: false }));
    if (subtype === 'normal_part') mesh.userData.solid = true;
    if (matrix) new THREE.Matrix4().fromArray(matrix).decompose(mesh.position, mesh.quaternion, mesh.scale);
    const part = { id: uid++, model_id, index, name, subtype, settings: { ...settings }, extruder, mesh, paint: JSON.parse(JSON.stringify(paint || {})) };
    mesh.userData.owner = part;
    mesh.userData.part = part;
    obj.group.add(mesh);
    obj.parts.push(part);
    this.hooks.onChange?.();
    return part;
  }

  removePart(obj, part) {
    obj.group.remove(part.mesh);
    obj.parts = obj.parts.filter((p) => p !== part);
    this.hooks.onChange?.();
  }

  _material(extruder) {
    const c = this.hooks.colourOf?.(extruder) || '#cccccc';
    return new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: 0.6, metalness: 0.05, flatShading: false });
  }

  refreshColours() {
    for (const o of this.objects) {
      o.mesh.material.color.set(this.hooks.colourOf?.(o.extruder) || '#cccccc');
      for (const pt of o.parts) if (pt.subtype === 'normal_part') pt.mesh.material.color.set(this.hooks.colourOf?.(pt.extruder || o.extruder) || '#cccccc');
      this._updateOutside(o);
    }
    this.refreshPaint();
  }

  remove(obj) {
    if (!obj) return;
    if (this.selected === obj) this.select(null);
    this.objGroup.remove(obj.group);
    this.objects = this.objects.filter((o) => o !== obj);
    this.hooks.onChange?.();
  }

  clear() {
    this.select(null);
    for (const o of [...this.objects]) this.objGroup.remove(o.group);
    this.objects = [];
    this.hooks.onChange?.();
  }

  async duplicate(obj) {
    if (!obj) return null;
    const m = obj.group.matrix.clone();
    const copy = await this.addObject({
      model_id: obj.model_id, index: obj.index, name: obj.name, extruder: obj.extruder, settings: obj.settings,
      matrix: m.toArray(), paint: obj.paint, layer_profile: obj.layer_profile, brim_points: obj.brim_points, layer_ranges: obj.layer_ranges, parts: obj.parts.map((p) => ({ ...p, matrix: p.mesh.matrix.toArray() })),
    });
    const s = this.worldBox(obj);
    copy.group.position.x += (s.max.x - s.min.x) + 5;
    this._afterTransform(copy);
    this.arrangeIfOverlap(copy);
    return copy;
  }

  select(obj) {
    if (this.selectedTower) this._unselectTower();
    if (this.selected) this.selected.mesh.material.emissive?.set(0x000000);
    this.selected = obj;
    if (obj && obj.plate >= 0 && obj.plate !== this.current) this.setCurrent(obj.plate);
    if (obj) {
      obj.mesh.material.emissive.set(0x1f5f58);
      this.gizmo.attach(obj.group);
      this.gizmo.setMode(this.mode);
    } else {
      this.gizmo.detach();
    }
    this.hooks.onSelect?.(obj);
  }

  setMode(mode) {
    this.mode = mode;
    this.gizmo.setMode(mode);
    this.gizmo.setSpace(mode === 'scale' ? 'local' : 'world');
  }

  // Encombrement réel : maillage principal + pièces normales (les modificateurs ne s'impriment pas)
  worldBox(obj) {
    obj.group.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(obj.mesh, true);
    for (const pt of obj.parts) if (pt.subtype === 'normal_part') b.union(new THREE.Box3().setFromObject(pt.mesh, true));
    return b;
  }

  // Après une transformation : objet posé sur le plateau, contrôle de sortie du volume.
  _afterTransform(obj, silent = false) {
    if (!obj) return;
    const b = this.worldBox(obj);
    obj.group.position.z -= b.min.z;
    obj.group.updateMatrixWorld(true);
    this._updateOutside(obj);
    if (!silent) this.hooks.onChange?.();
    this.hooks.onTransform?.(obj);
  }

  _updateOutside(obj) {
    const b = this.worldBox(obj);
    const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2;
    let pl = -1;
    for (let i = 0; i < this.plateCount; i++) {
      const p = this.plateBox(i);
      if (cx >= p.minX && cx <= p.maxX && cy >= p.minY && cy <= p.maxY) { pl = i; break; }
    }
    obj.plate = pl;
    let out = true;
    if (pl >= 0) {
      const { minX, maxX, minY, maxY } = this.plateBox(pl);
      out = b.min.x < minX - 0.01 || b.max.x > maxX + 0.01 || b.min.y < minY - 0.01 || b.max.y > maxY + 0.01 || b.max.z > this.bed.height + 0.01;
    }
    obj.outside = out;
    obj.mesh.material.color.set(out ? '#e0703a' : (this.hooks.colourOf?.(obj.extruder) || '#cccccc'));
  }

  applyTransform(obj, { pos, rot, scale, size }) {
    const g = obj.group;
    if (pos) g.position.set(pos[0], pos[1], g.position.z);
    if (rot) g.rotation.set(THREE.MathUtils.degToRad(rot[0]), THREE.MathUtils.degToRad(rot[1]), THREE.MathUtils.degToRad(rot[2]), 'XYZ');
    if (scale) g.scale.set(scale[0] / 100, scale[1] / 100, scale[2] / 100);
    if (size) {
      const bb = obj.mesh.geometry.boundingBox;
      const base = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
      g.scale.set(size[0] / base[0], size[1] / base[1], size[2] / base[2]);
    }
    this._afterTransform(obj, true);
    this.hooks.onChange?.();
  }

  // Pose l'objet sur la face cliquée (outil "Face au sol")
  layOnFace(obj, worldNormal) {
    const q = new THREE.Quaternion().setFromUnitVectors(worldNormal.clone().normalize(), new THREE.Vector3(0, 0, -1));
    obj.group.quaternion.premultiply(q);
    const b = this.worldBox(obj);
    const c = new THREE.Vector3();
    b.getCenter(c);
    obj.group.position.x += obj.group.position.x - c.x;
    obj.group.position.y += obj.group.position.y - c.y;
    this._afterTransform(obj);
  }

  centre(obj) {
    if (!obj) return;
    const b = this.worldBox(obj);
    const c = new THREE.Vector3(); b.getCenter(c);
    obj.group.position.x += this.bedBox.cx - c.x;
    obj.group.position.y += this.bedBox.cy - c.y;
    this._afterTransform(obj);
  }

  // Disposition automatique : rangement en étagères des empreintes, centré sur le lit.
  arrange(spacing = 6, rotate = false) {
    if (!this.objects.some((o) => o.plate === this.current || o.plate === -1)) return;
    if (rotate) {
      // rotation de 90° autour de Z quand elle allonge l'empreinte selon X (rangées plus compactes)
      for (const o of this.objects.filter((x) => x.plate === this.current || x.plate === -1)) {
        const b = this.worldBox(o);
        if (b.max.y - b.min.y > (b.max.x - b.min.x) * 1.05) { o.group.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), Math.PI / 2); this._afterTransform(o, true); }
      }
    }
    const { minX, maxX, minY, maxY } = this.bedBox;
    const W = maxX - minX;
    const items = this.objects.filter((o) => o.plate === this.current || o.plate === -1).map((o) => {
      const b = this.worldBox(o);
      return { o, w: b.max.x - b.min.x, d: b.max.y - b.min.y, b };
    }).sort((a, b) => b.d - a.d || b.w - a.w);
    const rows = [];
    let row = { items: [], w: 0, d: 0 };
    for (const it of items) {
      if (row.items.length && row.w + spacing + it.w > W) { rows.push(row); row = { items: [], w: 0, d: 0 }; }
      row.w += (row.items.length ? spacing : 0) + it.w;
      row.d = Math.max(row.d, it.d);
      row.items.push(it);
    }
    rows.push(row);
    const totalD = rows.reduce((s, r) => s + r.d, 0) + spacing * (rows.length - 1);
    let y = (minY + maxY) / 2 + totalD / 2;
    for (const r of rows) {
      let x = (minX + maxX) / 2 - r.w / 2;
      for (const it of r.items) {
        const c = new THREE.Vector3(); it.b.getCenter(c);
        it.o.group.position.x += x + it.w / 2 - c.x;
        it.o.group.position.y += y - r.d / 2 - c.y;
        x += it.w + spacing;
        this._afterTransform(it.o, true);
      }
      y -= r.d + spacing;
    }
    this.hooks.onChange?.();
    if (this.selected) this.hooks.onTransform?.(this.selected);
  }

  // ---------- zones de dégagement (séquence « par objet ») ----------
  // Comme Orca : enveloppe convexe de chaque objet élargie de extruder_clearance_max_radius / 2, en gris ;
  // rouge quand deux zones se chevauchent (la tête risquerait de heurter l'objet déjà imprimé).
  // hooks.clearance(plateIdx) renvoie le rayon d'élargissement en mm (0 = fonction inactive pour ce plateau).
  _hullOf(obj, r) {
    obj.group.updateMatrixWorld(true);
    const key = obj.group.matrixWorld.elements.join(',') + '|' + r + '|' + obj.parts.map((p) => p.subtype + p.mesh.matrixWorld.elements.join(',')).join(';');
    const c = this._hulls.get(obj);
    if (c && c.key === key) return c.hull;
    const pts = [];
    const v = new THREE.Vector3();
    const meshes = [obj.mesh, ...obj.parts.filter((p) => p.subtype === 'normal_part').map((p) => p.mesh)];
    for (const m of meshes) {
      m.updateWorldMatrix(true, false);
      const pos = m.geometry.attributes.position;
      const step = Math.max(1, Math.floor(pos.count / 40000));
      for (let i = 0; i < pos.count; i += step) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); pts.push([v.x, v.y]); }
    }
    const base = convexHull(pts);
    const ring = [];
    for (let k = 0; k < 24; k++) ring.push([Math.cos(k * Math.PI / 12) * r, Math.sin(k * Math.PI / 12) * r]);
    const grown = convexHull(base.flatMap(([x, y]) => ring.map(([dx, dy]) => [x + dx, y + dy])));
    this._hulls.set(obj, { key, hull: grown });
    return grown;
  }

  _syncClearance() {
    if (!this.hooks.clearance) return;
    const items = [];
    let sig = '';
    for (const o of this.objects) {
      const r = o.plate >= 0 ? (this.hooks.clearance(o.plate) || 0) : 0;
      if (r <= 0 || !o.mesh?.geometry?.attributes?.position) continue;
      o.group.updateMatrixWorld(true);
      sig += o.group.matrixWorld.elements.join(',') + '|' + r + '|' + o.plate + '|' + o.parts.length + '#';
      items.push({ o, r });
    }
    if (sig === this._clearSig) return;
    this._clearSig = sig;
    for (const ch of [...this.clearGroup.children]) { this.clearGroup.remove(ch); ch.geometry?.dispose(); ch.material?.dispose(); }
    const hulls = items.map(({ o, r }) => ({ o, hull: this._hullOf(o, r) })).filter((h) => h.hull.length >= 3);
    const hit = new Set();
    for (let i = 0; i < hulls.length; i++) for (let j = i + 1; j < hulls.length; j++) {
      if (hulls[i].o.plate === hulls[j].o.plate && hullsOverlap(hulls[i].hull, hulls[j].hull)) { hit.add(i); hit.add(j); }
    }
    hulls.forEach(({ hull }, i) => {
      const bad = hit.has(i);
      const col = bad ? 0xe5484d : 0x8a929c;
      const shape = new THREE.Shape(hull.map(([x, y]) => new THREE.Vector2(x, y)));
      const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: bad ? 0.38 : 0.22, depthWrite: false, side: THREE.DoubleSide }));
      fill.position.z = 0.12; fill.renderOrder = 2;
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(hull.map(([x, y]) => new THREE.Vector3(x, y, 0.14))), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9, depthWrite: false }));
      line.renderOrder = 2;
      this.clearGroup.add(fill, line);
    });
  }

  arrangeIfOverlap(obj) {
    const b = this.worldBox(obj);
    if (this.objects.some((o) => o !== obj && this.worldBox(o).intersectsBox(b)) || obj.outside) this.arrange();
  }

  _click(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const m = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(m, this.camera);
    const meshes = this.objects.flatMap((o) => [o.mesh, ...o.parts.filter((pt) => pt.subtype === 'normal_part').map((pt) => pt.mesh)]);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (this.picking) {
      const cb = this.picking; this.picking = null;
      if (hit && hit.face) {
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        cb({ obj: hit.object.parent.userData.obj, part: hit.object.userData.part || null, point: hit.point.clone(), normal: n });
      } else cb(null);
      return;
    }
    if (this.brim) { this._brimClick(e.shiftKey); return; }
    if (this.measuring) {
      const beds = []; this.bedGroup.traverse((m) => { if (m.name === 'bed') beds.push(m); });
      this._measureClick(hit || this.raycaster.intersectObjects(beds, false)[0]);
      return;
    }
    const th = this.raycaster.intersectObjects(this.towers.map((t) => t.mesh), false)[0];
    if (th && (!hit || th.distance < hit.distance) && !this.layFlat) { this.selectTower(th.object.userData.tower); return; }
    if (this.layFlat) {
      this.layFlat = false;
      this.hooks.onLayFlatDone?.();
      if (hit && hit.face) {
        const obj = hit.object.parent.userData.obj;
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        this.layOnFace(obj, n);
        this.select(obj);
      }
      return;
    }
    if (!hit && this.plateCount > 1) {
      const beds = [];
      this.bedGroup.traverse((m) => { if (m.name === 'bed') beds.push(m); });
      const bh = this.raycaster.intersectObjects(beds, false)[0];
      if (bh && bh.object.userData.plate !== this.current) { this.select(null); this.setCurrent(bh.object.userData.plate); return; }
    }
    this.select(hit ? hit.object.parent.userData.obj : null);
  }

  // ---------- miroir, remplacement de maillage ----------
  mirror(obj, axis) {
    if (!obj) return;
    const s = obj.group.scale;
    if (axis === 0) s.x *= -1; else if (axis === 1) s.y *= -1; else s.z *= -1;
    this._afterTransform(obj);
  }

  async replaceMesh(obj, model_id, index) {
    const geo = await loadGeometry(model_id, index);
    obj.mesh.geometry = geo;
    obj.model_id = model_id; obj.index = index;
    this._afterTransform(obj);
  }

  // ---------- peinture (supports, couture, couleurs, fuzzy skin) ----------
  // Maillages peignables d'un objet : maillage principal + pièces normales (comme Orca)
  _paintables(obj) { return [obj.mesh, ...obj.parts.filter((p) => p.subtype === 'normal_part').map((p) => p.mesh)]; }

  _layer(mesh, mode) {
    const owner = mesh.userData.owner;
    mesh.userData.layers ||= {};
    if (!mesh.userData.layers[mode]) mesh.userData.layers[mode] = new PaintLayer(mesh.geometry, owner.paint?.[mode]);
    return mesh.userData.layers[mode];
  }

  // Affiche les zones peintes : couleurs toujours visibles, autres modes seulement pendant leur peinture
  refreshPaint(obj) {
    const list = obj ? [obj] : this.objects;
    for (const o of list) {
      for (const mesh of this._paintables(o)) {
        const owner = mesh.userData.owner;
        for (const mode of Object.keys(MODES)) {
          const key = 'paint_' + mode;
          const old = mesh.getObjectByName(key);
          if (old) { mesh.remove(old); old.geometry.dispose(); }
          const show = mode === 'color' ? true : this.paint?.active && this.paint.mode === mode && o === this.selected;
          const has = owner.paint?.[mode] && Object.keys(owner.paint[mode]).length;
          if (!show || (!has && !mesh.userData.layers?.[mode])) continue;
          const L = this._layer(mesh, mode);
          if (L.isEmpty()) continue;
          const colourOf = mode === 'color' ? (st) => this.hooks.colourOf?.(st) : (st) => MODES[mode].states[st]?.[1];
          const ov = new THREE.Mesh(L.overlay(colourOf), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
          ov.name = key;
          ov.raycast = () => {};
          mesh.add(ov);
        }
      }
    }
  }

  setPaint(p) {
    this.paint = p;
    // en peinture : clic gauche = peindre ; rotation de la vue au clic droit, déplacement au clic milieu
    this.controls.mouseButtons = p?.active ? { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    if (p?.active) this.gizmo.detach(); else if (this.selected) this.gizmo.attach(this.selected.group);
    this.refreshPaint();
    if (this.brushCursor) this.brushCursor.visible = false;
  }

  _paintHit(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const m = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(m, this.camera);
    const obj = this.selected;
    if (!obj) return null;
    return this.raycaster.intersectObjects(this._paintables(obj), false)[0] || null;
  }

  _paintAt(hit, erase) {
    const p = this.paint, obj = this.selected;
    const state = erase ? 0 : p.state;
    let changed = false;
    if (p.tool === 'fill') {
      const L = this._layer(hit.object, p.mode);
      L.fill(hit.faceIndex, state, p.angle);
      changed = true;
    } else {
      // pinceau : sphère de rayon p.radius (mm) autour du point touché, appliquée à chaque maillage de l'objet
      for (const mesh of this._paintables(obj)) {
        mesh.updateMatrixWorld(true);
        const inv = mesh.matrixWorld.clone().invert();
        const c = hit.point.clone().applyMatrix4(inv);
        const sc = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
        const r = p.radius / Math.max(1e-6, (Math.abs(sc.x) + Math.abs(sc.y) + Math.abs(sc.z)) / 3);
        if (this._layer(mesh, p.mode).brush(c, r, state, Math.max(r / 6, 0.05))) changed = true;
      }
    }
    if (changed) this._commitPaint(obj);
  }

  _commitPaint(obj) {
    for (const mesh of this._paintables(obj)) {
      const L = mesh.userData.layers?.[this.paint.mode];
      if (!L) continue;
      const owner = mesh.userData.owner;
      owner.paint ||= {};
      const ser = L.serialize();
      if (Object.keys(ser).length) owner.paint[this.paint.mode] = ser; else delete owner.paint[this.paint.mode];
    }
    this.refreshPaint(obj);
  }

  paintOverhangs(angle, state) {
    const obj = this.selected;
    if (!obj) return 0;
    let n = 0;
    for (const mesh of this._paintables(obj)) {
      mesh.updateMatrixWorld(true);
      n += this._layer(mesh, this.paint.mode).overhangs(state, angle, new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld));
    }
    this._commitPaint(obj);
    return n;
  }

  clearPaint(mode) {
    const obj = this.selected;
    if (!obj) return;
    for (const mesh of this._paintables(obj)) { mesh.userData.layers?.[mode]?.clear(); delete mesh.userData.owner.paint?.[mode]; }
    this.refreshPaint(obj);
  }

  _brushCursor(hit) {
    if (!this.brushCursor) {
      this.brushCursor = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: 0xe08a57, depthTest: false, side: THREE.DoubleSide }));
      this.brushCursor.renderOrder = 20;
      this.scene.add(this.brushCursor);
    }
    const c = this.brushCursor;
    if (!hit || this.paint.tool !== 'brush') { c.visible = false; return; }
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    c.visible = true;
    c.position.copy(hit.point).addScaledVector(n, 0.05);
    c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    c.scale.setScalar(this.paint.radius);
  }

  // ---------- aperçu du plan de coupe ----------
  showCutPlane(point, normal, size, connectors = []) {
    if (this.cutGroup) { this.scene.remove(this.cutGroup); this.cutGroup = null; }
    if (!point) return;
    const g = this.cutGroup = new THREE.Group();
    const n = new THREE.Vector3(...normal).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: 0xe08a57, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size)), new THREE.LineBasicMaterial({ color: 0xe08a57 }));
    g.add(plane, edge);
    for (const c of connectors) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(c.r, c.r, c.h, 24), new THREE.MeshBasicMaterial({ color: 0x2f7d4f, transparent: true, opacity: 0.8 }));
      m.rotation.x = Math.PI / 2;
      m.position.set(c.x, c.y, c.z);
      g.add(m);
    }
    g.quaternion.copy(q);
    g.position.set(...point);
    this.scene.add(g);
  }

  // ---------- mesure ----------
  startMeasure(on) {
    this.measuring = on;
    this.measurePts = [];
    if (this.measureGroup) { this.scene.remove(this.measureGroup); this.measureGroup = null; }
    if (on) { this.measureGroup = new THREE.Group(); this.scene.add(this.measureGroup); }
  }

  _measureClick(hit) {
    if (!hit) return;
    const p = hit.point.clone();
    this.measurePts.push(p);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.6, this.camera.position.distanceTo(p) / 300), 12, 8), new THREE.MeshBasicMaterial({ color: 0xe08a57, depthTest: false }));
    dot.position.copy(p); dot.renderOrder = 10;
    this.measureGroup.add(dot);
    if (this.measurePts.length === 2) {
      const [a, b] = this.measurePts;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0xe08a57, depthTest: false }));
      line.renderOrder = 10;
      this.measureGroup.add(line);
      this.hooks.onMeasure?.({ d: a.distanceTo(b), dx: Math.abs(b.x - a.x), dy: Math.abs(b.y - a.y), dz: Math.abs(b.z - a.z) });
      this.measurePts = [];
    } else if (this.measurePts.length === 1 && this.measureGroup.children.length > 1) {
      // nouveau segment : on efface le précédent
      const keep = this.measureGroup.children.at(-1);
      this.measureGroup.clear(); this.measureGroup.add(keep);
    }
  }

  // ---------- assemblage face contre face (GLGizmoAssembly, mode « Face and face ») ----------
  // a : face de la pièce qui bouge, b : face de référence ({obj, part, point, normal} en coordonnées monde).
  // La pièce tourne pour que sa face regarde la face de référence (normales opposées), puis se plaque dessus
  // (écart = gap) ; centered : les points cliqués coïncident, sinon seul l'écart entre plans est corrigé.
  assembleFaces(a, b, { centered = true, gap = 0 } = {}) {
    const target = a.part ? a.part.mesh : a.obj.group;
    const nA = a.normal.clone().normalize(), nB = b.normal.clone().normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(nA, nB.clone().negate());
    if (Math.abs(nA.dot(nB) - 1) < 1e-9) {        // normales identiques : demi-tour autour d'un axe perpendiculaire
      const ax = Math.abs(nA.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      q.setFromAxisAngle(ax.cross(nA).normalize(), Math.PI);
    }
    // rotation monde autour du point a.point, puis translation
    const R = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const pivot = a.point.clone();
    const W = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    const d = centered ? b.point.clone().sub(pivot) : nB.clone().multiplyScalar(b.point.clone().sub(pivot).dot(nB));
    d.add(nB.clone().multiplyScalar(gap));
    W.premultiply(new THREE.Matrix4().makeTranslation(d.x, d.y, d.z));
    target.updateMatrixWorld(true);
    const world = W.multiply(target.matrixWorld);
    const local = target.parent ? new THREE.Matrix4().copy(target.parent.matrixWorld).invert().multiply(world) : world;
    local.decompose(target.position, target.quaternion, target.scale);
    target.updateMatrixWorld(true);
    this._afterTransform(a.obj);
    if (b.obj !== a.obj) this._afterTransform(b.obj, true);
    this.hooks.onChange?.();
  }

  // ---------- oreilles de bordure (GLGizmoBrimEars) ----------
  // brim = { obj, radius } quand l'outil est actif ; points [x, y, z, rayon] dans le repère de l'objet
  startBrim(obj, radius) {
    this.brim = obj ? { obj, radius } : null;
    for (const o of this.objects) this.refreshBrim(o);
  }

  _brimClick(remove) {
    const b = this.brim; if (!b) return;
    // comme Orca, le point est pris sur la première couche : intersection du rayon avec le plateau (z = 0)
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), p)) return;
    b.obj.group.updateMatrixWorld(true);
    const inv = b.obj.group.matrixWorld.clone().invert();
    if (remove) {
      let best = -1, bd = Infinity;
      b.obj.brim_points.forEach((q, i) => {
        const w = new THREE.Vector3(q[0], q[1], q[2]).applyMatrix4(b.obj.group.matrixWorld);
        const d = Math.hypot(w.x - p.x, w.y - p.y);
        if (d < Math.max(q[3], 1) && d < bd) { bd = d; best = i; }
      });
      if (best < 0) return;
      b.obj.brim_points.splice(best, 1);
    } else {
      const l = new THREE.Vector3(p.x, p.y, -0.0001).applyMatrix4(inv);
      b.obj.brim_points.push([l.x, l.y, l.z, b.radius]);
    }
    this.refreshBrim(b.obj);
    this.hooks.onBrim?.(b.obj);
  }

  setBrimPoints(obj, pts) { obj.brim_points = pts; this.refreshBrim(obj); this.hooks.onBrim?.(obj); }

  // disques posés sur le plateau (enfants du groupe de l'objet : ils suivent ses déplacements)
  refreshBrim(obj) {
    if (obj.brimGroup) { obj.group.remove(obj.brimGroup); obj.brimGroup = null; }
    if (!obj.brim_points?.length) return;
    const active = this.brim?.obj === obj;
    const g = new THREE.Group();
    const s = obj.group.scale;
    for (const [x, y, z, r] of obj.brim_points) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(r, 32), new THREE.MeshBasicMaterial({ color: active ? 0xe08a57 : 0x4fa3d9, transparent: true, opacity: active ? 0.65 : 0.4, depthWrite: false, side: THREE.DoubleSide }));
      m.position.set(x, y, z + 0.06 / (s.z || 1));
      m.scale.set(1 / (s.x || 1), 1 / (s.y || 1), 1);    // rayon en mm réels malgré l'échelle de l'objet
      m.renderOrder = 3;
      g.add(m);
    }
    obj.brimGroup = g;
    obj.group.add(g);
  }

  // ---------- tours de purge ----------
  // list : [{ plate, x, y, w, d, h }] en coordonnées du plateau (comme wipe_tower_x / wipe_tower_y d'Orca)
  setTowers(list) {
    const sel = this.selectedTower?.plate;
    this._unselectTower();
    this.towerGroup.clear();
    this.towers = [];
    for (const t of list) {
      const [ox, oy] = this.plateOrigin(t.plate);
      const geo = new THREE.BoxGeometry(t.w, t.d, Math.max(1, t.h));
      geo.translate(t.w / 2, t.d / 2, Math.max(1, t.h) / 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9aa4ae, transparent: true, opacity: 0.55, roughness: 0.8 }));
      mesh.position.set(ox + t.x, oy + t.y, 0);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xe08a57 }));
      mesh.add(edges);
      const tower = { ...t, mesh };
      mesh.userData.tower = tower;
      this.towerGroup.add(mesh);
      this.towers.push(tower);
    }
    if (sel != null) { const t = this.towers.find((x) => x.plate === sel); if (t) this.selectTower(t); }
  }

  selectTower(t) {
    if (this.selected) { this.selected.mesh.material.emissive?.set(0x000000); this.selected = null; this.hooks.onSelect?.(null); }
    this.selectedTower = t;
    if (t.plate !== this.current) this.setCurrent(t.plate);
    t.mesh.material.color.set(0xe08a57);
    this.gizmo.attach(t.mesh);
    this.gizmo.setMode('translate');
    this.gizmo.showZ = false;
    this.hooks.onTowerSelect?.(t);
  }

  _unselectTower() {
    if (!this.selectedTower) return;
    this.selectedTower.mesh.material.color.set(0x9aa4ae);
    this.selectedTower = null;
    this.gizmo.showZ = true;
    this.gizmo.detach();
    this.hooks.onTowerSelect?.(null);
  }

  _towerMoved(t) {
    const [ox, oy] = this.plateOrigin(t.plate), b = this.base;
    // reste sur son plateau (Orca refuse une tour hors du lit)
    const x = Math.min(Math.max(t.mesh.position.x - ox, b.minX), b.maxX - t.w);
    const y = Math.min(Math.max(t.mesh.position.y - oy, b.minY), b.maxY - t.d);
    t.mesh.position.set(ox + x, oy + y, 0);
    t.x = Math.round(x * 1000) / 1000; t.y = Math.round(y * 1000) / 1000;
    this.hooks.onTowerMove?.(t.plate, t.x, t.y);
  }

  // Matrice monde (column-major) envoyée au serveur pour la découpe
  matrixOf(obj) {
    obj.group.updateMatrixWorld(true);
    return obj.group.matrixWorld.toArray();
  }

  // plateIdx = null : tous les objets, coordonnées de la grille (projet). Sinon : objets du plateau, coordonnées locales (découpe).
  // local = false : objets du plateau mais en coordonnées de la grille (c'est ce qu'Orca découpe réellement).
  serialize(plateIdx = null, local = true) {
    const [ox, oy] = plateIdx == null || !local ? [0, 0] : this.plateOrigin(plateIdx);
    return this.objects.filter((o) => plateIdx == null || o.plate === plateIdx).map((o) => {
      const m = this.matrixOf(o); m[12] -= ox; m[13] -= oy;
      return {
        model_id: o.model_id, index: o.index, name: o.name, extruder: o.extruder, settings: o.settings, matrix: m, plate: o.plate, paint: o.paint || {}, layer_profile: o.layer_profile || [], brim_points: o.brim_points || [], layer_ranges: o.layer_ranges || [],
        parts: o.parts.map((p) => ({ model_id: p.model_id, index: p.index, name: p.name, subtype: p.subtype,
          settings: p.settings, extruder: p.extruder, matrix: p.mesh.matrix.toArray(), paint: p.paint || {} })),
      };
    });
  }

  // Miniatures PNG (base64 sans préfixe) pour l'écran de l'imprimante / Moonraker
  thumbnails(sizes = [[32, 32], [300, 300]]) {
    const mine = this.objectsOf(this.current);
    if (!mine.length) return [];
    const others = this.objects.filter((o) => o.plate !== this.current);
    others.forEach((o) => { o.group.visible = false; });
    const box = new THREE.Box3();
    mine.forEach((o) => box.union(this.worldBox(o)));
    const c = new THREE.Vector3(); box.getCenter(c);
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const cam = new THREE.PerspectiveCamera(30, 1, 1, 10000);
    cam.up.set(0, 0, 1);
    const dir = new THREE.Vector3(-0.5, -0.9, 0.7).normalize();
    cam.position.copy(c).addScaledVector(dir, r / Math.sin(THREE.MathUtils.degToRad(15)) * 1.05);
    cam.lookAt(c);
    const sel = this.selected;
    if (sel) sel.mesh.material.emissive.set(0x000000);
    this.gizmo.visible = false; this.bedGroup.visible = false;
    const out = [];
    for (const [w, h] of sizes) {
      const rt = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      rt.setSize(w, h); rt.setPixelRatio(1); rt.setClearColor(0x000000, 0);
      cam.aspect = w / h; cam.updateProjectionMatrix();
      rt.render(this.scene, cam);
      out.push({ w, h, data: rt.domElement.toDataURL('image/png').split(',')[1] });
      rt.dispose(); rt.forceContextLoss();
    }
    this.gizmo.visible = true; this.bedGroup.visible = true;
    others.forEach((o) => { o.group.visible = true; });
    if (sel) sel.mesh.material.emissive.set(0x1f5f58);
    return out;
  }
}
