"""Tests de pressure advance « ligne » et « motif » d'OrcaSlicer 2.5 (libslic3r/calib.cpp), portés en Python.

Orca les génère dans le moteur (GCode.cpp) à partir des « paramètres de calibration » de l'interface, que la ligne de
commande ne connaît pas :
- ligne (CalibPressureAdvanceLine) : le G-code du test remplace la première couche du modèle de remplacement
  (pressure_advance_test.drc) → post-traitement du G-code découpé ;
- motif (CalibPressureAdvancePattern) : G-code personnalisé par couche autour d'un petit cube « poignée »
  (generate_custom_gcodes) → G-code de couche du projet, inséré par Orca lui-même.
Le rédacteur (GCodeWriter) est imité pour Klipper : déplacements, rétractions, extrusions relatives (M83).
"""
import math


def _num(v, dec):
    s = f"{v:.{dec}f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    if s in ("", "-", "-0"):
        return "0"
    if s.startswith("0."):
        s = s[1:]
    elif s.startswith("-0."):
        s = "-" + s[2:]
    return s


def mm3_per_mm(width, height):
    """Flow::mm3_per_mm (rectangle aux bouts arrondis)."""
    return (width - height * (1 - math.pi / 4)) * height


def g_prec(v, digits):
    """std::setprecision(digits) d'un flux C++ (format %g)."""
    s = f"{v:.{digits}g}"
    if "e" in s:
        s = f"{v:.{digits}f}".rstrip("0").rstrip(".")
    return s


class Writer:
    """GCodeWriter minimal (Klipper, E relatif)."""

    def __init__(self, cfg, offset=(0.0, 0.0)):
        self.c = cfg
        self.ox, self.oy = offset
        self.retracted = False
        self.z = None

    def travel_to_xy(self, x, y):
        return f"G1 X{_num(x + self.ox, 3)} Y{_num(y + self.oy, 3)} F{_num(self.c['travel_speed'] * 60, 0)}\n"

    def travel_to_z(self, z):
        self.z = z
        return f"G1 Z{_num(z, 3)} F{_num(self.c['travel_speed_z'] * 60, 0)}\n"

    def retract(self):
        if self.retracted or self.c["retraction_length"] <= 0:
            return ""
        self.retracted = True
        return f"G1 E-{_num(self.c['retraction_length'], 5)} F{_num(self.c['retraction_speed'] * 60, 0)}\n"

    def unretract(self):
        if not self.retracted:
            return ""
        self.retracted = False
        return f"G1 E{_num(self.c['retraction_length'], 5)} F{_num(self.c['deretraction_speed'] * 60, 0)}\n"

    def extrude_to_xy(self, x, y, de):
        return f"G1 X{_num(x + self.ox, 3)} Y{_num(y + self.oy, 3)} E{_num(de, 5)}\n"

    def set_speed(self, f):
        return f"G1 F{_num(f, 3)}\n"

    def set_pressure_advance(self, pa):
        return "" if pa < 0 else f"SET_PRESSURE_ADVANCE ADVANCE={g_prec(pa, 4)}; Override pressure advance value\n"

    def set_print_acceleration(self, a):
        return f"SET_VELOCITY_LIMIT ACCEL={int(a)}\n"


