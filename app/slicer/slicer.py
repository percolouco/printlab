"""Construction du projet 3MF (format Orca/Bambu) et découpe via le CLI d'OrcaSlicer.

Le CLI d'Orca fusionne mal plusieurs profils de filament passés avec --load-filaments
(la plupart des options par filament restent à 1 valeur, donc un seul filament est
utilisé). On fait donc comme l'interface : on calcule nous-mêmes la configuration
complète (imprimante + réglages + N filaments) et on l'écrit dans
Metadata/project_settings.config, puis on découpe le 3MF tel quel.
"""
import asyncio
import base64
import json
import os
import re
import shutil
import time
import uuid
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

from . import profiles

ORCA_BIN = profiles.ORCA_DIR / "AppRun"
DATA_DIR = Path(os.environ.get("SLICER_DATA_DIR") or os.environ.get("DATA_DIR", "/data"))
JOBS_DIR = DATA_DIR / "jobs"
ORCA_DATADIR = DATA_DIR / "orca_datadir"
SLICE_TIMEOUT = int(os.environ.get("SLICE_TIMEOUT", "1800"))

# Clés propres à un profil, à ne pas recopier dans la config du projet
DROP_KEYS = {"compatible_printers", "compatible_printers_condition", "compatible_prints",
             "compatible_prints_condition", "name", "inherits", "from", "instantiation",
             "setting_id", "filament_settings_id", "print_settings_id", "printer_settings_id"}

_slice_lock = asyncio.Semaphore(int(os.environ.get("SLICE_CONCURRENCY", "2")))


def orca_version():
    try:
        url = (profiles.ORCA_DIR / "ORCA_URL").read_text().strip()
        m = re.search(r"_V([0-9][0-9.]*[0-9])", url)
        return m.group(1) if m else url
    except OSError:
        return "inconnue"


# ---------- couleurs / purge ----------

def flush_matrix_for(machine_cfg, filament_cfgs, colours, mixed=None):
    """Matrice de purge calculée exactement comme « Auto-calc » d'Orca (voir flush.py)."""
    from . import flush
    return flush.flush_matrix(colours, machine_cfg, filament_cfgs, mixed=mixed)


# ---------- configuration du projet ----------

def build_config(machine, process, filaments, colours, overrides=None, flush=None):
    """Assemble la configuration complète du projet (comme le fait l'interface d'Orca)."""
    mcfg = profiles.resolve("machine", machine)
    pcfg = profiles.resolve("process", process)
    fcfgs = [profiles.resolve("filament", f) for f in filaments]

    cfg = {}
    for src in (mcfg, pcfg):
        for k, v in src.items():
            if k not in DROP_KEYS:
                cfg[k] = v

    fkeys = set()
    for fc in fcfgs:
        fkeys.update(k for k in fc if k not in DROP_KEYS)
    for k in sorted(fkeys):
        vals = [fc.get(k) for fc in fcfgs]
        ref = next((v for v in vals if v is not None), None)
        if isinstance(ref, list):
            merged = []
            for v in vals:
                if isinstance(v, list) and v:
                    merged.append(v[0])
                elif v is not None and not isinstance(v, list):
                    merged.append(v)
                else:
                    merged.append(ref[0] if ref else "")
            cfg[k] = merged
        elif ref is not None:
            cfg[k] = ref

    n = len(filaments)
    cfg["filament_colour"] = list(colours)
    cfg["filament_settings_id"] = list(filaments)
    cfg["print_settings_id"] = process
    cfg["printer_settings_id"] = machine
    cfg["filament_map"] = ["1"] * n
    mixed = [str(x) in ("1", "true", "True") for x in (overrides or {}).get("filament_is_mixed", [])] or None
    cfg["flush_volumes_matrix"] = flush if flush and len(flush) == n * n else flush_matrix_for(mcfg, fcfgs, colours, mixed)
    cfg["flush_volumes_vector"] = ["140"] * (2 * n)
    # options de projet d'Orca (valeurs d'un nouveau projet dans l'application ; remplacées par les overrides)
    cfg.setdefault("flush_multiplier", ["0.3"])
    cfg.setdefault("prime_volume_mode", "Default")
    cfg["from"] = "project"
    cfg["name"] = "project_settings"
    cfg["version"] = mcfg.get("version", "2.4.0.0")

    for k, v in (overrides or {}).items():
        cfg[k] = v
    return cfg


