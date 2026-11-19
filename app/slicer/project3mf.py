"""Lecture d'un projet .3mf d'OrcaSlicer / QIDI Studio / Bambu Studio.

Restitue : objets (maillage + matrice), pièces spéciales (modificateurs, volumes négatifs, bloqueurs/forceurs
de supports), extrudeur et réglages par objet/pièce, plateaux, et la configuration de projet (imprimante,
process, filaments, couleurs, réglages modifiés par rapport aux profils système).

Les maillages sont conservés dans le repère local de l'objet : la transformation du <build>
(item) est reprise telle quelle comme matrice de l'objet, ce qui permet de réécrire le 3MF à l'identique.
"""
import json
import re
import zipfile
from pathlib import PurePosixPath

import numpy as np
from lxml import etree

NS_CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
NS_PROD = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06"
SUBTYPES = {"normal_part", "modifier_part", "negative_part", "support_blocker", "support_enforcer"}
IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def _tf(text):
    """transform 3MF (12 valeurs, vecteurs-lignes) -> tableau three.js 16 valeurs (colonnes)."""
    if not text:
        return list(IDENT)
    v = [float(x) for x in text.split()]
    if len(v) != 12:
        return list(IDENT)
    return [v[0], v[1], v[2], 0, v[3], v[4], v[5], 0, v[6], v[7], v[8], 0, v[9], v[10], v[11], 1]


def _mat(arr):
    return np.array(arr, dtype=np.float64).reshape(4, 4).T  # colonnes -> matrice usuelle


def _apply(m, v):
    return v @ m[:3, :3].T + m[:3, 3]


PAINT_ATTRS = {"paint_supports": "supports", "paint_seam": "seam", "paint_color": "color", "paint_fuzzy_skin": "fuzzy"}


def _read_mesh(obj):
    mesh = obj.find(f"{{{NS_CORE}}}mesh")
    if mesh is None:
        return None
    verts = np.array([[float(x.get("x")), float(x.get("y")), float(x.get("z"))]
                      for x in mesh.iter(f"{{{NS_CORE}}}vertex")], dtype=np.float64)
    tl, paint = [], {}
    for i, x in enumerate(mesh.iter(f"{{{NS_CORE}}}triangle")):
        tl.append([int(x.get("v1")), int(x.get("v2")), int(x.get("v3"))])
        for attr, mode in PAINT_ATTRS.items():
            h = x.get(attr)
            if h:
                paint.setdefault(mode, {})[i] = h
    tris = np.array(tl, dtype=np.int64)
    if not len(verts) or not len(tris):
        return None
    return verts, tris, paint


def _parse_model(z, name):
    """Retourne {objectid: {mesh:(v,f)|None, components:[{objectid,path,transform}]}} et la liste <build>."""
    root = etree.fromstring(z.read(name))
    objs = {}
    for o in root.iter(f"{{{NS_CORE}}}object"):
        comps = [{"objectid": c.get("objectid"), "path": c.get(f"{{{NS_PROD}}}path"), "transform": c.get("transform")}
                 for c in o.iter(f"{{{NS_CORE}}}component")]
        objs[o.get("id")] = {"mesh": _read_mesh(o), "components": comps}
    build = [{"objectid": i.get("objectid"), "transform": i.get("transform"), "printable": i.get("printable", "1")}
             for i in root.iter(f"{{{NS_CORE}}}item")]
    return objs, build


# réglages par plateau d'Orca (boîte « Réglages du plateau ») écrits dans model_settings.config
PLATE_KEYS = ("bed_type", "print_sequence", "spiral_mode", "first_layer_print_sequence")


def layer_ranges_xml(z):
    """Metadata/layer_config_ranges.xml (modificateurs par plage de hauteur) → {rang d'objet: [{min_z, max_z, settings}]}."""
    if "Metadata/layer_config_ranges.xml" not in z.namelist():
        return {}
    root = etree.fromstring(z.read("Metadata/layer_config_ranges.xml"))
    out = {}
    for o in root.iter("object"):
        rs = []
        for r in o.findall("range"):
            rs.append({"min_z": float(r.get("min_z")), "max_z": float(r.get("max_z")),
                       "settings": {op.get("opt_key"): (op.text or "") for op in r.findall("option")}})
        out[int(o.get("id"))] = rs
    return out


