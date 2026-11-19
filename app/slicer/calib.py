"""Calibrations d'OrcaSlicer 2.5, reproduites hors de l'application.

Orca prépare chaque calibration dans l'interface (Plater::calib_*) puis donne des « paramètres de calibration » au
moteur (Print::set_calib_params) qui modifie le G-code couche par couche (GCode.cpp). Ces paramètres n'existent ni
dans le 3MF ni en ligne de commande ; on les reproduit ainsi :
- modèle, découpes, réglages d'objet, de process, de filament et d'imprimante : exactement ceux de Plater::calib_* ;
- commandes ajoutées par couche (température, pressure advance) : insérées comme G-code personnalisé de couche,
  avec la valeur de GCode::interpolate_value_across_layers ;
- valeurs changées par le moteur (longueur de rétraction, vitesse de paroi extérieure) : appliquées au G-code
  après la découpe (post_process), selon les mêmes formules.
"""
import math
import re
from pathlib import Path

import numpy as np

from . import cut as cutmod
from . import project3mf

CALIB_DIR = Path("/opt/orca/resources/calib")
EPSILON = 1e-4


def _drc(rel):
    import DracoPy
    m = DracoPy.decode((CALIB_DIR / rel).read_bytes())
    return np.asarray(m.points, dtype=np.float64), np.asarray(m.faces, dtype=np.int64).reshape(-1, 3)


def _cut_keep(v, f, z, keep):
    """cut_horizontal d'Orca (KeepLower / KeepUpper), sans connecteur."""
    r = cutmod.cut(v, f, [0, 0, z], [0, 0, 1], {"keep_upper": keep == "upper", "keep_lower": keep == "lower",
                                                 "place_upper": False, "place_lower": False})
    part = r[keep]
    return part["vertices"] + [0, 0, z], part["faces"]


def _on_bed(v):
    v = v.copy()
    v[:, 2] -= v[:, 2].min()
    return v


def _layers(height, first, lh):
    """Hauteurs de couche (print_z) d'un objet à hauteur de couche uniforme."""
    zs = [first]
    while zs[-1] + lh <= height + 1e-6:
        zs.append(round(zs[-1] + lh, 6))
    if height - zs[-1] > 1e-3:
        zs.append(round(height, 6))
    return zs


def interpolate(i, count, start, end, step):
    """GCode::interpolate_value_across_layers (imprimante non « belt »)."""
    if i <= 1:
        return start
    ratio = i / (count - 1.0)
    if step > 0:
        n_bands = int(round(abs(end - start) / step)) + 1
        band = min(n_bands - 1, int(ratio * n_bands))
        return start + (1.0 if end >= start else -1.0) * band * step
    return start + ratio * (end - start)


def mm3_per_mm(width, height):
    """Flow::mm3_per_mm (extrusion non pontée) : rectangle aux bords arrondis."""
    return (width - height * (1.0 - 0.25 * math.pi)) * height


def _g(cfg, key, default):
    v = cfg.get(key, default)
    if isinstance(v, list):
        v = v[0] if v else default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _object_names(path):
    """Noms des objets d'un 3MF d'Orca (attribut name des <object>) : {id: nom}."""
    import zipfile
    with zipfile.ZipFile(path) as z:
        t = z.read("3D/3dmodel.model").decode("utf-8", "replace")
    return {int(i): n for i, n in re.findall(r'<object id="(\d+)" name="([^"]*)"', t)}


