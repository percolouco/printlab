// Peinture des triangles (supports, couture, couleurs, fuzzy skin), compatible avec TriangleSelector d'OrcaSlicer.
//
// Chaque triangle d'origine du maillage peut être subdivisé récursivement ; règles reprises de TriangleSelector::perform_split :
//   v = sommets du triangle tournés de « special_side » ; 1 côté coupé : enfants (v0,v1,m12) (m12,v2,v0) ;
//   2 côtés : (v0,m01,m02) (m01,v1,m02) (v1,v2,m02) ; 3 côtés : (v0,m01,m20) (m01,v1,m12) (m12,v2,m20) (m01,m12,m20).
// Codage (TriangleSelector::serialize / FacetsAnnotation::get_triangle_as_string) : quartets de bits par nœud,
//   nœud subdivisé : (côté spécial << 2) | nombre de côtés coupés, puis les enfants du dernier au premier ;
//   feuille : état << 2 si état < 3, sinon 0b1100 puis (état − 3) [ou 0b1111 puis (état − 18)] ;
//   la chaîne hexadécimale est écrite à l'envers (dernier quartet en premier).
import * as THREE from 'three';

export const MODES = {
  supports: { attr: 'paint_supports', label: 'Supports', states: { 1: ['Forcer', '#3fb950'], 2: ['Bloquer', '#e5534b'] } },
  seam: { attr: 'paint_seam', label: 'Couture', states: { 1: ['Forcer', '#3fb950'], 2: ['Bloquer', '#e5534b'] } },
  color: { attr: 'paint_color', label: 'Couleurs', states: {} },
  fuzzy: { attr: 'paint_fuzzy_skin', label: 'Fuzzy skin', states: { 1: ['Fuzzy skin', '#d29922'] } },
};

// ---------- codage ----------
export function decodeTri(hex) {
  const nib = [];
  for (let i = hex.length - 1; i >= 0; i--) nib.push(parseInt(hex[i], 16));
  let k = 0;
  const next = () => (k < nib.length ? nib[k++] : 0);
  const node = () => {
    const code = next();
    const split = code & 3;
    if (split) {
      const n = { split, special: split === 3 ? 0 : code >> 2, children: new Array(split + 1) };
      for (let c = split; c >= 0; c--) n.children[c] = node();
      return n;
    }
    if ((code & 0b1100) === 0b1100) {
      const a = next();
      return { state: a === 0b1111 ? next() + 18 : a + 3 };
    }
    return { state: code >> 2 };
  };
  return node();
}

export function encodeTri(root) {
  const nib = [];
  const walk = (n) => {
    if (n.children) {
      nib.push(((n.split === 3 ? 0 : n.special) << 2) | n.split);
      for (let c = n.split; c >= 0; c--) walk(n.children[c]);
    } else if (n.state < 3) nib.push(n.state << 2);
    else if (n.state <= 17) nib.push(0b1100, n.state - 3);
    else nib.push(0b1100, 0b1111, n.state - 18);
  };
  walk(root);
  return nib.reverse().map((x) => x.toString(16).toUpperCase()).join('');
}

const isEmpty = (n) => (n.children ? n.children.every(isEmpty) : !n.state);

// Fusionne les sous-arbres uniformes (comme le « garbage collection » de TriangleSelector)
function simplify(n) {
  if (!n.children) return n;
  n.children = n.children.map(simplify);
  const s = n.children[0].state;
  if (n.children.every((c) => !c.children && c.state === s)) return { state: s };
  return n;
}

// Sommets des enfants (positions) selon les règles d'Orca
function childVerts(n, [a, b, c]) {
  const rot = [a, b, c];
  const ss = n.split === 3 ? 0 : n.special;
  const v0 = rot[ss], v1 = rot[(ss + 1) % 3], v2 = rot[(ss + 2) % 3];
  const mid = (p, q) => p.clone().add(q).multiplyScalar(0.5);
  if (n.split === 1) { const m12 = mid(v2, v1); return [[v0, v1, m12], [m12, v2, v0]]; }
  if (n.split === 2) { const m01 = mid(v1, v0), m02 = mid(v0, v2); return [[v0, m01, m02], [m01, v1, m02], [v1, v2, m02]]; }
  const m01 = mid(v1, v0), m12 = mid(v2, v1), m20 = mid(v0, v2);
  return [[v0, m01, m20], [m01, v1, m12], [m12, v2, m20], [m01, m12, m20]];
}