# ---------- écriture du 3MF ----------

PAINT_ATTRS = {"supports": "paint_supports", "seam": "paint_seam", "color": "paint_color", "fuzzy": "paint_fuzzy_skin"}


def _mesh_xml(vertices, faces, paint=None):
    """paint : {"supports"|"seam"|"color"|"fuzzy": {index de triangle: chaîne hexa d'Orca}}"""
    out = ["<mesh><vertices>"]
    out.extend(f'<vertex x="{x:.6g}" y="{y:.6g}" z="{z:.6g}"/>' for x, y, z in vertices)
    out.append("</vertices><triangles>")
    maps = [(PAINT_ATTRS[m], {int(k): v for k, v in (d or {}).items() if v}) for m, d in (paint or {}).items() if m in PAINT_ATTRS]
    maps = [(a, d) for a, d in maps if d]
    if not maps:
        out.extend(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in faces)
    else:
        for i, (a, b, c) in enumerate(faces):
            extra = "".join(f' {attr}="{d[i]}"' for attr, d in maps if i in d)
            out.append(f'<triangle v1="{a}" v2="{b}" v3="{c}"{extra}/>')
    out.append("</triangles></mesh>")
    return "".join(out)


def _transform_3mf(m):
    """Matrice 4x4 three.js (column-major, 16 valeurs) -> transform 3MF (12 valeurs)."""
    e = [float(x) for x in m]
    return " ".join(f"{e[i]:.9g}" for i in (0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14))


