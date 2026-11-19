"""Étiquettes RFID de la QIDI Box (format BoxRFID de TinkerBarn).

Étiquette MIFARE Classic 1K, bloc 4 (clé A D3F7D3F7D3F7 puis FFFFFFFFFFFF) :
  octet 0 = code matière  (section [filaN] de officiall_filas_list.cfg)
  octet 1 = code couleur  ([colordict], 24 teintes)
  octet 2 = code marque   ([vendor_list])
  octets 3..15 = 0
La Box lit l'étiquette à l'insertion et expose marque / matière / couleur dans multi_color_controller
(box0_filament_info_N_*, info_from_rfid = 1). Aucun identifiant de bobine n'est écrit : PrintLab garde la
« signature » de chaque étiquette écrite et retrouve la bobine en comparant marque + matière + couleur.
"""
import re

KEYS = ("D3F7D3F7D3F7", "FFFFFFFFFFFF")
BLOCK = 4


def parse_cfg(text):
    """officiall_filas_list.cfg → {"materials": {n: {...}}, "colors": {n: "#RRGGBB"}, "vendors": {n: nom}}."""
    out = {"materials": {}, "colors": {}, "vendors": {}}
    sec = None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"\[(.+)\]$", line)
        if m:
            sec = m.group(1)
            continue
        if "=" not in line or not sec:
            continue
        k, v = (x.strip() for x in line.split("=", 1))
        fm = re.match(r"fila(\d+)$", sec)
        if fm:
            mat = out["materials"].setdefault(int(fm.group(1)), {})
            mat[k] = int(v) if re.fullmatch(r"-?\d+", v) else v
        elif sec == "colordict" and k.isdigit():
            out["colors"][int(k)] = v.upper()
        elif sec == "vendor_list" and k.isdigit():
            out["vendors"][int(k)] = v
    # matières sans nom = emplacements libres de la liste QIDI
    out["materials"] = {n: m for n, m in out["materials"].items() if m.get("filament")}
    return out


def _rgb(h):
    h = str(h or "").lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) if re.fullmatch(r"[0-9a-fA-F]{6}", h) else None


def _dist(a, b):
    # distance perçue approchée (« redmean »), suffisante pour une palette de 24 teintes
    r = (a[0] + b[0]) / 2
    dr, dg, db = a[0] - b[0], a[1] - b[1], a[2] - b[2]
    return ((2 + r / 256) * dr * dr + 4 * dg * dg + (2 + (255 - r) / 256) * db * db) ** 0.5


def nearest_color(codes, hexa):
    c = _rgb(hexa)
    if not c or not codes["colors"]:
        return None
    return min(codes["colors"], key=lambda n: _dist(c, _rgb(codes["colors"][n])))


def _tokens(s):
    return set(re.findall(r"[a-z0-9]+", str(s or "").lower().replace("-", " ")))


def suggest_material(codes, material, finish="", name=""):
    """Meilleure entrée de la liste QIDI pour une matière PrintLab (ex. PLA + Silk → « PLA Silk »)."""
    mat = str(material or "").upper().strip()
    want = _tokens(f"{material} {finish} {name}")
    best, score = None, -1e9
    for n, m in codes["materials"].items():
        typ = str(m.get("type", "")).upper()
        toks = _tokens(m["filament"])
        s = 0.0
        if typ == mat:
            s += 10
        elif mat and (typ.startswith(mat) or mat.startswith(typ)):
            s += 4
        else:
            s -= 10
        s += 2 * len(toks & want) - 0.6 * len(toks - want)
        if "basic" in toks and not (want & {"silk", "matte", "metal", "wood", "cf", "gf", "rapido", "translucent", "tough"}):
            s += 0.5      # matière « simple » : la variante Basic est la plus proche
        if s > score:
            best, score = n, s
    return best


def suggest_vendor(codes, vendor):
    v = str(vendor or "").strip().lower()
    for n, name in codes["vendors"].items():
        if name.lower() == v:
            return n
    for n, name in codes["vendors"].items():
        if name.lower() in v or (v and v in name.lower()):
            return n
    return 0 if 0 in codes["vendors"] else None


def suggest(codes, spool):
    return {"material": suggest_material(codes, spool.get("material"), spool.get("finish"), spool.get("filament_name")),
            "color": nearest_color(codes, spool.get("color_hex")),
            "vendor": suggest_vendor(codes, spool.get("vendor_name"))}


