// Habillage du plateau comme dans OrcaSlicer : modèle 3D (bed_model .stl) et logo (bed_texture .svg/.png)
// déclarés par le machine_model du constructeur. Placement repris de Bed3D::update_model_offset
// (modèle centré sur le volume d'impression, z = -0,41 + GROUND_Z) et de PartPlate::generate_logo_polygon
// (logo étiré sur le rectangle du plateau, z = GROUND_Z + 0,02).
import * as THREE from 'three';

const GROUND_Z = -0.04;
const MODEL_Z = -0.41 + GROUND_Z;
const LOGO_Z = GROUND_Z + 0.02;
const MODEL_COLOR = new THREE.Color(0.255, 0.255, 0.283);   // Bed3D::DEFAULT_MODEL_COLOR_DARK
const cache = new Map();

function parseSTL(buf) {
  const dv = new DataView(buf);
  const n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  let pos;
  if (n && 84 + n * 50 === buf.byteLength) {
    pos = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) for (let j = 0; j < 9; j++) pos[i * 9 + j] = dv.getFloat32(84 + i * 50 + 12 + j * 4, true);
  } else {
    const txt = new TextDecoder().decode(buf);
    const v = [...txt.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap((m) => [+m[1], +m[2], +m[3]]);
    pos = new Float32Array(v);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();   // non indexé : normales par face
  return g;
}

async function rasterize(blob, isSvg) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const size = 2048;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    c.getContext('2d').drawImage(img, 0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  } finally { URL.revokeObjectURL(url); }
}

// { geometry, texture } (chacun éventuellement null), mis en cache par imprimante
export function loadBedAssets(machine) {
  if (!machine) return Promise.resolve({ geometry: null, texture: null });
  if (!cache.has(machine)) {
    const q = '?name=' + encodeURIComponent(machine);
    const get = (w) => fetch('/slicer/api/profiles/machine/bed/' + w + q).then((r) => (r.ok ? r : null)).catch(() => null);
    cache.set(machine, Promise.all([
      get('model').then(async (r) => (r ? parseSTL(await r.arrayBuffer()) : null)).catch(() => null),
      get('texture').then(async (r) => {
        if (!r) return null;
        const blob = await r.blob();
        return rasterize(blob.type.includes('svg') ? new Blob([blob], { type: 'image/svg+xml' }) : blob);
      }).catch(() => null),
    ]).then(([geometry, texture]) => ({ geometry, texture })));
  }
  return cache.get(machine);
}

// Groupe à poser dans le repère d'un plateau (area = polygone du plateau en coordonnées machine)
export function bedDecor(area, assets, { dim = false } = {}) {
  const grp = new THREE.Group();
  if (!assets) return grp;
  const xs = area.map((p) => p[0]), ys = area.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  if (assets.geometry) {
    const m = new THREE.Mesh(assets.geometry, new THREE.MeshStandardMaterial({
      color: MODEL_COLOR.clone().multiplyScalar(dim ? 0.35 : 0.45), roughness: 0.9, metalness: 0.0 }));
    m.position.set((minX + maxX) / 2, (minY + maxY) / 2, MODEL_Z);
    m.name = 'bed-model';
    grp.add(m);
  }
  if (assets.texture) {
    const geo = new THREE.ShapeGeometry(new THREE.Shape(area.map(([x, y]) => new THREE.Vector2(x, y))));
    const p = geo.attributes.position, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = (p.getX(i) - minX) / (maxX - minX); uv[i * 2 + 1] = (p.getY(i) - minY) / (maxY - minY); }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: assets.texture, transparent: true, opacity: dim ? 0.5 : 1, depthWrite: false }));
    m.position.z = LOGO_Z;
    m.renderOrder = -1;
    grp.add(m);
  }
  return grp;
}
