"""Coupe d'un objet par un plan, avec connecteurs, sur le modèle de l'outil Coupe d'OrcaSlicer 2.5.

Repris d'Orca (GLGizmoCut3D, CutUtils.cpp, TriangleMesh.cpp) :
- repère de coupe : le plan est z = 0, la partie haute est du côté +z ;
- partie haute « posée sur la coupe » par défaut, partie basse dans son orientation d'origine ; « retourner » = 180° autour de X ;
- connecteurs : maillages unitaires d'Orca (its_make_cylinder / its_make_frustum / its_make_frustum_dowel) mis à l'échelle
  (rayon, rayon, hauteur), recentrés comme à leur chargement dans Orca ;
  * tenon (Plug) : pièce solide de la partie basse, logement (pièce négative) dans la partie haute avec la tolérance ;
  * goujon (Dowel) : logement dans chaque partie + un goujon séparé ; un goujon « prisme » a une hauteur doublée.
La coupe du maillage elle-même est calculée par Manifold (bouchage de la section inclus).
"""
import math

import numpy as np

CONNECTOR_HOLE_OVERLAP = 0.05
SECTORS = {"triangle": 3, "square": 4, "hexagon": 6, "circle": 360}


# ---------- maillages unitaires d'Orca ----------

def _cylinder(r, h, fa, top_scale=1.0):
    n = int(math.ceil(2 * math.pi / fa))
    step = 2 * math.pi / n
    v = [(0.0, 0.0, 0.0), (0.0, 0.0, h)]
    f = []

    def ring(i):
        a = step * i
        # Eigen::Rotation2Df(a) * (0, r)
        return (-math.sin(a) * r, math.cos(a) * r), (-math.sin(a) * r * top_scale, math.cos(a) * r * top_scale)
    b, t = ring(0)
    v += [(b[0], b[1], 0.0), (t[0], t[1], h)]
    for i in range(1, n):
        b, t = ring(i)
        v += [(b[0], b[1], 0.0), (t[0], t[1], h)]
        k = len(v) - 1
        f += [(0, k - 1, k - 3), (k, 1, k - 2), (k, k - 2, k - 3), (k, k - 3, k - 1)]
    k = len(v) - 1
    f += [(0, 2, k - 1), (3, 1, k), (k, 2, 3), (k, k - 1, 2)]
    return np.array(v, dtype=np.float64), np.array(f, dtype=np.int64)


def _frustum_dowel(radius, h, sectors):
    stacks = 2
    sstep = 2 * math.pi / sectors
    tstep = math.pi / stacks
    v = []
    for i in range(stacks + 1):
        a = 0.5 * math.pi - tstep * i
        xy, z = radius * math.cos(a), radius * math.sin(a)
        if i in (0, stacks):
            v.append((xy, 0.0, h * math.sin(a)))
        else:
            for j in range(sectors):
                sa = sstep * j + 0.25 * math.pi
                v.append((xy * math.cos(sa), xy * math.sin(sa), z))
    f = []
    for i in range(stacks):
        k1 = 0 if i == 0 else 1 + (i - 1) * sectors
        k1f = k1
        k2 = 1 if i == 0 else k1 + sectors
        k2f = k2
        for j in range(sectors):
            k1n, k2n = k1, k2
            if i != 0:
                k1n = k1f if j + 1 == sectors else k1 + 1
                f.append((k1, k2, k1n))
            if i != stacks - 1:
                k2n = k2f if j + 1 == sectors else k2 + 1
                f.append((k1n, k2, k2n))
            k1, k2 = k1n, k2n
    return np.array(v, dtype=np.float64), np.array(f, dtype=np.int64)


def connector_unit_mesh(ctype, style, shape):
    n = SECTORS.get(shape, 360)
    if style == "prism":
        v, f = _cylinder(1.0, 1.0, 2 * math.pi / n)
    elif ctype == "plug":
        v, f = _cylinder(1.0, 1.0, 2 * math.pi / n, top_scale=0.5)
    else:
        v, f = _frustum_dowel(1.0, 1.0, n)
    # « Mesh will be centered when loading » : centre de la boîte englobante à l'origine
    lo, hi = v.min(axis=0), v.max(axis=0)
    return v - (lo + hi) / 2, f


