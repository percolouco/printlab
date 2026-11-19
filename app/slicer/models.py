"""Import des modèles 3D (STL, OBJ, 3MF, STEP, PLY…) et stockage des maillages.

Chaque fichier importé peut contenir plusieurs objets (3MF). Chaque objet est stocké en
binaire compact : [nb_sommets uint32][nb_triangles uint32][sommets float32*3][triangles uint32*3],
directement chargeable par le navigateur (BufferGeometry) et par le serveur pour la découpe.
"""
import json
import os
import re
import struct
import uuid
from pathlib import Path

import numpy as np
import trimesh

DATA_DIR = Path(os.environ.get("SLICER_DATA_DIR") or os.environ.get("DATA_DIR", "/data"))
MODELS_DIR = DATA_DIR / "models"
ALLOWED = {".stl", ".obj", ".3mf", ".step", ".stp", ".ply", ".off", ".glb", ".gltf", ".amf"}


def _safe_name(name):
    return re.sub(r"[^\w .()+-]", "_", name)[:120] or "modele"


def _write_mesh(path, vertices, faces):
    v = np.ascontiguousarray(vertices, dtype="<f4")
    f = np.ascontiguousarray(faces, dtype="<u4")
    with open(path, "wb") as fh:
        fh.write(struct.pack("<II", len(v), len(f)))
        fh.write(v.tobytes())
        fh.write(f.tobytes())


def read_mesh(model_id, index):
    p = MODELS_DIR / model_id / f"mesh_{int(index)}.bin"
    data = p.read_bytes()
    nv, nf = struct.unpack_from("<II", data, 0)
    v = np.frombuffer(data, dtype="<f4", count=nv * 3, offset=8).reshape(-1, 3)
    f = np.frombuffer(data, dtype="<u4", count=nf * 3, offset=8 + nv * 12).reshape(-1, 3)
    return v, f


def mesh_path(model_id, index):
    return MODELS_DIR / model_id / f"mesh_{int(index)}.bin"


def _load_step(path):
    import cascadio  # conversion STEP -> GLB via OpenCascade
    glb = path.with_suffix(".glb")
    cascadio.step_to_glb(str(path), str(glb), tol_linear=0.01, tol_angular=0.5)
    return trimesh.load(str(glb), force="scene")


def import_file(src_path: Path, original_name: str):
    ext = Path(original_name).suffix.lower()
    if ext not in ALLOWED:
        raise ValueError(f"Format non pris en charge : {ext}")
    mid = uuid.uuid4().hex[:12]
    d = MODELS_DIR / mid
    d.mkdir(parents=True)
    stored = d / f"source{ext}"
    src_path.replace(stored)

    if ext in (".step", ".stp"):
        scene = _load_step(stored)
    else:
        scene = trimesh.load(str(stored), force="scene", file_type=ext.lstrip("."))

    objects = []
    base = Path(original_name).stem
    # un objet par nœud géométrique du fichier, transformations appliquées
    dumped = scene.dump(concatenate=False) if isinstance(scene, trimesh.Scene) else [scene]
    names = []
    if isinstance(scene, trimesh.Scene):
        for node in scene.graph.nodes_geometry:
            _, geom_name = scene.graph[node]
            names.append(node if node != geom_name else geom_name)
    for i, mesh in enumerate(dumped):
        if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
            continue
        mesh.merge_vertices()
        v = np.asarray(mesh.vertices, dtype=np.float64)
        f = np.asarray(mesh.faces, dtype=np.int64)
        lo, hi = v.min(axis=0), v.max(axis=0)
        center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]]
        v = v - center  # origine au centre de la base de l'objet
        idx = len(objects)
        _write_mesh(d / f"mesh_{idx}.bin", v, f)
        size = (hi - lo).tolist()
        objects.append({
            "index": idx,
            "name": _safe_name(names[i] if i < len(names) and len(dumped) > 1 else base),
            "triangles": int(len(f)),
            "size": [round(x, 3) for x in size],
            "position": [round(c, 3) for c in center],  # position d'origine (utile pour les 3MF)
            "watertight": bool(mesh.is_watertight),
        })
    if not objects:
        raise ValueError("Aucun maillage exploitable dans ce fichier")
    meta = {"id": mid, "file": original_name, "format": ext.lstrip("."), "objects": objects,
            "from_project": ext == ".3mf"}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    return meta