class _Base:
    """CalibPressureAdvance : chiffres, lignes, boîtes."""
    DIGIT_SEG, DIGIT_GAP, MAX_NUM_LEN, ENCROACH = 2.0, 1.0, 5, 1.0 / 3.0

    def __init__(self, w):
        self.w = w
        self.last = (0.0, 0.0)
        self.number_len = self.MAX_NUM_LEN

    def number_spacing(self):
        return self.DIGIT_SEG + self.DIGIT_GAP

    def move_to(self, x, y, z=0.0, layer_h=-1.0):
        w, g = self.w, ""
        g += w.retract()
        if z > 1e-4 and layer_h >= 0:
            g += w.travel_to_z(z) + w.travel_to_xy(x, y) + w.travel_to_z(layer_h)
        else:
            g += w.travel_to_xy(x, y)
        g += w.unretract()
        self.last = (x, y)
        return g

    def draw_line(self, x, y, e_per_mm, speed):
        d = math.hypot(x - self.last[0], y - self.last[1])
        g = self.w.set_speed(speed) + self.w.extrude_to_xy(x, y, e_per_mm * d)
        self.last = (x, y)
        return g

    @staticmethod
    def num_str(num, precision):
        return g_prec(num, precision if num >= 1000 else precision - 1) if precision else g_prec(num, 6)

    def draw_number(self, sx, sy, value, bottom_to_top, lw, epm, speed):
        s = self.num_str(value, self.number_len)
        g = self.w.set_speed(speed)
        for i, ch in enumerate(s[: self.number_len]):
            if bottom_to_top:
                g += self._digit(sx, sy + i * self.number_spacing(), ch, True, lw, epm)
            else:
                g += self._digit(sx + i * self.number_spacing(), sy, ch, False, lw, epm)
        return g

    def _digit(self, sx, sy, ch, btt, lw, epm):
        return _Digit(self, sx, sy, btt, lw, epm).draw(ch)

    def draw_box(self, min_x, min_y, size_x, size_y, perims, height, lw, speed, epm, filled):
        g = ""
        spacing = lw - height * (1 - math.pi / 4)
        s45 = math.sin(math.radians(45))
        max_p = min(math.floor(size_x * s45) / (spacing / s45), math.floor(size_y * s45) / (spacing / s45))
        perims = int(min(perims, max_p))
        x, y = min_x, min_y
        max_x, max_y = min_x + size_x, min_y + size_y
        g += self.move_to(x, y)
        for i in range(perims):
            if i:
                x += spacing
                y += spacing
                g += self.move_to(x, y)
            y += size_y - i * spacing * 2
            g += self.draw_line(x, y, epm, speed)
            x += size_x - i * spacing * 2
            g += self.draw_line(x, y, epm, speed)
            y -= size_y - i * spacing * 2
            g += self.draw_line(x, y, epm, speed)
            x -= size_x - i * spacing * 2
            g += self.draw_line(x, y, epm, speed)
        if not filled:
            return g
        sp45 = spacing / s45
        bm = spacing * (perims - 1) + lw * (1 - self.ENCROACH)
        x0, x1, y0, y1 = min_x + bm, max_x - bm, min_y + bm, max_y - bm
        xc, yc = math.floor((x1 - x0) / sp45), math.floor((y1 - y0) / sp45)
        xr, yr = math.fmod(x1 - x0, sp45), math.fmod(y1 - y0, sp45)
        x, y = x0, y0
        g += self.move_to(x, y)
        for i in range(xc + yc + (1 if xr + yr >= sp45 else 0)):
            if i < min(xc, yc):
                if i % 2 == 0:
                    x += sp45; y = y0; g += self.move_to(x, y)  # noqa: E702
                    y += x - x0; x = x0; g += self.draw_line(x, y, epm, speed)  # noqa: E702
                else:
                    y += sp45; x = x0; g += self.move_to(x, y)  # noqa: E702
                    x += y - y0; y = y0; g += self.draw_line(x, y, epm, speed)  # noqa: E702
            elif i < max(xc, yc):
                if xc > yc:
                    if i % 2 == 0:
                        x += sp45; y = y0; g += self.move_to(x, y)  # noqa: E702
                        x -= y1 - y0; y = y1; g += self.draw_line(x, y, epm, speed)  # noqa: E702
                    else:
                        if i == yc:
                            x += sp45 - yr; yr = 0  # noqa: E702
                        else:
                            x += sp45
                        y = y1; g += self.move_to(x, y)  # noqa: E702
                        x += y1 - y0; y = y0; g += self.draw_line(x, y, epm, speed)  # noqa: E702
                else:
                    if i % 2 == 0:
                        x = x1
                        if i == xc:
                            y += sp45 - xr; xr = 0  # noqa: E702
                        else:
                            y += sp45
                        g += self.move_to(x, y)
                        x = x0; y += x1 - x0; g += self.draw_line(x, y, epm, speed)  # noqa: E702
                    else:
                        x = x0; y += sp45; g += self.move_to(x, y)  # noqa: E702
                        x = x1; y -= x1 - x0; g += self.draw_line(x, y, epm, speed)  # noqa: E702
            else:
                if i % 2 == 0:
                    x = x1
                    y += (sp45 - xr) if i == xc else sp45
                    g += self.move_to(x, y)
                    x -= y1 - y; y = y1; g += self.draw_line(x, y, epm, speed)  # noqa: E702
                else:
                    x += (sp45 - yr) if i == yc else sp45
                    y = y1
                    g += self.move_to(x, y)
                    y -= x1 - x; x = x1; g += self.draw_line(x, y, epm, speed)  # noqa: E702
        return g