def write_3mf(path, objects, config, plate_name="Plateau 1", plates=None, layer_gcodes=None):
    """objects : [{name, vertices (N,3), faces (M,3), matrix (16), extruder, settings{}, parts[]}]

    Chaque objet peut contenir des pièces supplémentaires (modificateurs, bloqueurs de
    support…) dans "parts" : [{name, vertices, faces, matrix (relative à l'objet), subtype, settings}].

    plates : [{"name": str, "objects": [index d'objet, ...]}] pour un projet à plusieurs plateaux
    (les matrices des objets sont alors dans la grille de plateaux d'Orca). Par défaut : un seul plateau.
    layer_gcodes : {index de plateau: [{"z", "type", "extruder", "color", "extra"}]} = changements par couche
    (pause, changement de filament, G-code perso), écrits comme Orca dans Metadata/custom_gcode_per_layer.xml.
    """
    res, build, obj_cfg = [], [], []
    oid = 1
    for i, o in enumerate(objects, start=1):
        parts = [{"name": o["name"], "vertices": o["vertices"], "faces": o["faces"], "paint": o.get("paint"),
                  "matrix": None, "subtype": "normal_part", "settings": {}}] + list(o.get("parts") or [])
        comps, part_cfg = [], []
        for p in parts:
            pid = oid
            oid += 1
            res.append(f'<object id="{pid}" type="model">{_mesh_xml(p["vertices"], p["faces"], p.get("paint"))}</object>')
            t = _transform_3mf(p["matrix"]) if p.get("matrix") else "1 0 0 0 1 0 0 0 1 0 0 0"
            comps.append(f'<component objectid="{pid}" transform="{t}"/>')
            meta = [f'<metadata key="name" value={quoteattr(p["name"])}/>']
            if p.get("extruder"):
                meta.append(f'<metadata key="extruder" value="{int(p["extruder"])}"/>')
            for k, v in (p.get("settings") or {}).items():
                meta.append(f'<metadata key={quoteattr(k)} value={quoteattr(_cfg_str(v))}/>')
            part_cfg.append(f'<part id="{pid}" subtype="{p.get("subtype", "normal_part")}">{"".join(meta)}</part>')
        gid = oid
        oid += 1
        res.append(f'<object id="{gid}" type="model"><components>{"".join(comps)}</components></object>')
        build.append(f'<item objectid="{gid}" transform="{_transform_3mf(o["matrix"])}" printable="1"/>')
        ometa = [f'<metadata key="name" value={quoteattr(o["name"])}/>',
                 f'<metadata key="extruder" value="{int(o.get("extruder") or 1)}"/>']
        for k, v in (o.get("settings") or {}).items():
            ometa.append(f'<metadata key={quoteattr(k)} value={quoteattr(_cfg_str(v))}/>')
        obj_cfg.append(f'<object id="{gid}">{"".join(ometa)}{"".join(part_cfg)}</object>')

    gids = _group_ids(objects)
    if not plates:
        plates = [{"name": plate_name, "objects": list(range(len(objects)))}]

    def _plate_xml(n, pl):
        inst = "".join(
            f'<model_instance><metadata key="object_id" value="{gids[i]}"/><metadata key="instance_id" value="0"/>'
            f'<metadata key="identify_id" value="{100 + gids[i]}"/></model_instance>'
            for i in pl.get("objects", []) if 0 <= i < len(gids))
        return (f'<plate><metadata key="plater_id" value="{n}"/>'
                f'<metadata key="plater_name" value={quoteattr(pl.get("name") or "")}/>'
                '<metadata key="locked" value="false"/>'
                '<metadata key="filament_map_mode" value="Auto For Flush"/>'
                + _plate_settings_xml(pl.get("settings")) + f'{inst}</plate>')
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n'
             '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
             'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">'
             '<metadata name="Application">BambuStudio-02.06.00.51</metadata>'
             f'<metadata name="OrcaSlicer">{escape(orca_version())}</metadata>'
             '<metadata name="BambuStudio:3mfVersion">1</metadata>'
             f'<resources>{"".join(res)}</resources><build>{"".join(build)}</build></model>')
    settings = ('<?xml version="1.0" encoding="UTF-8"?>\n<config>' + "".join(obj_cfg) +
                "".join(_plate_xml(n, pl) for n, pl in enumerate(plates, start=1)) + '</config>')
    ct = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
          '<Default Extension="png" ContentType="image/png"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
            '</Relationships>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model)
        z.writestr("Metadata/model_settings.config", settings)
        z.writestr("Metadata/project_settings.config", json.dumps(config, indent=1, ensure_ascii=False))
        from . import layerheight
        lh = layerheight.profile_file([o.get("layer_profile") for o in objects])
        if lh:
            z.writestr("Metadata/layer_heights_profile.txt", lh)
        lh0 = config.get("layer_height", 0.2)
        lh0 = lh0[0] if isinstance(lh0, list) else lh0
        lr = layer_ranges_xml(objects, lh0)
        if lr:
            z.writestr("Metadata/layer_config_ranges.xml", lr)
        from . import brim

        def _orca_points(o):
            pts = o.get("brim_points") or []
            if not pts:
                return pts
            c = brim.orca_frame_shift(o["vertices"], 1 + len(o.get("parts") or []))
            return [[p[0] - c[0], p[1] - c[1], p[2] - c[2], p[3]] for p in pts]
        bp = brim.points_file([_orca_points(o) for o in objects])
        if bp:
            z.writestr("Metadata/brim_ear_points.txt", bp)
        xml = custom_gcode_xml(layer_gcodes, config)
        if xml:
            z.writestr("Metadata/custom_gcode_per_layer.xml", xml)


# Types de CustomGCode::Type d'Orca
CG_COLOR_CHANGE, CG_PAUSE, CG_TOOL_CHANGE, CG_TEMPLATE, CG_CUSTOM = 0, 1, 2, 3, 4


