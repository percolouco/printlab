"""Hauteur de couche variable : transposition de SlicingAdaptive.cpp et Slicing.cpp d'OrcaSlicer 2.5.

Profil = liste plate [z0, h0, z1, h1, …] (ModelObject::layer_height_profile), enregistré dans le 3MF dans
Metadata/layer_heights_profile.txt sous la forme « object_id=N|z0;h0;… » (_add_layer_height_profile_file_to_archive).
"""
import math

import numpy as np

f32 = np.float32
EPSILON = 1e-4
LAYER_HEIGHT_CHANGE_STEP = 0.04
MIN_LAYER_HEIGHT = 0.01
MIN_LAYER_HEIGHT_DEFAULT = 0.07


def slicing_params(layer_height, first_layer, nozzle_min, nozzle_max, object_height):
    """SlicingParameters::create_from_config (cas sans radeau ni support : couche initiale fixe)."""
    mn = MIN_LAYER_HEIGHT_DEFAULT if nozzle_min == 0 else max(MIN_LAYER_HEIGHT, nozzle_min)
    mx = nozzle_max if nozzle_max > 0 else layer_height
    mn = max(MIN_LAYER_HEIGHT, mn)
    mn = min(mn, layer_height)
    mx = max(mx, layer_height)
    return {"layer_height": layer_height, "first": first_layer, "min": mn, "max": mx, "height": object_height}


def _layer_height_from_slope(n_cos, n_sin, dev):
    return min(dev / f32(0.184), f32(1.44 * dev * math.sqrt(n_sin / n_cos)) if n_cos > 1e-5 else f32(np.finfo(np.float32).max))


def adaptive(vertices, faces, sp, quality=0.5):
    """layer_height_profile_adaptive : vertices dans le repère du plateau (instance appliquée), z ≥ 0."""
    tri = np.asarray(vertices, dtype=np.float32)[np.asarray(faces)]
    cr = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    nn = np.linalg.norm(cr, axis=1)
    n = cr / np.where(nn > 0, nn, 1)[:, None]
    zmin, zmax = tri[:, :, 2].min(axis=1), tri[:, :, 2].max(axis=1)
    faces_z = sorted(zip(zmin.tolist(), zmax.tolist(), np.abs(n[:, 2]).tolist(), np.sqrt(n[:, 0] ** 2 + n[:, 1] ** 2).tolist()),
                     key=lambda x: (x[0], x[1]))
    q = f32(quality)
    lerp = lambda a, b, t: f32(a) + f32(t) * (f32(b) - f32(a))  # noqa: E731
    dev = lerp(sp["min"], sp["layer_height"], f32(2) * q) if q < 0.5 else lerp(sp["max"], sp["layer_height"], f32(2) * (f32(1) - q))

    def next_height(print_z, cur):
        height = f32(sp["max"])
        oid = cur[0]
        first = False
        while oid < len(faces_z):
            z0, z1, nc, ns = faces_z[oid]
            if z0 >= print_z:
                break
            if z1 > print_z:
                if not first:
                    first = True
                    cur[0] = oid
                if z1 < print_z + EPSILON:
                    oid += 1
                    continue
                height = min(height, _layer_height_from_slope(nc, ns, dev))
            oid += 1
        height = max(height, f32(sp["min"]))
        if height > f32(sp["min"]):
            while oid < len(faces_z):
                z0, z1, nc, ns = faces_z[oid]
                if z0 >= print_z + height:
                    break
                if z1 < print_z + EPSILON:
                    oid += 1
                    continue
                red = _layer_height_from_slope(nc, ns, dev)
                zd = f32(z0 - print_z)
                if red < zd:
                    height = zd
                elif red < height:
                    height = red
                oid += 1
            height = max(height, f32(sp["min"]))
        return float(height)

    prof = [0.0, sp["first"], sp["first"], sp["first"]]
    print_z = sp["first"]
    cur = [0]
    H = sp["height"]
    while print_z + EPSILON < H:
        height = float(f32(min(next_height(f32(print_z), cur), float(f32(sp["max"])))))
        last = prof[-1]
        if last < height and height - last > LAYER_HEIGHT_CHANGE_STEP:
            height = last + LAYER_HEIGHT_CHANGE_STEP
        elif last > height and last - height > LAYER_HEIGHT_CHANGE_STEP:
            height = last - LAYER_HEIGHT_CHANGE_STEP
        prof += [print_z, height]
        print_z += height
    gap = H - prof[-2]
    if gap > 0:
        prof += [H, min(max(gap, sp["min"]), sp["max"])]
    return prof


def smooth(profile, sp, radius=5, keep_min=False):
    """smooth_height_profile : flou gaussien biaisé, appliqué 6 fois, première couche intacte."""
    def kernel(r):
        sigma = 0.3 * (r - 1) + 0.8
        two = 2.0 * sigma * sigma
        inv = 1.0 / math.sqrt(math.pi * two)
        return [inv * math.exp(-((i - r) ** 2) / two) for i in range(2 * r + 1)]

    def blur(p):
        skip = 4
        if len(p) - skip < 6:
            return list(p)
        r = max(int(radius), 1)
        k = kernel(r)
        two_r = 2 * r
        out = list(p[:skip])
        dh_all = sp["max"] - sp["min"]
        inv = 1.0 / dh_all if dh_all != 0 else 1.0
        band = r * sp["layer_height"]
        size = len(p)
        for i in range(skip, size, 2):
            zi, hi = p[i], p[i + 1]
            out.append(zi)
            h, wt = 0.0, 0.0
            for j in range(max(i - two_r, skip), min(i + two_r, size - 2) + 1, 2):
                kid = r + (j - i) // 2
                if abs(zi - p[j]) * sp["layer_height"] <= band:
                    w = k[kid] * math.sqrt(abs(sp["max"] - p[j + 1]) * inv)
                    h += w * p[j + 1]
                    wt += w
            h = min(max(hi if wt == 0 else h / wt, sp["min"]), sp["max"])
            if keep_min:
                h = min(h, hi)
            out.append(h)
        return out

    ret = list(profile)
    for _ in range(6):
        ret = blur(ret)
    return ret


def profile_file(profiles):
    """Contenu de Metadata/layer_heights_profile.txt ; profiles : liste alignée sur l'ordre des objets (None = aucun)."""
    lines = []
    for i, p in enumerate(profiles, start=1):
        if p and len(p) >= 4 and len(p) % 2 == 0:
            lines.append(f"object_id={i}|" + ";".join(f"{float(x):f}" for x in p))
    return "\n".join(lines) + ("\n" if lines else "")


def parse_profile_file(text):
    out = {}
    for line in text.splitlines():
        if not line.startswith("object_id="):
            continue
        head, _, vals = line.partition("|")
        try:
            out[int(head.split("=")[1])] = [float(x) for x in vals.split(";") if x.strip()]
        except ValueError:
            continue
    return out
