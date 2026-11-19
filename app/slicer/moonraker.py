"""Client Moonraker (Klipper) : état de l'imprimante, QIDI Box, envoi et pilotage des impressions."""
import os
from pathlib import Path

import httpx

MOONRAKER_URL = os.environ.get("MOONRAKER_URL", "").rstrip("/")
# PrintLab branche ici sa propre résolution (Paramètres > adresse de l'imprimante, sinon MOONRAKER_URL)
RESOLVE = None


def base_url():
    u = (RESOLVE() if RESOLVE else MOONRAKER_URL) or ""
    if not u:
        raise RuntimeError("Aucune imprimante configurée (Paramètres > Adresse de l'imprimante)")
    return u.rstrip("/")
MOONRAKER_API_KEY = os.environ.get("MOONRAKER_API_KEY", "")

STATUS_OBJECTS = [
    "print_stats", "virtual_sdcard", "display_status", "toolhead", "extruder", "heater_bed",
    "heater_generic chamber", "heater_generic heater_box1", "fan_generic cooling_fan",
    "fan_generic auxiliary_cooling_fan", "fan_generic chamber_circulation_fan", "idle_timeout",
    "webhooks", "gcode_move", "exclude_object", "multi_color_controller", "box_extras",
    "temperature_sensor heater_temp_a_box1", "aht20_f heater_box1", "output_pin caselight",
    "box_stepper slot0", "box_stepper slot1", "box_stepper slot2", "box_stepper slot3",
]


def _headers():
    return {"X-Api-Key": MOONRAKER_API_KEY} if MOONRAKER_API_KEY else {}


def _client(timeout=10):
    return httpx.AsyncClient(base_url=base_url(), headers=_headers(), timeout=timeout)


async def _get(path, params=None, timeout=10):
    async with _client(timeout) as c:
        r = await c.get(path, params=params)
        r.raise_for_status()
        return r.json().get("result")


async def _post(path, params=None, json=None, timeout=30):
    async with _client(timeout) as c:
        r = await c.post(path, params=params, json=json)
        r.raise_for_status()
        return r.json().get("result")


async def available_objects():
    res = await _get("/printer/objects/list")
    return res.get("objects", [])


async def status():
    objs = set(await available_objects())
    wanted = [o for o in STATUS_OBJECTS if o in objs]
    q = "&".join(o.replace(" ", "%20") for o in wanted)
    async with _client() as c:
        r = await c.get(f"/printer/objects/query?{q}")
        r.raise_for_status()
        st = r.json()["result"]["status"]
    return {"status": st, "box": box_from_status(st)}


def _box_slots_new(mcc):
    """Firmware récent : tout est dans multi_color_controller.box (box0_filament_info_N_*)."""
    b = mcc.get("box") or {}
    nb = int(b.get("box_count") or mcc.get("box_count") or 1)
    slots = []
    for i in range(max(nb, 1) * 4):
        bx, n = i // 4, i % 4
        pre = f"box{bx}_filament_info_{n}_"
        col = b.get(pre + "color_rgb_str")
        col = col[0] if isinstance(col, list) and col else (col if isinstance(col, str) else "#808080")
        slots.append({
            "index": i, "box": bx + 1, "loaded": bool(b.get(f"box{bx}_box_inserted_{n}")),
            "filament": b.get(pre + "filament_str", ""), "type": b.get(pre + "filament_type", ""),
            "vendor": b.get(pre + "vendor_str", ""), "filament_id": b.get(pre + "filament_id", ""),
            "color": col if col.startswith("#") else "#" + col,
            "min_temp": b.get(pre + "min_temp"), "max_temp": b.get(pre + "max_temp"),
            "rfid": b.get(f"box{bx}_slots_{n}_info_from_rfid"),
        })
    return nb, slots, b


def box_from_status(st):
    """Résumé de la QIDI Box : emplacements, matière, marque, couleur, présence, séchage."""
    mcc = st.get("multi_color_controller") or {}
    if not mcc:
        return None
    extras = st.get("box_extras") or {}
    heater = st.get("heater_generic heater_box1") or {}
    hum = st.get("aht20_f heater_box1") or {}
    if "box" in mcc:  # firmware récent
        nb, slots, b = _box_slots_new(mcc)
        dry = {f"box{i}": {"dry_state": b.get(f"box{i}_dry_state")} for i in range(nb)}
        return {
            "connected": bool(b.get("box0_is_online")), "count": nb, "mode": None,
            "ready": bool(mcc.get("enable_box", 1)), "slots": slots,
            "drying": extras.get("box_drying_state") or dry, "tool_change": b.get("is_tool_change"),
            "temperature": b.get("box0_aht20_temp", heater.get("temperature")), "target": heater.get("target"),
            "humidity": b.get("box0_aht20_humidity", hum.get("humidity")),
        }
    hw = mcc.get("hardware") or {}
    nb = int(hw.get("box_count") or 0)
    states = (mcc.get("slots") or {}).get("states") or {}
    mats = (mcc.get("slots") or {}).get("materials") or {}
    slots = []
    for i in range(max(nb, 1) * 4):
        k = f"slot{i}"
        m = mats.get(k) or {}
        fil = m.get("filament") or {}
        slots.append({
            "index": i, "box": i // 4 + 1, "loaded": bool(states.get(k)),
            "filament": fil.get("filament", ""), "type": fil.get("type", ""),
            "vendor": m.get("vendor", ""), "color": m.get("color", "#808080"),
            "min_temp": fil.get("min_temp"), "max_temp": fil.get("max_temp"),
            "rfid": (st.get(f"box_stepper {k}") or {}).get("rfid_state"),
        })
    return {
        "connected": bool(hw.get("connected")), "count": nb, "mode": (mcc.get("system") or {}).get("mode"),
        "ready": bool((mcc.get("system") or {}).get("ready")), "slots": slots,
        "drying": extras.get("box_drying_state"), "tool_change": extras.get("is_tool_change"),
        "temperature": heater.get("temperature"), "target": heater.get("target"),
        "humidity": hum.get("humidity"),
    }


