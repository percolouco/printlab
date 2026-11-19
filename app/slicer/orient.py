"""Orientation automatique : transposition de libslic3r/Orient.cpp (AutoOrienter) d'OrcaSlicer 2.5.

Paramètres de l'interface d'Orca : OrientJob (réglage « Optimiser la surface d'interface des supports » activé par défaut
→ setMinimalSupportAreaPrams, min_volume = false), angle de surplomb = support_threshold_angle de l'objet/du process,
ventilateur auxiliaire (fan_direction / auxiliary_fan) → rotation autour de Z vers le flux d'air (find_cooling_direction2).
Résultat : matrice de rotation à appliquer AVANT la rotation actuelle de l'instance (instance->rotate(R) d'Orca).
"""
import math

import numpy as np
import trimesh

f32 = np.float32
EPS = 1e-4

PARAMS_DEFAULT = dict(TAR_A=0.01, TAR_B=0.177, RELATIVE_F=6.610621027964314, CONTOUR_F=0.23228623269775997, BOTTOM_F=1.167152017941474,
                      BOTTOM_HULL_F=0.1, TAR_C=0.24308070476924726, TAR_D=0.6284515508160871, TAR_E=0.0, FIRST_LAY_H=0.2,
                      LAF_MAX=0.999, LAF_MIN=0.9703, TAR_LAF=0.01, TAR_PROJ_AREA=0.1, BOTTOM_MIN=0.1, APPERANCE_FACE_SUPP=3.0,
                      use_low_angle_face=True, min_volume=False)
# setMinimalSupportAreaPrams (OrientJob.cpp), utilisé par défaut dans l'interface
PARAMS_MIN_AREA = dict(PARAMS_DEFAULT, TAR_A=0.015, TAR_B=0.177, RELATIVE_F=20.0, CONTOUR_F=0.5, BOTTOM_F=2.5, BOTTOM_HULL_F=0.1,
                       TAR_C=0.1, TAR_D=1.0, TAR_E=0.0115, FIRST_LAY_H=0.2, LAF_MAX=0.999, LAF_MIN=0.97, TAR_LAF=0.001,
                       TAR_PROJ_AREA=0.1, BOTTOM_MIN=0.1, APPERANCE_FACE_SUPP=3.0, min_volume=False)

SUPPLEMENTS = [(0, 0, -1), (0.70710678, 0, -0.70710678), (0, 0.70710678, -0.70710678), (-0.70710678, 0, -0.70710678), (0, -0.70710678, -0.70710678),
               (1, 0, 0), (0.70710678, 0.70710678, 0), (0, 1, 0), (-0.70710678, 0.70710678, 0), (-1, 0, 0), (-0.70710678, -0.70710678, 0),
               (0, -1, 0), (0.70710678, -0.70710678, 0), (0.70710678, 0, 0.70710678), (0, 0.70710678, 0.70710678),
               (-0.70710678, 0, 0.70710678), (0, -0.70710678, 0.70710678), (0, 0, 1)]


def _face_data(v, f):
    tri = v[f].astype(np.float32)
    cr = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    norm = np.linalg.norm(cr, axis=1)
    normals = (cr / np.where(norm > 0, norm, 1)[:, None]).astype(np.float32)
    areas = (0.5 * norm).astype(np.float32)
    return tri, normals, areas


def _area_cumulation_accurate(normals, areas, n):
    """Regroupe les faces par normale quantifiée (floor(x*1000)/1000), garde la normale de la plus grande face de chaque groupe."""
    q = np.floor(normals * 1000) / 1000
    groups = {}
    for i, key in enumerate(map(tuple, q)):
        g = groups.get(key)
        if g is None:
            groups[key] = [float(areas[i]), float(areas[i]), normals[i]]
        else:
            g[1] += float(areas[i])
            if areas[i] > g[0]:
                g[0] = float(areas[i])
                g[2] = normals[i]
    items = sorted(groups.values(), key=lambda g: -g[1])
    return [tuple(map(float, g[2])) for g in items[:min(n, len(items))]]


