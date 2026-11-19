"""Oreilles de bordure (« brim ears ») peintes, comme l'outil Oreilles de bordure d'OrcaSlicer (GLGizmoBrimEars).

Les points sont dans le repère de l'objet : (x, y, z, rayon) = BrimPoint (pos, head_front_radius) d'Orca, enregistrés
dans Metadata/brim_ear_points.txt (« brim_points_format_version=0 » puis « object_id=N|x y z r x y z r… »).
Ils n'ont d'effet que si le type de bordure de l'objet vaut « painted » (btPainted).
Génération automatique = GLGizmoBrimEars::auto_generate : section du maillage à z = 0,1 mm (première couche),
simplification Douglas-Peucker (rayon de détection), puis sommets convexes du contour / concaves des trous dont
l'angle dépasse 180 - angle max.
"""
import math

import numpy as np

SCALE = 1e6                     # SCALING_FACTOR d'Orca = 1e-6 mm
RADIUS_MIN, RADIUS_MAX = 0.1, 100.0


def default_radius(initial_layer_line_width):
    """get_brim_default_radius : largeur de ligne de la première couche × 8."""
    return min(max(float(initial_layer_line_width) * 8.0, RADIUS_MIN), RADIUS_MAX)


def first_layer(parts):
    """parts : [(vertices monde, faces, négatif ?)] → polygones de la section à z = 0,1 (contours CCW, trous CW), en mm."""
    from manifold3d import Manifold, Mesh
    pos, neg = None, None
    import trimesh
    for v, f, negative in parts:
        t = trimesh.Trimesh(np.asarray(v, dtype=np.float64), np.asarray(f, dtype=np.int64), process=True)   # sommets soudés
        m = Manifold(Mesh(vert_properties=np.ascontiguousarray(t.vertices, dtype=np.float32),
                          tri_verts=np.ascontiguousarray(t.faces, dtype=np.uint32)))
        if m.is_empty():
            continue
        if negative:
            neg = m if neg is None else neg + m
        else:
            pos = m if pos is None else pos + m
    if pos is None:
        return []
    if neg is not None:
        pos = pos - neg
    from manifold3d import JoinType
    # MeshSlicingParamsEx du gizmo : closing_radius 0,1 (fermeture), extra_offset 0,05 (offset_ex, onglets « miter » limite 3)
    cs = pos.slice(0.1).offset(0.1, JoinType.Miter, 3.0).offset(-0.1, JoinType.Miter, 3.0).offset(0.05, JoinType.Miter, 3.0)
    return [np.asarray(p, dtype=np.float64) for p in cs.to_polygons() if len(p) >= 3]


def _area(p):
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _dp(points, tol):
    """MultiPoint::_douglas_peucker (version itérative d'Orca), coordonnées entières mises à l'échelle."""
    pts = [tuple(p) for p in points]
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    tol2 = tol * tol
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if l2 == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
                d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d2 > best:
                best, idx = d2, i
        if idx >= 0 and best > tol2:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(pts, keep) if k]


def _filter(points, angle_threshold, convex):
    """filter_convex_concave_points_by_angle_threshold + filter_points_by_vectors."""
    out = []
    if len(points) < 3:
        return out
    cos_t = math.cos(math.nextafter(angle_threshold, math.inf)) if angle_threshold > 1e-4 else None
    p1 = points[-1]
    v1 = (p1[0] - points[-2][0], p1[1] - points[-2][1])
    for p2 in points:
        v2 = (p2[0] - p1[0], p2[1] - p1[1])
        cr = v1[0] * v2[1] - v1[1] * v2[0]
        ok = cr > 0 if convex else cr < 0
        if ok and cos_t is not None:
            n1, n2 = math.hypot(*v1), math.hypot(*v2)
            ok = n1 > 0 and n2 > 0 and (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2) < cos_t
        if ok:
            out.append(p1)
        v1, p1 = v2, p2
    return out


def _generate(poly_mm, detection, max_angle, outer):
    pts = [(round(x * SCALE), round(y * SCALE)) for x, y in poly_mm]
    if detection > 0:
        pts = _dp(pts + [pts[0]], detection * SCALE)
        if len(pts) > 4:
            pts = pts[:-1]
    thr = (180 - max_angle) * math.pi / 180.0
    return [(x / SCALE, y / SCALE) for x, y in _filter(pts, thr, outer)]


def auto_points(polys, detection=1.0, max_angle=125.0):
    """Points (x, y) en mm, repère monde, comme auto_generate."""
    out = []
    for p in polys:
        if _area(p) > 0:
            out += _generate(p, detection, max_angle, True)
        else:
            out += _generate(p[::-1], detection, max_angle, False)
    return out


def detection_max(polys):
    """get_detection_radius_max (borne du curseur « rayon de détection »)."""
    best = 0.0
    for p in polys:
        if _area(p) <= 0:
            continue
        pts = [(round(x * SCALE), round(y * SCALE)) for x, y in p]
        pts.append(pts[0])
        tol, rep, n_min = 0.0, 0, len(_dp(pts, 0))
        for _ in range(100):
            tol += 10
            n = len(_dp(pts, tol * SCALE))
            if n == n_min:
                rep += 1
                if rep > 1:
                    break
            n_min = n
        for _ in range(100):
            tol -= 1
            n = len(_dp(pts, tol * SCALE))
            if n <= n_min:
                n_min = n
            else:
                break
        tol += 1
        best = max(best, tol)
    return 100.0 if best > 100 or best <= 0 else best


def points_file(per_object):
    """Contenu de Metadata/brim_ear_points.txt ; per_object aligné sur l'ordre des objets (liste de [x, y, z, r])."""
    lines = []
    for i, pts in enumerate(per_object, start=1):
        if pts:
            lines.append(f"object_id={i}|" + " ".join(f"{float(x):f} {float(y):f} {float(z):f} {float(r):f}" for x, y, z, r in pts))
    return ("brim_points_format_version=0\n" + "\n".join(lines) + "\n") if lines else ""


def parse_points_file(text):
    out, lines = {}, text.strip().splitlines()
    if lines and lines[0].startswith("brim_points_format_version="):
        lines = lines[1:]
    for line in lines:
        head, _, vals = line.partition("|")
        try:
            oid = int(head.split("=")[1])
            nums = [float(x) for x in vals.split()]
        except (IndexError, ValueError):
            continue
        out[oid] = [nums[k:k + 4] for k in range(0, len(nums) - 3, 4)]
    return out


def orca_frame_shift(vertices, n_volumes):
    """Décalage entre notre repère d'objet et celui d'Orca après chargement d'un 3MF.
    _BBS_3MF_Importer : chaque volume est recentré sur le centre de sa boîte (center_geometry_after_creation) ;
    pour un objet à un seul volume, ce décalage passe dans l'instance et le volume revient à 0,0,0 : le repère de
    l'objet est alors centré sur la boîte du maillage. Avec plusieurs volumes, rien ne bouge.
    Les points d'oreilles étant relus tels quels, il faut les écrire dans ce repère : p_orca = p - décalage."""
    if n_volumes != 1 or vertices is None or not len(vertices):
        return np.zeros(3)
    v = np.asarray(vertices, dtype=np.float64)
    return (v.min(axis=0) + v.max(axis=0)) / 2
