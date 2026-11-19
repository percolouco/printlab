"""Suivi automatique de la consommation de filament par slot de la QIDI Box.

SÉCURITÉ IMPRIMANTE : ce module ne fait que des requêtes GET de lecture sur Moonraker
(/printer/objects/query). Il n'envoie jamais de commande, de G-code ni de fichier.
(La seule écriture de PrintLab vers l'imprimante est le chauffage de séchage : voir boxheat.py.)

Principe : pendant une impression, on lit `print_stats.filament_used` (mm, cumul net) et le slot chargé.
Chaque variation est attribuée au slot chargé, SAUF pendant un changement de filament
(`is_tool_change` = 1), où le déchargement/chargement fausse le compteur (il redescend à la rétraction).

Fin de bobine : quand la Box bascule seule sur une bobine identique (AUTO_RELOAD_FILAMENT), le firmware réécrit
value_tN. La bobine de l'emplacement de départ est vide : à la déduction, elle est ramenée à 0 g par une ligne
« fin de bobine » (visible et annulable dans son historique).
"""
import asyncio
import json
import math
import time

import httpx

QUERY = {"print_stats": "", "multi_color_controller": "", "save_variables": ""}
ACTIVE = ("printing", "paused")
ENDED = ("complete", "cancelled", "error", "standby")


def slot_key(loaded):
    """'slot0'..'slot3' -> '0'..'3' ; slot16 / vide -> 'ext' (hors Box)."""
    try:
        n = int(str(loaded).replace("slot", ""))
    except Exception:
        return "ext"
    return str(n) if 0 <= n < 16 else "ext"


def advance(track, fu, loaded, tool_change):
    """Fait avancer le suivi d'un échantillon. track : dict avec last_fu et slots_mm. Renvoie True si modifié."""
    if fu is None:
        return False
    if tool_change:
        track["last_fu"] = fu          # on ignore tout ce qui se passe pendant un changement
        return True
    delta = fu - track["last_fu"]
    track["last_fu"] = fu
    if abs(delta) < 1e-9:
        return False
    k = slot_key(loaded)
    mm = track["slots_mm"]
    mm[k] = max(mm.get(k, 0.0) + delta, 0.0)
    return True


def watch_runout(track, variables, now=None):
    """Fin de bobine + bascule automatique : pendant l'impression, le firmware réécrit value_tN (outil → emplacement)
    quand AUTO_RELOAD_FILAMENT passe sur une autre bobine (ex. value_t0 slot0 → slot2). PrintLab n'écrit jamais ces
    variables pendant une impression : tout changement vu ici vient donc de la Box. Renvoie True si un événement est ajouté."""
    vt = {k: v for k, v in (variables or {}).items() if k.startswith("value_t") and isinstance(v, str)}
    if not vt:
        return False
    base = track.get("_vt")
    track["_vt"] = vt
    if base is None:            # premier échantillon de l'impression : référence
        return False
    added = False
    for k, v in vt.items():
        old = base.get(k)
        a, b = slot_key(old), slot_key(v)
        if old and v != old and a != "ext" and b != "ext":
            ev = track.setdefault("events", [])
            if not any(e.get("slot") == a for e in ev):
                ev.append({"kind": "runout", "slot": a, "to": b, "tool": k.replace("value_t", "T"), "ts": now or time.time()})
                added = True
    return added


def mm_to_g(mm, diameter=1.75, density=1.24):
    return mm * math.pi * (diameter / 2) ** 2 * density / 1000