class _Digit:
    """Glyphe à 7 segments de CalibPressureAdvance::draw_digit (seul le glyphe demandé est tracé)."""

    def __init__(self, base, sx, sy, btt, lw, epm):
        self.b, self.sx, self.sy, self.btt, self.lw, self.epm = base, sx, sy, btt, lw, epm

    def draw(self, ch):
        b, sx, sy, L = self.b, self.sx, self.sy, _Base.DIGIT_SEG
        gap = self.lw / 2.0
        dE, d2 = self.epm * L, self.epm * L * 2
        if self.btt:
            P = {"0": (sx, sy), "05": (sx, sy + L / 2), "1": (sx, sy + L), "2": (sx + L, sy + L), "3": (sx + L, sy),
                 "4": (sx + 2 * L, sy), "45": (sx + 2 * L, sy + L / 2), "5": (sx + 2 * L, sy + L)}
            g03, g23, dot = (sx + gap, sy), (sx + L, sy + L + gap), (-L / 2, 0)
        else:
            P = {"0": (sx, sy), "05": (sx + L / 2, sy), "1": (sx + L, sy), "2": (sx + L, sy - L), "3": (sx, sy - L),
                 "4": (sx, sy - 2 * L), "45": (sx + L / 2, sy - 2 * L), "5": (sx + L, sy - 2 * L)}
            g03, g23, dot = (sx, sy - gap), (sx + L - gap, sy - L), (0, L / 2)
        w = b.w
        out = []
        mv = lambda p: out.append(b.move_to(*p))  # noqa: E731
        ex = lambda p, e: out.append(w.extrude_to_xy(p[0], p[1], e))  # noqa: E731
        p = P
        if ch == "0":
            mv(p["0"]); ex(p["1"], dE); ex(p["5"], d2); ex(p["4"], dE); ex(g03, d2)  # noqa: E702
        elif ch == "1":
            mv(p["05"]); ex(p["45"], d2)  # noqa: E702
        elif ch == "2":
            mv(p["0"]); ex(p["1"], dE); ex(p["2"], dE); ex(p["3"], dE); ex(p["4"], dE); ex(p["5"], dE)  # noqa: E702
        elif ch == "3":
            mv(p["0"]); ex(p["1"], dE); ex(p["5"], d2); ex(p["4"], dE); mv(g23); ex(p["3"], dE)  # noqa: E702
        elif ch == "4":
            mv(p["0"]); ex(p["3"], dE); ex(p["2"], dE); mv(p["1"]); ex(p["5"], d2)  # noqa: E702
        elif ch == "5":
            mv(p["1"]); ex(p["0"], dE); ex(p["3"], dE); ex(p["2"], dE); ex(p["5"], dE); ex(p["4"], dE)  # noqa: E702
        elif ch == "6":
            mv(p["1"]); ex(p["0"], dE); ex(p["4"], d2); ex(p["5"], dE); ex(p["2"], dE); ex(p["3"], dE)  # noqa: E702
        elif ch == "7":
            mv(p["0"]); ex(p["1"], dE); ex(p["5"], d2)  # noqa: E702
        elif ch == "8":
            mv(p["2"]); ex(p["3"], dE); ex(p["4"], dE); ex(p["5"], dE); ex(p["1"], d2); ex(p["0"], dE); ex(p["3"], dE)  # noqa: E702
        elif ch == "9":
            mv(p["5"]); ex(p["1"], d2); ex(p["0"], dE); ex(p["3"], dE); ex(p["2"], dE)  # noqa: E702
        elif ch == ".":
            mv(p["45"]); ex((p["45"][0] + dot[0], p["45"][1] + dot[1]), dE)  # noqa: E702
        return "".join(out)


