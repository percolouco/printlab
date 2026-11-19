"""Alertes PrintLab envoyées par Home Assistant (mêmes canaux que les alertes d'impression existantes).

PrintLab appelle les services HA listés dans le réglage `notify_services` :
  - rest_command.* reçoit {"message": "**titre** texte"} (ex. rest_command.discord_homelab_alert → Discord)
  - notify.*       reçoit {"title": titre, "message": texte} (ex. notification du téléphone)
HA_URL / HA_TOKEN (jeton longue durée) viennent de l'environnement du conteneur.
"""
import os

import httpx

HA_URL = os.environ.get("HA_URL", "").rstrip("/")
HA_TOKEN = os.environ.get("HA_TOKEN", "")


def configured():
    return bool(HA_URL and HA_TOKEN)


async def send(services, title, message):
    """Renvoie la liste des erreurs (vide si tout est parti)."""
    if not configured():
        return ["Home Assistant non configuré (HA_URL / HA_TOKEN)"]
    errs = []
    async with httpx.AsyncClient(base_url=HA_URL, headers={"Authorization": f"Bearer {HA_TOKEN}"}, timeout=10) as c:
        for svc in services or []:
            dom, _, name = str(svc).partition(".")
            if not dom or not name:
                continue
            data = {"title": title, "message": message} if dom == "notify" else {"message": f"**{title}** {message}"}
            try:
                r = await c.post(f"/api/services/{dom}/{name}", json=data)
                if r.status_code >= 400:
                    errs.append(f"{svc} : HTTP {r.status_code}")
            except Exception as e:
                errs.append(f"{svc} : {e}")
    return errs


async def history_delta(entities, start, end):
    """Variation de chaque capteur cumulatif (kWh, €) entre deux instants, d'après l'historique de HA.
    Renvoie {entité: delta} (entités sans données absentes)."""
    if not configured() or not entities:
        return {}
    from datetime import datetime, timezone
    iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat()   # noqa: E731
    async with httpx.AsyncClient(base_url=HA_URL, headers={"Authorization": f"Bearer {HA_TOKEN}"}, timeout=15) as c:
        r = await c.get(f"/api/history/period/{iso(start)}", params={"end_time": iso(end), "filter_entity_id": ",".join(entities),
                                                                    "minimal_response": "", "no_attributes": ""})
        r.raise_for_status()
        out = {}
        for serie in r.json():
            vals = []
            for x in serie:
                try:
                    vals.append(float(x["state"]))
                except (TypeError, ValueError, KeyError):
                    pass
            if len(vals) >= 1 and serie:
                ent = serie[0].get("entity_id")
                # compteur remis à zéro en cours de route : on additionne les montées
                d = sum(max(b - a, 0) for a, b in zip(vals, vals[1:]))
                out[ent] = round(d, 4)
        return out