def _settings_xml(z):
    if "Metadata/model_settings.config" not in z.namelist():
        return {}, []
    root = etree.fromstring(z.read("Metadata/model_settings.config"))
    objects = {}
    for o in root.findall("object"):
        meta = {m.get("key"): m.get("value") for m in o.findall("metadata") if m.get("key")}
        parts = {}
        for p in o.findall("part"):
            pm = {m.get("key"): m.get("value") for m in p.findall("metadata") if m.get("key")}
            parts[p.get("id")] = {"subtype": p.get("subtype", "normal_part"), "meta": pm}
        objects[o.get("id")] = {"meta": meta, "parts": parts}
    plates = []
    for p in root.findall("plate"):
        meta = {m.get("key"): m.get("value") for m in p.findall("metadata") if m.get("key")}
        inst = [i for mi in p.findall("model_instance") for i in [{m.get("key"): m.get("value") for m in mi.findall("metadata")}]]
        ps = {k: meta[k] for k in PLATE_KEYS if meta.get(k) not in (None, "")}
        if "spiral_mode" in ps:
            ps["spiral_mode"] = "1" if ps["spiral_mode"].lower() in ("true", "1") else "0"
        plates.append({"id": meta.get("plater_id"), "name": meta.get("plater_name") or "", "objects": [i.get("object_id") for i in inst],
                       "settings": ps})
    return objects, plates


# réglages d'objet/pièce qui ne sont pas des paramètres d'Orca
_NOT_SETTINGS = {"name", "extruder", "matrix", "source_object_id", "source_volume_id", "source_offset_x", "source_offset_y",
                 "source_offset_z", "source_in_inches", "source_in_meters", "source_file", "volume_type", "face_count",
                 "text", "font", "mesh_stat"}


def _settings(meta):
    return {k: v for k, v in meta.items() if k not in _NOT_SETTINGS and not k.startswith("source_")}