// ---------- données de peinture d'un maillage ----------
export class PaintLayer {
  // geometry : BufferGeometry indexée du maillage (repère local) ; data : { indexTriangle: chaîne hexa }
  constructor(geometry, data = {}) {
    this.geo = geometry;
    this.pos = geometry.attributes.position;
    this.idx = geometry.index;
    this.ntri = this.idx.count / 3;
    this.trees = new Map();
    for (const [k, h] of Object.entries(data || {})) if (h) this.trees.set(+k, decodeTri(h));
    this._prep();
  }

  _prep() {
    const n = this.ntri, P = this.pos, I = this.idx;
    this.cent = new Float32Array(n * 3); this.rad = new Float32Array(n); this.nrm = new Float32Array(n * 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), m = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    for (let t = 0; t < n; t++) {
      a.fromBufferAttribute(P, I.getX(3 * t)); b.fromBufferAttribute(P, I.getX(3 * t + 1)); c.fromBufferAttribute(P, I.getX(3 * t + 2));
      m.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      this.cent.set([m.x, m.y, m.z], 3 * t);
      this.rad[t] = Math.max(m.distanceTo(a), m.distanceTo(b), m.distanceTo(c));
      e1.subVectors(b, a); e2.subVectors(c, a); e1.cross(e2).normalize();
      this.nrm.set([e1.x, e1.y, e1.z], 3 * t);
    }
  }

  triVerts(t) {
    const P = this.pos, I = this.idx;
    return [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(P, I.getX(3 * t + k)));
  }

  serialize() {
    const out = {};
    for (const [t, tree] of this.trees) if (!isEmpty(tree)) out[t] = encodeTri(simplify(tree));
    return out;
  }

  isEmpty() { for (const tr of this.trees.values()) if (!isEmpty(tr)) return false; return true; }

  clear() { this.trees.clear(); }

  // Feuilles peintes (état > 0) : [[v0, v1, v2], état]
  leaves() {
    const out = [];
    const walk = (n, vs) => {
      if (n.children) { const cv = childVerts(n, vs); n.children.forEach((c, i) => walk(c, cv[i])); }
      else if (n.state) out.push([vs, n.state]);
    };
    for (const [t, tree] of this.trees) walk(tree, this.triVerts(t));
    return out;
  }

  // Pinceau sphérique (centre et rayon dans le repère local) ; minEdge = finesse de la subdivision au bord
  brush(center, radius, state, minEdge) {
    const r2 = radius * radius;
    const inside = (v) => v.distanceToSquared(center) <= r2;
    const tmp = new THREE.Vector3();
    let changed = false;
    const paintNode = (n, vs) => {
      const ins = vs.map(inside);
      if (ins.every(Boolean)) {                       // entièrement sous le pinceau
        if (n.children || n.state !== state) { changed = true; return { state }; }
        return n;
      }
      // triangle touché ? (sommet dedans, ou plus proche point du triangle dans la sphère)
      const tri = new THREE.Triangle(...vs);
      tri.closestPointToPoint(center, tmp);
      if (tmp.distanceToSquared(center) > r2) return n;
      const edge = Math.max(vs[0].distanceTo(vs[1]), vs[1].distanceTo(vs[2]), vs[2].distanceTo(vs[0]));
      if (edge > minEdge) {                           // bord du pinceau : on subdivise (3 côtés, comme Orca)
        if (!n.children) n = { split: 3, special: 0, children: [0, 1, 2, 3].map(() => ({ state: n.state || 0 })) };
        const cv = childVerts(n, vs);
        n.children = n.children.map((c, i) => paintNode(c, cv[i]));
        return n;
      }
      const g = vs[0].clone().add(vs[1]).add(vs[2]).multiplyScalar(1 / 3);
      if (inside(g) && (n.children || n.state !== state)) { changed = true; return { state }; }
      return n;
    };
    for (let t = 0; t < this.ntri; t++) {
      const dx = this.cent[3 * t] - center.x, dy = this.cent[3 * t + 1] - center.y, dz = this.cent[3 * t + 2] - center.z;
      const rr = radius + this.rad[t];
      if (dx * dx + dy * dy + dz * dz > rr * rr) continue;
      const before = this.trees.get(t) || { state: 0 };
      const after = simplify(paintNode(before, this.triVerts(t)));
      if (isEmpty(after)) this.trees.delete(t); else this.trees.set(t, after);
    }
    return changed;
  }