class Tracker:
    def __init__(self, db, rows, row, url_fn, settings_fn, use_spool, now_iso, hook=None):
        self.db, self.rows, self.row = db, rows, row
        self.url_fn, self.settings_fn, self.use_spool, self.now_iso = url_fn, settings_fn, use_spool, now_iso
        self.cur = None        # suivi ouvert (dict)
        self.check = None
        self.error = None
        self.last_seen = None
        self.hook = hook       # hook(kind, track, event) : « runout » pendant le print, « closed » à la fin (alertes, fin de relais)

    def _emit(self, kind, t, ev=None):
        if self.hook:
            try:
                self.hook(kind, t, ev)
            except Exception:
                pass

    # ---- base ----
    def _save(self, t):
        self.db.execute("UPDATE tracks SET ended=?,status=?,last_fu=?,slots_mm=?,partial=?,applied=?,parts=?,events=? WHERE id=?",
                        (t.get("ended"), t["status"], t["last_fu"], json.dumps(t["slots_mm"]), t["partial"], t.get("applied", 0),
                         json.dumps(t.get("parts")) if t.get("parts") is not None else None,
                         json.dumps(t.get("events")) if t.get("events") else None, t["id"]))
        self.db.commit()

    def _load(self, r):
        return {"id": r["id"], "filename": r["filename"], "started": r["started"], "ended": r["ended"], "status": r["status"],
                "last_fu": r["last_fu"] or 0.0, "slots_mm": json.loads(r["slots_mm"] or "{}"), "slot_map": json.loads(r["slot_map"] or "{}"),
                "partial": r["partial"], "applied": r["applied"], "parts": json.loads(r["parts"]) if r["parts"] else None,
                "events": json.loads(r["events"]) if r["events"] else []}

    def _snapshot_map(self):
        return {str(r["slot"]): r["spool_id"] for r in self.rows("SELECT slot,spool_id FROM slot_map") if r["spool_id"]}

    # ---- calcul / application ----
    def compute_parts(self, t, smap=None):
        smap = smap if smap is not None else t["slot_map"]
        parts = []
        for k, mm in sorted(t["slots_mm"].items()):
            sid = smap.get(k) if k != "ext" else None
            d, rho = 1.75, 1.24
            if sid:
                f = self.row("SELECT f.diameter,f.density FROM spools s JOIN filaments f ON f.id=s.filament_id WHERE s.id=?", (sid,))
                if f:
                    d, rho = f["diameter"] or 1.75, f["density"] or 1.24
            parts.append({"slot": k, "mm": round(mm, 1), "spool_id": sid, "weight": round(mm_to_g(mm, d, rho), 2)})
        return parts

    def undo(self, tid):
        for u in self.rows("SELECT spool_id,weight FROM usage WHERE job_id=?", (f"trk-{tid}",)):
            self.db.execute("UPDATE spools SET used_weight=MAX(used_weight-?,0) WHERE id=?", (u["weight"], u["spool_id"]))
        self.db.execute("DELETE FROM usage WHERE job_id=?", (f"trk-{tid}",))
        self.db.execute("UPDATE tracks SET applied=0 WHERE id=?", (tid,))
        self.db.commit()

    def apply(self, tid, smap=None):
        r = self.row("SELECT * FROM tracks WHERE id=?", (tid,))
        if not r:
            raise KeyError(tid)
        t = self._load(r)
        if t["applied"]:
            self.undo(tid)
        t["parts"] = self.compute_parts(t, smap)
        for p in t["parts"]:
            if p["spool_id"] and p["weight"] >= 0.05:
                self.use_spool(p["spool_id"], p["weight"], "suivi", f"trk-{tid}", t["filename"])
        smap_eff = smap if smap is not None else t["slot_map"]
        for e in t.get("events") or []:
            sid = smap_eff.get(str(e["slot"])) if e.get("kind") == "runout" else None
            s = sid and self.row("SELECT s.initial_weight, s.used_weight, f.weight FROM spools s JOIN filaments f ON f.id=s.filament_id WHERE s.id=?", (sid,))
            if not s:
                continue
            init = s["initial_weight"] if s["initial_weight"] is not None else (s["weight"] or 1000)
            rest = round(init - s["used_weight"], 2)
            e["spool_id"], e["corrected_g"] = sid, rest
            if abs(rest) >= 0.05:      # ramène la bobine à 0 g (rest < 0 : le suivi avait compté plus que le poids initial)
                self.use_spool(sid, rest, "fin de bobine", f"trk-{tid}",
                               f"Bobine vide détectée (bascule automatique vers l'emplacement {int(e['to']) + 1}) : "
                               f"PrintLab pensait qu'il restait {str(round(rest, 1)).replace('.', ',')} g")
        t["applied"] = 1
        if smap is not None:
            self.db.execute("UPDATE tracks SET slot_map=? WHERE id=?", (json.dumps({str(k): v for k, v in smap.items()}), tid))
        self._save(t)
        return t

    # ---- cycle de vie ----
    def _open(self, ps, fu):
        name = ps.get("filename") or ""
        r = self.row("SELECT * FROM tracks WHERE status='running' AND filename=? ORDER BY id DESC LIMIT 1", (name,))
        if r:                                   # reprise après redémarrage de PrintLab
            self.cur = self._load(r)
            return
        partial = 1 if (fu or 0) > 50 else 0     # PrintLab a raté le début : on ne compte que la suite
        cur = self.db.execute("INSERT INTO tracks(filename,started,status,last_fu,slots_mm,slot_map,partial) VALUES(?,?,?,?,?,?,?)",
                              (name, time.time(), "running", fu if partial else 0.0, "{}", json.dumps(self._snapshot_map()), partial))
        self.db.commit()
        r = self.row("SELECT * FROM tracks WHERE id=?", (cur.lastrowid,))
        self.cur = self._load(r)

    def _close(self, state):
        t = self.cur
        t["ended"] = time.time()
        t["status"] = {"complete": "terminée"}.get(state, "interrompue")
        self._save(t)
        self.cur = None
        if state not in ("complete", "cancelled", "error"):
            self.check = (t["id"], t["filename"])     # l'état final n'a pas été vu : on le lira dans l'historique Moonraker
        if self.settings_fn().get("auto_deduct", True):
            self.apply(t["id"])
        self._emit("closed", t)

    def step(self, status):
        """Traite un échantillon Moonraker (dict status). Pure lecture + écritures dans la base PrintLab."""
        ps = status.get("print_stats") or {}
        box = (status.get("multi_color_controller") or {}).get("box") or {}
        state = ps.get("state")
        fu = ps.get("filament_used")
        if state in ACTIVE:
            if self.cur is None:
                self._open(ps, fu)
            changed = advance(self.cur, fu, box.get("loaded_slot"), bool(box.get("is_tool_change")))
            if watch_runout(self.cur, ((status.get("save_variables") or {}).get("variables"))):
                changed = True
                self._emit("runout", self.cur, self.cur["events"][-1])
            if changed:
                self._save(self.cur)
        elif self.cur is not None and state in ENDED:
            self._close(state)

    async def _fix_status(self, base):
        tid, name = self.check
        self.check = None
        try:
            async with httpx.AsyncClient(timeout=4) as c:
                r = await c.get(base + "/server/history/list", params={"limit": 5, "order": "desc"})   # GET seulement
                jobs = r.json()["result"]["jobs"]
            for j in jobs:
                if j.get("filename") == name and j.get("status") in ("completed", "cancelled", "error", "interrupted", "klippy_shutdown"):
                    new = "terminée" if j["status"] == "completed" else "interrompue"
                    self.db.execute("UPDATE tracks SET status=? WHERE id=?", (new, tid))
                    self.db.commit()
                    break
        except Exception:
            pass

    async def run(self):
        while True:
            wait = 10
            try:
                base = self.url_fn()
                if base:
                    async with httpx.AsyncClient(timeout=4) as c:
                        r = await c.get(base + "/printer/objects/query", params=QUERY)   # GET seulement
                        r.raise_for_status()
                        st = r.json()["result"]["status"]
                    self.error = None
                    self.step(st)
                    if getattr(self, "check", None):
                        await self._fix_status(base)
                    wait = 2 if (st.get("print_stats") or {}).get("state") in ACTIVE else 8
            except Exception as e:
                self.error = (str(e) or e.__class__.__name__)[:150]
            await asyncio.sleep(wait)