def _rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)


def connector_mesh(c, hole):
    """Maillage du connecteur dans le repère de coupe (plan z = 0). hole=True : logement avec tolérances."""
    r = float(c.get("size", 2.5)) * 0.5
    h = float(c.get("depth", 3.0))
    rtol = float(c.get("size_tolerance", 0.0)) * 0.5
    htol = float(c.get("depth_tolerance", 0.1))
    ctype, style = c.get("type", "plug"), c.get("style", "prism")
    if ctype == "dowel" and style == "prism":
        h *= 2
    v, f = connector_unit_mesh(ctype, style, c.get("shape", "circle"))
    pos = np.array([float(c["x"]), float(c["y"]), 0.0])
    if ctype != "dowel":
        pos[2] += 0.5 * h            # le tenon part du plan vers la partie haute
    sx = sy = r
    sz = h
    if hole:
        sx += rtol
        sy += rtol
        sz += htol
        if ctype != "dowel":
            sz += CONNECTOR_HOLE_OVERLAP
            pos[2] += 0.5 * (htol - CONNECTOR_HOLE_OVERLAP)
    v = (v * [sx, sy, sz]) @ _rot_z(-math.radians(float(c.get("angle", 0)))).T + pos
    return v, f


# ---------- coupe ----------

def _to_manifold(v, f):
    from manifold3d import Manifold, Mesh
    m = Manifold(Mesh(vert_properties=np.ascontiguousarray(v, dtype=np.float32), tri_verts=np.ascontiguousarray(f, dtype=np.uint32)))
    if m.status().name != "NoError" or m.is_empty():
        raise ValueError("maillage non fermé : utilise « Réparer » avant de couper")
    return m


def _from_manifold(m):
    mesh = m.to_mesh()
    return np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3], np.asarray(mesh.tri_verts, dtype=np.int64)


def cut_frame(point, normal):
    """Matrice (4×4) du repère de coupe : origine sur le plan, z = normale."""
    n = np.asarray(normal, dtype=np.float64)
    n /= np.linalg.norm(n)
    a = np.array([1.0, 0, 0]) if abs(n[0]) < 0.9 else np.array([0, 1.0, 0])
    x = np.cross(a, n)
    x /= np.linalg.norm(x)
    y = np.cross(n, x)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, y, n, point
    if abs(n[2] - 1) < 1e-9:      # plan horizontal : repère aligné sur le plateau
        m[:3, :3] = np.eye(3)
    return m


