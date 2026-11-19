"""Fichiers à imprimer stockés sur l'imprimante (Moonraker, racine « gcodes ») : lecture seule.

Pour chaque fichier .gcode.3mf (QIDI Studio / Orca), on lit à distance, par requêtes HTTP Range, seulement les
morceaux utiles de l'archive : slice_info.config (temps, poids et couleurs par filament), plate_1.json (objets,
encombrement), project_settings.config (réglages d'impression), l'aperçu plate_1.png et l'en-tête du G-code
(nombre de couches, hauteur). Rien n'est envoyé à l'imprimante. Le résultat est mis en cache sur disque
(data/gcodes/<hash>.json + .png), invalidé quand la date de modification du fichier change.
Pour les .gcode simples, on se contente des métadonnées calculées par Moonraker.
"""
import asyncio
import hashlib
import io
import json
import re
import time
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote

import httpx

BLOCK = 65536


class RangeFile(io.RawIOBase):
    """Fichier distant lu par blocs via HTTP Range (assez pour que zipfile lise le répertoire central et quelques membres)."""

    def __init__(self, client, url, size):
        self.c, self.url, self.size, self.pos, self.cache = client, url, size, 0, {}

    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def _block(self, i):
        if i not in self.cache:
            a = i * BLOCK
            r = self.c.get(self.url, headers={"Range": f"bytes={a}-{min(a + BLOCK, self.size) - 1}"})
            r.raise_for_status()
            if r.status_code != 206 and len(r.content) > BLOCK:   # serveur sans Range : on garde le tout
                for j in range(0, len(r.content), BLOCK):
                    self.cache[j // BLOCK] = r.content[j:j + BLOCK]
            else:
                self.cache[i] = r.content
        return self.cache[i]

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = max(0, min(n, self.size - self.pos))
        out = bytearray()
        while n > 0:
            i, o = divmod(self.pos, BLOCK)
            chunk = self._block(i)[o:o + n]
            if not chunk:
                break
            out += chunk
            self.pos += len(chunk)
            n -= len(chunk)
        return bytes(out)

    def readinto(self, b):
        d = self.read(len(b))
        b[:len(d)] = d
        return len(d)


def _lst(v):
    if isinstance(v, list):
        return v
    return [] if v in (None, "") else [v]


def _num(v):
    try:
        return float(str(v).rstrip("%"))
    except (TypeError, ValueError):
        return None


SETTINGS_KEYS = ["layer_height", "initial_layer_print_height", "sparse_infill_density", "sparse_infill_pattern", "wall_loops",
                 "top_shell_layers", "bottom_shell_layers", "enable_support", "support_type", "support_on_build_plate_only",
                 "brim_type", "curr_bed_type", "print_settings_id", "printer_settings_id", "filament_settings_id",
                 "nozzle_temperature", "nozzle_temperature_initial_layer", "hot_plate_temp", "textured_plate_temp",
                 "cool_plate_temp", "eng_plate_temp", "chamber_temperatures", "enable_prime_tower", "prime_tower_width",
                 "print_sequence", "ironing_type", "fuzzy_skin", "seam_position", "outer_wall_speed", "inner_wall_speed",
                 "sparse_infill_speed", "filament_vendor", "filament_type", "filament_colour", "filament_density",
                 "timelapse_type", "spiral_mode", "nozzle_diameter", "wall_generator", "flush_multiplier"]


def parse_3mf(base, path, size, thumb_out):
    url = f"{base}/server/files/gcodes/{quote(path)}"
    info = {"kind": "3mf"}
    with httpx.Client(timeout=20) as c:
        z = zipfile.ZipFile(io.BufferedReader(RangeFile(c, url, size), buffer_size=BLOCK))
        names = set(z.namelist())
        plates = sorted(int(m.group(1)) for n in names if (m := re.match(r"Metadata/plate_(\d+)\.gcode$", n)))
        info["plates"] = plates
        p = plates[0] if plates else 1
        # temps, poids, filaments
        if "Metadata/slice_info.config" in names:
            root = ET.fromstring(z.read("Metadata/slice_info.config"))
            hdr = {h.get("key"): h.get("value") for h in root.iter("header_item")}
            info["slicer"] = (hdr.get("X-QDT-Client-Version") or hdr.get("X-BBL-Client-Version") or "")
            pl = root.find("plate")
            if pl is not None:
                md = {m.get("key"): m.get("value") for m in pl.findall("metadata")}
                info.update(prediction=_num(md.get("prediction")), weight=_num(md.get("weight")),
                            first_layer_time=_num(md.get("first_layer_time")), support_used=md.get("support_used") == "true",
                            outside=md.get("outside") == "true", printer_model=md.get("printer_model_id"),
                            timelapse=md.get("timelapse_type") not in (None, "0"))
                info["filaments"] = [{"id": int(f.get("id")), "type": f.get("type"), "color": (f.get("color") or "").upper(),
                                      "used_g": _num(f.get("used_g")), "used_m": _num(f.get("used_m")),
                                      "support": f.get("used_for_support") == "true", "tray": f.get("tray_info_idx")}
                                     for f in pl.findall("filament")]
                info["objects"] = [{"name": o.get("name"), "skipped": o.get("skipped") == "true"} for o in pl.findall("object")]
                info["warnings"] = [w.get("msg") for w in pl.findall("warning") if w.get("msg")]
        # encombrement
        pj = f"Metadata/plate_{p}.json"
        if pj in names:
            j = json.loads(z.read(pj))
            bb = j.get("bbox_all")
            if bb and len(bb) == 4:
                info["footprint"] = [round(bb[2] - bb[0], 1), round(bb[3] - bb[1], 1)]
            info["bed_type"] = j.get("bed_type")
            info["parts"] = [o.get("name") for o in j.get("bbox_objects") or [] if o.get("name") != "wipe_tower"]
            info["wipe_tower"] = any(o.get("name") == "wipe_tower" for o in j.get("bbox_objects") or [])
        # changements de filament
        if "Metadata/filament_sequence.json" in names:
            try:
                seq = json.loads(z.read("Metadata/filament_sequence.json")).get(f"plate_{p}", {}).get("sequence") or []
                info["changes"] = max(len(seq) - 1, 0)
            except Exception:
                pass
        # réglages
        if "Metadata/project_settings.config" in names:
            try:
                ps = json.loads(z.read("Metadata/project_settings.config"))
                info["settings"] = {k: ps.get(k) for k in SETTINGS_KEYS if ps.get(k) not in (None, "")}
            except Exception:
                pass
        # en-tête du G-code : couches, hauteur max
        gm = f"Metadata/plate_{p}.gcode"
        if gm in names:
            with z.open(gm) as f:
                head = f.read(6000).decode("utf-8", "replace")
            for k, rx in (("layers", r"total layer number:\s*(\d+)"), ("max_z", r"max_z_height:\s*([\d.]+)")):
                m = re.search(rx, head)
                if m:
                    info[k] = float(m.group(1))
            m = re.search(r";\s*(QIDIStudio|OrcaSlicer|BambuStudio|PrusaSlicer|SuperSlicer)\s+([\w.\-]+)", head)
            if m:
                info["slicer"] = f"{m.group(1)} {m.group(2)}"
        # aperçu
        for t in (f"Metadata/plate_{p}.png", f"Metadata/plate_no_light_{p}.png"):
            if t in names:
                thumb_out.write_bytes(z.read(t))
                info["thumb"] = True
                break
    return info


class GFiles:
    def __init__(self, data_dir, url_fn):
        self.dir = Path(data_dir) / "gcodes"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.url_fn = url_fn
        self.task = None
        self.progress = {"todo": 0, "done": 0, "error": None}
        self.mem = {}

    def _key(self, path):
        return hashlib.sha1(path.encode()).hexdigest()[:20]

    def cached(self, path, modified):
        k = self._key(path)
        c = self.mem.get(k)
        if c is None:
            f = self.dir / (k + ".json")
            if f.exists():
                try:
                    c = self.mem[k] = json.loads(f.read_text())
                except Exception:
                    c = None
        return c if c and abs((c.get("modified") or 0) - modified) < 1 else None

    def thumb_path(self, path):
        return self.dir / (self._key(path) + ".png")

    async def listing(self):
        base = self.url_fn()
        if not base:
            raise RuntimeError("Imprimante non configurée (Paramètres → Imprimante)")
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.get(base + "/server/files/list", params={"root": "gcodes"})
            r.raise_for_status()
            files = r.json()["result"]
        files = [f for f in files if not f["path"].startswith(".") and "/." not in f["path"]]
        stale = [f for f in files if self.cached(f["path"], f["modified"]) is None]
        if stale and (self.task is None or self.task.done()):
            self.task = asyncio.create_task(self._fill(base, stale))
        return files, len(stale)

    async def _fill(self, base, stale):
        """Analyse les fichiers manquants un par un (doucement : l'imprimante peut être en train d'imprimer)."""
        self.progress = {"todo": len(stale), "done": 0, "error": None}
        for f in stale:
            try:
                info = await asyncio.to_thread(self._analyse, base, f)
            except Exception as e:
                info = {"error": str(e)[:200]}
                self.progress["error"] = f"{f['path']} : {str(e)[:120]}"
            info.update(path=f["path"], modified=f["modified"], size=f["size"], analysed=time.time())
            k = self._key(f["path"])
            (self.dir / (k + ".json")).write_text(json.dumps(info))
            self.mem[k] = info
            self.progress["done"] += 1
            await asyncio.sleep(0.3)

    def _analyse(self, base, f):
        path = f["path"]
        info = {}
        if path.lower().endswith(".3mf"):
            info = parse_3mf(base, path, f["size"], self.thumb_path(path))
        # métadonnées Moonraker (complètent ou remplacent pour un .gcode simple)
        with httpx.Client(timeout=10) as c:
            r = c.get(base + "/server/files/metadata", params={"filename": path})
            md = r.json().get("result", {}) if r.status_code == 200 else {}
            info["moonraker"] = {k: md.get(k) for k in ("estimated_time", "filament_weight_total", "filament_total", "layer_height",
                                                         "first_layer_height", "object_height", "nozzle_diameter", "filament_name",
                                                         "filament_type", "preset_colours", "slicer", "slicer_version",
                                                         "first_layer_bed_temp", "first_layer_extr_temp", "layer_count") if md.get(k) is not None}
            if not info.get("thumb"):
                th = sorted(md.get("thumbnails") or [], key=lambda t: -(t.get("width") or 0))
                if th:
                    d = path.rsplit("/", 1)[0] + "/" if "/" in path else ""
                    t = c.get(base + "/server/files/gcodes/" + quote(d + th[0]["relative_path"]))
                    if t.status_code == 200:
                        self.thumb_path(path).write_bytes(t.content)
                        info["thumb"] = True
        if not info.get("filaments") and info["moonraker"].get("preset_colours"):
            types = (info["moonraker"].get("filament_type") or "").split(";")
            info["filaments"] = [{"id": i + 1, "type": types[i] if i < len(types) else None, "color": c.upper(), "used_g": None, "used_m": None}
                                 for i, c in enumerate(info["moonraker"]["preset_colours"])]
        return info