  // Remplissage : triangles reliés au triangle de départ dont la normale s'écarte de moins de `angle`° (« remplissage intelligent »)
  fill(seed, state, angleDeg) {
    if (!this.adj) this._adjacency();
    const cosA = Math.cos(THREE.MathUtils.degToRad(angleDeg));
    const n0 = [this.nrm[3 * seed], this.nrm[3 * seed + 1], this.nrm[3 * seed + 2]];
    const seen = new Uint8Array(this.ntri), stack = [seed];
    seen[seed] = 1;
    let count = 0;
    while (stack.length) {
      const t = stack.pop();
      if (state) this.trees.set(t, { state }); else this.trees.delete(t);
      count++;
      for (const u of this.adj[t]) {
        if (seen[u]) continue;
        const d = this.nrm[3 * u] * n0[0] + this.nrm[3 * u + 1] * n0[1] + this.nrm[3 * u + 2] * n0[2];
        if (d >= cosA) { seen[u] = 1; stack.push(u); }
      }
    }
    return count;
  }

  // Tous les triangles dont la normale (repère monde, matrice 3×3 fournie) pointe vers le bas au-delà du seuil
  overhangs(state, angleDeg, normalMatrix) {
    const lim = -Math.cos(THREE.MathUtils.degToRad(angleDeg));
    const n = new THREE.Vector3();
    let count = 0;
    for (let t = 0; t < this.ntri; t++) {
      n.set(this.nrm[3 * t], this.nrm[3 * t + 1], this.nrm[3 * t + 2]).applyMatrix3(normalMatrix).normalize();
      if (n.z < lim) { this.trees.set(t, { state }); count++; }
    }
    return count;
  }

  _adjacency() {
    const I = this.idx, map = new Map();
    // sommets soudés par position (le maillage peut dupliquer les sommets)
    const P = this.pos, key = (i) => `${P.getX(i).toFixed(4)},${P.getY(i).toFixed(4)},${P.getZ(i).toFixed(4)}`;
    const vid = new Map(), id = (i) => { const k = key(i); if (!vid.has(k)) vid.set(k, vid.size); return vid.get(k); };
    this.adj = Array.from({ length: this.ntri }, () => []);
    for (let t = 0; t < this.ntri; t++) {
      const v = [id(I.getX(3 * t)), id(I.getX(3 * t + 1)), id(I.getX(3 * t + 2))];
      for (let e = 0; e < 3; e++) {
        const a = v[e], b = v[(e + 1) % 3], k = a < b ? `${a}_${b}` : `${b}_${a}`;
        const o = map.get(k);
        if (o === undefined) map.set(k, t); else { this.adj[t].push(o); this.adj[o].push(t); }
      }
    }
  }

  // Maillage d'affichage des zones peintes (légèrement décollé de la surface)
  overlay(colourOf) {
    const L = this.leaves();
    const pos = new Float32Array(L.length * 9), col = new Float32Array(L.length * 9);
    const c = new THREE.Color(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    L.forEach(([vs, st], i) => {
      e1.subVectors(vs[1], vs[0]); e2.subVectors(vs[2], vs[0]); e1.cross(e2).normalize().multiplyScalar(0.02);
      c.set(colourOf(st) || '#ff00ff');
      vs.forEach((v, k) => { pos.set([v.x + e1.x, v.y + e1.y, v.z + e1.z], 9 * i + 3 * k); col.set([c.r, c.g, c.b], 9 * i + 3 * k); });
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  }
}