def optimal_pa_speed(outer_wall_speed, max_vol, line_width, layer_height):
    """CalibPressureAdvance::find_optimal_PA_speed."""
    return math.floor(min(max(100.0, outer_wall_speed), max_vol / mm3_per_mm(line_width, layer_height)))


def pa_line(cfg, start, step, count, numbers=True):
    """CalibPressureAdvanceLine::generate_test + print_pa_lines ; cfg = valeurs effectives (mm, mm/s)."""
    w = Writer(cfg)
    b = _Base(w)
    nd = cfg["nozzle_diameter"]
    lw = nd * 1.5 if nd < 0.51 else nd * 1.05
    h = cfg["initial_layer_print_height"]
    space_y, l_short = 3.5, 20.0
    bx0, by0, bx1, by1 = cfg["bed"]
    bw, bh = bx1 - bx0, by1 - by0
    count = min(count, int((bh - 10) / space_y))
    l_long = 40 + min(bw - 120.0, 0.0)
    sx = bx0 + (bw - l_short * 2 - l_long - 20) / 2
    sy = by0 + (bh - count * space_y) / 2
    fil_area = math.pi * (cfg["filament_diameter"] / 2) ** 2
    epm = lambda width: mm3_per_mm(width, h) * cfg["filament_flow_ratio"] * cfg["print_flow_ratio"] / fil_area  # noqa: E731
    e, e_num = epm(lw), epm(nd)
    fast = optimal_pa_speed(cfg["outer_wall_speed"], cfg["filament_max_volumetric_speed"], lw, h)
    slow = max(10.0, fast / 10.0)
    if fast < slow + 5:
        fast = slow + 5
    fast, slow = fast * 60, slow * 60
    zo = cfg.get("z_offset", 0.0)
    g = ";LAYER_CHANGE\n;Z:%s\n;HEIGHT:%s\n" % (_num(h + zo, 3), _num(h, 3))
    if cfg.get("outer_wall_acceleration", 0) > 0:
        g += w.set_print_acceleration(math.floor(cfg["outer_wall_acceleration"] + 0.5))
    g += w.travel_to_z(h + zo)
    g += ";TYPE:Custom\n" + w.set_pressure_advance(0.0)
    y = sy
    g += b.move_to(sx, y + count * space_y)
    g += w.set_speed(slow) + w.extrude_to_xy(sx, y, e * space_y * count * 1.2)
    for i in range(count):
        g += w.set_pressure_advance(start + i * step)
        g += b.move_to(sx, y + i * space_y)
        g += ";TYPE:Custom\n" + w.set_speed(slow) + w.extrude_to_xy(sx + l_short, y + i * space_y, e * l_short)
        g += ";TYPE:Outer wall\n" + w.set_speed(fast) + w.extrude_to_xy(sx + l_short + l_long, y + i * space_y, e * l_long)
        g += ";TYPE:Custom\n" + w.set_speed(slow) + w.extrude_to_xy(sx + 2 * l_short + l_long, y + i * space_y, e * l_short)
        if i == 0:
            g += w.set_pressure_advance(0.0)
            g += w.extrude_to_xy(sx + 2 * l_short + l_long, y + count * space_y, e * space_y * count * 1.2)
    g += w.set_pressure_advance(0.0)
    if numbers:
        bsx = sx + 2 * l_short + l_long + lw
        g += ";TYPE:Bottom surface\n"
        g += b.draw_box(bsx, sy - space_y, b.number_spacing() * 8, (count + 1) * space_y, 2, h, lw, fast, e, True)
        g += ";LAYER_CHANGE\n;Z:%s\n;HEIGHT:%s\n;TYPE:Top surface\n" % (_num(2 * h + zo, 3), _num(h, 3))
        g += w.travel_to_z(2 * h + zo)
        for i in range(0, count, 2):
            g += b.draw_number(bsx + 3 + lw, y + i * space_y + space_y / 2, start + i * step, False, nd, e_num, 3600)
    return g + w.retract()