def custom_gcode_xml(layer_gcodes, config):
    """Même contenu que _BBS_3MF_Exporter::_add_custom_gcode_per_print_z_file_to_archive."""
    if not layer_gcodes:
        return ""
    nfil = len(config.get("filament_colour") or []) or 1
    mode = "MultiAsSingle" if nfil > 1 else "SingleExtruder"
    scal = lambda v: v[0] if isinstance(v, list) and v else (v or "")  # noqa: E731
    out = ['<?xml version="1.0" encoding="utf-8"?>', "<custom_gcodes_per_layer>"]
    for pidx in sorted(layer_gcodes, key=int):
        items = sorted(layer_gcodes[pidx] or [], key=lambda it: float(it["z"]))
        if not items:
            continue
        out.append("<plate>")
        out.append(f'<plate_info id="{int(pidx) + 1}"/>')
        for it in items:
            t = int(it.get("type", CG_PAUSE))
            extra = str(it.get("extra") or "")
            gcode = (scal(config.get("machine_pause_gcode")) if t == CG_PAUSE else
                     scal(config.get("template_custom_gcode")) if t == CG_TEMPLATE else
                     "tool_change" if t == CG_TOOL_CHANGE else extra)
            out.append(f'<layer top_z={quoteattr(_num(it["z"]))} type="{t}" extruder="{int(it.get("extruder") or 1)}" '
                       f'color={quoteattr(str(it.get("color") or ""))} extra={quoteattr(extra)} gcode={quoteattr(gcode)}/>')
        out.append(f'<mode value="{mode}"/>')
        out.append("</plate>")
    out.append("</custom_gcodes_per_layer>")
    return "\n".join(out) if len(out) > 2 else ""


def _num(v):
    s = repr(float(v))
    return s[:-2] if s.endswith(".0") else s


def _plate_settings_xml(ps):
    """Réglages par plateau d'Orca (type de plateau, séquence d'impression, vase spirale, ordre de la 1re couche)."""
    out = ""
    for k, v in (ps or {}).items():
        if k not in ("bed_type", "print_sequence", "spiral_mode", "first_layer_print_sequence") or v in (None, ""):
            continue
        if k == "spiral_mode":
            v = "true" if str(v).lower() in ("1", "true") else "false"
        if k == "first_layer_print_sequence" and isinstance(v, list):
            v = " ".join(str(int(x)) for x in v)
        out += f'<metadata key="{k}" value={quoteattr(str(v))}/>'
    return out


def layer_ranges_xml(objects, default_layer_height=0.2):
    """Metadata/layer_config_ranges.xml d'Orca (_add_layer_config_ranges_file_to_archive).
    Orca lit toujours « layer_height » dans une plage (Slicing.cpp) : on l'ajoute s'il manque, sinon le moteur plante."""
    rows = []
    for i, o in enumerate(objects, start=1):
        rs = o.get("layer_ranges") or []
        if not rs:
            continue
        rows.append(f' <object id="{i}">')
        for r in sorted(rs, key=lambda r: float(r["min_z"])):
            rows.append(f'  <range min_z="{float(r["min_z"]):g}" max_z="{float(r["max_z"]):g}">')
            st = dict(r.get("settings") or {})
            st.setdefault("layer_height", default_layer_height)
            for k, v in st.items():
                rows.append(f'   <option opt_key={quoteattr(k)}>{escape(_cfg_str(v))}</option>')
            rows.append('  </range>')
        rows.append(' </object>')
    return ('<?xml version="1.0" encoding="utf-8"?>\n<objects>\n' + "\n".join(rows) + '\n</objects>\n') if rows else ""


def _group_ids(objects):
    """Identifiant 3MF de chaque objet (groupe) : ses pièces prennent les numéros précédents."""
    ids, oid = [], 1
    for o in objects:
        oid += 1 + len(o.get("parts") or [])   # pièce principale + pièces spéciales
        ids.append(oid)                         # puis l'objet lui-même
        oid += 1
    return ids


def _cfg_str(v):
    if isinstance(v, list):
        return ",".join(str(x) for x in v)
    if isinstance(v, bool):
        return "1" if v else "0"
    return str(v)


# ---------- découpe ----------

CLI_GCODE_PATH_CONFLICTS = -101   # code de sortie du CLI Orca/Bambu


