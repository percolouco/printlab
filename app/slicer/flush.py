"""Volumes de purge entre filaments : transposition exacte du calcul d'OrcaSlicer 2.5.

Sources Orca : libslic3r/FlushVolCalc.cpp, libslic3r/FlushVolPredictor.cpp, slic3r/Utils/ColorSpaceConvert.cpp,
slic3r/GUI/Plater.cpp (get_min_flush_volumes, Sidebar::auto_calc_flushing_volumes_internal), GUI_App.cpp
(is_support_filament). Les calculs gardent les mêmes étapes et les mêmes arrondis (float, troncature en int).
"""
import math
import os
from functools import lru_cache
from pathlib import Path

import numpy as np

ORCA_DIR = Path(os.environ.get("ORCA_DIR", "/opt/orca"))
MIN_FLUSH_FROM_SUPPORT = 700
FLUSH_TO_SUPPORT = 230
MAX_FLUSH = 20000
f32 = np.float32


def _rgba(hexcol):
    h = (hexcol or "#FFFFFF").strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    h = (h + "FF")[:8] if len(h) == 6 else h[:8].ljust(8, "F")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16)


# ---------- ColorSpaceConvert.cpp ----------

def _rgb2hsv(r, g, b):
    r, g, b = f32(r), f32(g), f32(b)
    cmax = max(r, g, b)
    cmin = min(r, g, b)
    delta = f32(cmax - cmin)
    if abs(delta) < 0.001:
        h = f32(0)
    elif cmax == r:
        h = f32(60) * f32(math.fmod(float(f32((g - b) / delta)), 6.0))
    elif cmax == g:
        h = f32(60) * f32((b - r) / delta + f32(2))
    else:
        h = f32(60) * f32((r - g) / delta + f32(4))
    s = f32(0) if abs(cmax) < 0.001 else f32(delta / cmax)
    return f32(h), s, f32(cmax)


# ---------- FlushVolPredictor.cpp (table de mesures) ----------

def _rgb2lab(c):
    def gamma(x):
        return ((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92
    R, G, B = (gamma(v / 255.0) * 100 for v in c)
    x = 0.412453 * R + 0.357580 * G + 0.180423 * B
    y = 0.212671 * R + 0.715160 * G + 0.072169 * B
    z = 0.019334 * R + 0.119193 * G + 0.950227 * B
    thr = float(f32(0.008856))

    def f(t):
        return t ** (1.0 / 3.0) if t > thr else 7.787 * t + 0.137931
    xn, yn, zn = f(x / 95.0489), f(y / 100), f(z / 108.8840)
    return 116.0 * yn - 16.0, 500.0 * (xn - yn), 200.0 * (yn - zn)


def _de2000(l1, l2):
    p25 = 25 ** 7
    C1 = math.hypot(l1[1], l1[2])
    C2 = math.hypot(l2[1], l2[2])
    Cm = (C1 + C2) / 2.0
    G = 0.5 * (1 - math.sqrt(Cm ** 7 / (Cm ** 7 + p25)))
    a1, a2 = (1 + G) * l1[1], (1 + G) * l2[1]
    b1, b2 = l1[2], l2[2]
    c1, c2 = math.hypot(a1, b1), math.hypot(a2, b2)

    def hue(a, b):
        if a == 0 and b == 0:
            return 0.0
        h = math.atan2(b, a)
        return h + 2 * math.pi if h < 0 else h
    h1, h2 = hue(a1, b1), hue(a2, b2)
    dL, dC = l2[0] - l1[0], c2 - c1
    cm = c1 * c2
    if cm == 0:
        dH = 0.0
    else:
        dh = h2 - h1
        if dh < -math.pi:
            dh += 2 * math.pi
        elif dh > math.pi:
            dh -= 2 * math.pi
        dH = 2 * math.sqrt(cm) * math.sin(dh / 2.0)
    Lm, Cmn = (l1[0] + l2[0]) / 2.0, (c1 + c2) / 2.0
    hs = h1 + h2
    if c1 * c2 == 0:
        Hm = hs
    elif abs(h1 - h2) <= math.pi:
        Hm = hs / 2
    else:
        Hm = (hs + 2 * math.pi) / 2.0 if hs < 2 * math.pi else (hs - 2 * math.pi) / 2.0
    d = math.radians
    T = 1 - 0.17 * math.cos(Hm - d(30)) + 0.24 * math.cos(2 * Hm) + 0.32 * math.cos(3 * Hm + d(6)) - 0.2 * math.cos(4 * Hm - d(63))
    dth = d(30) * math.exp(-(((Hm - d(275)) / d(25)) ** 2))
    RC = 2 * math.sqrt(Cmn ** 7 / (Cmn ** 7 + p25))
    pl = (Lm - 50) ** 2
    SL = 1 + (0.015 * pl) / math.sqrt(20 + pl)
    SC = 1 + 0.045 * Cmn
    SH = 1 + 0.015 * Cmn * T
    RT = -math.sin(2 * dth) * RC
    return float(f32(math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH))))