def build(kind, p, machine, process, filament):
    """Retourne la recette : objets, overrides (process / filament / machine), G-code de couche, post-traitement."""
    nozzle = _g(machine, "nozzle_diameter", 0.4)
    out = {"name": "", "objects": [], "process": {}, "filament": {}, "machine": {"resonance_avoidance": "0"}, "layer_gcodes": [], "post": None}

    if kind == "temp":
        start, end = int(round(p.get("start", 230))), int(round(p.get("end", 190)))
        step, block = 5, 10.0
        v, f = _drc("temperature_tower/temperature_tower.drc")
        bc = round((500 - end) / step + 1)
        if bc > 0 and bc * block - EPSILON < v[:, 2].max():
            v, f = _cut_keep(v, f, bc * block - EPSILON, "lower")
        bc = round((500 - start) / step)
        if bc > 0 and bc * block + EPSILON < v[:, 2].max():
            v, f = _cut_keep(v, f, bc * block + EPSILON, "upper")
        scale = nozzle / 0.4
        v = _on_bed(v) * [scale, scale, scale]
        lh = nozzle / 2
        out["name"] = f"Tour de température {start}-{end} °C"
        out["filament"] = {"nozzle_temperature_initial_layer": [str(start)], "nozzle_temperature": [str(start)]}
        out["process"] = {"enable_wrapping_detection": "0", "initial_layer_print_height": f"{lh:g}"}
        settings = {"layer_height": f"{lh:g}", "brim_type": "outer_only", "brim_width": "5", "brim_object_gap": "0",
                    "alternate_extra_wall": "0", "seam_slope_type": "none", "overhang_reverse": "0", "precise_z_height": "0"}
        out["objects"].append({"name": "temperature_tower", "vertices": v, "faces": f, "settings": settings})
        zs = _layers(v[:, 2].max(), lh, lh)
        last = None
        for i, z in enumerate(zs):
            t = int(interpolate(i, len(zs), start, end, 5.0))
            if t != last:
                out["layer_gcodes"].append({"z": z, "extra": f"M104 S{t} ; set nozzle temperature"})
                last = t

    elif kind == "pa_tower":
        start, end, step = float(p.get("start", 0.0)), float(p.get("end", 0.1)), float(p.get("step", 0.002))
        v, f = _drc("pressure_advance/tower_with_seam.drc")
        h = math.ceil((end - start) / step) + 1
        if h < v[:, 2].max():
            v, f = _cut_keep(v, f, h, "lower")
        v = _on_bed(v)
        lh = _g(process, "layer_height", 0.2)
        lw = _g(process, "line_width", 0) or nozzle * 1.125     # Flow::auto_extrusion_width(frPerimeter)
        maxv = _g(filament, "filament_max_volumetric_speed", 12.0) / mm3_per_mm(lw, lh)
        out["name"] = f"Tour de pressure advance {start:g}-{end:g}"
        out["process"] = {"enable_wrapping_detection": "0", "outer_wall_speed": [f"{maxv:g}"], "inner_wall_speed": [f"{maxv:g}"],
                          "max_volumetric_extrusion_rate_slope": "0", "wipe_inward": "0"}
        out["filament"] = {"slow_down_layer_time": ["1"]}
        settings = {"alternate_extra_wall": "0", "seam_position": "back", "wall_loops": "2", "top_shell_layers": "0", "bottom_shell_layers": "0",
                    "sparse_infill_density": "0%", "brim_type": "brim_ears", "brim_object_gap": "0", "brim_ears_max_angle": "135",
                    "brim_width": "6", "seam_slope_type": "none"}
        out["objects"].append({"name": "pa_tower", "vertices": v, "faces": f, "settings": settings})
        zs = _layers(v[:, 2].max(), _g(process, "initial_layer_print_height", lh), lh)
        last = None
        for i, z in enumerate(zs):
            k = interpolate(i, len(zs), start, end, step)
            if k != last:
                out["layer_gcodes"].append({"z": z, "extra": f"SET_PRESSURE_ADVANCE ADVANCE={k:.4g}; Override pressure advance value"})
                last = k

    elif kind in ("pa_line", "pa_pattern"):
        from . import calib_pa
        start, end, step = float(p.get("start", 0.0)), float(p.get("end", 0.1)), float(p.get("step", 0.002))
        area = machine.get("printable_area") or ["0x0", "256x0", "256x256", "0x256"]
        pts = [tuple(float(c) for c in str(a).split("x")) for a in area]
        bed = (min(x for x, _ in pts), min(y for _, y in pts), max(x for x, _ in pts), max(y for _, y in pts))
        cfg = {"nozzle_diameter": nozzle, "filament_diameter": _g(filament, "filament_diameter", 1.75),
               "filament_flow_ratio": _g(filament, "filament_flow_ratio", 1.0), "print_flow_ratio": _g(process, "print_flow_ratio", 1.0) or 1.0,
               "initial_layer_print_height": _g(process, "initial_layer_print_height", 0.2), "layer_height": _g(process, "layer_height", 0.2),
               "z_offset": _g(machine, "z_offset", 0.0), "outer_wall_speed": _g(process, "outer_wall_speed", 200),
               "filament_max_volumetric_speed": _g(filament, "filament_max_volumetric_speed", 12.0),
               "outer_wall_acceleration": _g(process, "outer_wall_acceleration", 0) or _g(process, "inner_wall_acceleration", 0) or _g(process, "default_acceleration", 0),
               "travel_speed": _g(process, "travel_speed", 300), "travel_speed_z": _g(process, "travel_speed_z", 0) or 10,
               "retraction_length": _g(filament, "filament_retraction_length", 0) or _g(machine, "retraction_length", 0.8),
               "retraction_speed": _g(filament, "filament_retraction_speed", 0) or _g(machine, "retraction_speed", 30),
               "deretraction_speed": _g(filament, "filament_deretraction_speed", 0) or _g(machine, "deretraction_speed", 0) or _g(machine, "retraction_speed", 30),
               "z_hop": _g(filament, "filament_z_hop", 0) or _g(machine, "z_hop", 0), "bed": bed}
        out["process"] = {"overhang_reverse": "0", "precise_z_height": "0", "wipe_inward": "0", "enable_wrapping_detection": "0"}
        if kind == "pa_line":
            v, f = _drc("pressure_advance/pressure_advance_test.drc")
            out["name"] = f"Pressure advance — lignes {start:g}-{end:g}"
            out["objects"].append({"name": "pressure_advance_test", "vertices": _on_bed(v), "faces": f, "settings": {}})
            count = int(round(math.ceil((end - start) / step))) + 1
            out["post"] = {"type": "pa_line", "cfg": cfg, "start": start, "step": step, "count": count, "numbers": bool(p.get("numbers", True))}
        else:
            # _calib_pa_pattern : réglages suggérés (SuggestedConfigCalibPAPattern), vitesse optimale, poignée au centre du plateau
            lw, lw1 = nozzle * 1.125, nozzle * 1.4
            speed = calib_pa.optimal_pa_speed(cfg["outer_wall_speed"], cfg["filament_max_volumetric_speed"], lw, cfg["layer_height"])
            cfg.update({"line_width": lw, "initial_layer_line_width": lw1, "initial_layer_speed": 30.0, "wall_loops": 3, "outer_wall_speed": speed})
            out["process"].update({"outer_wall_acceleration": [f"{cfg['outer_wall_acceleration']:g}"], "print_sequence": "by layer",
                                   "initial_layer_speed": ["30"], "line_width": f"{lw:g}", "initial_layer_line_width": f"{lw1:g}",
                                   "skirt_loops": "0", "wall_loops": "3", "brim_type": "no_brim", "outer_wall_speed": [f"{speed:g}"]})
            out["filament"] = {"filament_retract_when_changing_layer": ["0"], "filament_wipe": ["0"]}
            out["machine"].update({"wipe": ["0"], "retract_when_changing_layer": ["0"]})
            pat = calib_pa.Pattern(cfg, start, end, step)
            ox, oy, _ = pat.handle_pos_offset()
            cx, cy = (bed[0] + bed[2]) / 2 + ox, (bed[1] + bed[3]) / 2 + oy
            hs, hz = pat.HANDLE, pat.max_layer_z()
            box = np.array([[x, y, z] for z in (0, hz) for y in (-hs / 2, hs / 2) for x in (-hs / 2, hs / 2)], dtype=np.float64)
            faces = np.array([[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]])
            out["name"] = f"Pressure advance — motif {start:g}-{end:g}"
            out["objects"].append({"name": f"pa_pattern_{int(speed)}_{int(cfg['outer_wall_acceleration'])}", "vertices": box, "faces": faces,
                                   "settings": {}, "abs_xy": [cx, cy]})
            for z, g in pat.custom_gcodes((cx - hs / 2, cy - hs / 2, cx + hs / 2, cy + hs / 2)):
                out["layer_gcodes"].append({"z": round(z, 6), "extra": g})

    elif kind == "retraction":
        start, end, step = float(p.get("start", 0.0)), float(p.get("end", 2.0)), float(p.get("step", 0.1))
        v, f = _drc("retraction/retraction_tower.drc")
        lh = 0.05 if nozzle <= 0.1 else 0.1 if nozzle <= 0.2 else 0.2
        h = 1.0 + 0.4 + (end - start) / step - EPSILON
        if h < v[:, 2].max():
            v, f = _cut_keep(v, f, h, "lower")
        v = _on_bed(v)
        out["name"] = f"Tour de rétraction {start:g}-{end:g} mm"
        out["process"] = {"enable_wrapping_detection": "0", "wipe_inward": "0", "initial_layer_print_height": f"{lh:g}"}
        out["machine"].update({"use_firmware_retraction": "0", "max_layer_height": [f"{max(lh, _g(machine, 'max_layer_height', lh)):g}"]})
        settings = {"wall_loops": "2", "top_shell_layers": "0", "bottom_shell_layers": "3", "sparse_infill_density": "0%", "layer_height": f"{lh:g}",
                    "alternate_extra_wall": "0", "seam_position": "aligned", "wall_sequence": "inner wall/outer wall", "overhang_reverse": "0",
                    "precise_z_height": "0", "seam_slope_type": "none"}
        out["objects"].append({"name": "retraction_tower", "vertices": v, "faces": f, "settings": settings})
        out["post"] = {"type": "retraction", "start": start, "step": step, "length": _g(machine, "retraction_length", 0.8)}

    elif kind == "max_flow":
        start, end, step = float(p.get("start", 5.0)), float(p.get("end", 20.0)), float(p.get("step", 0.5))
        v, f = _drc("volumetric_speed/SpeedTestStructure.drc")
        area = machine.get("printable_area") or ["0x0", "256x0", "256x256", "0x256"]
        bed_w = max(float(a.split("x")[0]) for a in area) - min(float(a.split("x")[0]) for a in area)
        sx = (bed_w - 10) / (v[:, 0].max() - v[:, 0].min())
        if sx < 1.0:
            c = (v[:, 0].max() + v[:, 0].min()) / 2
            v[:, 0] = (v[:, 0] - c) * sx + c
        lw, lh = nozzle * 1.75, nozzle * 0.8
        h = (end - start + 1) / step
        if h < v[:, 2].max():
            v, f = _cut_keep(v, f, h, "lower")
        v = _on_bed(v)
        out["name"] = f"Débit volumétrique max {start:g}-{end:g} mm³/s"
        fmax = max(_g(filament, "filament_max_volumetric_speed", 12.0), 200.0)
        out["filament"] = {"filament_max_volumetric_speed": [f"{fmax:g}"], "slow_down_layer_time": ["0"]}
        out["machine"].update({"max_layer_height": [f"{max(lh, _g(machine, 'max_layer_height', lh)):g}"]})
        out["process"] = {"timelapse_type": "1", "spiral_mode": "1", "max_volumetric_extrusion_rate_slope": "0", "enable_wrapping_detection": "0"}
        settings = {"enable_overhang_speed": "0", "wall_loops": "1", "alternate_extra_wall": "0", "top_shell_layers": "0", "bottom_shell_layers": "0",
                    "sparse_infill_density": "0%", "outer_wall_line_width": f"{lw:g}", "layer_height": f"{lh:g}", "brim_type": "outer_and_inner",
                    "brim_width": "5", "brim_object_gap": "0", "precise_z_height": "0"}
        out["objects"].append({"name": "SpeedTestStructure", "vertices": v, "faces": f, "settings": settings})
        q = mm3_per_mm(lw, lh) * _g(filament, "filament_flow_ratio", 1.0)
        out["post"] = {"type": "outer_wall_speed", "start": start / q, "step": step / q}

    elif kind in ("flow1", "flow2", "yolo1", "yolo2"):
        pas = 1 if kind in ("flow1", "yolo1") else 2
        linear = kind.startswith("yolo")              # « YOLO » d'Orca : Orca-LinearFlow(_fine).3mf, débit absolu
        src = CALIB_DIR / "filament_flow" / (("Orca-LinearFlow.3mf" if pas == 1 else "Orca-LinearFlow_fine.3mf") if linear
                                             else f"flowrate-test-pass{pas}.3mf")
        proj = project3mf.parse(src)
        names = _object_names(src)
        cur = _g(filament, "filament_flow_ratio", 1.0) or 1.0
        first = _g(process, "initial_layer_print_height", 0.2)
        lh = nozzle / 2.0
        first = max(first, lh)
        xy = nozzle / 0.6
        zscale = (first + 9 * lh) / 2
        sxy = xy if xy > 1.2 else 1.0
        iw = nozzle * 1.2
        fmax = _g(filament, "filament_max_volumetric_speed", 12.0)
        maxs = (fmax / (mm3_per_mm(iw, lh) * (cur + (0.035 if pas == 2 else 0.05)) / cur) if linear
                else fmax / (mm3_per_mm(iw, lh) * (1.2 if pas == 1 else 1)))      # generate_max_speed_parameter_value
        speed_isi = math.floor(min(_g(process, "internal_solid_infill_speed", 150), maxs))
        speed_top = math.floor(min(_g(process, "top_surface_speed", 100), maxs))
        out["name"] = (f"Débit YOLO{' — perfectionniste' if pas == 2 else ''}" if linear else f"Test de débit — passe {pas}")
        out["process"] = {"layer_height": f"{lh:g}", "alternate_extra_wall": "0", "initial_layer_print_height": f"{first:g}", "reduce_crossing_wall": "1",
                          "enable_wrapping_detection": "0", "max_volumetric_extrusion_rate_slope": "0"}
        for o in proj["objects"]:
            name = names.get(int(o["gid"]) if str(o.get("gid", "")).isdigit() else -1, o["name"])
            mod = name[9:] if len(name) > 9 else "0"
            mod = ("-" + mod[1:]) if mod.startswith("m") else mod
            try:
                modifier = float(mod)
            except ValueError:
                modifier = 0.0
            vv = o["vertices"] @ np.array(o["matrix"]).reshape(4, 4).T[:3, :3].T + np.array(o["matrix"][12:15])
            vv = vv * [sxy, sxy, zscale]
            settings = {"wall_loops": "1", "only_one_wall_top": "1", "thick_internal_bridges": "0", "enable_extra_bridge_layer": "disabled",
                        "internal_bridge_density": "100%", "sparse_infill_density": "35%", "min_width_top_surface": "100%", "bottom_shell_layers": "2",
                        "top_shell_layers": "5", "top_shell_thickness": "0", "bottom_shell_thickness": "0", "detect_thin_wall": "1",
                        "filter_out_gap_fill": "0", "sparse_infill_pattern": "rectilinear", "top_surface_line_width": f"{iw:g}",
                        "internal_solid_infill_line_width": f"{iw:g}", "top_surface_pattern": "monotonic", "top_solid_infill_flow_ratio": "1",
                        "infill_direction": "45", "solid_infill_direction": "135", "center_of_surface_pattern": "each_surface",
                        "separated_infills": "0", "align_infill_direction_to_model": "1", "ironing_type": "no ironing",
                        "internal_solid_infill_speed": f"{speed_isi:g}", "top_surface_speed": f"{speed_top:g}", "seam_slope_type": "none",
                        "gap_fill_target": "nowhere", "calib_flowrate_topinfill_special_order": "1", "top_surface_fill_order": "default",
                        "print_flow_ratio": repr(float(((cur + modifier) / cur) if linear else 1.0 + modifier / 100.0))}
            out["objects"].append({"name": name, "vertices": _on_bed(vv) + [0, 0, 0], "faces": o["faces"], "settings": settings,
                                   "xy": [float(vv[:, 0].mean()), float(vv[:, 1].mean())]})
    elif kind == "vfa":
        start, end, step = float(p.get("start", 40)), float(p.get("end", 200)), float(p.get("step", 10))
        v, f = _drc("vfa/vfa.drc")
        lh = nozzle / 2.0
        h = 5.0 * ((end - start) / step + 1) - EPSILON          # vfa_base_block_height × nombre de paliers
        if h < v[:, 2].max():
            v, f = _cut_keep(v, f, h, "lower")
        xy, zs_ = nozzle / 0.4, (25 * lh) / 5.0                   # vfa_layers_per_block = 25
        v = _on_bed(v) * [xy, xy, zs_]
        out["name"] = f"Test VFA {start:g}-{end:g} mm/s"
        out["filament"] = {"slow_down_layer_time": ["0"]}
        out["process"] = {"enable_overhang_speed": ["0"], "timelapse_type": "1", "wall_loops": "1", "alternate_extra_wall": "0", "top_shell_layers": "0",
                          "bottom_shell_layers": "1", "sparse_infill_density": "0%", "detect_thin_wall": "0", "spiral_mode": "1",
                          "enable_wrapping_detection": "0", "precise_z_height": "0", "initial_layer_print_height": f"{lh:g}"}
        settings = {"layer_height": f"{lh:g}", "brim_type": "outer_only", "brim_width": "3", "brim_object_gap": "0"}
        out["objects"].append({"name": "vfa", "vertices": v, "faces": f, "settings": settings})
        out["post"] = {"type": "outer_wall_bands", "start": start, "end": end, "step": step}

    elif kind in ("is_freq", "is_damp", "cornering"):
        v, f = _drc("input_shaping/ringing_tower.drc")
        v = _on_bed(v)
        maxspeed = min(_g(machine, "machine_max_speed_x", 500), _g(machine, "machine_max_speed_y", 500))
        maxacc = _g(machine, "machine_max_acceleration_extruding", 20000)
        out["filament"] = {"slow_down_layer_time": ["0"], "slow_down_min_speed": ["0"], "slow_down_for_layer_cooling": ["0"],
                           "adaptive_pressure_advance": ["0"]}
        out["process"] = {"enable_overhang_speed": ["0"], "timelapse_type": "1", "wall_loops": "1", "top_shell_layers": "0", "bottom_shell_layers": "1",
                          "sparse_infill_density": "0%", "detect_thin_wall": "0", "spiral_mode": "1", "spiral_mode_smooth": "0",
                          "bottom_surface_pattern": "rectilinear", "outer_wall_speed": [f"{maxspeed:g}"], "default_acceleration": [f"{maxacc:g}"],
                          "outer_wall_acceleration": [f"{maxacc:g}"], "precise_z_height": "0", "default_jerk": ["0"],
                          "accel_to_decel_enable": "1", "accel_to_decel_factor": "100%"}
        settings = {"brim_type": "outer_only", "brim_width": "3", "brim_object_gap": "0"}
        out["objects"].append({"name": "ringing_tower", "vertices": v, "faces": f, "settings": settings})
        lh = 0.2 if kind == "is_freq" else _g(process, "layer_height", 0.2)
        if kind == "is_freq":
            out["process"]["layer_height"] = "0.2"
        zs = _layers(v[:, 2].max(), _g(process, "initial_layer_print_height", lh), lh)
        n = len(zs)
        if kind == "cornering":
            start, end = float(p.get("start", 1)), float(p.get("end", 15))
            out["name"] = f"Test de jerk (SCV) {start:g}-{end:g}"
            out["machine"].update({"machine_max_jerk_x": [f"{end:g}"], "machine_max_jerk_y": [f"{end:g}"], "input_shaping_emit": "1", "input_shaping_type": "Disable"})
            fmax = max(_g(filament, "filament_max_volumetric_speed", 12.0), 200.0)
            out["filament"]["filament_max_volumetric_speed"] = [f"{fmax:g}"]
            last = None
            for i, z in enumerate(zs):
                j = min(interpolate(i, n, start, end, 0), end)
                if j >= 0.01 and (last is None or abs(j - last) > 1e-9):
                    out["layer_gcodes"].append({"z": z, "extra": f"SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY={j:g}"})
                    last = j
        else:
            jerk = max(_g(machine, "machine_max_jerk_x", 5), 5.0)
            out["machine"].update({"machine_max_jerk_x": [f"{jerk:g}"], "machine_max_jerk_y": [f"{max(_g(machine, 'machine_max_jerk_y', 5), 5.0):g}"],
                                   "input_shaping_emit": "0"})
            if kind == "is_freq":
                f0, f1, damp = float(p.get("start", 15)), float(p.get("end", 110)), float(p.get("damp", 0.1))
                out["name"] = f"Input shaping — fréquence {f0:g}-{f1:g} Hz"
                for i, z in enumerate(zs):
                    if i == 1:
                        out["layer_gcodes"].append({"z": z, "extra": f"SET_INPUT_SHAPER DAMPING_RATIO_X={damp:.3f} DAMPING_RATIO_Y={damp:.3f}"})
                    elif i > 1:
                        fr = interpolate(i, n, f0, f1, 0)
                        out["layer_gcodes"].append({"z": z, "extra": f"SET_INPUT_SHAPER SHAPER_FREQ_X={fr:.2f} SHAPER_FREQ_Y={fr:.2f}"})
            else:
                freq, d0, d1 = float(p.get("freq", 50)), float(p.get("start", 0.0)), float(p.get("end", 0.4))
                out["name"] = f"Input shaping — amortissement {d0:g}-{d1:g} à {freq:g} Hz"
                for i, z in enumerate(zs):
                    if i == 1:
                        out["layer_gcodes"].append({"z": z, "extra": f"SET_INPUT_SHAPER SHAPER_FREQ_X={freq:.2f} SHAPER_FREQ_Y={freq:.2f}"})
                    elif i > 1:
                        dm = interpolate(i, n, d0, d1, 0)
                        if dm > 0:
                            out["layer_gcodes"].append({"z": z, "extra": f"SET_INPUT_SHAPER DAMPING_RATIO_X={dm:.3f} DAMPING_RATIO_Y={dm:.3f}"})
    else:
        raise ValueError(f"Calibration inconnue : {kind}")
    return out


