"""Texte 3D et SVG en volume, sur le modèle de l'outil Texte / SVG d'OrcaSlicer (GLGizmoEmboss / GLGizmoSVG).

Texte : contours des glyphes (fontTools) aplatis en polylignes, échelle = size_in_mm / unités par em (FontProp d'Orca, 10 mm par défaut),
écart entre lettres / lignes en unités de police (char_gap / line_gap), alignement centré, extrusion sur l'épaisseur.
SVG : chemins (svgelements) aplatis, mis à l'échelle à la largeur voulue, extrudés.
Le volume est centré en X/Y et va de z = 0 (face posée sur l'objet) à z = épaisseur.
"""
from pathlib import Path

import numpy as np

FONT_DIRS = [Path("/usr/share/fonts"), Path("/usr/local/share/fonts")]


def fonts():
    out = []
    for d in FONT_DIRS:
        if d.is_dir():
            for p in sorted(d.rglob("*.ttf")) + sorted(d.rglob("*.otf")):
                out.append({"file": p.name, "name": p.stem.replace("-", " ")})
    return out


def _font_path(name):
    for d in FONT_DIRS:
        if d.is_dir():
            for p in d.rglob("*"):
                if p.name == name:
                    return p
    raise ValueError(f"Police introuvable : {name}")


def _flatten(seg_start, ctrl, end, steps=8, cubic=False):
    t = np.linspace(0, 1, steps + 1)[1:, None]
    p0 = np.asarray(seg_start, dtype=np.float64)
    p3 = np.asarray(end, dtype=np.float64)
    if cubic:
        c1, c2 = (np.asarray(c, dtype=np.float64) for c in ctrl)
        return ((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * c1 + 3 * (1 - t) * t ** 2 * c2 + t ** 3 * p3
    c = np.asarray(ctrl[0], dtype=np.float64)
    return ((1 - t) ** 2) * p0 + 2 * (1 - t) * t * c + t ** 2 * p3


class _PolyPen:
    """Pen fontTools → liste de contours (polylignes)."""

    def __init__(self):
        self.contours, self.cur, self.pos = [], [], None

    def moveTo(self, p):
        self._close()
        self.cur, self.pos = [p], p

    def lineTo(self, p):
        self.cur.append(p)
        self.pos = p

    def curveTo(self, *pts):
        # cubique (éventuellement une suite) : on découpe par 3 points
        pts = list(pts)
        while len(pts) >= 3:
            c1, c2, e = pts[:3]
            self.cur.extend(map(tuple, _flatten(self.pos, (c1, c2), e, cubic=True)))
            self.pos = e
            pts = pts[3:]

    def qCurveTo(self, *pts):
        pts = list(pts)
        if pts and pts[-1] is None:          # contour entièrement quadratique (rare)
            pts = pts[:-1]
        # suite de points de contrôle quadratiques avec points implicites au milieu
        for i, c in enumerate(pts[:-1]):
            e = pts[-1] if i == len(pts) - 2 else ((c[0] + pts[i + 1][0]) / 2, (c[1] + pts[i + 1][1]) / 2)
            self.cur.extend(map(tuple, _flatten(self.pos, (c,), e)))
            self.pos = e

    def closePath(self):
        self._close()

    endPath = closePath

    def _close(self):
        if len(self.cur) >= 3:
            self.contours.append(np.asarray(self.cur, dtype=np.float64))
        self.cur = []

    def addComponent(self, glyphName, transformation):   # glyphes composés (accents) : décomposés par la police
        raise NotImplementedError


def text_polygons(text, font_file, size_mm=10.0, char_gap=0, line_gap=0):
    from fontTools.pens.recordingPen import DecomposingRecordingPen
    from fontTools.ttLib import TTFont
    font = TTFont(str(_font_path(font_file)))
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    upem = font["head"].unitsPerEm
    hhea = font["hhea"]
    line_h = hhea.ascent - hhea.descent + hhea.lineGap
    scale = size_mm / upem                        # Emboss::get_text_shape_scale : size_in_mm / unit_per_em
    lines = text.split("\n")
    polys, widths = [], []
    for li, line in enumerate(lines):
        x = 0.0
        y = -li * (line_h + line_gap)
        line_polys = []
        for ch in line:
            gname = cmap.get(ord(ch)) or ".notdef"
            g = gs[gname]
            rec = DecomposingRecordingPen(gs)
            g.draw(rec)
            pen = _PolyPen()
            rec.replay(pen)
            pen._close()
            for c in pen.contours:
                line_polys.append(c + [x, y])
            x += g.width + char_gap
        widths.append(x - char_gap if line else 0)
        polys.append(line_polys)
    # alignement centré de chaque ligne (FontProp::Align par défaut : center, center)
    wmax = max(widths) if widths else 0
    out = []
    for lp, w in zip(polys, widths):
        for c in lp:
            out.append((c - [w / 2, 0]) * scale)
    if not out:
        raise ValueError("Texte vide")
    allp = np.concatenate(out)
    mid = (allp.min(axis=0) + allp.max(axis=0)) / 2
    return [c - mid for c in out], float(upem)


def svg_polygons(svg_bytes, width_mm=30.0):
    import io

    from svgelements import SVG, Path as SPath, Shape
    svg = SVG.parse(io.BytesIO(svg_bytes))
    contours = []
    for el in svg.elements():
        if not isinstance(el, Shape):
            continue
        try:
            p = abs(SPath(el))
        except Exception:
            continue
        for sub in p.as_subpaths():
            sp = SPath(sub)
            L = sp.length(error=1e-3)
            if not L:
                continue
            n = max(8, min(400, int(L / 0.5)))
            pts = np.array([(pt.x, -pt.y) for pt in (sp.point(t) for t in np.linspace(0, 1, n))], dtype=np.float64)
            if len(pts) >= 3:
                contours.append(pts)
    if not contours:
        raise ValueError("Aucune forme exploitable dans ce SVG")
    allp = np.concatenate(contours)
    lo, hi = allp.min(axis=0), allp.max(axis=0)
    s = width_mm / max(hi[0] - lo[0], 1e-9)
    mid = (lo + hi) / 2
    return [(c - mid) * s for c in contours]


def extrude(polys, depth):
    """Polygones (règle non nulle, comme les polices TrueType) → solide de z = 0 à z = depth."""
    from manifold3d import CrossSection, FillRule, Manifold  # noqa: F401
    cs = CrossSection([np.ascontiguousarray(p, dtype=np.float64) for p in polys], fillrule=FillRule.NonZero)
    if cs.is_empty():
        raise ValueError("Contours vides")
    m = Manifold.extrude(cs, float(depth))
    mesh = m.to_mesh()
    return np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3], np.asarray(mesh.tri_verts, dtype=np.int64)
