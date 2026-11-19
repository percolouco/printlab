"""Outils 3D du Slicer : coupe (connecteurs d'Orca), orientation automatique, texte 3D."""
import os
import sys

import numpy as np
import trimesh

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.slicer import cut, emboss, orient  # noqa: E402

# coupe d'un cube de 20 mm à mi-hauteur avec un tenon de 5 × 4 mm (règles de CutUtils.cpp)
b = trimesh.creation.box((20, 20, 20))
b.apply_translation((100, 100, 10))
r = cut.cut(b.vertices, b.faces, [100, 100, 10], [0, 0, 1],
            {"connectors": [{"type": "plug", "style": "prism", "shape": "circle", "x": 0, "y": 0, "size": 5, "depth": 4}]})
up, lo = r["upper"], r["lower"]
assert np.allclose(up["vertices"].min(axis=0), [-10, -10, 0]) and np.allclose(up["vertices"].max(axis=0), [10, 10, 10])
assert [p["subtype"] for p in up["parts"]] == ["negative_part"] and [p["subtype"] for p in lo["parts"]] == ["normal_part"]
hole = up["parts"][0]["vertices"]
assert np.isclose(hole[:, 2].min(), -0.05) and np.isclose(hole[:, 2].max(), 4.1)        # profondeur + tolérance + recouvrement
assert np.isclose(lo["parts"][0]["vertices"][:, 2].max(), 4.0)
# orientation : une colonne se couche, un cône pointe en bas se retourne
col = trimesh.creation.box((10, 10, 40))
R, _ = orient.orient(col.vertices, col.faces, 30, True, None)
v = col.vertices @ R.T
assert np.isclose(v[:, 2].max() - v[:, 2].min(), 10), v.max(0) - v.min(0)
cone = trimesh.creation.cone(10, 30)
cone.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [1, 0, 0]))
_, best = orient.orient(cone.vertices, cone.faces, 30, True, None)
assert np.allclose(best, [0, 0, -1], atol=1e-6), best
# texte : solide fermé, hauteur de police = size_in_mm / unités par em
p, upem = emboss.text_polygons("A", "DejaVuSans.ttf", 10)
tv, tf = emboss.extrude(p, 1.0)
assert trimesh.Trimesh(tv, tf).is_watertight and np.isclose(tv[:, 2].max(), 1.0)
# hauteur de couche adaptative : couches fines aux pôles d'une sphère, épaisses à l'équateur (comportement d'Orca)
from app.slicer import layerheight  # noqa: E402
sph = trimesh.creation.icosphere(4, 20)
sph.apply_translation((0, 0, 20))
sp = layerheight.slicing_params(0.2, 0.2, 0.08, 0.28, 40.0)
prof = layerheight.adaptive(sph.vertices, sph.faces, sp, 0.5)
zs, hs = prof[0::2], prof[1::2]
eq = [h for z, h in zip(zs, hs) if 19 < z < 21]
assert min(hs) >= 0.08 - 1e-6 and max(hs) <= 0.28 + 1e-6 and all(h > 0.27 for h in eq) and hs[3] < 0.2, (min(hs), max(hs), eq[:3], hs[:5])
assert all(abs(b - a) <= 0.04 + 1e-6 for a, b in zip(hs[2:], hs[3:]))          # LAYER_HEIGHT_CHANGE_STEP
print("OK — coupe, orientation, texte, hauteur de couche adaptative")
