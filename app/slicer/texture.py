"""Texture en relief (« texture displacement » d'OrcaSlicer 2.5, outil D).

Orca « cuit » le relief dans le maillage (TextureDisplacement.cpp, ~10 000 lignes : subdivision adaptive, projections
tri-planaire / cylindrique / sphérique / LSCM, calques, masques peints). Ici un calcul plus simple, même principe et
mêmes réglages de base (TextureDisplacementLayer) :
  - subdivision uniforme du maillage entier (garde un maillage fermé, comme subdivide_mesh_uniform d'Orca) jusqu'à
    une longueur d'arête adaptée à la taille du motif ;
  - projection tri-planaire (poids |n|^4, TRIPLANAR_BLEND_SHARPNESS = 4), motif répété (Repeat) ;
  - hauteur = (texel − niveau neutre) × profondeur, le long de la normale lissée du sommet ;
  - zone : tout l'objet ou les côtés seulement ; la face posée sur le plateau reste plane.
Le maillage obtenu n'est donc pas identique au bit près à celui d'Orca ; la découpe, elle, est faite par Orca.
Textures : celles livrées avec Orca (resources/textures/displacement/*.png).
"""
import io
import os
from pathlib import Path

import numpy as np

ORCA_DIR = Path(os.environ.get("ORCA_DIR", "/opt/orca"))
TEX_DIR = ORCA_DIR / "resources" / "textures" / "displacement"
MAX_FACES = 1_500_000


def list_textures():
    return sorted(p.stem for p in TEX_DIR.glob("*.png")) if TEX_DIR.is_dir() else []


def texture_path(name):
    p = TEX_DIR / f"{name}.png"
    if p.parent != TEX_DIR or not p.is_file():
        raise ValueError("Texture inconnue")
    return p


def load_height(data: bytes, smoothing=0.0):
    """Image → carte de hauteur 0..1 (luminance), flou optionnel (TextureDisplacementLayer::smoothing)."""
    from PIL import Image, ImageFilter
    im = Image.open(io.BytesIO(data)).convert("L")
    if smoothing > 0:
        im = im.filter(ImageFilter.GaussianBlur(radius=max(0.5, smoothing * 0.02 * max(im.size))))
    return np.asarray(im, dtype=np.float32) / 255.0


def _sample(tex, u, v):
    """Échantillonnage bilinéaire, motif répété (TextureTileMethod::Repeat). u, v en tuiles."""
    h, w = tex.shape
    x = (u - np.floor(u)) * w - 0.5
    y = (1.0 - (v - np.floor(v))) * h - 0.5      # v vers le haut, image vers le bas
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx, fy = x - x0, y - y0
    x0 %= w
    y0 %= h
    x1, y1 = (x0 + 1) % w, (y0 + 1) % h
    a = tex[y0, x0] * (1 - fx) + tex[y0, x1] * fx
    b = tex[y1, x0] * (1 - fx) + tex[y1, x1] * fx
    return a * (1 - fy) + b * fy


def subdivide_once(v, f):
    """Découpe de chaque triangle en 4 par les milieux d'arêtes ; arêtes partagées découpées une seule fois (maillage fermé)."""
    e = np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1)
    ue, inv = np.unique(e, axis=0, return_inverse=True)
    inv = inv.reshape(3, -1).T + len(v)                      # milieux des arêtes (01, 12, 20) de chaque face
    nv = np.concatenate([v, (v[ue[:, 0]] + v[ue[:, 1]]) / 2])
    a, b, c = f[:, 0], f[:, 1], f[:, 2]
    ab, bc, ca = inv[:, 0], inv[:, 1], inv[:, 2]
    nf = np.concatenate([np.stack([a, ab, ca], 1), np.stack([ab, b, bc], 1), np.stack([ca, bc, c], 1), np.stack([ab, bc, ca], 1)])
    return nv, nf


def _subdivide(v, f, max_edge):
    for _ in range(8):
        e = np.linalg.norm(v[f[:, [1, 2, 0]]] - v[f], axis=2).max()
        if e <= max_edge or len(f) * 4 > MAX_FACES:
            break
        v, f = subdivide_once(v, f)
    return v, f


def _normals(v, f):
    """Normales de faces et normales de sommets pondérées par l'aire."""
    cr = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    vn = np.zeros_like(v)
    for k in range(3):
        np.add.at(vn, f[:, k], cr)
    fn = cr / np.maximum(np.linalg.norm(cr, axis=1, keepdims=True), 1e-20)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-20)
    return fn, vn


def displace(vertices, faces, height, depth=0.4, tile=12.5, rotation=0.0, offset=(0.0, 0.0), invert=False,
             midlevel=0.0, zone="all", keep_bottom=True):
    """Renvoie (vertices, faces) du maillage en relief. Coordonnées de l'objet (mm), z = 0 sur le plateau."""
    import trimesh
    t = trimesh.Trimesh(np.asarray(vertices, dtype=np.float64), np.asarray(faces, dtype=np.int64), process=True)
    v, f = t.vertices.copy(), t.faces.copy()
    # finesse : ~40 arêtes par tuile, bornée à 0,15–1 mm et au budget de triangles
    max_edge = float(np.clip(tile / 40.0, 0.15, 1.0))
    area = float(t.area)
    while area / (max_edge * max_edge * 0.43) > MAX_FACES:
        max_edge *= 1.25
    v, f = _subdivide(v, f, max_edge)
    fn, vn = _normals(v, f)
    zmin = v[:, 2].min()
    # faces texturées
    sel = np.ones(len(f), dtype=bool)
    if zone == "sides":
        sel &= np.abs(fn[:, 2]) < 0.7
    elif zone == "top":
        sel &= fn[:, 2] > 0.7
    bottom = (fn[:, 2] < -0.99) & (np.abs(v[f].max(axis=1)[:, 2] - zmin) < 1e-3)
    if keep_bottom:
        sel &= ~bottom
    vsel = np.zeros(len(v), dtype=bool)
    vsel[f[sel].ravel()] = True
    # projection tri-planaire
    th = np.deg2rad(rotation)
    c, s = np.cos(th), np.sin(th)
    w = np.abs(vn) ** 4
    w /= np.maximum(w.sum(axis=1, keepdims=True), 1e-12)
    hsum = np.zeros(len(v))
    for axis, (a, b) in enumerate(((1, 2), (0, 2), (0, 1))):     # plans YZ (axe X), XZ (axe Y), XY (axe Z)
        p, q = v[:, a] / tile, v[:, b] / tile
        u, vv = c * p - s * q + offset[0], s * p + c * q + offset[1]
        hsum += w[:, axis] * _sample(height, u, vv)
    if invert:
        hsum = 1.0 - hsum
    d = (hsum - midlevel) * depth
    d[~vsel] = 0.0
    disp = vn * d[:, None]
    if keep_bottom:
        # sommets de la face d'appui : ils ne bougent que dans le plan du plateau (la base reste à z = 0)
        on_bed = np.zeros(len(v), dtype=bool)
        on_bed[f[bottom].ravel()] = True
        disp[on_bed, 2] = 0.0
    out = v + disp
    return out, f
