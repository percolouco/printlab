"""Lecture des profils système d'OrcaSlicer (resources/profiles) et des profils utilisateur.

Un profil Orca est un JSON qui hérite (clé "inherits") d'un autre profil du même
fabricant, ou de la bibliothèque commune OrcaFilamentLibrary pour les filaments.
On résout la chaîne d'héritage pour obtenir la configuration complète, comme le fait
l'interface d'Orca.
"""
import json
import os
import re
from functools import lru_cache
from pathlib import Path

ORCA_DIR = Path(os.environ.get("ORCA_DIR", "/opt/orca"))
PROFILES_DIR = ORCA_DIR / "resources" / "profiles"
USER_DIR = Path(os.environ.get("SLICER_DATA_DIR") or os.environ.get("DATA_DIR", "/data")) / "user_profiles"
COMMON_LIB = "OrcaFilamentLibrary"
KINDS = ("machine", "process", "filament")
META_KEYS = {"inherits", "from", "instantiation", "setting_id", "base_id", "is_custom_defined",
             "version", "type", "renamed_from", "description"}


def _load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def _index():
    """name -> path, par (fabricant, type). Inclut les profils non instanciables (bases)."""
    idx = {}
    for vendor_json in sorted(PROFILES_DIR.glob("*.json")):
        vendor = vendor_json.stem
        vdir = PROFILES_DIR / vendor
        if not vdir.is_dir():
            continue
        try:
            meta = _load_json(vendor_json)
        except Exception:
            continue
        for kind in KINDS:
            for entry in meta.get(f"{kind}_list", []):
                p = vdir / entry["sub_path"]
                if p.exists():
                    idx.setdefault((vendor, kind), {})[entry["name"]] = p
    return idx


def vendors():
    return sorted({v for v, k in _index() if k == "machine" and v != COMMON_LIB})


def _find(vendor, kind, name):
    for v in (vendor, COMMON_LIB):
        p = _index().get((v, kind), {}).get(name)
        if p:
            return v, p
    # dernier recours : n'importe quel fabricant (rare, héritages croisés)
    for (v, k), names in _index().items():
        if k == kind and name in names:
            return v, names[name]
    raise KeyError(f"profil {kind} introuvable : {name}")


@lru_cache(maxsize=4096)
def _resolve_system(vendor, kind, name):
    v, path = _find(vendor, kind, name)
    data = _load_json(path)
    parent = data.get("inherits")
    if parent:
        base = dict(_resolve_system(v, kind, parent))
    else:
        base = {}
    base.update(data)
    return base


def resolve(kind, name, vendor=None):
    """Configuration complète d'un profil (système ou utilisateur), sans les clés méta."""
    user = load_user(kind, name)
    if user is not None:
        cfg = dict(resolve(kind, user["inherits"], user.get("vendor")))
        cfg.update(user.get("settings", {}))
        cfg["name"] = name
        return cfg
    if vendor is None:
        vendor = vendor_of(kind, name)
    cfg = dict(_resolve_system(vendor, kind, name))
    for k in META_KEYS:
        cfg.pop(k, None)
    return cfg


@lru_cache(maxsize=1)
def _instantiable():
    """Profils visibles dans l'interface (instantiation=true), par type."""
    out = {k: {} for k in KINDS}
    for (vendor, kind), names in _index().items():
        for name, path in names.items():
            try:
                data = _load_json(path)
            except Exception:
                continue
            if str(data.get("instantiation", "")).lower() == "true":
                out[kind].setdefault(name, vendor)
    return out


def vendor_of(kind, name):
    v = _instantiable()[kind].get(name)
    if v:
        return v
    for (vendor, k), names in _index().items():
        if k == kind and name in names:
            return vendor
    raise KeyError(name)


def list_machines():
    res = []
    for name, vendor in sorted(_instantiable()["machine"].items()):
        if vendor == COMMON_LIB:
            continue
        cfg = _resolve_system(vendor, "machine", name)
        res.append({"name": name, "vendor": vendor, "model": cfg.get("printer_model", ""),
                    "nozzle": (cfg.get("nozzle_diameter") or [""])[0]})
    for u in list_user("machine"):
        res.append({"name": u["name"], "vendor": "Utilisateur", "model": u.get("model", ""), "user": True,
                    "inherits": u["inherits"]})
    return res


def _compatible(cfg, machine_name, machine_cfg):
    printers = cfg.get("compatible_printers") or []
    if printers and machine_name not in printers:
        return False
    cond = (cfg.get("compatible_printers_condition") or "").strip()
    if cond and not printers:
        return _eval_condition(cond, machine_cfg)
    return True