def create_primitive(shape: str, size):
    """Crée une forme simple (modificateurs, bloqueurs de support…) comme un modèle importé."""
    sx, sy, sz = (float(x) for x in size)
    if shape == "cylinder":
        mesh = trimesh.creation.cylinder(radius=0.5, height=1.0, sections=48)
    elif shape == "sphere":
        mesh = trimesh.creation.icosphere(subdivisions=3, radius=0.5)
    else:
        mesh = trimesh.creation.box(extents=(1, 1, 1))
    mesh.apply_scale((sx, sy, sz))
    mid = uuid.uuid4().hex[:12]
    d = MODELS_DIR / mid
    d.mkdir(parents=True)
    v = np.asarray(mesh.vertices) - [0, 0, mesh.bounds[0][2]]
    _write_mesh(d / "mesh_0.bin", v, mesh.faces)
    names = {"box": "Cube", "cylinder": "Cylindre", "sphere": "Sphère"}
    meta = {"id": mid, "file": f"{shape}.prim", "format": "primitive", "from_project": False,
            "objects": [{"index": 0, "name": names.get(shape, "Cube"), "triangles": int(len(mesh.faces)),
                         "size": [sx, sy, sz], "position": [0, 0, 0], "watertight": True}]}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    return meta


def get_meta(model_id):
    if not re.fullmatch(r"[0-9a-f]{12}", model_id):
        raise KeyError(model_id)
    p = MODELS_DIR / model_id / "meta.json"
    if not p.exists():
        raise KeyError(model_id)
    return json.loads(p.read_text())