def cut(vertices_world, faces, point, normal, opts):
    """Coupe un maillage exprimé dans le repère du plateau.

    Retourne {"upper": {...}|None, "lower": {...}|None, "dowels": [...]}, chaque partie :
    {"vertices", "faces" (repère final, posé), "parts": [{"subtype", "vertices", "faces"}]} ; les maillages sont dans le
    repère de la pièce finale (orientation déjà appliquée), à poser sur le plateau.
    """
    F = cut_frame(point, normal)
    Finv = np.linalg.inv(F)
    v = np.asarray(vertices_world, dtype=np.float64) @ Finv[:3, :3].T + Finv[:3, 3]
    m = _to_manifold(v, faces)
    upper_m, lower_m = m.split_by_plane((0.0, 0.0, 1.0), 0.0)
    conns = opts.get("connectors") or []
    flip = np.diag([1.0, -1.0, -1.0])           # 180° autour de X

    def finish(man, side):
        if man.is_empty():
            return None
        pv, pf = _from_manifold(man)
        parts = []
        for c in conns:
            ctype = c.get("type", "plug")
            if ctype == "plug":
                hole = side == "upper"
                cv, cf = connector_mesh(c, hole=hole)
                parts.append({"subtype": "negative_part" if hole else "normal_part", "name": "Connecteur", "vertices": cv, "faces": cf})
            elif ctype == "dowel":
                cv, cf = connector_mesh(c, hole=True)
                parts.append({"subtype": "negative_part", "name": "Connecteur", "vertices": cv, "faces": cf})
        place = opts.get(f"place_{side}", side == "upper")
        rot = opts.get(f"flip_{side}", False)
        # orientation finale : posé sur la coupe = repère de coupe (partie haute) ou repère de coupe retourné (partie basse)
        if place:
            R = np.eye(3) if side == "upper" else flip
        else:
            R = F[:3, :3]                         # orientation d'origine (repère du plateau)
        if rot:
            R = flip @ R
        tr = lambda x: x @ R.T  # noqa: E731
        return {"vertices": tr(pv), "faces": pf, "parts": [{**p, "vertices": tr(p["vertices"])} for p in parts], "placed": bool(place or rot)}

    out = {"upper": finish(upper_m, "upper") if opts.get("keep_upper", True) else None,
           "lower": finish(lower_m, "lower") if opts.get("keep_lower", True) else None, "dowels": []}
    for c in conns:
        if c.get("type") == "dowel":
            dv, df = connector_mesh(c, hole=False)
            dv = dv - [float(c["x"]), float(c["y"]), 0.0]
            out["dowels"].append({"vertices": dv, "faces": df})
    return out


# ---------- section et placement automatique des connecteurs ----------

def _inside_many(pts, polys):
    """Pair-impair vectorisé : quels points sont dans l'ensemble des contours (trous compris)."""
    x, y = pts[:, 0][:, None], pts[:, 1][:, None]
    c = np.zeros(len(pts), dtype=bool)
    for p in polys:
        x1, y1 = p[:, 0][None, :], p[:, 1][None, :]
        x2, y2 = np.roll(p[:, 0], -1)[None, :], np.roll(p[:, 1], -1)[None, :]
        cross = ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-300) + x1)
        c ^= (cross.sum(axis=1) % 2).astype(bool)
    return c


def section(vertices_world, faces, point, normal, count=0, size=2.5):
    """Contours de la section (repère de coupe) et positions proposées pour `count` connecteurs."""
    F = cut_frame(point, normal)
    Finv = np.linalg.inv(F)
    v = np.asarray(vertices_world, dtype=np.float64) @ Finv[:3, :3].T + Finv[:3, 3]
    m = _to_manifold(v, faces)
    cs = m.slice(0.0)
    polys = [np.asarray(p, dtype=np.float64) for p in cs.to_polygons()]
    out = {"polygons": [p.tolist() for p in polys], "area": float(cs.area()), "frame": F.T.flatten().tolist(), "positions": []}
    if count <= 0 or not polys:
        return out
    inner = cs.offset(-(size * 0.5 + 1.0))
    try:
        ipolys = [np.asarray(p, dtype=np.float64) for p in inner.to_polygons()] or polys
    except Exception:
        ipolys = polys
    allp = np.concatenate(ipolys)
    lo, hi = allp.min(axis=0), allp.max(axis=0)
    step = max((hi - lo).max() / 60.0, 0.2)
    xs, ys = np.arange(lo[0], hi[0] + step, step), np.arange(lo[1], hi[1] + step, step)
    grid = np.array([(x, y) for x in xs for y in ys], dtype=np.float64)
    cand = grid[_inside_many(grid, ipolys)]
    if not len(cand):
        return out
    c0 = cand.mean(axis=0)
    first = cand[np.argmin(((cand - c0) ** 2).sum(axis=1))] if count == 1 else cand[np.argmax(((cand - c0) ** 2).sum(axis=1))]
    chosen = [first]
    while len(chosen) < count:       # points les plus éloignés les uns des autres
        d = np.min([((cand - c) ** 2).sum(axis=1) for c in chosen], axis=0)
        chosen.append(cand[int(np.argmax(d))])
    out["positions"] = [[round(float(p[0]), 3), round(float(p[1]), 3)] for p in chosen]
    return out