@lru_cache(maxsize=4)
def _dataset(n):
    name = {0: "flush_data_standard.txt", 1: "flush_data_dual_standard.txt", 2: "flush_data_dual_highflow.txt"}.get(n)
    p = ORCA_DIR / "resources" / "flush" / (name or "")
    if not name or not p.exists():
        return None
    lines = p.read_text().splitlines()
    colors = [_rgba(c)[:3] for c in lines[1].split()]
    table = {}
    for line in lines[3:]:
        parts = line.split()
        if len(parts) != 3:
            return None
        table[(_rgba(parts[0])[:3], _rgba(parts[1])[:3])] = float(f32(parts[2]))
    return colors, table


def _predict(n, src, dst):
    ds = _dataset(n)
    if not ds:
        return None
    colors, table = ds
    sim = lambda c: next((k for k in colors if _de2000(_rgb2lab(k), _rgb2lab(c)) <= 5.0), None)  # noqa: E731
    a, b = sim(src), sim(dst)
    if a is None or b is None:
        return None
    return table.get((a, b))


# ---------- FlushVolCalc.cpp ----------

def _lum(r, g, b):
    return f32(f32(r) * f32(0.3) + f32(g) * f32(0.59) + f32(b) * f32(0.11))


def _delta_hs(h1, s1, v1, h2, s2, v2):
    r1, r2 = f32(h1 / f32(180) * f32(math.pi)), f32(h2 / f32(180) * f32(math.pi))
    dx = f32(math.cos(r1)) * s1 * v1 - f32(math.cos(r2)) * s2 * v2
    dy = f32(math.sin(r1)) * s1 * v1 - f32(math.sin(r2)) * s2 * v2
    return min(f32(1.2), f32(math.sqrt(float(dx * dx + dy * dy))))


def _calc_rgb(src, dst, dataset):
    if dataset == 0:
        v = _predict(0, src, dst)
        if v is not None:
            return int(v)
    sr, sg, sb = (f32(x) / f32(255) for x in src)
    dr, dg, db = (f32(x) / f32(255) for x in dst)
    fh, fs, fv = _rgb2hsv(sr, sg, sb)
    th, ts, tv = _rgb2hsv(dr, dg, db)
    hs = _delta_hs(fh, fs, fv, th, ts, tv)
    fl, tl = _lum(sr, sg, sb), _lum(dr, dg, db)
    if tl >= fl:
        lumi = f32(f32(math.pow(float(tl - fl), float(f32(0.7)))) * f32(560))
    else:
        lumi = f32((fl - tl) * f32(80))
        inter = f32(f32(0.67) * tv + f32(0.33) * fv)
        hs = min(inter, hs)
    hsf = f32(f32(230) * hs)
    vol = f32(math.sqrt(float(hsf * hsf + lumi * lumi - f32(2) * hsf * lumi * f32(math.cos(float(f32(120) / f32(180) * f32(math.pi)))))))
    vol = max(vol, f32(60))
    return int(vol)