def qidi_target(qcat, codes, spool):
    """Réglage QIDI d'une bobine PrintLab, pour UPDATE_FILAMENT_INFORMATION (même commande que l'écran de l'imprimante).

    qcat = qidi_catalog.json ({code: {name, type, vendor}}, base de filaments de l'écran : le firmware cherche
    « <VENDOR> <FILAMENT> » dans ses noms). Marque inconnue de QIDI → « Generic » de la même matière.
    Couleur = teinte la plus proche de la palette de la Box (24 teintes), comme une étiquette RFID.
    Renvoie {code, vendor, filament, name, type, color, generic} ou lève ValueError."""
    mat = str(spool.get("material") or "").upper().strip()
    want = _tokens(f"{spool.get('material')} {spool.get('finish') or ''} {spool.get('filament_name') or ''}")
    v = str(spool.get("vendor_name") or "").strip().lower()
    vendors = {e["vendor"] for e in qcat.values()}
    qv = next((x for x in vendors if x.lower() == v), None) or next(
        (x for x in vendors if x.lower() != "generic" and (v.startswith(x.lower()) or x.lower() in v.split())), None)

    def best(vendor):
        top, score = None, 0
        for code, e in qcat.items():
            if e["vendor"] != vendor:
                continue
            typ = str(e["type"]).upper()
            if typ == mat:
                s = 10.0
            elif mat and (typ.startswith(mat) or mat.startswith(typ)):
                s = 4.0
            else:
                continue
            toks = _tokens(e["name"]) - _tokens(vendor)
            s += 2 * len(toks & want) - 0.6 * len(toks - want)
            if ("+" in mat) == ("+" in e["name"]):
                s += 1    # PLA+ → « Generic PLA+ », PLA → « Generic PLA » (le « + » disparaît des mots comparés)
            if "basic" in toks and not (want & {"silk", "matte", "metal", "wood", "cf", "gf", "rapido", "translucent", "tough"}):
                s += 0.5
            if top is None or s > score:
                top, score = code, s
        return top

    code = (best(qv) if qv else None) or best("Generic")
    if not code:
        raise ValueError(f"Matière « {spool.get('material') or '?'} » absente de la liste de filaments de l'imprimante")
    e = qcat[code]
    n = nearest_color(codes, spool.get("color_hex"))
    if n is None:
        raise ValueError("Couleur de la bobine non renseignée")
    color = codes["colors"][n].lstrip("#").upper()
    filament = e["name"][len(e["vendor"]):].strip() if e["name"].startswith(e["vendor"] + " ") else e["name"]
    return {"code": code, "vendor": e["vendor"], "filament": filament, "name": e["name"], "type": e["type"],
            "color": color, "generic": e["vendor"] != qv}


def payload(material, color, vendor):
    """Les 16 octets du bloc 4."""
    b = bytearray(16)
    b[0], b[1], b[2] = int(material) & 0xFF, int(color) & 0xFF, int(vendor) & 0xFF
    return bytes(b)


def decode(block):
    b = bytes(block)
    return {"material": b[0], "color": b[1], "vendor": b[2]}


def signature(codes, material, color, vendor):
    """Ce que la Box affichera après lecture de l'étiquette (sert à reconnaître la bobine)."""
    m = codes["materials"].get(int(material)) or {}
    return {"vendor": codes["vendors"].get(int(vendor), ""), "filament": m.get("filament", ""), "type": m.get("type", ""),
            "color": codes["colors"].get(int(color), "")}


def matches(sig, fw):
    """fw = infos de la Box pour un emplacement : vendor_str, filament_str, filament_type, color (#RRGGBB)."""
    if not sig or not fw:
        return False
    low = lambda s: str(s or "").strip().lower()  # noqa: E731
    if low(sig["vendor"]) != low(fw.get("vendor")):
        return False
    if _rgb(sig["color"]) != _rgb(fw.get("color")):
        return False
    names = {low(sig["filament"]), low(sig["type"])}
    return bool({low(fw.get("filament")), low(fw.get("type"))} & names)


def pick(candidates, current, elsewhere):
    """Choisit la bobine d'un emplacement parmi les étiquettes qui correspondent.
    candidates : ids de bobines ; current : bobine déjà associée à l'emplacement ; elsewhere : ids associés ailleurs.
    Renvoie (id ou None, ambigu)."""
    if not candidates:
        return None, False
    if current in candidates:
        return current, False
    free = [c for c in candidates if c not in elsewhere]
    if len(free) == 1:
        return free[0], False
    return None, len(free) > 1