# ---------- post-traitement du G-code (valeurs que le moteur d'Orca change en cours d'impression) ----------

def post_process(path, post):
    if not post:
        return
    if post["type"] == "pa_line":
        # GCode.cpp (Calib_PA_Line) : le test remplace l'impression des objets ; on garde le G-code de démarrage et de fin
        from . import calib_pa
        lines = Path(path).read_text(errors="replace").splitlines(keepends=True)
        a = next((i for i, ln in enumerate(lines) if ln.startswith(";LAYER_CHANGE")), None)
        b = max((i for i, ln in enumerate(lines) if ln.startswith(";TYPE:Custom")), default=None)
        if a is None or b is None or b <= a:
            raise RuntimeError("G-code inattendu : impossible de placer le test de pressure advance")
        test = calib_pa.pa_line(post["cfg"], post["start"], post["step"], post["count"], post.get("numbers", True))
        Path(path).write_text("".join(lines[:a]) + test + "".join(lines[b:]))
        return
    lines = Path(path).read_text(errors="replace").splitlines(keepends=True)
    z = 0.0
    out = []
    if post["type"] == "retraction":
        # GCode.cpp (Calib_Retraction_tower) : longueur = start + floor(max(0, z - 0.4)) * step ; on remet à l'échelle
        # chaque séquence de rétraction (E négatifs, essuyage compris) et la dérétraction qui suit
        base = post["length"] or 1.0
        target = base
        for ln in lines:
            if ln.startswith(";Z:"):
                z = float(ln[3:])
                target = post["start"] + math.floor(max(0.0, z - 0.4)) * post["step"]
            m = re.match(r"^(G1\b[^;]*?)\bE(-?[\d.]+)(.*)$", ln.rstrip("\n"))
            if m and z > 0:
                e = float(m.group(2))
                xy = re.search(r"\b[XY]-?[\d.]", m.group(1))
                if e < 0 or (e > 0 and not xy):
                    ne = e * target / base
                    ln = f"{m.group(1)}E{ne:.5f}{m.group(3)}\n"
            out.append(ln)
    elif post["type"] == "outer_wall_speed":
        # GCode.cpp (Calib_Vol_speed_Tower) : vitesse de paroi extérieure = start + z * step (mm/s), arrondie
        typ = ""
        for ln in lines:
            if ln.startswith(";Z:"):
                z = float(ln[3:])
            if ln.startswith(";TYPE:"):
                typ = ln[6:].strip()
            if typ == "Outer wall" and z > 0.3 and ln.startswith("G1 ") and " E" in ln and re.search(r"\bF[\d.]+", ln):
                f = round(post["start"] + max(0.0, z) * post["step"]) * 60
                ln = re.sub(r"\bF[\d.]+", f"F{f:g}", ln)
            out.append(ln)
    elif post["type"] == "outer_wall_bands":
        # GCode.cpp (Calib_VFA_Tower) : vitesse de paroi extérieure par paliers de couches (interpolate_value_across_layers)
        n = sum(1 for ln in lines if ln.startswith(";Z:"))
        idx, typ, speed = -1, "", None
        for ln in lines:
            if ln.startswith(";Z:"):
                idx += 1
                speed = round(interpolate(idx, max(n, 2), post["start"], post["end"], post["step"]))
            if ln.startswith(";TYPE:"):
                typ = ln[6:].strip()
            if typ == "Outer wall" and idx >= 1 and speed and ln.startswith("G1 ") and " E" in ln and re.search(r"\bF[\d.]+", ln):
                ln = re.sub(r"\bF[\d.]+", f"F{speed * 60:g}", ln)
            out.append(ln)
    Path(path).write_text("".join(out))