async def _orca(cmd, job_dir: Path, out: Path):
    env = dict(os.environ, HOME=str(DATA_DIR), XDG_RUNTIME_DIR="/tmp")
    (out / "result.json").unlink(missing_ok=True)
    async with _slice_lock:
        t0 = time.time()
        proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(job_dir), env=env,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=SLICE_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError("La découpe a dépassé le temps limite")
        dt = time.time() - t0
    log = stdout.decode(errors="replace")
    with open(job_dir / "slice.log", "a") as f:
        f.write(" ".join(cmd[2:]) + "\n" + log + "\n")
    rj = out / "result.json"
    result = json.loads(rj.read_text()) if rj.exists() else {}
    return log, result, dt


def _conflict_detail(job_dir: Path, log: str):
    """« A et B » d'après la ligne « gcode path conflicts found between A and B » du journal d'Orca."""
    texts = [log] + [p.read_text(errors="replace") for p in job_dir.glob("*.log") if p.name != "slice.log"]
    for t in texts:
        m = re.search(r"conflicts found between (.+?) and (.+?)\s*$", t, re.M)
        if m:
            a, b = (x.strip() for x in m.groups())
            return f"deux « {a} »" if a == b else f"« {a} » et « {b} »"
    return ""


async def run_slice(job_dir: Path, project: Path, plate: int = 0):
    """plate : numéro du plateau à découper (1..n), 0 = tous."""
    out = job_dir / "out"
    out.mkdir(exist_ok=True)
    ORCA_DATADIR.mkdir(parents=True, exist_ok=True)
    base = ["xvfb-run", "-a", str(ORCA_BIN), "--datadir", str(ORCA_DATADIR), "--allow-newer-file"]
    tail = ["--slice", str(int(plate)), "--outputdir", str(out), str(project)]
    log, result, dt = await _orca(base + tail, job_dir, out)
    extra = []
    if result.get("return_code") == CLI_GCODE_PATH_CONFLICTS and not list(out.glob("*.gcode")):
        # Le CLI d'Orca refuse tout « conflit de trajectoires » (objets très proches, souvent un faux positif),
        # là où Orca / QIDI Studio en interface affichent un simple avertissement : on relance sans ce contrôle
        # (les autres vérifications sont déjà passées, le conflit n'est cherché qu'après la découpe).
        detail = _conflict_detail(job_dir, log)
        log, result, dt2 = await _orca(base + ["--no-check"] + tail, job_dir, out)
        dt += dt2
        extra.append("Conflit de trajectoires détecté" + (f" entre {detail}" if detail else "") +
                     " (objets très proches) : découpé quand même, comme QIDI Studio. Vérifie l'aperçu.")
    gcodes = sorted(out.glob("*.gcode"))
    if not gcodes:
        msg = result.get("error_string") or log.strip().splitlines()[-1:] or ["échec inconnu"]
        raise RuntimeError(f"Échec de la découpe : {msg if isinstance(msg, str) else msg[0]}")
    warnings = extra + [p.get("warning_message") for p in result.get("sliced_plates", []) if p.get("warning_message")]
    return gcodes[0], {"duration": round(dt, 1), "warnings": warnings}


def gcode_stats(path: Path):
    """Lit les statistiques qu'Orca écrit en commentaire dans le G-code."""
    stats = {}
    pats = {
        "time": r"^; estimated printing time \(normal mode\) = (.+)$",
        "first_layer_time": r"^; estimated first layer printing time \(normal mode\) = (.+)$",
        "filament_mm": r"^; filament used \[mm\] = (.+)$",
        "filament_cm3": r"^; filament used \[cm3\] = (.+)$",
        "filament_g": r"^; filament used \[g\] = (.+)$",
        "cost": r"^; filament cost = (.+)$",
        "total_g": r"^; total filament used \[g\] = (.+)$",
        "total_cost": r"^; total filament cost = (.+)$",
        "layers": r"^; total layer number: (\d+)$",
        "max_z": r"^; max_z_height: (.+)$",
        "filament_changes": r"^; total filament change: (\d+)$",
    }
    comp = {k: re.compile(v) for k, v in pats.items()}
    size = path.stat().st_size
    with open(path, "rb") as f:
        head = f.read(200_000).decode(errors="replace")
        f.seek(max(0, size - 600_000))
        tail = f.read().decode(errors="replace")
    for line in (head + "\n" + tail).splitlines():
        for k, r in comp.items():
            if k in stats:
                continue
            m = r.match(line)
            if m:
                v = m.group(1).strip()
                if k.startswith("filament_") and k != "filament_changes":
                    v = [x.strip() for x in v.split(",")]
                stats[k] = v
    stats["tool_changes"] = sum(1 for _ in re.finditer(r"(?m)^TOOL_CHANGE_START", tail)) if size < 600_000 else None
    stats["size"] = size
    return stats