def _eval_condition(cond, mcfg):
    """Évaluation simplifiée des conditions Orca (printer_notes=~/.../, nozzle_diameter[0]==0.4, and/or)."""
    def val(key):
        m = re.match(r"(\w+)(?:\[(\d+)\])?$", key)
        if not m:
            return None
        v = mcfg.get(m.group(1))
        if isinstance(v, list):
            v = v[int(m.group(2) or 0)] if v else None
        return v

    def atom(a):
        a = a.strip().strip("()").strip()
        neg = a.startswith("!")
        a = a.lstrip("!").strip()
        m = re.match(r"(\S+)\s*=~\s*/(.*)/$", a)
        if m:
            r = re.search(m.group(2), str(val(m.group(1)) or ""), re.S) is not None
            return not r if neg else r
        m = re.match(r"(\S+)\s*(==|!=|>=|<=|>|<)\s*\"?([^\"]*)\"?$", a)
        if m:
            left, op, right = val(m.group(1)), m.group(2), m.group(3)
            try:
                left, right = float(left), float(right)
            except (TypeError, ValueError):
                left, right = str(left), str(right)
            r = {"==": left == right, "!=": left != right, ">=": left >= right, "<=": left <= right,
                 ">": left > right, "<": left < right}[op]
            return not r if neg else r
        return True  # condition non comprise : on n'exclut pas

    try:
        return any(all(atom(p) for p in re.split(r"\band\b", part)) for part in re.split(r"\bor\b", cond))
    except Exception:
        return True


def _list_compatible(kind, machine):
    mvendor = vendor_of("machine", machine) if load_user("machine", machine) is None else None
    mcfg = resolve("machine", machine)
    base_machine = machine
    u = load_user("machine", machine)
    if u:
        base_machine = u["inherits"]
        mvendor = vendor_of("machine", base_machine)
    res = []
    for name, vendor in sorted(_instantiable()[kind].items()):
        if vendor not in (mvendor, COMMON_LIB):
            continue
        cfg = _resolve_system(vendor, kind, name)
        if _compatible(cfg, base_machine, mcfg):
            item = {"name": name, "vendor": vendor}
            if kind == "filament":
                item.update(type=(cfg.get("filament_type") or [""])[0],
                            filament_vendor=(cfg.get("filament_vendor") or [""])[0],
                            colour=(cfg.get("default_filament_colour") or [""])[0])
            else:
                item.update(layer_height=cfg.get("layer_height"))
            res.append(item)
    for u in list_user(kind):
        item = {"name": u["name"], "vendor": "Utilisateur", "user": True, "inherits": u["inherits"]}
        if kind == "filament":
            c = resolve("filament", u["name"])
            item.update(type=(c.get("filament_type") or [""])[0], filament_vendor=(c.get("filament_vendor") or [""])[0])
        res.append(item)
    return res


def list_processes(machine):
    return _list_compatible("process", machine)


def list_filaments(machine):
    # Les filaments génériques de la bibliothèque commune sont compatibles avec tout : on
    # garde en priorité ceux propres à l'imprimante, puis la bibliothèque.
    return _list_compatible("filament", machine)


# ---------- profils utilisateur ----------

def _user_path(kind, name):
    safe = re.sub(r"[^\w .@()+-]", "_", name)
    return USER_DIR / kind / f"{safe}.json"


def load_user(kind, name):
    p = _user_path(kind, name)
    if p.exists():
        return _load_json(p)
    return None


def list_user(kind):
    d = USER_DIR / kind
    if not d.is_dir():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        try:
            out.append(_load_json(p))
        except Exception:
            pass
    return out


def save_user(kind, name, inherits, settings):
    if kind not in KINDS:
        raise ValueError(kind)
    base = load_user(kind, inherits)
    vendor = base.get("vendor") if base else vendor_of(kind, inherits)
    # on ne stocke que les différences avec le profil parent
    parent = resolve(kind, inherits)
    diff = {k: v for k, v in settings.items() if parent.get(k) != v and k not in META_KEYS and k != "name"}
    if base:
        diff = {**base.get("settings", {}), **diff}
        inherits = base["inherits"]
    p = _user_path(kind, name)
    p.parent.mkdir(parents=True, exist_ok=True)
    data = {"name": name, "inherits": inherits, "vendor": vendor, "settings": diff}
    if kind == "machine":
        data["model"] = resolve("machine", inherits).get("printer_model", "")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    return data


def delete_user(kind, name):
    p = _user_path(kind, name)
    if p.exists():
        p.unlink()
        return True
    return False


def machine_cover(machine):
    """Image de couverture de l'imprimante si elle existe."""
    try:
        cfg = resolve("machine", machine)
        vendor = vendor_of("machine", (load_user("machine", machine) or {}).get("inherits", machine))
    except KeyError:
        return None
    p = PROFILES_DIR / vendor / f"{cfg.get('printer_model', '')}_cover.png"
    return p if p.exists() else None


def machine_bed(machine, which):
    """Modèle 3D (bed_model, .stl) ou logo (bed_texture, .svg/.png) du plateau, déclarés par le machine_model du constructeur."""
    try:
        cfg = resolve("machine", machine)
        vendor = vendor_of("machine", (load_user("machine", machine) or {}).get("inherits", machine))
    except KeyError:
        return None
    model = cfg.get("printer_model", "")
    mfile = PROFILES_DIR / vendor / "machine" / f"{model}.json"
    if not model or not mfile.exists():
        return None
    try:
        fname = json.loads(mfile.read_text()).get("bed_model" if which == "model" else "bed_texture", "")
    except ValueError:
        return None
    p = PROFILES_DIR / vendor / fname
    if not fname or "/" in fname or not p.is_file():
        return None
    return p