def _rotation_from_two_vectors(a, b):
    """Eigen::Quaterniond().setFromTwoVectors(a, b).toRotationMatrix()"""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    c = float(np.dot(a, b))
    if c < -1 + 1e-12:
        # vecteurs opposés : axe = vecteur singulier (comme Eigen)
        M = np.vstack([a, b])
        _, _, vt = np.linalg.svd(M)
        axis = vt[2]
        w, xyz = 0.0, axis
    else:
        s = math.sqrt((1 + c) * 2)
        xyz = np.cross(a, b) / s
        w = s * 0.5
    x, y, z = xyz
    n = math.sqrt(w * w + x * x + y * y + z * z)
    w, x, y, z = w / n, x / n, y / n, z / n
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def orient(vertices, faces, overhang_angle=30.0, min_area=True, cooling_direction=None):
    """Renvoie (rotation 3×3 à appliquer, orientation choisie) pour un maillage dans le repère de l'objet."""
    P = PARAMS_MIN_AREA if min_area else dict(PARAMS_DEFAULT, min_volume=True)
    ASCENT = f32(math.cos(math.pi - overhang_angle * math.pi / 180))
    v = np.asarray(vertices, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64)
    tri, normals, areas = _face_data(v, f)
    from manifold3d import Manifold            # coque convexe 3D (Orca : its_convex_hull / qhull)
    hm = Manifold.hull_points(np.ascontiguousarray(v, dtype=np.float32)).to_mesh()
    htri, hnormals, hareas = _face_data(np.asarray(hm.vert_properties, dtype=np.float64)[:, :3], np.asarray(hm.tri_verts, dtype=np.int64))

    orients = [(0.0, 0.0, -1.0)]
    orients += _area_cumulation_accurate(normals, areas, 10)
    orients += _area_cumulation_accurate(hnormals, hareas, 14)
    orients += [tuple(map(float, x)) for x in SUPPLEMENTS]
    uniq = [orients[0]]
    for o in orients[1:]:          # remove_duplicates (isApprox, tolérance 1e-7)
        ov = np.array(o)
        if np.allclose(ov, 0, atol=1e-7):
            continue
        if any(np.linalg.norm(ov - np.array(u)) <= 1e-7 * min(np.linalg.norm(ov), np.linalg.norm(u)) for u in uniq):
            continue
        uniq.append(o)

    results = []
    for o in uniq:
        orientation = -np.array(o, dtype=np.float32)
        zp = tri @ orientation                         # (n, 3)
        z_max = zp.max(axis=1)
        z_mean = zp.mean(axis=1)
        zh_max = (htri @ orientation).max(axis=1)
        total_min_z = zp.min()
        FLH = f32(P["FIRST_LAY_H"])
        bottom_c = z_max < total_min_z + FLH - f32(EPS)
        bottom_hc = zh_max < total_min_z + FLH - f32(EPS)
        bottom_c2 = z_max < total_min_z + FLH / f32(2) - f32(EPS)
        bottom = f32(areas[bottom_c].sum() * f32(0.5) + areas[bottom_c2].sum())
        nproj = normals @ orientation
        areas_app = areas * f32(1)          # pas de faces « apparence » peintes
        overhang_areas = np.where((nproj < ASCENT) & ~bottom_c2, areas_app, f32(0))
        inner = np.abs(np.minimum(nproj - ASCENT, 0))
        if P["min_volume"]:
            overhang = f32((((z_mean - total_min_z) * overhang_areas) * inner).sum())
        else:
            overhang = f32(np.abs(overhang_areas).sum())
        contour = f32(4 * math.sqrt(float(bottom)))
        bottom_hull = f32(hareas[bottom_hc].sum())
        na = np.abs(nproj)
        laf = f32(areas[(na < f32(P["LAF_MAX"])) & (na > f32(P["LAF_MIN"])) & (z_max > total_min_z + FLH)].sum())
        area_projected = 0.0
        if P["min_volume"]:
            ov = overhang / 25
            cost = P["TAR_A"] * (ov + P["TAR_B"]) + P["RELATIVE_F"] * (ov * P["TAR_C"] + P["TAR_D"] + P["TAR_LAF"] * laf * P["use_low_angle_face"]) / (
                P["TAR_D"] + P["CONTOUR_F"] * contour + P["BOTTOM_F"] * bottom + P["BOTTOM_HULL_F"] * bottom_hull + P["TAR_E"] * ov + P["TAR_PROJ_AREA"] * area_projected)
        else:
            cost = P["RELATIVE_F"] * (overhang * P["TAR_C"] + P["TAR_D"] + P["TAR_LAF"] * laf * P["use_low_angle_face"]) / (
                P["TAR_D"] + P["CONTOUR_F"] * contour + P["BOTTOM_F"] * bottom + P["BOTTOM_HULL_F"] * bottom_hull + P["TAR_PROJ_AREA"] * area_projected)
        cost = float(f32(cost)) + (100 if bottom < P["BOTTOM_MIN"] else 0)
        cool = None
        if cooling_direction is not None:
            cond = (nproj < f32(-0.6427)) & (nproj > f32(-0.97))
            a_ = np.where(cond & ~bottom_c2, areas, f32(0))
            cool = a_ * (f32(1) - nproj)
        results.append((orientation.astype(np.float64), cost, cool))
    # tri stable par coût ; à coût égal (EPSILON), Orca préfère l'orientation d'origine (0, 0, 1)
    results.sort(key=lambda r: r[1])
    best, best_i = results[0][0], 0
    n1 = np.array([0.0, 0.0, 1.0])
    for i in range(1, len(results) - 1):
        if abs(results[i][1] - results[0][1]) < EPS and abs(float(results[0][0] @ n1) - 1) > EPS:
            if abs(float(results[i][0] @ n1) - 1) < EPS * EPS:
                best, best_i = n1, i
                break
        else:
            break
    R = _rotation_from_two_vectors(best, [0, 0, 1])
    if cooling_direction is not None and results[best_i][2] is not None:
        R = _cooling(R, v, f, results[best_i][2], np.asarray(cooling_direction, dtype=np.float64)) @ R
    return R, best.tolist()


def _cooling(R, v, f, areas_in, machine_dir):
    """find_cooling_direction2 : rotation autour de Z qui expose le plus les surplombs au flux d'air du ventilateur."""
    vr = v @ R.T
    tri, normals, _ = _face_data(vr, f)
    best_dir, best_val, origin_val = np.zeros(3), 0.0, 0.0
    for i in range(180):
        a = math.radians(i * 2.0)
        d = np.array([math.cos(a), math.sin(a), 0.0], dtype=np.float32)
        proj = normals @ d
        val = float((areas_in * np.where((areas_in > 0) & (proj > 0), proj, 0)).sum())
        if val > best_val:
            best_val, best_dir = val, d.astype(np.float64)
        if float(d @ machine_dir) > 0.999:
            origin_val = val
    if abs(origin_val - best_val) < 1.0 or not best_dir.any():
        best_dir = machine_dir
    return _rotation_from_two_vectors(best_dir, machine_dir)