def inject_thumbnails(gcode: Path, png_b64_list):
    """Insère des miniatures PNG (base64) au format attendu par Moonraker/Klipper."""
    blocks = []
    for item in png_b64_list:
        w, h, b64 = item["w"], item["h"], item["data"]
        lines = [b64[i:i + 78] for i in range(0, len(b64), 78)]
        blocks.append(f"; thumbnail begin {w}x{h} {len(b64)}\n" + "".join(f"; {l}\n" for l in lines) +
                      "; thumbnail end\n;\n")
    if not blocks:
        return
    tmp = gcode.with_suffix(".tmp")
    with open(gcode, "rb") as src, open(tmp, "wb") as dst:
        first = src.readline()
        if first.startswith(b"; HEADER_BLOCK_START") or not first.startswith(b";"):
            dst.write(("; THUMBNAIL_BLOCK_START\n" + "".join(blocks) + "; THUMBNAIL_BLOCK_END\n\n").encode())
            dst.write(first)
        else:
            dst.write(first)
            dst.write(("; THUMBNAIL_BLOCK_START\n" + "".join(blocks) + "; THUMBNAIL_BLOCK_END\n\n").encode())
        shutil.copyfileobj(src, dst, 1 << 20)
    tmp.replace(gcode)


def new_job_dir():
    jid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    d = JOBS_DIR / jid
    d.mkdir(parents=True)
    return jid, d