def tools_used(gcode_path):
    """Outils (T0, T1…) appelés dans le G-code."""
    import re
    rx = re.compile(rb"^T(\d+)\s*$", re.M)
    return sorted({int(m.group(1)) for m in rx.finditer(Path(gcode_path).read_bytes())})


async def sync_tool_mapping(tools, choice=None):
    """choice = {outil: emplacement} choisi dans la fenêtre d'envoi (16 = bobine externe) ; par défaut filament n du slicer = bobine n de la Box : enregistre value_tN = slotN (comme le fait l'écran de
    l'imprimante avant un print), sinon le firmware reprend le dernier mapping choisi à l'écran.
    Jamais pendant une impression. Renvoie les changements faits."""
    st = (await _get("/printer/objects/query", params={"print_stats": "", "save_variables": ""}))["status"]
    if (st.get("print_stats") or {}).get("state") in ("printing", "paused"):
        raise RuntimeError("une impression est en cours")
    cur = ((st.get("save_variables") or {}).get("variables") or {})
    changes = {}
    choice = choice or {}
    for t in tools:
        slot = int(choice.get(t, t))
        if not 0 <= slot <= 16:
            raise ValueError(f"emplacement {slot} invalide pour T{t}")
        want = f"slot{slot}"
        if cur.get(f"value_t{t}") != want:
            await _post("/printer/gcode/script", params={"script": f"SAVE_VARIABLE VARIABLE=value_t{t} VALUE='\"{want}\"'"})
            changes[f"T{t}"] = {"avant": cur.get(f"value_t{t}"), "apres": want}
    return changes


async def upload_and_print(gcode_path, filename, start=True):
    async with httpx.AsyncClient(base_url=base_url(), headers=_headers(), timeout=600) as c:
        with open(gcode_path, "rb") as f:
            files = {"file": (filename, f, "application/octet-stream")}
            data = {"root": "gcodes", "print": "true" if start else "false"}
            r = await c.post("/server/files/upload", files=files, data=data)
        r.raise_for_status()
        return r.json()


async def queue_status():
    return await _get("/server/job_queue/status")


async def queue_add(filename):
    return await _post("/server/job_queue/job", params={"filenames": filename})


async def queue_remove(job_id):
    async with _client() as c:
        r = await c.delete("/server/job_queue/job", params={"job_ids": job_id})
        r.raise_for_status()
        return r.json().get("result")


async def queue_control(what):
    return await _post(f"/server/job_queue/{'start' if what == 'start' else 'pause'}")


async def action(name):
    paths = {"pause": "/printer/print/pause", "resume": "/printer/print/resume",
             "cancel": "/printer/print/cancel", "emergency_stop": "/printer/emergency_stop",
             "firmware_restart": "/printer/firmware_restart"}
    return await _post(paths[name])


async def gcode(script):
    return await _post("/printer/gcode/script", params={"script": script}, timeout=600)


async def gcode_store(count=50):
    res = await _get("/server/gcode_store", params={"count": count})
    return res.get("gcode_store", [])


async def files(limit=100):
    res = await _get("/server/files/list", params={"root": "gcodes"})
    res.sort(key=lambda f: f.get("modified", 0), reverse=True)
    return res[:limit]


async def start_file(filename):
    return await _post("/printer/print/start", params={"filename": filename})


async def history(limit=30):
    res = await _get("/server/history/list", params={"limit": limit, "order": "desc"})
    return res.get("jobs", [])


async def webcams():
    res = await _get("/server/webcams/list")
    return res.get("webcams", [])


async def fetch_raw(path, timeout=10):
    """Récupère une ressource du serveur web de l'imprimante (webcam, miniatures)."""
    b = base_url(); base = b.rsplit(":", 1)[0] if path.startswith("/webcam") else b
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.get(base + path, headers=_headers())
        r.raise_for_status()
        return r.content, r.headers.get("content-type", "application/octet-stream")


async def stream_raw(path):
    b = base_url(); base = b.rsplit(":", 1)[0] if path.startswith("/webcam") else b
    client = httpx.AsyncClient(timeout=None)
    req = client.build_request("GET", base + path, headers=_headers())
    resp = await client.send(req, stream=True)
    return client, resp