def list_models():
    out = []
    if MODELS_DIR.is_dir():
        for p in sorted(MODELS_DIR.glob("*/meta.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                out.append(json.loads(p.read_text()))
            except Exception:
                pass
    return out


def import_project(src_path: Path, original_name: str):
    """Ouvre un projet .3mf (Orca / QIDI / Bambu Studio) : maillages stockés, structure du projet renvoyée."""
    from . import project3mf
    proj = project3mf.parse(src_path)
    if not proj["objects"]:
        raise ValueError("Aucun objet dans ce projet")
    mid = uuid.uuid4().hex[:12]
    d = MODELS_DIR / mid
    d.mkdir(parents=True)
    src_path.replace(d / "source.3mf")
    idx, meta_objs, objects = 0, [], []
    for o in proj["objects"]:
        v, f = o["vertices"], o["faces"]
        _write_mesh(d / f"mesh_{idx}.bin", v, f)
        lo, hi = v.min(axis=0), v.max(axis=0)
        meta_objs.append({"index": idx, "name": _safe_name(o["name"]), "triangles": int(len(f)), "size": [round(x, 3) for x in (hi - lo)],
                          "position": [0, 0, 0], "watertight": True})
        item = {"model_id": mid, "index": idx, "name": o["name"], "extruder": o["extruder"], "settings": o["settings"],
                "matrix": o["matrix"], "gid": o["gid"], "multi_part": o["multi_part"], "parts": [], "paint": o.get("paint") or {}, "layer_profile": o.get("layer_profile") or [], "brim_points": o.get("brim_points") or [], "layer_ranges": o.get("layer_ranges") or []}
        idx += 1
        for pt in o["parts"]:
            _write_mesh(d / f"mesh_{idx}.bin", pt["vertices"], pt["faces"])
            meta_objs.append({"index": idx, "name": _safe_name(pt["name"]), "triangles": int(len(pt["faces"])), "size": [0, 0, 0],
                              "position": [0, 0, 0], "watertight": True})
            item["parts"].append({"model_id": mid, "index": idx, "name": pt["name"], "subtype": pt["subtype"],
                                  "settings": pt["settings"], "extruder": pt["extruder"], "matrix": pt["matrix"], "paint": pt.get("paint") or {}})
            idx += 1
        objects.append(item)
    meta = {"id": mid, "file": original_name, "format": "3mf", "objects": meta_objs, "from_project": True, "is_project": True}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    cfg = proj["config"] or {}
    area = cfg.get("printable_area") or []
    try:
        xs = [float(a.split("x")[0]) for a in area]
        bed_w = max(xs) - min(xs)
        ys = [float(a.split("x")[1]) for a in area]
        bed_d = max(ys) - min(ys)
    except Exception:
        bed_w = bed_d = 0
    return {"model_id": mid, "file": original_name, "app": proj["app"], "plates": proj["plates"], "objects": objects,
            "source_printer": cfg.get("printer_settings_id", ""), "source_process": cfg.get("print_settings_id", ""),
            "source_filaments": cfg.get("filament_settings_id") or [], "source_colours": cfg.get("filament_colour") or [], "source_types": cfg.get("filament_type") or [],
            "bed_type": cfg.get("curr_bed_type", ""), "layer_gcodes": {str(k): v for k, v in proj.get("layer_gcodes", {}).items()},
            "project_opts": {k: cfg[k] for k in ("flush_volumes_matrix", "flush_multiplier", "prime_volume_mode", "wipe_tower_x", "wipe_tower_y",
                                                     "filament_is_mixed", "filament_mixed_components", "filament_mixed_sublayer_ratios",
                                                     "filament_mixed_gradient", "filament_mixed_gradient_range", "filament_mixed_gradient_per_part") if k in cfg}, "source_bed_width": bed_w, "source_bed_depth": bed_d, "overrides": project3mf.overrides_from_config(cfg)}


def split_mesh(model_id, index):
    """Composantes connexes d'un maillage (« Séparer » d'Orca), stockées comme un nouveau modèle.

    Les maillages restent dans le repère de l'objet d'origine : il suffit de leur appliquer la même matrice.
    Tri par volume décroissant (la plus grosse pièce en premier)."""
    v, f = read_mesh(model_id, index)
    mesh = trimesh.Trimesh(vertices=np.asarray(v, dtype=np.float64), faces=np.asarray(f, dtype=np.int64), process=False)
    comps = mesh.split(only_watertight=False)
    comps = sorted(comps, key=lambda m: -abs(float(m.volume)) if m.is_volume else -float(m.area))
    if len(comps) < 2:
        raise ValueError("Ce maillage est d'un seul tenant : rien à séparer")
    mid = uuid.uuid4().hex[:12]
    d = MODELS_DIR / mid
    d.mkdir(parents=True)
    objs = []
    for i, m in enumerate(comps):
        _write_mesh(d / f"mesh_{i}.bin", m.vertices, m.faces)
        lo, hi = m.vertices.min(axis=0), m.vertices.max(axis=0)
        objs.append({"index": i, "name": f"pièce {i + 1}", "triangles": int(len(m.faces)), "size": [round(x, 3) for x in (hi - lo)],
                     "position": [0, 0, 0], "watertight": bool(m.is_watertight)})
    meta = {"id": mid, "file": f"séparation de {model_id}", "format": "split", "objects": objs, "from_project": False}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    return meta


def repair_mesh(model_id, index):
    """Réparation du maillage : sommets soudés, triangles dégénérés / doublons retirés, orientation des faces
    rendue cohérente (normales vers l'extérieur), trous bouchés. Orca répare avec CGAL (MeshRepair.cpp) :
    le résultat peut différer sur des maillages très abîmés (auto-intersections non traitées ici)."""
    v, f = read_mesh(model_id, index)
    m = trimesh.Trimesh(vertices=np.asarray(v, dtype=np.float64), faces=np.asarray(f, dtype=np.int64), process=False)
    st = {"watertight_before": bool(m.is_watertight), "faces_before": int(len(m.faces)), "vertices_before": int(len(m.vertices))}
    m.merge_vertices()
    st["welded_vertices"] = st["vertices_before"] - int(len(m.vertices))
    n0 = len(m.faces)
    m.update_faces(m.nondegenerate_faces())
    m.update_faces(m.unique_faces())
    m.remove_unreferenced_vertices()
    st["removed_triangles"] = int(n0 - len(m.faces))
    before_fill = len(m.faces)
    trimesh.repair.fill_holes(m)
    st["filled_triangles"] = int(len(m.faces) - before_fill)
    trimesh.repair.fix_winding(m)
    trimesh.repair.fix_inversion(m, multibody=True)
    st["watertight_after"] = bool(m.is_watertight)
    st["faces_after"] = int(len(m.faces))
    mid = uuid.uuid4().hex[:12]
    d = MODELS_DIR / mid
    d.mkdir(parents=True)
    _write_mesh(d / "mesh_0.bin", m.vertices, m.faces)
    lo, hi = m.vertices.min(axis=0), m.vertices.max(axis=0)
    meta = {"id": mid, "file": f"réparation de {model_id}", "format": "repair", "from_project": False,
            "objects": [{"index": 0, "name": "réparé", "triangles": int(len(m.faces)), "size": [round(x, 3) for x in (hi - lo)],
                         "position": [0, 0, 0], "watertight": bool(m.is_watertight)}]}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    return {"meta": meta, "stats": st}


def store_mesh(v, f, name, fmt="mesh"):
    """Enregistre un maillage calculé (booléen, simplification…) comme un nouveau modèle à un objet, sans recentrage."""
    mid = uuid.uuid4().hex[:12]
    d = MODELS_DIR / mid
    d.mkdir(parents=True)
    v = np.asarray(v, dtype=np.float64)
    _write_mesh(d / "mesh_0.bin", v, f)
    lo, hi = v.min(axis=0), v.max(axis=0)
    meta = {"id": mid, "file": name, "format": fmt, "from_project": False,
            "objects": [{"index": 0, "name": name, "triangles": int(len(f)), "size": [round(x, 3) for x in (hi - lo)],
                         "position": [0, 0, 0], "watertight": True}]}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    return {"model_id": mid, "index": 0, "triangles": int(len(f))}


def store_cut(res):
    """Enregistre le résultat d'une coupe : un modèle, un maillage par objet et par connecteur."""
    mid = uuid.uuid4().hex[:12]
    d = MODELS_DIR / mid
    d.mkdir(parents=True)
    idx, metas, objects = 0, [], []

    def put(v, f, name):
        nonlocal idx
        v = np.asarray(v, dtype=np.float64)
        _write_mesh(d / f"mesh_{idx}.bin", v, f)
        lo, hi = v.min(axis=0), v.max(axis=0)
        metas.append({"index": idx, "name": name, "triangles": int(len(f)), "size": [round(x, 3) for x in (hi - lo)],
                      "position": [0, 0, 0], "watertight": True})
        idx += 1
        return idx - 1

    for kind in ("upper", "lower"):
        r = res.get(kind)
        if not r:
            continue
        # recentrage : origine de l'objet au centre de sa base (comme un modèle importé)
        v = np.asarray(r["vertices"])
        lo, hi = v.min(axis=0), v.max(axis=0)
        c = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])
        main = put(v - c, r["faces"], kind)
        parts = [{"index": put(np.asarray(p["vertices"]) - c, p["faces"], p["name"]), "subtype": p["subtype"], "name": p["name"]} for p in r["parts"]]
        objects.append({"kind": kind, "index": main, "parts": parts, "size": metas[main]["size"], "offset": c.tolist(), "placed": bool(r.get("placed"))})
    for k, dw in enumerate(res.get("dowels") or []):
        v = np.asarray(dw["vertices"])
        lo, hi = v.min(axis=0), v.max(axis=0)
        c = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])
        objects.append({"kind": "dowel", "index": put(v - c, dw["faces"], f"goujon {k + 1}"), "parts": [], "size": metas[-1]["size"] if metas else [0, 0, 0]})
    if not objects:
        raise ValueError("La coupe ne donne aucune pièce (plan hors de l'objet ?)")
    meta = {"id": mid, "file": "coupe", "format": "cut", "objects": metas, "from_project": False}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    return {"model_id": mid, "objects": objects}