def package_gcode_3mf(job_dir: Path, gcode: Path, thumbs, plate: int, stats: dict, out: Path):
    """Assemble un .gcode.3mf comme Orca / QIDI Studio : projet + G-code du plateau + md5 + images + plan des
    filaments. C'est ce format que l'écran de l'imprimante sait afficher (aperçu, filaments, réimpression)."""
    import hashlib
    src = zipfile.ZipFile(job_dir / "plate.3mf")
    names = {n: src.read(n) for n in src.namelist()}
    cfg = json.loads(names["Metadata/project_settings.config"].decode())
    gbytes = gcode.read_bytes()
    # Le firmware lance toujours « PLATEINDEX=1 » et cherche Metadata/plate_1.gcode : on empaquette donc ce
    # plateau seul sous le numéro 1 (sinon « 3MF processing error … shadow_native_plate_1.gcode »).
    pl, n = int(plate), 1
    # images : la plus grande pour le plateau, la plus petite pour la vignette
    imgs = sorted(thumbs or [], key=lambda t: t["w"])
    big = base64.b64decode(imgs[-1]["data"]) if imgs else None
    small = base64.b64decode(imgs[0]["data"]) if imgs else None
    if big:
        for nm in (f"plate_{n}.png", f"plate_no_light_{n}.png", f"top_{n}.png", f"pick_{n}.png"):
            names["Metadata/" + nm] = big
        names[f"Metadata/plate_{n}_small.png"] = small
    names[f"Metadata/plate_{n}.gcode"] = gbytes
    names[f"Metadata/plate_{n}.gcode.md5"] = hashlib.md5(gbytes).hexdigest().upper().encode()
    # filaments utilisés
    used = sorted({int(m.group(1)) for m in re.finditer(rb"^T(\d+)\s*$", gbytes, re.M)} - {16}) or [0]
    cols, types = cfg.get("filament_colour") or [], cfg.get("filament_type") or []
    mm, gr = stats.get("filament_mm") or [], stats.get("filament_g") or []

    def val(lst, i):
        try:
            return float(lst[i] if len(lst) > max(used) else lst[used.index(i)])
        except Exception:
            return 0.0
    fl = "".join(
        f'    <filament id="{t + 1}" tray_info_idx="" type="{escape(str(types[t]) if t < len(types) else "PLA")}" '
        f'color="{escape(str(cols[t]) if t < len(cols) else "#808080")}" used_m="{val(mm, t) / 1000:.2f}" '
        f'used_g="{val(gr, t):.2f}" group_id="0" nozzle_diameter="0.40" volume_type="Standard" '
        f'used_for_object="true" used_for_support="false"/>\n' for t in used)
    pred = 0
    m = re.match(r"(?:(\d+)d )?(?:(\d+)h )?(?:(\d+)m )?(?:(\d+)s)?", str(stats.get("time") or ""))
    if m:
        d, h, mi, s = (int(x or 0) for x in m.groups())
        pred = d * 86400 + h * 3600 + mi * 60 + s
    names["Metadata/slice_info.config"] = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n'
        '    <header_item key="X-BBL-Client-Type" value="slicer"/>\n'
        '    <header_item key="X-BBL-Client-Version" value="02.08.01.55"/>\n'
        '    <header_item key="OrcaSlicer-Version" value="2.5.1"/>\n  </header>\n  <plate>\n'
        f'    <metadata key="index" value="{n}"/>\n    <metadata key="extruder_type" value="0"/>\n'
        '    <metadata key="nozzle_volume_type" value="0"/>\n'
        '    <metadata key="printer_model_id" value="Qidi-XMax-4"/>\n'
        '    <metadata key="nozzle_diameters" value="0.4"/>\n    <metadata key="timelapse_type" value="0"/>\n'
        f'    <metadata key="prediction" value="{pred}"/>\n'
        f'    <metadata key="weight" value="{sum(val(gr, t) for t in used):.2f}"/>\n'
        '    <metadata key="outside" value="false"/>\n    <metadata key="support_used" value="false"/>\n'
        '    <metadata key="label_object_enabled" value="true"/>\n'
        f'    <metadata key="filament_maps" value="{" ".join("1" for _ in (types or [0]))}"/>\n'
        f'{fl}    <nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="Standard"/>\n'
        '  </plate>\n</config>\n').encode()
    names["Metadata/filament_sequence.json"] = json.dumps({"plate_%d" % n: {"sequence": []}}).encode()
    # model_settings : références du plateau
    ms = names["Metadata/model_settings.config"].decode()
    ref = (f'<metadata key="gcode_file" value="Metadata/plate_{n}.gcode"/>'
           f'<metadata key="thumbnail_file" value="Metadata/plate_{n}.png"/>'
           f'<metadata key="thumbnail_no_light_file" value="Metadata/plate_no_light_{n}.png"/>'
           f'<metadata key="top_file" value="Metadata/top_{n}.png"/>'
           f'<metadata key="pick_file" value="Metadata/pick_{n}.png"/>')
    ms = re.sub(rf'(<metadata key="plater_id" value="{pl}"/>)', r"\1" + ref.replace("\\", "\\\\"), ms, count=1)
    names["Metadata/model_settings.config"] = ms.encode()
    # relations + types
    rel = ('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
           ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n')
    if big:
        rel += (f' <Relationship Target="/Metadata/plate_{n}.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>\n'
                f' <Relationship Target="/Metadata/plate_{n}.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>\n'
                f' <Relationship Target="/Metadata/plate_{n}_small.png" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>\n')
    names["_rels/.rels"] = (rel + "</Relationships>").encode()
    names["Metadata/_rels/model_settings.config.rels"] = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        f' <Relationship Target="/Metadata/plate_{n}.gcode" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/>\n</Relationships>').encode()
    names["[Content_Types].xml"] = (
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
        ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
        ' <Default Extension="png" ContentType="image/png"/>\n <Default Extension="json" ContentType="application/json"/>\n'
        ' <Default Extension="gcode" ContentType="text/x.gcode"/>\n</Types>').encode()
    order = ["[Content_Types].xml", "_rels/.rels"] + [k for k in names if k not in ("[Content_Types].xml", "_rels/.rels")]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for k in order:
            z.writestr(k, names[k])
    return out
