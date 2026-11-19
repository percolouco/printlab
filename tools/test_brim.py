"""Oreilles de bordure : génération automatique (règles de GLGizmoBrimEars) et prise en compte par le vrai moteur d'Orca.
À lancer dans le conteneur : python -m tools.test_brim (ou /venv/bin/python tools/test_brim.py depuis /app)."""
import asyncio
import os
import re
import sys
import tempfile
from pathlib import Path

import numpy as np
import trimesh

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.slicer import brim, project3mf, slicer  # noqa: E402

# un pavé 30 × 20 × 5 : 4 coins convexes à 90° → 4 oreilles (angle max 125° : seuil 55°)
box = trimesh.creation.box((30, 20, 5))
box.apply_translation((0, 0, 2.5))
W = np.eye(4)
W[:3, 3] = (128, 128, 0)
polys = brim.first_layer([(box.vertices + W[:3, 3], box.faces, False)])
pts = brim.auto_points(polys, 1.0, 125.0)
assert len(pts) == 4, pts
assert all(abs(abs(x - 128) - 15.05) < 1e-3 and abs(abs(y - 128) - 10.05) < 1e-3 for x, y in pts), pts   # + extra_offset 0,05
# trou carré dans une plaque : comme Orca (trous retournés puis concave_points), un trou convexe ne reçoit pas d'oreille
outer = trimesh.creation.box((40, 40, 3))
hole = trimesh.creation.box((10, 10, 10))
plate = outer.difference(hole)
plate.apply_translation((0, 0, 1.5))
pp = brim.auto_points(brim.first_layer([(plate.vertices, plate.faces, False)]), 1.0, 125.0)
assert len(pp) == 4, pp

# découpe par Orca : avec les oreilles + bordure « painted », la première couche contient des oreilles de 4 mm de rayon
r = 4.0
local = [[x - 128, y - 128, -0.0001, r] for x, y in pts]


async def slice_with(brim_points, brim_type):
    d = Path(tempfile.mkdtemp())
    cfg = slicer.build_config("Qidi X-Max 4 0.4 nozzle", "0.20mm Standard @X-Max 4", ["QIDI PLA Rapido @Qidi X-Max 4 0.4 nozzle"], ["#F2754E"])
    m = np.eye(4)
    m[:3, 3] = (128, 128, 0)
    obj = {"name": "pave", "vertices": box.vertices.tolist(), "faces": box.faces.tolist(), "matrix": m.T.flatten().tolist(),
           "extruder": 1, "settings": {"brim_type": brim_type}, "parts": [], "brim_points": brim_points}
    slicer.write_3mf(d / "p.3mf", [obj], cfg)
    back = project3mf.parse(d / "p.3mf")["objects"][0].get("brim_points") or []
    assert np.allclose(back, brim_points, atol=1e-5), (back, brim_points)
    gpath, _ = await slicer.run_slice(d, d / "p.3mf")
    g = gpath.read_text()
    first = g.split(";LAYER_CHANGE")[1] if ";LAYER_CHANGE" in g else g
    xy = np.array([(float(a), float(b)) for a, b in re.findall(r"G1 X([-\d.]+) Y([-\d.]+) E", first.split(";LAYER_CHANGE")[0])])
    return xy


painted = asyncio.run(slice_with(local, "painted"))
plain = asyncio.run(slice_with(local, "no_brim"))
ext = lambda a: (a[:, 0].min(), a[:, 0].max(), a[:, 1].min(), a[:, 1].max())  # noqa: E731
pe, ne = ext(painted), ext(plain)
# les oreilles débordent du coin de ~ rayon (4 mm) au-delà du pavé ; sans bordure on reste sur le pavé
assert pe[0] < ne[0] - 3 and pe[1] > ne[1] + 3 and pe[2] < ne[2] - 3 and pe[3] > ne[3] + 3, (pe, ne)
print("OK — oreilles : génération auto (4 coins, trou convexe ignoré), relecture 3MF, oreilles dans le G-code d'Orca", pe, ne)