def parse(path):
    """Lit un .3mf. Retourne {"objects": [...], "plates": [...], "config": {...}|None, "app": str}."""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        main, build = _parse_model(z, "3D/3dmodel.model")
        files = {}

        def sub(pth):
            pth = pth.lstrip("/")
            if pth not in files:
                files[pth] = _parse_model(z, pth)[0] if pth in names else {}
            return files[pth]

        cfg_objects, plates = _settings_xml(z)
        config = None
        if "Metadata/project_settings.config" in names:
            try:
                config = json.loads(z.read("Metadata/project_settings.config"))
            except Exception:
                config = None
        app = ""
        try:
            for m in etree.fromstring(z.read("3D/3dmodel.model")).iter(f"{{{NS_CORE}}}metadata"):
                if m.get("name") == "Application":
                    app = m.text or ""
        except Exception:
            pass

        layer_gcodes = {}
        lg_name = next((n for n in ("Metadata/custom_gcode_per_layer.xml", "Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml") if n in names), None)
        if lg_name:
            try:
                root = etree.fromstring(z.read(lg_name))
                for pl in root.findall("plate"):
                    info = pl.find("plate_info")
                    pid = int(info.get("id")) - 1 if info is not None else 0
                    items = []
                    for ly in pl.findall("layer"):
                        items.append({"z": float(ly.get("top_z")), "type": int(ly.get("type", 1)), "extruder": int(ly.get("extruder", 1)),
                                      "color": ly.get("color", ""), "extra": ly.get("extra", "")})
                    if items:
                        layer_gcodes[pid] = items
            except Exception:
                layer_gcodes = {}

        lh = {}
        if "Metadata/layer_heights_profile.txt" in names:
            from .layerheight import parse_profile_file
            lh = parse_profile_file(z.read("Metadata/layer_heights_profile.txt").decode("utf-8", "replace"))

        lr = layer_ranges_xml(z)
        bp = {}
        if "Metadata/brim_ear_points.txt" in names:
            from .brim import parse_points_file
            bp = parse_points_file(z.read("Metadata/brim_ear_points.txt").decode("utf-8", "replace"))

        out = []
        for it in build:
            gid = it["objectid"]
            grp = main.get(gid)
            if grp is None:
                continue
            cfg = cfg_objects.get(gid, {"meta": {}, "parts": {}})
            volumes = []  # (subtype, name, extruder, settings, verts, faces, matrix_rel)
            comps = grp["components"] or []
            if not comps and grp["mesh"]:
                comps = [{"objectid": gid, "path": None, "transform": None, "_inline": grp["mesh"]}]
            for c in comps:
                mesh = c.get("_inline")
                if mesh is None:
                    src = sub(c["path"]) if c["path"] else main
                    mesh = (src.get(c["objectid"]) or {}).get("mesh")
                if mesh is None:
                    continue
                pinfo = cfg["parts"].get(c["objectid"]) or {"subtype": "normal_part", "meta": {}}
                subtype = pinfo["subtype"] if pinfo["subtype"] in SUBTYPES else "normal_part"
                ext = pinfo["meta"].get("extruder")
                volumes.append({"subtype": subtype, "name": pinfo["meta"].get("name") or cfg["meta"].get("name") or f"Objet {gid}",
                                "extruder": int(ext) if ext and ext.isdigit() else 0,
                                "settings": _settings(pinfo["meta"]), "mesh": mesh, "matrix": _tf(c["transform"])})
            normal = [v for v in volumes if v["subtype"] == "normal_part"]
            if not normal:
                continue
            # première pièce normale = maillage principal (repère de l'objet) ; les autres restent des pièces
            # séparées (chacune avec son filament), comme les volumes d'un objet Orca
            mv, mf = normal[0]["mesh"][:2]
            vs, fs = [_apply(_mat(normal[0]["matrix"]), mv)], [mf]
            parts = []
            for v in volumes:
                if v is normal[0]:
                    continue
                parts.append({"name": v["name"], "subtype": v["subtype"], "settings": v["settings"], "extruder": v["extruder"],
                              "vertices": v["mesh"][0], "faces": v["mesh"][1], "matrix": v["matrix"], "paint": v["mesh"][2]})
            ometa = cfg["meta"]
            ext = ometa.get("extruder")
            out.append({"name": ometa.get("name") or normal[0]["name"], "extruder": int(ext) if ext and ext.isdigit() else 1,
                        "settings": _settings(ometa), "vertices": np.concatenate(vs), "faces": np.concatenate(fs),
                        "matrix": _tf(it["transform"]), "printable": it["printable"] != "0", "gid": gid, "parts": parts,
                        "multi_part": False, "main_extruder": normal[0]["extruder"], "paint": normal[0]["mesh"][2]})
        for i, o in enumerate(out, start=1):       # object_id = rang de l'objet dans le modèle (ordre du <build>)
            if i in lh:
                o["layer_profile"] = lh[i]
            if i in lr:
                o["layer_ranges"] = lr[i]
            if i in bp:
                from .brim import orca_frame_shift
                c = orca_frame_shift(o["vertices"], 1 + len(o["parts"]))
                o["brim_points"] = [[p[0] + c[0], p[1] + c[1], p[2] + c[2], p[3]] for p in bp[i]]
        pl = []
        for i, p in enumerate(plates):
            pl.append({"index": i, "name": p["name"], "objects": [o["gid"] for o in out if o["gid"] in set(p["objects"])],
                       "settings": p.get("settings") or {}})
        return {"objects": out, "plates": pl, "config": config, "app": app, "layer_gcodes": layer_gcodes}


def overrides_from_config(cfg):
    """Réglages modifiés par rapport aux profils système, par catégorie, d'après `different_settings_to_system`.

    Retourne {"process": {...}, "machine": {...}, "filament": [{...}, ...]}.
    """
    if not cfg:
        return {"process": {}, "machine": {}, "filament": []}
    diffs = cfg.get("different_settings_to_system") or []
    nfil = len(cfg.get("filament_settings_id") or []) or 1
    keys = lambda s: [k for k in (s or "").split(";") if k]  # noqa: E731
    process = keys(diffs[0]) if len(diffs) > 0 else []
    fil = [keys(diffs[1 + i]) if len(diffs) > 1 + i else [] for i in range(nfil)]
    machine = keys(diffs[1 + nfil]) if len(diffs) > 1 + nfil else []

    def pick(ks, idx=None):
        out = {}
        for k in ks:
            if k in cfg:
                v = cfg[k]
                if idx is not None and isinstance(v, list):
                    v = [v[idx]] if idx < len(v) else v
                out[k] = v
        return out

    return {"process": pick(process), "machine": pick(machine), "filament": [pick(f, i) for i, f in enumerate(fil)]}
