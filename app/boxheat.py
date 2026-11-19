"""Chauffage de séchage de la QIDI Box, indépendant du reste de l'imprimante.

SÉCURITÉ IMPRIMANTE : c'est le SEUL endroit de PrintLab qui envoie une commande à Moonraker, et il n'envoie qu'UNE
seule forme de G-code : `SET_HEATER_TEMPERATURE HEATER=heater_box1 TARGET=<n>` (même commande que l'intégration
Home Assistant). Aucun mouvement, aucune rotation des bobines, aucun fichier. La consigne est bornée (0 ou 30–65 °C).

Garde-fous :
- aucune restriction liée à l'impression : c'est l'utilisateur qui décide (démarrage et arrêt possibles pendant
  une impression) ;
- arrêt automatique (consigne remise à 0) : durée maximale écoulée, humidité sous le seuil pendant 10 min ;
- si le chauffage a été coupé côté imprimante (écran, fin de séchage, redémarrage), PrintLab se contente de
  marquer le séchage comme terminé, sans rien envoyer.
"""
import asyncio
import json
import time

import httpx

HEATER = "heater_box1"
TEMP_MIN, TEMP_MAX = 30, 65
HUM_HOLD_S = 600        # humidité sous le seuil pendant 10 min avant arrêt
LOST_HOLD_S = 120       # chauffage éteint côté imprimante depuis 2 min -> séchage terminé
PRINTING = ("printing", "paused")
KEY = "box_heat"
QUERY = {"print_stats": "", f"heater_generic {HEATER}": "", "multi_color_controller": ""}


def gcode_for(target):
    """Seule commande autorisée. `target` est validé ici, quel que soit l'appelant."""
    t = int(target)
    if t != 0 and not (TEMP_MIN <= t <= TEMP_MAX):
        raise ValueError(f"Température hors limites ({TEMP_MIN}–{TEMP_MAX} °C)")
    return f"SET_HEATER_TEMPERATURE HEATER={HEATER} TARGET={t}"


class BoxHeat:
    def __init__(self, db, rows, moonraker_url, now):
        self.db, self.rows, self.url, self.now = db, rows, moonraker_url, now
        self.hum_since = None
        self.lost_since = None

    # ----- état persistant (table settings) -----
    def load(self):
        r = self.rows("SELECT value FROM settings WHERE key=?", (KEY,))
        try:
            return json.loads(r[0]["value"]) if r else {"active": False}
        except Exception:
            return {"active": False}

    def save(self, st):
        self.db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (KEY, json.dumps(st)))
        self.db.commit()

    # ----- Moonraker -----
    async def _get(self):
        base = self.url()
        if not base:
            raise RuntimeError("Imprimante non configurée (Paramètres → Imprimante)")
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get(base + "/printer/objects/query", params=QUERY)
            r.raise_for_status()
            s = r.json()["result"]["status"]
        box = (s.get("multi_color_controller") or {}).get("box") or {}
        return {"print": (s.get("print_stats") or {}).get("state"),
                "target": float((s.get(f"heater_generic {HEATER}") or {}).get("target") or 0),
                "temp": float((s.get(f"heater_generic {HEATER}") or {}).get("temperature") or 0),
                "hum": box.get("box0_aht20_humidity")}

    async def _send(self, target):
        script = gcode_for(target)
        base = self.url()
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(base + "/printer/gcode/script", params={"script": script})
            r.raise_for_status()

    # ----- actions -----
    async def start(self, temp, hours, hum_stop):
        temp, hours, hum_stop = int(temp), float(hours), float(hum_stop)
        if not (TEMP_MIN <= temp <= TEMP_MAX):
            raise ValueError(f"Température : {TEMP_MIN} à {TEMP_MAX} °C")
        if not (0.25 <= hours <= 24):
            raise ValueError("Durée : 15 min à 24 h")
        if not (0 <= hum_stop <= 100):
            raise ValueError("Seuil d'humidité : 0 à 100 %")
        await self._get()   # vérifie que l'imprimante répond avant d'envoyer
        await self._send(temp)
        self.hum_since = self.lost_since = None
        st = {"active": True, "target": temp, "started": time.time(), "hours": hours, "hum_stop": hum_stop, "reason": None}
        self.save(st)
        return st

    async def stop(self, reason="arrêt manuel"):
        await self._send(0)
        st = self.load()
        st.update(active=False, reason=reason, ended=time.time())
        self.save(st)
        return st

    async def status(self):
        st = self.load()
        out = dict(st)
        out["online"] = True
        try:
            cur = await self._get()
            out.update(heater_target=cur["target"], temp=cur["temp"], humidity=cur["hum"], printing=cur["print"] in PRINTING)
        except Exception as e:
            out.update(online=False, error=str(e)[:200])
        if st.get("active"):
            out["remaining_s"] = max(0, int(st["started"] + st["hours"] * 3600 - time.time()))
        return out

    # ----- surveillance (toutes les 30 s) -----
    async def tick(self):
        st = self.load()
        if not st.get("active"):
            return
        try:
            cur = await self._get()
        except Exception:
            return    # imprimante injoignable : on réessaie au prochain tour
        t = time.time()
        if cur["target"] <= 0:         # coupé côté imprimante (écran, fin de séchage, redémarrage)
            self.lost_since = self.lost_since or t
            if t - self.lost_since >= LOST_HOLD_S:
                st.update(active=False, reason="chauffage arrêté côté imprimante", ended=t)
                self.save(st)
            return
        self.lost_since = None
        if t >= st["started"] + st["hours"] * 3600:
            await self.stop("durée maximale atteinte")
            return
        h = cur["hum"]
        if h is not None and float(h) <= st["hum_stop"]:
            self.hum_since = self.hum_since or t
            if t - self.hum_since >= HUM_HOLD_S:
                await self.stop(f"humidité {h} % sous le seuil de {st['hum_stop']:g} %")
        else:
            self.hum_since = None

    async def run(self):
        while True:
            try:
                await self.tick()
            except Exception:
                pass
            await asyncio.sleep(30)
