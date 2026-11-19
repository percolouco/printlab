"""Test de non-régression : écriture puis relecture d'un projet 3MF (objets, matrices, pièces spéciales, réglages)."""
import os
import sys
import tempfile

import numpy as np

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.slicer import project3mf, slicer  # noqa: E402


def cube(s):
    v = np.array([[x, y, z] for x in (0, s) for y in (0, s) for z in (0, s)], dtype=float)
    f = np.array([[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]])
    return v, f


v, f = cube(10)
mv, mf = cube(4)
m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 120, 80, 0, 1]
objs = [{"name": "Cube", "vertices": v, "faces": f, "matrix": m, "extruder": 2, "settings": {"sparse_infill_density": "40%"},
         "parts": [{"name": "mod", "vertices": mv, "faces": mf, "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 3, 3, 1],
                    "subtype": "negative_part", "settings": {}}]}]
p = os.path.join(tempfile.mkdtemp(), "t.3mf")
slicer.write_3mf(p, objs, {"printer_settings_id": "P", "print_settings_id": "Q", "filament_settings_id": ["F"], "filament_colour": ["#ff0000"],
                           "different_settings_to_system": ["layer_height;", "", ""], "layer_height": "0.3"}, "Plateau A")
r = project3mf.parse(p)
o = r["objects"][0]
assert len(r["objects"]) == 1 and o["name"] == "Cube" and o["extruder"] == 2, o["name"]
assert np.allclose(o["vertices"], v) and np.allclose(o["matrix"], m)
assert o["settings"].get("sparse_infill_density") == "40%"
assert [x["subtype"] for x in o["parts"]] == ["negative_part"] and np.allclose(o["parts"][0]["matrix"][12:15], [3, 3, 3])
assert r["plates"][0]["name"] == "Plateau A"
assert project3mf.overrides_from_config(r["config"])["process"] == {"layer_height": "0.3"}
# projet à 2 plateaux : chaque objet doit revenir sur son plateau (identifiants d'instance corrects)
objs2 = [dict(objs[0]), {"name": "B", "vertices": v, "faces": f, "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 500, 80, 0, 1], "extruder": 1, "settings": {}, "parts": []}]
slicer.write_3mf(p, objs2, {"printer_settings_id": "P"}, "x", [{"name": "Un", "objects": [0]}, {"name": "Deux", "objects": [1]}])
r = project3mf.parse(p)
gid = {o["name"]: o["gid"] for o in r["objects"]}
assert [(pl["name"], pl["objects"]) for pl in r["plates"]] == [("Un", [gid["Cube"]]), ("Deux", [gid["B"]])], r["plates"]
# changements par couche (pause, changement de filament) : écrits et relus au format d'Orca
slicer.write_3mf(p, objs2, {"filament_colour": ["#fff", "#000"], "machine_pause_gcode": "PAUSE"}, "x",
                 [{"name": "Un", "objects": [0]}, {"name": "Deux", "objects": [1]}],
                 {"1": [{"z": 2.4, "type": 2, "extruder": 2, "color": "#000"}, {"z": 1.2, "type": 1}]})
r = project3mf.parse(p)
assert r["layer_gcodes"] == {1: [{"z": 1.2, "type": 1, "extruder": 1, "color": "", "extra": ""},
                                 {"z": 2.4, "type": 2, "extruder": 2, "color": "#000", "extra": ""}]}, r["layer_gcodes"]
# peinture (format TriangleSelector d'Orca) et hauteur de couche variable
objs3 = [dict(objs[0], paint={"color": {"0": "1C0C2C0C1C13", "3": "8"}, "supports": {"5": "4"}}, layer_profile=[0, 0.2, 0.2, 0.2, 0.2, 0.12, 0.32, 0.28])]
slicer.write_3mf(p, objs3, {"printer_settings_id": "P"}, "x")
r = project3mf.parse(p)
o = r["objects"][0]
assert o["paint"] == {"color": {0: "1C0C2C0C1C13", 3: "8"}, "supports": {5: "4"}}, o["paint"]
assert o["layer_profile"] == [0, 0.2, 0.2, 0.2, 0.2, 0.12, 0.32, 0.28], o["layer_profile"]
print("OK — relecture de projet 3MF (objets, pièces, réglages, plateaux, changements par couche, peinture, hauteur de couche)")