class Pattern:
    """CalibPressureAdvancePattern (un seul test : une vitesse, une accélération)."""
    HANDLE, HANDLE_SP, LAYERS, SIDE, ANGLE, PSPACE, GPAD_H, GPAD_V = 5.0, 1.2, 4, 30.0, 90, 2, 1.0, 1.0

    def __init__(self, cfg, start, end, step):
        self.c, self.start, self.end, self.step = cfg, start, end, step
        self.w = Writer(cfg)
        self.b = _Base(self.w)
        self.b.number_len = self.b.MAX_NUM_LEN

    # réglages (m_config)
    def lw(self):
        return self.c["line_width"]

    def lw1(self):
        return self.c["initial_layer_line_width"]

    def h1(self):
        return self.c["initial_layer_print_height"]

    def h(self):
        return self.c["layer_height"]

    def walls(self):
        return int(self.c["wall_loops"])

    def n(self):
        return math.ceil((self.end - self.start) / self.step + 1)

    def sp(self):
        return self.lw() - self.h() * (1 - math.pi / 4)

    def sp1(self):
        return self.lw1() - self.h1() * (1 - math.pi / 4)

    def sp_angle(self):
        return self.sp() / math.sin(math.radians(self.ANGLE) / 2)

    def frame_y(self):
        return math.sin(math.radians(self.ANGLE / 2)) * self.SIDE * 2

    def max_num_len(self):
        most = max(len(_Base.num_str(self.start + i * self.step, 6)) for i in range(0, self.n(), 2))
        most = max(most, len(_Base.num_str(self.c["outer_wall_acceleration"], 6)))
        return min(most, _Base.MAX_NUM_LEN)

    def num_height(self):
        k = self.max_num_len()
        return k * _Base.DIGIT_SEG + (k - 1) * _Base.DIGIT_GAP

    def shift(self):
        return (self.walls() - 1) * self.sp1() + self.lw1() + self.GPAD_H

    def object_size_x(self):
        n = self.n()
        return (n * ((self.walls() - 1) * self.sp_angle()) + (n - 1) * (self.PSPACE + self.lw())
                + math.cos(math.radians(self.ANGLE) / 2) * self.SIDE + self.sp1() * self.walls())

    def object_size_y(self):
        return 2 * (math.sin(math.radians(self.ANGLE) / 2) * self.SIDE) + self.num_height() + self.GPAD_V * 2 + self.lw1()

    def print_size_x(self):
        return self.object_size_x() + self.shift()

    def max_layer_z(self):
        return self.h1() + (self.LAYERS - 1) * self.h()

    def handle_pos_offset(self):
        return (0 - self.print_size_x() / 2 + self.HANDLE / 2 + self.HANDLE_SP, 0 - self.num_height() / 2 - self.GPAD_V, self.max_layer_z() / 2)

    def glyph_start_x(self, i):
        x = self.sx + self.shift() + i * (self.walls() - 1) * self.sp_angle() + i * self.lw() + i * self.PSPACE
        x += self.walls() * self.sp_angle() / 2
        return x - (self.lw() + 2 * _Base.DIGIT_SEG) / 2

    def flow_val(self):
        return self.c["outer_wall_speed"] * mm3_per_mm(self.lw(), self.h()) * self.c["filament_flow_ratio"]

    def custom_gcodes(self, cube_bbox):
        """Liste [(print_z, G-code)] ; cube_bbox = (min_x, min_y, max_x, max_y) de la poignée sur le plateau."""
        c, w, b = self.c, self.w, self.b
        self.sx = cube_bbox[0] - self.HANDLE_SP
        self.sy = cube_bbox[3] - math.sin(math.radians(self.ANGLE) / 2) * self.SIDE - (cube_bbox[3] - cube_bbox[1]) / 2
        sx, sy = self.sx, self.sy
        zo = c.get("z_offset", 0.0)
        fil_area = math.pi * (c["filament_diameter"] / 2) ** 2
        epm = lambda width, hh: mm3_per_mm(width, hh) * c["filament_flow_ratio"] / fil_area  # noqa: E731 (draw_line : sans print_flow_ratio)
        speed1, speedp, accel = c["initial_layer_speed"], c["outer_wall_speed"], c["outer_wall_acceleration"]
        items = []
        g = "; start pressure advance pattern for layer\n"
        g += b.move_to(sx, sy) + w.travel_to_z(self.h1() + zo) + w.set_pressure_advance(self.start)
        g += ";TYPE:Outer wall\n"
        g += b.draw_box(sx, sy, self.print_size_x(), self.frame_y(), self.walls(), self.h1(), self.lw1(), speed1 * 60, epm(self.lw1(), self.h1()), False)
        g += ";TYPE:Bottom surface\n"
        g += b.draw_box(sx, sy + self.frame_y() + self.sp1(), self.print_size_x(), self.num_height() + self.sp1() + self.GPAD_V * 2,
                        self.walls(), self.h1(), self.lw1(), speed1 * 60, epm(self.lw1(), self.h1()), True)
        zhop = c.get("z_hop", 0.0)
        g += ";TYPE:Outer wall\n"
        for i in range(self.LAYERS):
            lh = self.h1() + zo + i * self.h()
            zh = lh + zhop
            if i > 0:
                g += "; end pressure advance pattern for layer\n"
                items.append((self.h1() + (i - 1) * self.h(), g))
                g = "; start pressure advance pattern for layer\n" + w.travel_to_z(lh)
            if i == 1:
                b.number_len = self.max_num_len()
                g += w.set_pressure_advance(self.start)
                ne = epm(self.lw(), self.h())
                g += ";TYPE:Outer wall\n"
                yy = sy + self.frame_y() + self.GPAD_V + self.lw()
                for j in range(0, self.n(), 2):
                    g += b.draw_number(self.glyph_start_x(j), yy, self.start + j * self.step, True, self.lw(), ne, speed1)
                g += b.draw_number(self.glyph_start_x(self.n() + 2), yy, self.flow_val(), True, self.lw(), ne, speed1)
                g += b.draw_number(self.glyph_start_x(self.n() + 4), yy, accel, True, self.lw(), ne, speed1)
            to_x, to_y, side = sx + self.shift(), sy, self.SIDE
            half = math.radians(self.ANGLE) / 2
            if i == 0:
                shrink = (self.sp1() * (self.walls() - 1) + self.lw1() * (1 - _Base.ENCROACH)) / math.sin(half)
                side = self.SIDE - shrink
                to_x += shrink * math.sin(math.radians(90) - half)
                to_y += self.sp1() * (self.walls() - 1) + self.lw1() * (1 - _Base.ENCROACH)
            else:
                g += w.set_print_acceleration(max(1, int(accel) - 1))
                g += b.move_to(sx, sy, zh, lh)
                g += b.draw_line(sx, sy + self.frame_y(), epm(self.lw(), self.h()), max(1, int(speedp) - 1) * 60)
                g += w.set_print_acceleration(accel)
            ix, iy = to_x, to_y
            g += b.move_to(to_x, to_y, zh, lh)
            for j in range(self.n()):
                g += w.set_pressure_advance(self.start + j * self.step) + ";TYPE:Outer wall\n"
                hh = self.h1() if i == 0 else self.h()
                spd = (speed1 if i == 0 else speedp) * 60
                for k in range(self.walls()):
                    to_x += math.cos(half) * side
                    to_y += math.sin(half) * side
                    g += b.draw_line(to_x, to_y, epm(self.lw(), hh), spd)
                    to_x -= math.cos(half) * side
                    to_y += math.sin(half) * side
                    g += b.draw_line(to_x, to_y, epm(self.lw(), hh), spd)
                    to_y = iy
                    if k != self.walls() - 1:
                        to_x += self.sp_angle()
                        g += b.move_to(to_x, to_y, zh, lh)
                    elif j != self.n() - 1:
                        to_x += self.PSPACE + self.lw()
                        g += b.move_to(to_x, to_y, zh, lh)
                    elif i != self.LAYERS - 1:
                        to_x = ix
                        g += b.move_to(to_x, to_y, zh, lh)
        g += w.set_pressure_advance(self.start) + "; end pressure advance pattern for layer\n"
        items.append((self.max_layer_z(), g))
        return items