def calc_flush_vol(src_hex, dst_hex, min_vol, dataset=0, max_vol=MAX_FLUSH):
    sr, sg, sb, sa = _rgba(src_hex)
    dr, dg, db, da = _rgba(dst_hex)
    if sa == 0:
        sr = sg = sb = 255
    if da == 0:
        dr = dg = db = 255
    if dataset != 0:
        v = _predict(dataset, (sr, sg, sb), (dr, dg, db))
        if v is not None:
            return min(int(v), max_vol)
    vol = f32(_calc_rgb((sr, sg, sb), (dr, dg, db), dataset))
    is_from_dark = _lum(sr, sg, sb) > f32(180) / f32(255)
    is_to_light = _lum(dr, dg, db) < f32(75) / f32(255)
    if dataset != 0 and is_from_dark and is_to_light:
        vol = f32(vol * f32(1.3))
    vol = f32(vol + f32(min_vol))
    return min(int(vol), max_vol)


# ---------- Plater.cpp / GUI_App.cpp ----------

def _get(cfg, key, default, idx=0):
    v = cfg.get(key, default)
    if isinstance(v, list):
        v = v[idx] if idx < len(v) else (v[0] if v else default)
    return v


def min_flush_volumes(machine_cfg, filament_cfgs, nozzle=0):
    """get_min_flush_volumes : volume de la buse moins la rétraction longue à la coupe (si activée)."""
    nozzle_volume = int(float(_get(machine_cfg, "nozzle_volume", "0", nozzle) or 0))
    level = int(float(_get(machine_cfg, "enable_long_retraction_when_cut", "0") or 0))
    activated = str(_get(machine_cfg, "long_retractions_when_cut", "0", nozzle)) in ("1", "true")
    printer_dist = float(_get(machine_cfg, "retraction_distances_when_cut", "18", nozzle) or 18)
    out = []
    for fc in filament_cfgs:
        retract = printer_dist if (level and activated) else 0
        fa = fc.get("filament_long_retractions_when_cut")
        fa = int(float(fa[0] if isinstance(fa, list) and fa else (fa if fa not in (None, "nil") else 0)) or 0) if fa not in (None, "nil", ["nil"]) else 0
        fd = fc.get("filament_retraction_distances_when_cut")
        fd = fd[0] if isinstance(fd, list) and fd else fd
        if fa == 0:
            retract = 0
        elif fa == 1 and level == 2:   # LongRectrationLevel::EnableFilament
            retract = int(float(fd)) if fd not in (None, "nil", "") else printer_dist
        out.append(int(nozzle_volume - math.pi * 1.75 * 1.75 / 4 * retract))
    return out


def is_support_filament(i, filament_cfgs, strict=False):
    types = [str(_get(fc, "filament_type", "PLA")) for fc in filament_cfgs]
    t = types[i]
    if not strict and t in ("PETG", "PLA"):
        others = ["PLA"] if t == "PETG" else ["PETG", "TPU", "TPU-AMS"]
        if any(x in others for x in types):
            return True
    return str(_get(filament_cfgs[i], "filament_is_support", "0")) in ("1", "true")


def flush_matrix(colours, machine_cfg, filament_cfgs, nozzle=0, multi_colours=None, mixed=None):
    """Matrice complète (n×n, ligne = filament de départ) recalculée comme « Auto-calc » d'Orca.

    Emplacements mixtes : jamais purgés ; Orca laisse leur ligne et leur colonne à la valeur d'initialisation
    (flush_volumes_vector : 140 + 140 = 280, cf. PresetBundle::update_multi_material_filament_presets)."""
    n = len(colours)
    dataset = int(float(_get(machine_cfg, "nozzle_flush_dataset", "0", nozzle) or 0))
    mins = min_flush_volumes(machine_cfg, filament_cfgs, nozzle)
    cols = [list(multi_colours[i]) if multi_colours and i < len(multi_colours) and multi_colours[i] else [colours[i]] for i in range(n)]
    sup = [is_support_filament(i, filament_cfgs) for i in range(n)]
    m = [0] * (n * n)
    for a in range(n):
        for b in range(n):
            if a == b:
                continue
            if mixed and (mixed[a] or mixed[b]):
                m[a * n + b] = 280
                continue
            if sup[b]:
                vol = FLUSH_TO_SUPPORT
            else:
                vol = max(calc_flush_vol(x, y, mins[a], dataset) for x in cols[a] for y in cols[b])
                if sup[a]:
                    vol = max(vol, MIN_FLUSH_FROM_SUPPORT)
            m[a * n + b] = vol
    return [str(v) for v in m]
