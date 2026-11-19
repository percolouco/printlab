"""PrintLab : gestion des filaments, de l'imprimante et de la QIDI Box."""
import asyncio
import hmac
import ipaddress
import json
import math
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import BackgroundTasks, Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, URLSafeTimedSerializer

from . import db, eta, images, invoices, modelsearch, notify, rfid, rfid_writer, workshop
from .backups import Backups
from .boxheat import BoxHeat
from .gfiles import GFiles
from .tracker import Tracker

STATIC_DIR = Path(__file__).parent / "static"
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
API_TOKEN = os.environ.get("API_TOKEN", "")
def _secret_key():
    """SECRET_KEY du .env, sinon une clé aléatoire créée au premier lancement et gardée dans les données."""
    k = os.environ.get("SECRET_KEY", "").strip()
    if k:
        return k
    f = Path(os.environ.get("DATA_DIR", "/data")) / "secret_key"
    try:
        if f.exists():
            return f.read_text().strip()
        import secrets
        k = secrets.token_urlsafe(48)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(k)
        f.chmod(0o600)
        return k
    except OSError:
        import secrets
        return secrets.token_urlsafe(48)  # sessions perdues au redémarrage, mais jamais de clé devinable


SECRET_KEY = _secret_key()
# Valeurs de repli (optionnelles) ; le réglage se fait dans Paramètres → Imprimante
ENV_MOONRAKER = os.environ.get("MOONRAKER_URL", "").strip()
ENV_SPOOLMAN = os.environ.get("SPOOLMAN_URL", "").strip()
COOKIE = "printlab_session"
SESSION_DAYS = 30

app = FastAPI(title="PrintLab", docs_url=None, redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=1000)
signer = URLSafeTimedSerializer(SECRET_KEY, salt="session")
DB = db.init()
_fails = {}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def rows(sql, args=()):
    return [dict(r) for r in DB.execute(sql, args).fetchall()]


def row(sql, args=()):
    r = DB.execute(sql, args).fetchone()
    return dict(r) if r else None


# ---------- authentification ----------

def _lan_direct(request: Request):
    """Accès direct depuis le LAN (sans passer par Traefik) : réservé à l'API compatible Spoolman."""
    if request.headers.get("x-forwarded-for") or not request.client:
        return False
    try:
        return ipaddress.ip_address(request.client.host).is_private
    except ValueError:
        return False


def _authenticated(request: Request):
    auth = request.headers.get("authorization", "")
    if API_TOKEN and auth.startswith("Bearer ") and hmac.compare_digest(auth[7:], API_TOKEN):
        return True
    tok = request.cookies.get(COOKIE)
    if not tok:
        return False
    try:
        signer.loads(tok, max_age=SESSION_DAYS * 86400)
        return True
    except BadSignature:
        return False


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    p = request.url.path
    public = p in ("/login", "/api/login", "/healthz", "/favicon.svg", "/static/style.css", "/static/themes.css", "/static/favicon.svg", "/static/login.html")
    if p.startswith("/api/v1/") and _lan_direct(request):
        public = True
    if not public and not _authenticated(request):
        if p.startswith(("/api/", "/slicer/api/")):
            return JSONResponse({"detail": "Non authentifié"}, status_code=401)
        return RedirectResponse("/login")
    return await call_next(request)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/favicon.svg")
def favicon():
    return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")


@app.get("/login")
def login_page():
    html = (STATIC_DIR / "login.html").read_text().replace("{{v}}", _asset_version())
    return Response(html, media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-cache"})


@app.post("/api/login")
def login(request: Request, body: dict = Body(...)):
    ip = request.client.host if request.client else "?"  # adresse réelle (en-têtes du proxy pris en compte seulement si FORWARDED_ALLOW_IPS le permet)
    n, t = _fails.get(ip, (0, 0))
    if n >= 5 and time.time() - t < 300:
        raise HTTPException(429, "Trop d'essais, réessaie dans quelques minutes")
    if not APP_PASSWORD or not hmac.compare_digest(str(body.get("password", "")).encode(), APP_PASSWORD.encode()):
        _fails[ip] = (n + 1, time.time())
        raise HTTPException(401, "Mot de passe incorrect")
    _fails.pop(ip, None)
    r = JSONResponse({"ok": True})
    r.set_cookie(COOKIE, signer.dumps("ok"), max_age=SESSION_DAYS * 86400, httponly=True, secure=request.url.scheme == "https", samesite="lax")
    return r


@app.post("/api/logout")
def logout():
    r = JSONResponse({"ok": True})
    r.delete_cookie(COOKIE)
    return r


# ---------- calculs ----------

def length_from_weight(w, density, diameter):
    area = math.pi * (diameter / 2) ** 2  # mm²
    return w / density / area * 1000 if density and diameter else None  # mm


def weight_from_length(mm, density, diameter):
    area = math.pi * (diameter / 2) ** 2
    return mm * area / 1000 * density


SPOOL_SQL = """
SELECT s.*, f.name AS filament_name, f.material, f.finish, f.color_hex, f.color_hexes, f.density, f.diameter,
       f.weight AS filament_weight, f.spool_weight, f.low_threshold, f.price AS filament_price,
       f.nozzle_min, f.nozzle_max, f.bed_min, f.bed_max, f.vendor_id, f.image, v.name AS vendor_name, sm.slot AS slot,
       COALESCE(f.spool_weight, v.empty_spool_weight) AS tare,
       (SELECT MAX(u.ts) FROM usage u WHERE u.spool_id=s.id AND u.source='pesée') AS weighed_at,
       (SELECT COALESCE(SUM(u.weight), 0) FROM usage u WHERE u.spool_id=s.id) AS usage_sum
FROM spools s JOIN filaments f ON f.id=s.filament_id LEFT JOIN vendors v ON v.id=f.vendor_id
LEFT JOIN slot_map sm ON sm.spool_id=s.id
"""


MENU_KEYS = ("printer", "box", "spools", "invoices", "models", "slicer", "workshop")
SETTING_DEFAULTS = {"currency": "EUR", "round_prices": False, "base_url": "", "low_threshold": 100, "moonraker_url": "", "spoolman_url": "", "auto_deduct": True,
                    "extra_fields_spool": [], "extra_fields_filament": [], "extra_fields_vendor": [], "materials": [], "hidden_menus": [],
                    "rfid_writer": "", "rfid_autolink": True, "printer_write": False,
                    "notify_services": [], "alerts": {"runout": True, "low": True, "relay_end": True},
                    "elec_cost_entity": "", "elec_energy_entities": []}


def get_settings():
    out = dict(SETTING_DEFAULTS)
    for r in rows("SELECT key,value FROM settings"):
        if r["key"] in out:
            try:
                out[r["key"]] = json.loads(r["value"])
            except Exception:
                pass
    return out


def norm_url(v, port=None):
    """Accepte « 192.168.1.50 », « 192.168.1.50:7125 » ou une URL complète ; renvoie http://hôte:port sans slash final."""
    v = (v or "").strip().rstrip("/")
    if not v:
        return ""
    if "://" not in v:
        v = "http://" + v
    if port and not re.search(r":\d+$", v):
        v += f":{port}"
    return v


def moonraker_url():
    return norm_url(get_settings()["moonraker_url"] or ENV_MOONRAKER, 7125)


def spoolman_url():
    return norm_url(get_settings()["spoolman_url"] or ENV_SPOOLMAN, 7912)


@app.get("/api/settings")
def settings_get():
    return get_settings()


@app.put("/api/settings")
def settings_put(body: dict = Body(...)):
    for k, v in body.items():
        if k not in SETTING_DEFAULTS:
            continue
        if k == "currency":
            v = str(v or "EUR").upper()[:3]
        if k in ("moonraker_url", "spoolman_url"):
            v = norm_url(v, 7125 if k == "moonraker_url" else 7912)
            if v and not re.match(r"^https?://[^\s/]+(:\d+)?$", v):
                raise HTTPException(400, "Adresse invalide (exemple : 192.168.1.50 ou http://192.168.1.50:7125)")
        if k == "low_threshold":
            v = float(v) if v not in (None, "") else 100
        if k == "hidden_menus":
            v = sorted({str(x) for x in (v or []) if str(x) in MENU_KEYS})
        if k == "elec_cost_entity":
            v = str(v or "").strip()
        if k == "elec_energy_entities":
            v = [str(x).strip() for x in (v or []) if str(x).strip()]
        if k == "notify_services":
            v = [str(x).strip() for x in (v or []) if re.fullmatch(r"(notify|rest_command|script)\.[a-z0-9_]+", str(x).strip())]
        if k == "alerts":
            v = {a: bool((v or {}).get(a, True)) for a in ("runout", "low", "relay_end")}
        if k == "materials":
            v = sorted({str(x).strip().upper() for x in (v or []) if str(x).strip()})
        DB.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, json.dumps(v)))
    DB.commit()
    return get_settings()


def enrich_spool(s, thr_default=None):
    init = s["initial_weight"] if s["initial_weight"] is not None else (s["filament_weight"] or 1000)
    s["initial_weight"] = init
    s["remaining_weight"] = max(init - s["used_weight"], 0)
    s["remaining_pct"] = round(100 * s["remaining_weight"] / init, 1) if init else None
    s["remaining_length"] = length_from_weight(s["remaining_weight"], s["density"], s["diameter"])
    s["anomaly"] = s["used_weight"] > init + 0.5
    # fiabilité du poids : pesée > suivi complet depuis une bobine neuve > estimation (part de consommation non tracée)
    if s.get("weighed_at"):
        s["weight_src"] = "weighed"
    elif s["used_weight"] <= 0.5:
        s["weight_src"] = "new"
    elif abs(s["used_weight"] - (s.get("usage_sum") or 0)) <= 1:
        s["weight_src"] = "tracked"
    else:
        s["weight_src"] = "estimated"
    if s["low_threshold"] is not None:
        thr = s["low_threshold"]
    else:
        thr = thr_default if thr_default is not None else get_settings()["low_threshold"]
    s["low"] = (not s["archived"]) and s["remaining_weight"] <= thr
    s["price_eff"] = s["price"] if s["price"] is not None else s["filament_price"]
    s["color_hexes"] = json.loads(s["color_hexes"]) if s.get("color_hexes") else None
    return s


def get_spool(sid):
    s = row(SPOOL_SQL + " WHERE s.id=?", (sid,))
    if not s:
        raise HTTPException(404, "Bobine introuvable")
    return enrich_spool(s)


def use_spool(sid, weight, source="manual", job_id=None, note=None, ts=None):
    if weight == 0:
        return get_spool(sid)
    get_spool(sid)
    ts = ts or now_iso()
    DB.execute("INSERT INTO usage(spool_id,ts,weight,source,job_id,note) VALUES(?,?,?,?,?,?)",
               (sid, ts, weight, source, job_id, note))
    DB.execute("UPDATE spools SET used_weight=MAX(used_weight+?,0), last_used=?, first_used=COALESCE(first_used,?) WHERE id=?",
               (weight, ts, ts, sid))
    DB.commit()
    return get_spool(sid)


# ---------- CRUD générique ----------

VENDOR_F = ["name", "website", "comment", "empty_spool_weight", "extra"]
FILAMENT_F = ["vendor_id", "name", "material", "finish", "color_hex", "color_hexes", "density", "diameter", "weight",
              "spool_weight", "price", "article_number", "nozzle_min", "nozzle_max", "bed_min", "bed_max",
              "low_threshold", "comment", "external_id", "extra"]
SPOOL_F = ["filament_id", "initial_weight", "used_weight", "price", "location", "lot_nr", "comment", "archived", "extra"]


def _vals(body, fields):
    out = {}
    for k in fields:
        if k in body:
            v = body[k]
            if k == "color_hexes" and isinstance(v, list):
                v = json.dumps(v) if v else None
            if k == "color_hex" and isinstance(v, str):
                v = v.lstrip("#").upper() or None
            if k == "extra":
                v = json.dumps(v) if isinstance(v, dict) and v else None
            if v == "":
                v = None
            out[k] = v
    return out


def _insert(table, vals):
    cols = ",".join(vals)
    cur = DB.execute(f"INSERT INTO {table}({cols}) VALUES({','.join('?' * len(vals))})", list(vals.values()))
    DB.commit()
    return cur.lastrowid


def _update(table, id_, vals):
    if vals:
        DB.execute(f"UPDATE {table} SET {','.join(k + '=?' for k in vals)} WHERE id=?", [*vals.values(), id_])
        DB.commit()


@app.get("/api/vendors")
def vendors():
    return rows("""SELECT v.*, (SELECT COUNT(*) FROM filaments WHERE vendor_id=v.id) AS filaments,
        (SELECT COUNT(*) FROM spools s JOIN filaments f ON f.id=s.filament_id WHERE f.vendor_id=v.id AND s.archived=0) AS spools
        FROM vendors v ORDER BY name COLLATE NOCASE""")


@app.post("/api/vendors")
def vendor_add(body: dict = Body(...)):
    v = _vals(body, VENDOR_F)
    if not v.get("name"):
        raise HTTPException(400, "Nom requis")
    try:
        return {"id": _insert("vendors", v)}
    except Exception:
        raise HTTPException(409, "Ce fabricant existe déjà")


@app.put("/api/vendors/{id}")
def vendor_edit(id: int, body: dict = Body(...)):
    _update("vendors", id, _vals(body, VENDOR_F))
    return {"ok": True}


@app.delete("/api/vendors/{id}")
def vendor_del(id: int):
    if row("SELECT 1 FROM filaments WHERE vendor_id=?", (id,)):
        raise HTTPException(409, "Ce fabricant a encore des filaments")
    DB.execute("DELETE FROM vendors WHERE id=?", (id,))
    DB.commit()
    return {"ok": True}


FIL_SQL = """SELECT f.*, v.name AS vendor_name, COALESCE(f.spool_weight, v.empty_spool_weight) AS tare,
  (SELECT COUNT(*) FROM spools WHERE filament_id=f.id AND archived=0) AS spools,
  (SELECT COALESCE(SUM(MAX(COALESCE(initial_weight,f.weight)-used_weight,0)),0) FROM spools WHERE filament_id=f.id AND archived=0) AS remaining
  FROM filaments f LEFT JOIN vendors v ON v.id=f.vendor_id"""


def _fil(f):
    f["color_hexes"] = json.loads(f["color_hexes"]) if f.get("color_hexes") else None
    return f


@app.get("/api/filaments")
def filaments():
    return [_fil(f) for f in rows(FIL_SQL + " ORDER BY v.name COLLATE NOCASE, f.name COLLATE NOCASE")]


@app.post("/api/filaments")
def filament_add(bg: BackgroundTasks, body: dict = Body(...)):
    v = _vals(body, FILAMENT_F)
    if not v.get("name"):
        raise HTTPException(400, "Nom requis")
    fid = _insert("filaments", v)
    bg.add_task(_img_auto, fid)   # photo officielle cherchée en tâche de fond
    return {"id": fid}


@app.put("/api/filaments/{id}")
def filament_edit(id: int, body: dict = Body(...)):
    _update("filaments", id, _vals(body, FILAMENT_F))
    return {"ok": True}


@app.delete("/api/filaments/{id}")
def filament_del(id: int):
    sp = DB.execute("SELECT id, archived FROM spools WHERE filament_id=?", (id,)).fetchall()
    if sp:
        ids = ", ".join(f"n°{s[0]}{' (archivée)' if s[1] else ''}" for s in sp)
        raise HTTPException(409, f"Ce filament a encore {len(sp)} bobine(s) : {ids}. Une bobine vide s'archive "
                                 "(Bobines → modifier → Archivée = Oui) pour garder son historique ; "
                                 "supprime d'abord les bobines pour supprimer le filament.")
    DB.execute("DELETE FROM filaments WHERE id=?", (id,))
    DB.commit()
    _img_path(id).unlink(missing_ok=True)
    return {"ok": True}


# ---------- photos des filaments ----------
# Fichiers dans DATA_DIR/images/f<id>.jpg ; la colonne image vaut « f<id>.jpg?v=<horodatage> » (cache navigateur).

def _img_path(fid):
    return db.DATA_DIR / "images" / f"f{fid}.jpg"


def _img_set(fid, url, src):
    images.download(url, _img_path(fid))
    DB.execute("UPDATE filaments SET image=?, image_src=? WHERE id=?", (f"f{fid}.jpg?v={int(time.time())}", src, fid))
    DB.commit()


def _img_find(fid):
    f = row("SELECT f.*, v.name AS vendor_name, v.website FROM filaments f LEFT JOIN vendors v ON v.id=f.vendor_id WHERE f.id=?", (fid,))
    if not f:
        raise HTTPException(404, "Filament inconnu")
    hit = images.find(f, f.get("vendor_name") or "", f.get("website"))
    if hit:
        _img_set(fid, hit[0], hit[1])
    return hit


def _img_auto(fid):
    try:
        _img_find(fid)
    except Exception as e:
        print(f"photo filament {fid} : {e}")


@app.get("/api/filaments/{id}/image")
def filament_image(id: int):
    p = _img_path(id)
    if not p.exists():
        raise HTTPException(404, "Pas de photo")
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=31536000, immutable"})


@app.post("/api/filaments/{id}/image/find")
def filament_image_find(id: int):
    try:
        hit = _img_find(id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Boutique injoignable : {e}")
    if not hit:
        raise HTTPException(404, "Aucune photo officielle trouvée pour ce filament")
    return {"ok": True, "source": hit[1]}


@app.post("/api/filaments/{id}/image/url")
def filament_image_url(id: int, body: dict = Body(...)):
    url = (body.get("url") or "").strip()
    if not re.match(r"https?://", url):
        raise HTTPException(400, "Adresse d'image invalide")
    try:
        _img_set(id, url, url)
    except Exception as e:
        raise HTTPException(400, f"Image illisible : {e}")
    return {"ok": True}


@app.post("/api/filaments/{id}/image/upload")
async def filament_image_upload(id: int, file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(413, "Image trop lourde (15 Mo max)")
    try:
        images.save_bytes(data, _img_path(id))
    except Exception as e:
        raise HTTPException(400, f"Image illisible : {e}")
    DB.execute("UPDATE filaments SET image=?, image_src=? WHERE id=?", (f"f{id}.jpg?v={int(time.time())}", "import manuel", id))
    DB.commit()
    return {"ok": True}


@app.delete("/api/filaments/{id}/image")
def filament_image_del(id: int):
    _img_path(id).unlink(missing_ok=True)
    DB.execute("UPDATE filaments SET image=NULL, image_src=NULL WHERE id=?", (id,))
    DB.commit()
    return {"ok": True}


@app.post("/api/images/find-all")
def images_find_all(force: bool = False):
    """Cherche la photo officielle de chaque filament qui n'en a pas encore."""
    found, missing = [], []
    for f in rows("SELECT f.id, f.name, v.name AS vendor FROM filaments f LEFT JOIN vendors v ON v.id=f.vendor_id"
                  + ("" if force else " WHERE f.image IS NULL")):
        try:
            hit = _img_find(f["id"])
        except Exception:
            hit = None
        (found if hit else missing).append(f"{f['vendor'] or ''} {f['name']}".strip())
    return {"found": len(found), "missing": missing}


@app.get("/api/spools")
def spools(archived: int = 0, all: int = 0):
    sql = SPOOL_SQL + ("" if all else " WHERE s.archived=?")
    items = rows(sql, () if all else (archived,))
    thr = get_settings()["low_threshold"]
    return [enrich_spool(s, thr) for s in items]


@app.get("/api/spools/{id}")
def spool_get(id: int):
    s = get_spool(id)
    s["usage"] = rows("SELECT * FROM usage WHERE spool_id=? ORDER BY ts DESC LIMIT 200", (id,))
    return s


@app.post("/api/spools")
def spool_add(body: dict = Body(...)):
    v = _vals(body, SPOOL_F)
    if not v.get("filament_id"):
        raise HTTPException(400, "Filament requis")
    v.setdefault("registered", now_iso())
    v["registered"] = now_iso()
    n = int(body.get("quantity") or 1)
    ids = [_insert("spools", v) for _ in range(max(1, min(n, 50)))]
    return {"id": ids[0], "ids": ids}


@app.put("/api/spools/{id}")
def spool_edit(id: int, body: dict = Body(...)):
    get_spool(id)
    _update("spools", id, _vals(body, SPOOL_F))
    return {"ok": True}


@app.delete("/api/spools/{id}")
def spool_del(id: int):
    DB.execute("DELETE FROM slot_map WHERE spool_id=?", (id,))
    DB.execute("DELETE FROM spools WHERE id=?", (id,))
    DB.commit()
    return {"ok": True}


@app.post("/api/spools/{id}/use")
def spool_use(id: int, body: dict = Body(...)):
    w = body.get("weight")
    if w is None and body.get("length") is not None:
        s = get_spool(id)
        w = weight_from_length(float(body["length"]), s["density"], s["diameter"])
    if w is None:
        raise HTTPException(400, "weight ou length requis")
    return use_spool(id, float(w), body.get("source") or "manual", body.get("job_id"), body.get("note"), body.get("ts"))


# ---------- historique : corrections ----------
# Chaque ligne de « usage » a déjà été appliquée au poids utilisé de sa bobine : toute correction
# retire l'ancien effet puis applique le nouveau, pour que le stock reste cohérent.

def _usage(uid):
    u = row("SELECT * FROM usage WHERE id=?", (uid,))
    if not u:
        raise HTTPException(404, "Ligne d'historique inconnue")
    return u


@app.put("/api/usage/{uid}")
def usage_edit(uid: int, body: dict = Body(...)):
    """Corrige une ligne : poids, bobine (déplacement), date ou note."""
    u = _usage(uid)
    w = float(body["weight"]) if body.get("weight") not in (None, "") else u["weight"]
    sid = int(body["spool_id"]) if body.get("spool_id") else u["spool_id"]
    get_spool(sid)
    ts = body.get("ts") or u["ts"]
    note = body["note"] if "note" in body else u["note"]
    DB.execute("UPDATE spools SET used_weight=MAX(used_weight-?,0) WHERE id=?", (u["weight"], u["spool_id"]))
    DB.execute("UPDATE spools SET used_weight=MAX(used_weight+?,0), last_used=MAX(COALESCE(last_used,''),?) WHERE id=?", (w, ts, sid))
    src = u["source"] if (u["source"] or "").endswith("corrigé") else f"{u['source'] or 'manuel'} · corrigé"
    DB.execute("UPDATE usage SET weight=?, spool_id=?, ts=?, note=?, source=? WHERE id=?", (w, sid, ts, note, src, uid))
    DB.commit()
    return {"ok": True}


@app.delete("/api/usage/{uid}")
def usage_del(uid: int):
    u = _usage(uid)
    DB.execute("UPDATE spools SET used_weight=MAX(used_weight-?,0) WHERE id=?", (u["weight"], u["spool_id"]))
    DB.execute("DELETE FROM usage WHERE id=?", (uid,))
    DB.commit()
    return {"ok": True}


@app.post("/api/spools/{id}/measure")
def spool_measure(id: int, body: dict = Body(...)):
    """Pesée : poids restant de filament (remaining_weight) ou poids brut bobine comprise (gross_weight,
    tare = poids de bobine vide du filament, sinon du fabricant) -> recale le poids utilisé et trace la correction."""
    s = get_spool(id)
    if body.get("remaining_weight") is not None:
        remaining, note = float(body["remaining_weight"]), None
        if body.get("gross"):
            if not s["tare"]:
                raise HTTPException(400, "Poids de la bobine vide inconnu : renseigne-le sur le filament ou le fabricant")
            note = f"pesée {remaining:g} g − bobine {s['tare']:g} g"
            remaining -= s["tare"]
    elif body.get("gross_weight") is not None:
        gross = float(body["gross_weight"])
        if not s["tare"]:
            raise HTTPException(400, "Poids de la bobine vide inconnu : renseigne-le sur le filament ou le fabricant")
        remaining, note = gross - s["tare"], f"pesée {gross:g} g − bobine {s['tare']:g} g"
    else:
        raise HTTPException(400, "Poids requis")
    remaining = min(max(remaining, 0), s["initial_weight"])
    used = s["initial_weight"] - remaining
    delta = used - s["used_weight"]
    if abs(delta) >= 0.05:
        DB.execute("UPDATE spools SET used_weight=? WHERE id=?", (used, id))
        DB.execute("INSERT INTO usage(spool_id,ts,weight,source,note) VALUES(?,?,?,?,?)",
                   (id, now_iso(), delta, "pesée", note or f"restant {remaining:g} g"))
        DB.commit()
    return get_spool(id)


@app.post("/api/spools/{id}/duplicate")
def spool_dup(id: int):
    s = get_spool(id)
    new = {k: s[k] for k in SPOOL_F if k in s}
    new.update(used_weight=0, archived=0, registered=now_iso())
    return {"id": _insert("spools", new)}


@app.get("/api/locations")
def locations():
    return [r["location"] for r in rows("SELECT DISTINCT location FROM spools WHERE location IS NOT NULL AND location<>'' ORDER BY location")]


@app.get("/api/materials")
def materials():
    return [r["material"] for r in rows("SELECT DISTINCT material FROM filaments WHERE material IS NOT NULL ORDER BY material")]


@app.get("/api/export/spools.csv")
def export_csv():
    import csv, io
    out = io.StringIO()
    w = csv.writer(out, delimiter=";")
    w.writerow(["id", "fabricant", "filament", "matière", "finition", "couleur", "poids initial", "utilisé", "restant", "%", "prix", "emplacement", "lot", "archivée", "commentaire"])
    for s in spools(all=1):
        w.writerow([s["id"], s["vendor_name"], s["filament_name"], s["material"], s["finish"], s["color_hex"], s["initial_weight"],
                    round(s["used_weight"], 1), round(s["remaining_weight"], 1), s["remaining_pct"], s["price_eff"], s["location"],
                    s["lot_nr"], s["archived"], s["comment"]])
    return Response(out.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": "attachment; filename=bobines.csv"})


# ---------- tableau de bord ----------

# lignes d'historique qui ne sont pas de la consommation (corrections de poids)
NOT_USE = "u.source NOT IN ('pesée', 'fin de bobine')"


@app.get("/api/stats")
def stats(days: int = 30):
    """days = 0 : depuis le début."""
    sp = [s for s in spools() if not s["archived"]]
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ") if days > 0 else "0000"
    per_day = rows(f"SELECT substr(u.ts,1,10) AS day, SUM(u.weight) AS g FROM usage u WHERE u.ts>=? AND u.weight>0 AND {NOT_USE} GROUP BY day ORDER BY day", (since,))
    per_month = rows(f"SELECT substr(u.ts,1,7) AS month, SUM(u.weight) AS g FROM usage u WHERE u.ts>=? AND u.weight>0 AND {NOT_USE} GROUP BY month ORDER BY month", (since,))
    by_mat = rows(f"""SELECT f.material AS material, SUM(u.weight) AS g FROM usage u JOIN spools s ON s.id=u.spool_id
        JOIN filaments f ON f.id=s.filament_id WHERE u.ts>=? AND u.weight>0 AND {NOT_USE} GROUP BY f.material ORDER BY g DESC""", (since,))
    top = rows(f"""SELECT f.name AS name, v.name AS vendor, f.color_hex AS color_hex, SUM(u.weight) AS g FROM usage u
        JOIN spools s ON s.id=u.spool_id JOIN filaments f ON f.id=s.filament_id LEFT JOIN vendors v ON v.id=f.vendor_id
        WHERE u.ts>=? AND u.weight>0 AND {NOT_USE} GROUP BY f.id ORDER BY g DESC LIMIT 8""", (since,))
    cost = 0.0
    for r in rows(f"""SELECT u.weight, COALESCE(s.price, f.price) AS price, COALESCE(s.initial_weight, f.weight) AS iw
        FROM usage u JOIN spools s ON s.id=u.spool_id JOIN filaments f ON f.id=s.filament_id WHERE u.ts>=? AND u.weight>0 AND {NOT_USE}""", (since,)):
        if r["price"] and r["iw"]:
            cost += r["weight"] * r["price"] / r["iw"]
    # impressions suivies sur la période
    t0 = (datetime.now(timezone.utc) - timedelta(days=days)).timestamp() if days > 0 else 0
    trs = rows("SELECT status, started, ended, meta FROM tracks WHERE status!='running' AND started>=?", (t0,))
    ok = sum(1 for t in trs if t["status"] == "terminée")
    hours = sum(max((t["ended"] or t["started"]) - t["started"], 0) for t in trs) / 3600
    elec = [json.loads(t["meta"]).get("elec") for t in trs if t["meta"]]
    elec = [e for e in elec if e and e.get("eur") is not None]
    # prévision : au rythme des 60 derniers jours, quand chaque filament sera épuisé
    s60 = (datetime.now(timezone.utc) - timedelta(days=60)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rate = {r["fid"]: r["g"] / 60 for r in rows(f"""SELECT s.filament_id AS fid, SUM(u.weight) AS g FROM usage u JOIN spools s ON s.id=u.spool_id
        WHERE u.ts>=? AND u.weight>0 AND {NOT_USE} GROUP BY s.filament_id""", (s60,))}
    stock = {}
    for s in sp:
        o = stock.setdefault(s["filament_id"], {"filament_id": s["filament_id"], "name": s["filament_name"], "vendor": s["vendor_name"],
                                                "color_hex": s["color_hex"], "material": s["material"], "g": 0})
        o["g"] += s["remaining_weight"]
    forecast = []
    for fid, o in stock.items():
        r = rate.get(fid) or 0
        if r > 0.5:
            forecast.append({**o, "per_day": round(r, 1), "days_left": round(o["g"] / r)})
    forecast.sort(key=lambda x: x["days_left"])
    return {
        "prints": len(trs), "prints_ok": ok, "print_hours": round(hours, 1),
        "elec_eur": round(sum(e["eur"] for e in elec), 2) if elec else None, "elec_kwh": round(sum(e.get("kwh") or 0 for e in elec), 2) if elec else None,
        "elec_n": len(elec), "per_month": per_month, "forecast": forecast[:6],
        "days": days,
        "spools": len(sp),
        "remaining_kg": round(sum(s["remaining_weight"] for s in sp) / 1000, 2),
        "stock_value": round(sum((s["price_eff"] or 0) * s["remaining_weight"] / s["initial_weight"] for s in sp if s["initial_weight"]), 2),
        "used_g": round(sum(r["g"] for r in per_day), 1),
        "cost": round(cost, 2),
        "low": [s for s in sp if s["low"]],
        "anomalies": [s for s in sp if s["anomaly"]],
        "per_day": per_day, "by_material": by_mat, "top": top,
    }


# ---------- Suivi automatique de la consommation par slot (lecture seule côté imprimante) ----------

def _track_hook(kind, t, ev=None):
    asyncio.get_running_loop().create_task(_on_track(kind, dict(t), ev))


def _spool_label(sid):
    try:
        s = get_spool(sid)
        return f"{s.get('vendor_name') or ''} {s.get('filament_name') or ''}".strip() + f" (#{sid})"
    except HTTPException:
        return f"#{sid}"


async def alert(kind, title, message):
    st = get_settings()
    if not st["alerts"].get(kind, True) or not st["notify_services"]:
        return
    errs = await notify.send(st["notify_services"], title, message)
    if errs:
        print("alerte non envoyée :", errs, flush=True)


async def _on_track(kind, t, ev):
    smap = t.get("slot_map") or {}
    if kind == "runout":
        a, b = int(ev["slot"]), int(ev["to"])
        sa, sb = smap.get(str(a)), smap.get(str(b))
        await alert("runout", "🧵 Bobine vide, relais pris",
                    f"La bobine n°{a + 1}{' — ' + _spool_label(sa) if sa else ''} est vide. La Box continue avec la n°{b + 1}"
                    f"{' — ' + _spool_label(sb) if sb else ''}. Impression : {t.get('filename')}")
        return
    if kind != "closed":
        return
    await _track_elec(t["id"])
    # bobines passées sous le seuil de stock bas (une seule alerte par bobine, réarmée quand elle repasse au-dessus)
    r = row("SELECT value FROM settings WHERE key='low_notified'")
    done = set(json.loads(r["value"])) if r else set()
    empty = {e.get("spool_id") for e in t.get("events") or []}
    for sid in {p.get("spool_id") for p in t.get("parts") or [] if p.get("spool_id")}:
        try:
            s = get_spool(sid)
        except HTTPException:
            continue
        if s["low"] and sid not in done and sid not in empty:
            done.add(sid)
            await alert("low", "📉 Stock bas", f"{_spool_label(sid)} : il reste {round(s['remaining_weight'])} g.")
        elif not s["low"]:
            done.discard(sid)
    DB.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('low_notified',?)", (json.dumps(sorted(done)),))
    DB.commit()
    # fin automatique des relais utilisés : l'emplacement de relais reprend sa vraie identité
    relays = _relays()
    for e in t.get("events") or []:
        a, b = int(e["slot"]), int(e["to"])
        if relays.get(b) != a:
            continue
        await asyncio.sleep(30)                 # laisse finir la macro de fin d'impression
        try:
            await box_slot_sync(b, {})
            await alert("relay_end", "↻ Relais terminé", f"La bobine n°{b + 1} a repris son vrai réglage sur l'imprimante"
                        f"{' (' + _spool_label(smap.get(str(b))) + ')' if smap.get(str(b)) else ''}.")
        except HTTPException as x:
            await alert("relay_end", "⚠ Relais à terminer", f"Fin du relais n°{b + 1} impossible ({x.detail}) : "
                        "page Box → « Fin du relais : synchroniser ».")


TRACKER = Tracker(DB, rows, row, moonraker_url, get_settings, use_spool, now_iso, _track_hook)


def _track_meta(tid):
    r = row("SELECT meta FROM tracks WHERE id=?", (tid,))
    try:
        return json.loads(r["meta"]) if r and r["meta"] else {}
    except ValueError:
        return {}


def _track_meta_set(tid, meta):
    DB.execute("UPDATE tracks SET meta=? WHERE id=?", (json.dumps(meta), tid))
    DB.commit()


async def _track_elec(tid):
    """Coût électrique d'une impression = variation des compteurs HA (€ et kWh) entre son début et sa fin."""
    st = get_settings()
    cost_e, en_e = st.get("elec_cost_entity"), st.get("elec_energy_entities") or []
    t = row("SELECT started, ended FROM tracks WHERE id=?", (tid,))
    if not t or not t["ended"] or not (cost_e or en_e):
        return None
    meta = _track_meta(tid)
    try:
        d = await notify.history_delta(([cost_e] if cost_e else []) + en_e, t["started"], t["ended"])
    except Exception:
        return None
    if not d:
        if time.time() - t["ended"] > 8 * 86400:      # au-delà de la rétention de HA : on n'insiste plus
            meta["elec"] = {"eur": None, "kwh": None}
            _track_meta_set(tid, meta)
        return None
    meta["elec"] = {"eur": d.get(cost_e) if cost_e else None, "kwh": round(sum(d.get(e, 0) for e in en_e), 3) if en_e else None}
    _track_meta_set(tid, meta)
    return meta["elec"]


# ---------- journal des impressions (suivis PrintLab + historique Moonraker + timelapses) ----------
_tl_cache = {"t": 0, "files": []}


async def _timelapses(force=False):
    if force or time.time() - _tl_cache["t"] > 600:
        try:
            _tl_cache["files"] = await mr("/server/files/list", {"root": "timelapse"})
        except Exception:
            _tl_cache["files"] = []
        _tl_cache["t"] = time.time()
    return _tl_cache["files"]


def _tl_match(files, filename, started, ended):
    """timelapse_<fichier>_<AAAAMMJJ_HHMM>.mp4 : même fichier, horodatage proche du début de l'impression."""
    base = (filename or "").split("/")[-1]
    best, bd = None, 1e9
    for f in files:
        p = f.get("path", "")
        if not p.endswith(".mp4") or not p.startswith("timelapse_" + base + "_"):
            continue
        try:
            ts = datetime.strptime(p[-17:-4], "%Y%m%d_%H%M").timestamp()
        except ValueError:
            continue
        d = abs(ts - started)
        if d < bd and d < 6 * 3600:
            best, bd = f, d
    return best


@app.get("/api/journal")
async def journal(limit: int = 30, offset: int = 0):
    trs = rows("SELECT * FROM tracks WHERE status!='running' ORDER BY id DESC LIMIT ? OFFSET ?", (limit, offset))
    total = row("SELECT COUNT(*) AS n FROM tracks WHERE status!='running'")["n"]
    tls = await _timelapses()
    try:
        files = {f["path"]: f for f in (await _fl_get())[0]}
    except Exception:
        files = {}
    out = []
    for r in trs:
        t = _track_out(r)
        meta = _track_meta(t["id"])
        if "elec" not in meta and t.get("ended"):
            e = await _track_elec(t["id"])
            if e:
                meta["elec"] = e
        mat = 0.0
        for p in t["parts"] or []:
            p["label"], p["color_hex"], p["cost"] = None, None, None
            if p.get("spool_id"):
                try:
                    s = get_spool(p["spool_id"])
                    p["label"] = f"{s.get('vendor_name') or ''} {s.get('filament_name') or ''}".strip()
                    p["color_hex"] = s.get("color_hex")
                    if s.get("price_eff") and s.get("initial_weight"):
                        p["cost"] = round(p["weight"] * s["price_eff"] / s["initial_weight"], 2)
                        mat += p["cost"]
                except HTTPException:
                    pass
        tl = _tl_match(tls, t["filename"], t["started"], t.get("ended"))
        f = files.get(t["filename"])
        out.append({**t, "meta": meta, "cost_mat": round(mat, 2), "timelapse": tl["path"] if tl else None,
                    "file": {"path": f["path"], "modified": f["modified"], "thumb": bool((GFILES.cached(f["path"], f["modified"]) or {}).get("thumb")),
                             "filaments": (GFILES.cached(f["path"], f["modified"]) or {}).get("filaments") or []} if f else None})
    return {"items": out, "total": total, "write": bool(get_settings().get("printer_write"))}


@app.put("/api/tracks/{tid}/meta")
def track_meta_put(tid: int, body: dict = Body(...)):
    if not row("SELECT 1 FROM tracks WHERE id=?", (tid,)):
        raise HTTPException(404, "Suivi inconnu")
    meta = _track_meta(tid)
    if "rating" in body:
        meta["rating"] = body["rating"] if body["rating"] in ("ok", "bof", "raté") else None
    if "note" in body:
        meta["note"] = str(body["note"] or "")[:2000]
    _track_meta_set(tid, meta)
    return meta


@app.get("/api/timelapse")
async def timelapse_list():
    fs = [f for f in await _timelapses() if f.get("path", "").endswith(".mp4")]
    return {"count": len(fs), "size": sum(f.get("size", 0) for f in fs), "oldest": min((f["modified"] for f in fs), default=None),
            "write": bool(get_settings().get("printer_write"))}


@app.get("/api/timelapse/video")
async def timelapse_video(request: Request, path: str):
    """Relaie une vidéo timelapse de l'imprimante (en-tête Range transmis : lecture et avance rapide dans le navigateur)."""
    if "/" in path or not path.endswith(".mp4"):
        raise HTTPException(400, "Fichier invalide")
    b = moonraker_url()
    client = httpx.AsyncClient(timeout=httpx.Timeout(10, read=60))
    hdr = {"Range": request.headers["range"]} if request.headers.get("range") else {}
    try:
        r = await client.send(client.build_request("GET", f"{b}/server/files/timelapse/{quote(path)}", headers=hdr), stream=True)
    except Exception as e:
        await client.aclose()
        raise HTTPException(502, f"Imprimante injoignable : {e}")
    if r.status_code >= 400:
        await r.aclose(); await client.aclose()
        raise HTTPException(r.status_code, "Timelapse introuvable")

    async def gen():
        try:
            async for chunk in r.aiter_raw():
                yield chunk
        finally:
            await r.aclose()
            await client.aclose()
    keep = {k: v for k, v in r.headers.items() if k.lower() in ("content-length", "content-range", "accept-ranges", "last-modified")}
    return StreamingResponse(gen(), status_code=r.status_code, media_type="video/mp4", headers={**keep, "Accept-Ranges": "bytes"})


@app.post("/api/timelapse/cleanup")
async def timelapse_cleanup(body: dict = Body(...)):
    """Supprime de l'imprimante les timelapses (vidéo + vignette) plus vieux que `days` jours."""
    _need_write()
    days = int(body.get("days") or 0)
    if days < 7:
        raise HTTPException(400, "Minimum 7 jours")
    lim = time.time() - days * 86400
    _tl_cache["t"] = 0
    gone, freed = 0, 0
    for f in await _timelapses():
        p = f.get("path", "")
        if f.get("modified", lim) < lim and p.startswith("timelapse_") and "/" not in p:
            await mr_send("DELETE", "/server/files/timelapse/" + quote(p))
            gone += p.endswith(".mp4")
            freed += f.get("size", 0)
    _tl_cache["t"] = 0
    return {"deleted": gone, "freed": freed}


@app.post("/api/alerts/test")
async def alerts_test():
    st = get_settings()
    if not st["notify_services"]:
        raise HTTPException(400, "Aucun canal configuré")
    return {"errors": await notify.send(st["notify_services"], "🧪 Test PrintLab", "Les alertes de PrintLab arrivent bien ici.")}


BOXHEAT = BoxHeat(DB, rows, moonraker_url, now_iso)
BACKUPS = Backups(DB, rows, row, moonraker_url, now_iso)


@app.on_event("startup")
async def _start_tracker():
    asyncio.create_task(TRACKER.run())
    asyncio.create_task(_fl_warm())
    asyncio.create_task(_rfid_loop())
    asyncio.create_task(BOXHEAT.run())
    asyncio.create_task(BACKUPS.run())


def _track_out(r):
    t = TRACKER._load(r)
    t["parts"] = t["parts"] or TRACKER.compute_parts(t)
    return t


@app.get("/api/tracks")
def tracks_list():
    live = None
    if TRACKER.cur:
        live = dict(TRACKER.cur)
        live["parts"] = TRACKER.compute_parts(live)
    return {"live": live, "error": TRACKER.error, "auto": get_settings()["auto_deduct"],
            "tracks": [_track_out(r) for r in rows("SELECT * FROM tracks WHERE status!='running' ORDER BY id DESC LIMIT 50")]}


@app.post("/api/tracks/{tid}/undo")
def track_undo(tid: int):
    if not row("SELECT 1 FROM tracks WHERE id=?", (tid,)):
        raise HTTPException(404, "Suivi inconnu")
    TRACKER.undo(tid)
    return {"ok": True}


@app.post("/api/tracks/{tid}/apply")
def track_apply(tid: int, body: dict = Body(default={})):
    """Applique (ou ré-applique) la consommation au stock. body.map = {slot: spool_id} pour corriger l'association."""
    r = row("SELECT status FROM tracks WHERE id=?", (tid,))
    if not r or r["status"] == "running":
        raise HTTPException(404, "Suivi introuvable ou encore en cours")
    smap = None
    if body.get("map") is not None:
        smap = {str(k): int(v) for k, v in body["map"].items() if v}
        for v in smap.values():
            get_spool(v)
    TRACKER.apply(tid, smap)
    return {"ok": True}


# ---------- Moonraker (lecture seule) ----------

async def mr(path, params=None, timeout=6):
    base = moonraker_url()
    if not base:
        raise RuntimeError("Imprimante non configurée (Paramètres → Imprimante)")
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.get(base + path, params=params)
        r.raise_for_status()
        return r.json()["result"]


_LIVE_PREFIX = ("fan_generic ", "controller_fan ", "heater_fan ", "box_heater_fan ", "temperature_sensor ", "heater_generic ", "aht20_f ")
_LIVE_FIXED = ("print_stats", "extruder", "heater_bed", "toolhead", "display_status", "virtual_sdcard", "gcode_move", "motion_report",
               "system_stats", "output_pin polar_cooler", "output_pin caselight", "idle_timeout")
_live_objs = {"base": None, "list": None}


async def _live_objects():
    """Objets Klipper à suivre (ventilateurs, capteurs, chauffages) : liste mise en cache par adresse d'imprimante."""
    b = moonraker_url()
    if _live_objs["base"] != b or not _live_objs["list"]:
        objs = (await mr("/printer/objects/list"))["objects"]
        _live_objs.update(base=b, list=[o for o in objs if o.startswith(_LIVE_PREFIX) or o in _LIVE_FIXED])
    return _live_objs["list"]


_est_cache = {}   # nom de fichier → (heure de lecture, durée estimée par le slicer en secondes ou None)


async def _estimated_time(filename):
    """Durée totale estimée par le slicer (métadonnées Moonraker du fichier), gardée en mémoire 10 minutes."""
    now = time.time()
    hit = _est_cache.get(filename)
    if hit and now - hit[0] < 600:
        return hit[1]
    est = None
    try:
        md = await mr("/server/files/metadata", {"filename": filename})
        est = md.get("estimated_time")
        est = float(est) if est else None
    except Exception:
        pass
    if len(_est_cache) > 50:
        _est_cache.clear()
    _est_cache[filename] = (now, est)
    return est


@app.get("/api/printer")
async def printer():
    try:
        info = await mr("/printer/info")
        q = await mr("/printer/objects/query", {o: "" for o in await _live_objects()})
    except Exception as e:
        return {"online": False, "error": str(e)[:200]}
    st = q["status"]
    ps = st.get("print_stats", {})
    b = moonraker_url()
    fans, sensors = {}, {}
    for k, v in st.items():
        if k.startswith(("fan_generic ", "controller_fan ", "heater_fan ", "box_heater_fan ")):
            fans[k.split(" ", 1)[1]] = {"speed": v.get("speed"), "rpm": v.get("rpm"), "kind": k.split(" ", 1)[0]}
        elif k.startswith(("temperature_sensor ", "heater_generic ", "aht20_f ")):
            name = k.split(" ", 1)[1]
            sensors.setdefault(name, {}).update({x: v.get(x) for x in ("temperature", "target", "power", "humidity", "measured_max_temp") if v.get(x) is not None})
    progress = (st.get("display_status") or {}).get("progress") or (st.get("virtual_sdcard") or {}).get("progress")
    left = src = end = est = None
    if ps.get("state") in ("printing", "paused") and ps.get("filename"):
        est = await _estimated_time(ps["filename"])
        left, src = eta.remaining(ps.get("print_duration"), progress, est)
        if left is not None:
            end = int(time.time() + left)
    return {"online": True, "webcam": b.rsplit(":", 1)[0] + "/webcam/?action=stream", "klippy": info.get("state"), "hostname": info.get("hostname"),
            "remaining_s": None if left is None else int(left), "eta": end, "eta_source": src, "estimated_s": est, "write": bool(get_settings().get("printer_write")),
            "state": ps.get("state"), "filename": ps.get("filename"),
            "progress": (st.get("display_status") or {}).get("progress") or (st.get("virtual_sdcard") or {}).get("progress"),
            "layer": ps.get("info"), "print_duration": ps.get("print_duration"), "total_duration": ps.get("total_duration"),
            "filament_used_mm": ps.get("filament_used"),
            "extruder": st.get("extruder"), "bed": st.get("heater_bed"), "chamber": sensors.get("chamber"),
            "fans": fans, "sensors": sensors,
            "polar_cooler": (st.get("output_pin polar_cooler") or {}).get("value"), "caselight": (st.get("output_pin caselight") or {}).get("value"),
            "speed_factor": (st.get("gcode_move") or {}).get("speed_factor"), "velocity": (st.get("motion_report") or {}).get("live_velocity"),
            "position": (st.get("gcode_move") or {}).get("gcode_position"), "idle": (st.get("idle_timeout") or {}).get("state"),
            "system": st.get("system_stats"), "homed": (st.get("toolhead") or {}).get("homed_axes")}


try:
    QCAT = json.loads((Path(__file__).parent / "qidi_catalog.json").read_text())
except Exception:
    QCAT = {}


def _hex6(v):
    v = v[0] if isinstance(v, list) and v else v
    return v.upper() if isinstance(v, str) and re.fullmatch(r"[0-9A-Fa-f]{6}", v) else None


# ---------- catalogue de filaments (SpoolmanDB, voir scripts/build_catalog.py) ----------
try:
    FCAT = json.loads((Path(__file__).parent / "filament_catalog.json").read_text())
except Exception:
    FCAT = {"families": {}, "brands": {}}
_BKEY = lambda n: re.sub(r"[^a-z0-9]", "", (n or "").lower())
BRAND_ALIAS = {"qidi": "qiditech", "amazon": "amazonbasics", "prusa": "prusament", "elegoo3d": "elegoo"}
FCAT_IDX = {_BKEY(b): b for b in FCAT["brands"]}


def catalog_brand(name):
    k = _BKEY(name)
    return FCAT_IDX.get(k) or FCAT_IDX.get(BRAND_ALIAS.get(k, ""))


@app.get("/api/catalog")
def catalog_info():
    """Familles de matières et marques connues du catalogue (avec leur nombre de couleurs)."""
    return {"source": FCAT.get("source"), "built": FCAT.get("built"), "families": FCAT["families"],
            "brands": {b: sum(len(g["colors"]) for g in gs) for b, gs in FCAT["brands"].items()}}


@app.get("/api/catalog/brand")
def catalog_for(name: str):
    b = catalog_brand(name)
    return {"brand": b, "lines": FCAT["brands"].get(b, []) if b else []}


@app.get("/api/box")
async def box():
    try:
        q = await mr("/printer/objects/query", {"multi_color_controller": "", "save_variables": ""})
    except Exception as e:
        # imprimante injoignable : les associations bobine ↔ emplacement restent connues (base PrintLab)
        smap = {r["slot"]: r["spool_id"] for r in rows("SELECT slot, spool_id FROM slot_map")}
        return {"online": False, "error": str(e)[:200],
                "slots": [{"slot": i, "name": "A%d" % (i + 1), "spool_id": smap.get(i)} for i in range(4)]}
    b = (q["status"].get("multi_color_controller") or {}).get("box") or {}
    sv = ((q["status"].get("save_variables") or {}).get("variables")) or {}
    slots = []
    smap = {r["slot"]: r["spool_id"] for r in rows("SELECT slot, spool_id FROM slot_map")}
    known = {r["id"] for r in rows("SELECT id FROM spools")}
    for i in range(4):
        # Infos résolues par le firmware de la Box (box0_filament_info_N_*) : elles valent quel que soit le format écrit
        # dans saved_variables (index numériques de Fluidd, ou couleur hexa + code QFLxx de QIDI Studio / de l'écran).
        fw = lambda k: b.get(f"box0_filament_info_{i}_{k}")
        pc = _hex6([c.lstrip("#") for c in (fw("color_rgb_str") or [])]) or _hex6(sv.get(f"color_slot{i}"))
        fc = fw("filament_id") or sv.get(f"filament_slot{i}")
        fc = fc if isinstance(fc, str) and fc.startswith("Q") else None
        fi = QCAT.get(fc) if fc else None
        if fw("filament_str"):
            fi = {"name": f'{fw("vendor_str") or ""} {fw("filament_str")}'.strip(), "type": fw("filament_type") or (fi or {}).get("type")}
        ps = sv.get(f"spool_slot{i}")
        ps = ps if isinstance(ps, int) and ps in known else None
        slots.append({"slot": i, "name": "A%d" % (i + 1), "printer_color": pc, "printer_spool_id": ps,
                      "printer_filament": fc, "printer_filament_name": fi["name"] if fi else None, "printer_type": fi["type"] if fi else None,
                      "box_inserted": bool(b.get(f"box0_box_inserted_{i}")),
                      "filament_inserted": bool(b.get(f"box0_filament_inserted_{i}")),
                      "loaded": b.get("loaded_slot") == f"slot{i}",
                      "spool_id": smap.get(i)})
    rf = rfid_autolink(b)
    try:
        codes = (await rfid_codes())[0]
    except Exception:
        codes = None
    relays = _relays()
    for sl in slots:
        if sl["slot"] in relays:
            sl["relay_of"] = relays[sl["slot"]]
        sl.update(rf.get(sl["slot"], {}))
        if sl.get("rfid_linked"):
            sl["spool_id"] = sl["rfid_linked"]
        # réglage attendu côté imprimante pour la bobine associée, et accord avec ce que la Box indique
        if sl["spool_id"] and codes:
            try:
                t = rfid.qidi_target(QCAT, codes, get_spool(sl["spool_id"]))
                sl["sync_target"] = t
                sl["in_sync"] = sl["printer_filament"] == t["code"] and (sl["printer_color"] or "").upper() == t["color"]
            except (ValueError, HTTPException) as e:
                sl["sync_error"] = getattr(e, "detail", None) or str(e)
    return {"online": True, "loaded_slot": b.get("loaded_slot"), "humidity": b.get("box0_aht20_humidity"),
            "temp": b.get("box0_aht20_temp"), "target_temp": b.get("box0_box_target_temp"),
            "dry_state": b.get("box0_dry_state"), "box_online": bool(b.get("box0_is_online")), "slots": slots}


@app.get("/api/box/heat")
async def box_heat():
    return await BOXHEAT.status()


@app.post("/api/box/heat")
async def box_heat_start(body: dict = Body(...)):
    """Démarre le chauffage de séchage de la Box (seule écriture vers l'imprimante, voir boxheat.py)."""
    try:
        await BOXHEAT.start(body.get("temp", 50), body.get("hours", 4), body.get("hum_stop", 15))
    except PermissionError as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, "Imprimante injoignable : " + str(e)[:150])
    return await BOXHEAT.status()


@app.post("/api/box/heat/stop")
async def box_heat_stop():
    try:
        await BOXHEAT.stop()
    except Exception as e:
        raise HTTPException(502, "Imprimante injoignable : " + str(e)[:150])
    return await BOXHEAT.status()


@app.get("/api/search/printables")
def search_printables(q: str, limit: int = 24):
    q = q.strip()
    if not q:
        return []
    try:
        return modelsearch.printables(q, min(max(limit, 1), 48))
    except Exception as e:
        raise HTTPException(502, f"Printables ne répond pas : {e}")


@app.get("/api/search/thingiverse")
def search_thingiverse(q: str, limit: int = 24):
    q = q.strip()
    tok = os.environ.get("THINGIVERSE_TOKEN", "").strip()
    if not tok:
        raise HTTPException(400, "Jeton Thingiverse absent (variable THINGIVERSE_TOKEN)")
    if not q:
        return []
    try:
        return modelsearch.thingiverse(q, tok, min(max(limit, 1), 48))
    except Exception as e:
        raise HTTPException(502, f"Thingiverse ne répond pas : {type(e).__name__}")


# ---------- Sauvegardes des fichiers de l'imprimante (lecture seule côté imprimante, voir backups.py) ----------

@app.get("/api/backups")
def backups_list():
    return {"snapshots": BACKUPS.listing()}


@app.post("/api/backups")
async def backups_create(body: dict = Body(default={})):
    try:
        snap = await BACKUPS.snapshot(label=str(body.get("label") or "manuelle"), auto=False)
    except Exception as e:
        raise HTTPException(502, "Imprimante injoignable : " + str(e)[:150])
    return snap


@app.get("/api/backups/{sid}")
def backups_detail(sid: int):
    d = BACKUPS.detail(sid)
    if not d:
        raise HTTPException(404, "Instantané introuvable")
    return d


@app.get("/api/backups/{sid}/file")
def backups_file(sid: int, path: str, dl: int = 0):
    data = BACKUPS.content(sid, path)
    if data is None:
        raise HTTPException(404, "Fichier introuvable")
    h = {"Content-Disposition": 'attachment; filename="%s"' % path.rsplit("/", 1)[-1].replace('"', "")} if dl else {}
    return Response(data, media_type="text/plain; charset=utf-8" if not dl else "application/octet-stream", headers=h)


@app.get("/api/backups/{sid}/diff")
async def backups_diff(sid: int, path: str, against: str = "prev"):
    try:
        return await BACKUPS.diff(sid, path, against)
    except Exception as e:
        raise HTTPException(502, str(e)[:200])


@app.get("/api/backups/{sid}/zip")
def backups_zip(sid: int):
    z = BACKUPS.zip_snapshot(sid)
    if z is None:
        raise HTTPException(404, "Instantané introuvable")
    return Response(z, media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="printlab-config-%d.zip"' % sid})


@app.delete("/api/backups/{sid}")
def backups_delete(sid: int):
    BACKUPS.delete(sid)
    return {"ok": True}


@app.put("/api/box/slots/{slot}")
def box_slot(slot: int, body: dict = Body(...)):
    """Association PrintLab uniquement : ne touche pas à la QIDI Box."""
    if slot not in range(4):
        raise HTTPException(400, "Slot invalide")
    sid = body.get("spool_id")
    DB.execute("DELETE FROM slot_map WHERE slot=? OR spool_id=?", (slot, sid))
    if sid:
        get_spool(sid)
        DB.execute("INSERT INTO slot_map(slot,spool_id) VALUES(?,?)", (slot, sid))
    DB.commit()
    return {"ok": True}


@app.post("/api/box/slots/{slot}/sync")
async def box_slot_sync(slot: int, body: dict = Body(default={})):
    """Envoie à l'imprimante la marque / matière / couleur de la bobine associée à l'emplacement, par la même commande
    que l'écran (UPDATE_FILAMENT_INFORMATION) : la Box en déduit les températures, comme après lecture d'une étiquette RFID.
    Aucun mouvement : rien n'est chargé, déchargé ni éjecté. Refusé pendant une impression."""
    if slot not in range(4):
        raise HTTPException(400, "Slot invalide")
    if not moonraker_url():
        raise HTTPException(400, "Imprimante non configurée")
    r = row("SELECT spool_id FROM slot_map WHERE slot=?", (slot,))
    sid = body.get("spool_id") or (r["spool_id"] if r else None)
    if not sid:
        raise HTTPException(400, "Aucune bobine associée à cet emplacement")
    state, _ = await _print_state()
    if state in ("printing", "paused"):
        raise HTTPException(409, "Impression en cours : synchronisation possible une fois l'impression terminée")
    codes, _ = await rfid_codes()
    try:
        t = rfid.qidi_target(QCAT, codes, get_spool(sid))
    except ValueError as e:
        raise HTTPException(400, str(e))
    fw = await _box_update(slot, t["color"], t["vendor"], t["filament"], t["code"])
    _relay_set(slot, None)
    return {"ok": True, "target": t, "printer": fw}


def _box_fw(b, slot):
    return {k[len(f"box0_filament_info_{slot}_"):]: v for k, v in b.items() if k.startswith(f"box0_filament_info_{slot}_")}


async def _box_update(slot, color, vendor, filament, code):
    """UPDATE_FILAMENT_INFORMATION (commande de l'écran) puis relecture jusqu'à ce que la Box indique le réglage."""
    for v in (color, vendor, filament):
        if "'" in str(v) or "\n" in str(v):
            raise HTTPException(400, "Valeur invalide")
    script = f"UPDATE_FILAMENT_INFORMATION SLOT={slot} COLOR='{color}' VENDOR='{vendor}' FILAMENT='{filament}'"
    await mr_send("POST", "/printer/gcode/script", params={"script": script})
    fw = {}
    for _ in range(6):
        await asyncio.sleep(0.5)
        q = await mr("/printer/objects/query", {"multi_color_controller": ""})
        fw = _box_fw((q["status"].get("multi_color_controller") or {}).get("box") or {}, slot)
        col = (fw.get("color_rgb_str") or [""])[0].lstrip("#").upper()
        if fw.get("filament_id") == code and col == color:
            return fw
    raise HTTPException(502, f"L'imprimante n'a pas pris le réglage (elle indique {fw.get('vendor_str') or '?'} {fw.get('filament_str') or '?'})")


# bobines de relais : {emplacement: emplacement imité}. L'emplacement de relais est déclaré à l'imprimante avec la même
# marque / matière / couleur que celui qu'il relaie, pour que la recharge automatique de la Box accepte de basculer.
# Les associations bobine ↔ emplacement de PrintLab ne changent pas : le suivi compte toujours la vraie bobine.
def _relays():
    r = row("SELECT value FROM settings WHERE key='box_relay'")
    try:
        return {int(k): int(v) for k, v in json.loads(r["value"]).items()} if r else {}
    except (ValueError, TypeError):
        return {}


def _relay_set(slot, source):
    rl = _relays()
    if source is None:
        rl.pop(slot, None)
    else:
        rl[slot] = source
    DB.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('box_relay',?)", (json.dumps({str(k): v for k, v in rl.items()}),))
    DB.commit()


@app.post("/api/box/slots/{slot}/relay")
async def box_slot_relay(slot: int, body: dict = Body(...)):
    """Déclare l'emplacement `slot` comme identique à `source` (marque, matière, couleur lues sur l'imprimante)."""
    src = body.get("source")
    if slot not in range(4) or src not in range(4) or src == slot:
        raise HTTPException(400, "Emplacements invalides")
    if not moonraker_url():
        raise HTTPException(400, "Imprimante non configurée")
    state, _ = await _print_state()
    if state in ("printing", "paused"):
        raise HTTPException(409, "Impression en cours : à faire avant de lancer l'impression")
    q = await mr("/printer/objects/query", {"multi_color_controller": ""})
    fs = _box_fw((q["status"].get("multi_color_controller") or {}).get("box") or {}, src)
    col = (fs.get("color_rgb_str") or [""])[0].lstrip("#").upper()
    if not (fs.get("vendor_str") and fs.get("filament_str") and fs.get("filament_id") and re.fullmatch(r"[0-9A-F]{6}", col)):
        raise HTTPException(400, f"L'emplacement n°{src + 1} n'a pas de filament réglé sur l'imprimante")
    r = row("SELECT spool_id FROM slot_map WHERE slot=?", (slot,))
    if r and r["spool_id"]:
        sp = get_spool(r["spool_id"])
        if str(sp.get("material") or "").upper().rstrip("+") != str(fs.get("filament_type") or "").upper().rstrip("+"):
            raise HTTPException(400, f"Matières différentes : {sp.get('material')} ici, {fs.get('filament_type')} sur le n°{src + 1}")
    fw = await _box_update(slot, col, fs["vendor_str"], fs["filament_str"], fs["filament_id"])
    _relay_set(slot, src)
    return {"ok": True, "printer": fw}


# ---------- atelier : entretien, firmware, santé, mods (voir workshop.py) ----------

_fw_cache = {"t": 0, "data": None}


def _ws_state():
    r = row("SELECT value FROM settings WHERE key='workshop'")
    try:
        st = json.loads(r["value"]) if r else {}
    except ValueError:
        st = {}
    st.setdefault("tasks", {}); st.setdefault("mods", {}); st.setdefault("firmware", "")
    return st


def _ws_save(st):
    DB.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('workshop',?)", (json.dumps(st),))
    DB.commit()


async def _fw_latest():
    """Dernières versions du firmware Max 4 (suivi communautaire sur GitHub), en cache 6 h."""
    if _fw_cache["data"] is not None and time.time() - _fw_cache["t"] < 6 * 3600:
        return _fw_cache["data"]
    try:
        async with httpx.AsyncClient(timeout=8, headers={"User-Agent": "PrintLab", "Accept": "application/vnd.github+json"}) as c:
            r = await c.get(workshop.FW_RELEASES)
            r.raise_for_status()
            data = []
            for x in r.json()[:5]:
                m = re.search(r"\d{2}\.\d{2}\.\d{2}\.\d{2}", (x.get("name") or "") + " " + (x.get("tag_name") or ""))
                data.append({"tag": m.group(0) if m else x.get("tag_name"), "name": x.get("name"), "date": (x.get("published_at") or "")[:10], "url": x.get("html_url")})
    except Exception:
        data = _fw_cache["data"] or []
    _fw_cache.update(t=time.time(), data=data)
    return data


@app.get("/api/workshop")
async def workshop_info():
    st = _ws_state()
    health, hours, err = {}, None, None
    try:
        tot = (await mr("/server/history/totals"))["job_totals"]
        hours = round(tot["total_print_time"] / 3600, 1)
        health.update(jobs=int(tot["total_jobs"]), filament_km=round(tot["total_filament_used"] / 1e6, 2), longest_h=round(tot["longest_print"] / 3600, 1))
        q = await mr("/printer/objects/query", {"system_stats": "", "temperature_sensor Chamber_Thermal_Protection_Sensor": "",
                                                "multi_color_controller": ""})
        stt = q["status"]
        ss = stt.get("system_stats") or {}
        ch = stt.get("temperature_sensor Chamber_Thermal_Protection_Sensor") or {}
        b = (stt.get("multi_color_controller") or {}).get("box") or {}
        health.update(mem_mb=round((ss.get("memavail") or 0) / 1024), load=ss.get("sysload"), chamber=ch.get("temperature"),
                      chamber_max=ch.get("measured_max_temp"), box_temp=b.get("box0_aht20_temp"), box_hum=b.get("box0_aht20_humidity"))
    except Exception as e:
        err = str(e)[:200]
    if hours is None:
        hours = round(sum((r["print_duration"] or 0) for r in rows("SELECT print_duration FROM jobs")) / 3600, 1)
    tasks = [workshop.task_status(t, st["tasks"], hours) for t in workshop.TASKS]
    return {"hours": hours, "health": health, "error": err, "tasks": tasks, "mods": workshop.MODS, "mods_done": st["mods"],
            "tips": workshop.TIPS, "firmware": st["firmware"], "releases": await _fw_latest()}


@app.post("/api/workshop/tasks/{tid}")
async def workshop_task_done(tid: str):
    if tid not in {t["id"] for t in workshop.TASKS}:
        raise HTTPException(404)
    st = _ws_state()
    try:
        hours = round((await mr("/server/history/totals"))["job_totals"]["total_print_time"] / 3600, 1)
    except Exception:
        hours = round(sum((r["print_duration"] or 0) for r in rows("SELECT print_duration FROM jobs")) / 3600, 1)
    st["tasks"][tid] = {"t": time.time(), "h": hours}
    _ws_save(st)
    return {"ok": True}


@app.put("/api/workshop")
def workshop_put(body: dict = Body(...)):
    st = _ws_state()
    if "firmware" in body:
        st["firmware"] = str(body["firmware"] or "")[:40]
    if isinstance(body.get("mod"), str) and body["mod"] in {m["id"] for m in workshop.MODS}:
        st["mods"][body["mod"]] = bool(body.get("done"))
    _ws_save(st)
    return {"ok": True}


# ---------- étiquettes RFID de la QIDI Box (voir rfid.py) ----------

RFID_EVENTS = []          # dernières associations faites par lecture d'étiquette (affichées dans la page RFID)
_rfid_codes = {"t": 0, "codes": None, "source": None}


async def rfid_codes(force=False):
    """Liste des codes QIDI : lue sur l'imprimante (officiall_filas_list.cfg), copie locale sinon, copie livrée en dernier recours."""
    if _rfid_codes["codes"] and not force and time.time() - _rfid_codes["t"] < 3600:
        return _rfid_codes["codes"], _rfid_codes["source"]
    local = db.DATA_DIR / "officiall_filas_list.cfg"
    text, source = None, None
    try:
        base = moonraker_url()
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get(base + "/server/files/config/officiall_filas_list.cfg")
            r.raise_for_status()
            text, source = r.text, "imprimante"
        local.write_text(text)
    except Exception:
        if local.exists():
            text, source = local.read_text(), "copie locale"
        else:
            text, source = (Path(__file__).parent / "qidi_filas_default.cfg").read_text(), "liste QIDI d'origine"
    _rfid_codes.update(t=time.time(), codes=rfid.parse_cfg(text), source=source)
    return _rfid_codes["codes"], source


def _rfid_fw(b, i):
    fw = lambda k: b.get(f"box0_filament_info_{i}_{k}")  # noqa: E731
    col = fw("color_rgb_str") or []
    return {"vendor": fw("vendor_str"), "filament": fw("filament_str"), "type": fw("filament_type"),
            "color": col[0] if col else None, "from_rfid": bool(fw("info_from_rfid") or b.get(f"box0_slots_{i}_info_from_rfid"))}


def rfid_autolink(b):
    """Pour chaque emplacement dont la Box a lu une étiquette : retrouve la bobine PrintLab correspondante et l'associe.
    Renvoie {slot: {"rfid": True, "rfid_linked": id | None, "rfid_candidates": [...]}}."""
    out = {}
    tags = rows("SELECT t.spool_id, t.sig FROM rfid_tags t JOIN spools s ON s.id=t.spool_id WHERE s.archived=0")
    if not tags:
        return out
    smap = {r["slot"]: r["spool_id"] for r in rows("SELECT slot, spool_id FROM slot_map")}
    auto = get_settings().get("rfid_autolink", True)
    changed = False
    read = {}
    for i in range(4):
        fw = _rfid_fw(b, i)
        if fw["from_rfid"] and b.get(f"box0_box_inserted_{i}"):
            read[i] = [t["spool_id"] for t in tags if rfid.matches(json.loads(t["sig"] or "{}"), fw)]
    for i, cands in read.items():
        # une bobine ne peut être qu'à un endroit : seules les étiquettes lues ailleurs (sans ambiguïté) l'excluent,
        # une simple association manuelle ailleurs est remplacée par la lecture
        elsewhere = {c[0] for k, c in read.items() if k != i and len(c) == 1}
        sid, ambiguous = rfid.pick(cands, smap.get(i), elsewhere)
        out[i] = {"rfid": True, "rfid_candidates": cands if ambiguous else [], "rfid_linked": sid}
        if sid and auto and smap.get(i) != sid:
            DB.execute("DELETE FROM slot_map WHERE slot=? OR spool_id=?", (i, sid))
            DB.execute("INSERT INTO slot_map(slot,spool_id) VALUES(?,?)", (i, sid))
            smap = {k: v for k, v in smap.items() if v != sid}
            smap[i] = sid
            changed = True
            RFID_EVENTS.insert(0, {"ts": now_iso(), "slot": i, "spool_id": sid})
            del RFID_EVENTS[30:]
    if changed:
        DB.commit()
    return out


async def _rfid_loop():
    """Association automatique même sans page ouverte (lecture seule de l'imprimante, toutes les 20 s)."""
    while True:
        await asyncio.sleep(20)
        try:
            if rows("SELECT 1 FROM rfid_tags LIMIT 1"):
                q = await mr("/printer/objects/query", {"multi_color_controller": ""})
                rfid_autolink((q["status"].get("multi_color_controller") or {}).get("box") or {})
        except Exception:
            pass


def _writer():
    w = rfid_writer.make(get_settings().get("rfid_writer"), db.DATA_DIR)
    if not w:
        raise HTTPException(409, "Aucun lecteur RFID configuré (Paramètres → Étiquettes RFID)")
    return w


@app.get("/api/rfid")
async def rfid_info():
    codes, source = await rfid_codes()
    w = rfid_writer.make(get_settings().get("rfid_writer"), db.DATA_DIR)
    tags = rows("SELECT * FROM rfid_tags")
    for t in tags:
        t["sig"] = json.loads(t["sig"] or "{}")
    return {"codes": codes, "source": source, "writer": (await w.status()) if w else None,
            "tags": tags, "events": RFID_EVENTS}


@app.get("/api/rfid/suggest/{sid}")
async def rfid_suggest(sid: int):
    codes, _ = await rfid_codes()
    sp = get_spool(sid)
    t = row("SELECT * FROM rfid_tags WHERE spool_id=?", (sid,))
    cur = {"material": t["material"], "color": t["color"], "vendor": t["vendor"]} if t else None
    return {"suggest": rfid.suggest(codes, sp), "current": cur}


def _rfid_check(codes, material, color, vendor):
    if int(material) not in codes["materials"]:
        raise HTTPException(400, "Matière inconnue de la liste QIDI")
    if int(color) not in codes["colors"]:
        raise HTTPException(400, "Couleur inconnue de la liste QIDI")
    if int(vendor) not in codes["vendors"]:
        raise HTTPException(400, "Marque inconnue de la liste QIDI")


@app.post("/api/rfid/write")
async def rfid_write(body: dict = Body(...)):
    """Écrit l'étiquette posée sur le lecteur pour une bobine, puis mémorise sa signature."""
    codes, _ = await rfid_codes()
    sid = int(body.get("spool_id") or 0)
    get_spool(sid)
    m, c, v = body.get("material"), body.get("color"), body.get("vendor")
    _rfid_check(codes, m, c, v)
    try:
        res = await _writer().write(rfid.payload(m, c, v))
    except rfid_writer.WriterError as e:
        raise HTTPException(409, str(e))
    sig = rfid.signature(codes, m, c, v)
    DB.execute("INSERT OR REPLACE INTO rfid_tags(spool_id,material,color,vendor,sig,uid,written) VALUES(?,?,?,?,?,?,?)",
               (sid, int(m), int(c), int(v), json.dumps(sig), res.get("uid"), now_iso()))
    DB.commit()
    return {"ok": True, "uid": res.get("uid"), "sig": sig}


@app.post("/api/rfid/read")
async def rfid_read():
    codes, _ = await rfid_codes()
    try:
        res = await _writer().read()
    except rfid_writer.WriterError as e:
        raise HTTPException(409, str(e))
    d = rfid.decode(res["data"])
    blank = not any(res["data"][:3])
    sig = None if blank else rfid.signature(codes, d["material"], d["color"], d["vendor"])
    known = [t["spool_id"] for t in rows("SELECT spool_id, sig FROM rfid_tags")
             if sig and rfid.matches(json.loads(t["sig"] or "{}"), {"vendor": sig["vendor"], "filament": sig["filament"], "type": sig["type"], "color": sig["color"]})]
    return {"uid": res.get("uid"), "codes": d, "blank": blank, "sig": sig, "spools": known}


@app.delete("/api/rfid/tags/{sid}")
def rfid_forget(sid: int):
    DB.execute("DELETE FROM rfid_tags WHERE spool_id=?", (sid,))
    DB.commit()
    return {"ok": True}


def _cam_base():
    b = moonraker_url()
    return b.rsplit(":", 1)[0] + "/webcam/" if b else None


@app.get("/api/printer/webcam")
async def webcam():
    b = _cam_base()
    return {"url": b + "?action=stream" if b else None}


@app.get("/api/printer/stream")
async def webcam_stream(request: Request, snapshot: int = 0):
    """Relaie le flux MJPEG de la caméra (http, réseau local) à travers PrintLab : visible aussi en https / hors réseau."""
    b = _cam_base()
    if not b:
        raise HTTPException(404, "Imprimante non configurée")
    client = httpx.AsyncClient(timeout=httpx.Timeout(10, read=30))
    try:
        req = client.build_request("GET", b, params={"action": "snapshot" if snapshot else "stream"})
        r = await client.send(req, stream=True)
    except Exception as e:
        await client.aclose()
        raise HTTPException(502, f"Caméra injoignable : {e}")

    async def gen():
        try:
            async for chunk in r.aiter_raw():
                if await request.is_disconnected():
                    break
                yield chunk
        finally:
            await r.aclose()
            await client.aclose()
    return StreamingResponse(gen(), media_type=r.headers.get("content-type", "multipart/x-mixed-replace"),
                             headers={"Cache-Control": "no-store", "Content-Encoding": "identity", "X-Accel-Buffering": "no"})


@app.post("/api/printer/light")
async def printer_light(body: dict = Body(...)):
    """Allume / éteint l'éclairage du caisson (SET_PIN caselight). Seule commande envoyée par PrintLab à l'imprimante."""
    on = bool(body.get("on"))
    base = moonraker_url()
    if not base:
        raise HTTPException(400, "Imprimante non configurée")
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.post(base + "/printer/gcode/script", params={"script": f"SET_PIN PIN=caselight VALUE={1 if on else 0}"})
            r.raise_for_status()
    except Exception as e:
        raise HTTPException(502, f"Commande refusée : {str(e)[:150]}")
    return {"ok": True, "on": on}


# ---------- Actions d'écriture (désactivées par défaut : Paramètres → Imprimante) ----------

def _need_write():
    if not get_settings().get("printer_write"):
        raise HTTPException(403, "Actions d'écriture désactivées (Paramètres → Imprimante)")
    if not moonraker_url():
        raise HTTPException(400, "Imprimante non configurée")


async def mr_send(method, path, params=None, json_body=None):
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.request(method, moonraker_url() + path, params=params, json=json_body)
            if r.status_code >= 400:
                try:
                    m = r.json().get("error", {}).get("message")
                except Exception:
                    m = None
                raise HTTPException(502, f"Refusé par l'imprimante : {(m or r.text)[:160]}")
            return r.json().get("result")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Imprimante injoignable : {str(e)[:150]}")


async def _print_state():
    try:
        st = (await mr("/printer/objects/query", {"print_stats": "state,filename"}))["status"]["print_stats"]
    except Exception as e:
        raise HTTPException(502, f"Imprimante injoignable : {str(e)[:150]}")
    return st.get("state"), st.get("filename")


def _clean_path(p, allow_empty=False):
    p = (p or "").strip().strip("/")
    parts = p.split("/") if p else []
    if (not parts and not allow_empty) or any(x in ("", ".", "..") or x.startswith(".") or "\\" in x for x in parts):
        raise HTTPException(400, "Chemin invalide")
    return "/".join(parts)


@app.post("/api/printer/job/{action}")
async def printer_job(action: str, body: dict = Body(default={})):
    """Pause, reprise ou annulation de l'impression en cours."""
    _need_write()
    if action not in ("pause", "resume", "cancel"):
        raise HTTPException(404, "Action inconnue")
    state, _ = await _print_state()
    if action == "pause" and state != "printing":
        raise HTTPException(409, "Aucune impression en cours")
    if action == "resume" and state != "paused":
        raise HTTPException(409, "L'impression n'est pas en pause")
    if action == "cancel" and state not in ("printing", "paused"):
        raise HTTPException(409, "Aucune impression à annuler")
    await mr_send("POST", f"/printer/print/{action}")
    return {"ok": True}


@app.post("/api/files/print")
async def gfiles_print(body: dict = Body(...)):
    _need_write()
    path = _clean_path(body.get("path"))
    state, _ = await _print_state()
    if state in ("printing", "paused"):
        raise HTTPException(409, "Une impression est déjà en cours")
    info = await mr("/printer/info")
    if info.get("state") != "ready":
        raise HTTPException(409, f"Imprimante pas prête (Klipper : {info.get('state')})")
    # relais choisis dans la fenêtre de lancement, puis outil → emplacement (value_tN, comme l'écran avant un print)
    for r in body.get("relays") or []:
        await box_slot_relay(int(r["slot"]), {"source": int(r["source"])})
    mp = body.get("mapping") or {}
    if mp:
        cur = ((await mr("/printer/objects/query", {"save_variables": ""}))["status"].get("save_variables") or {}).get("variables") or {}
        for t, slot in mp.items():
            t, slot = int(t), int(slot)
            if not (0 <= t < 16 and 0 <= slot <= 16):
                raise HTTPException(400, "Correspondance invalide")
            if cur.get(f"value_t{t}") != f"slot{slot}":
                await mr_send("POST", "/printer/gcode/script", params={"script": f"SAVE_VARIABLE VARIABLE=value_t{t} VALUE='\"slot{slot}\"'"})
    await mr_send("POST", "/printer/print/start", params={"filename": path})
    _fl_invalidate()
    return {"ok": True}


@app.post("/api/files/delete")
async def gfiles_delete(body: dict = Body(...)):
    _need_write()
    path = _clean_path(body.get("path"))
    state, cur = await _print_state()
    busy = state in ("printing", "paused") and cur
    if body.get("dir"):
        if busy and (cur == path or cur.startswith(path + "/")):
            raise HTTPException(409, "Un fichier de ce dossier est en cours d'impression")
        await mr_send("DELETE", "/server/files/directory", params={"path": "gcodes/" + path, "force": "true"})
    else:
        if busy and cur == path:
            raise HTTPException(409, "Ce fichier est en cours d'impression")
        await mr_send("DELETE", "/server/files/gcodes/" + quote(path))
    _fl_invalidate()
    return {"ok": True}


@app.post("/api/files/mkdir")
async def gfiles_mkdir(body: dict = Body(...)):
    _need_write()
    await mr_send("POST", "/server/files/directory", json_body={"path": "gcodes/" + _clean_path(body.get("path"))})
    _fl_invalidate()
    return {"ok": True}


@app.post("/api/files/move")
async def gfiles_move(body: dict = Body(...)):
    """Déplace ou renomme un fichier / dossier."""
    _need_write()
    src, dest = _clean_path(body.get("src")), _clean_path(body.get("dest"))
    if dest == src or dest.startswith(src + "/"):
        raise HTTPException(400, "Destination invalide")
    state, cur = await _print_state()
    if state in ("printing", "paused") and cur and (cur == src or cur.startswith(src + "/")):
        raise HTTPException(409, "Ce fichier est en cours d'impression")
    await mr_send("POST", "/server/files/move", json_body={"source": "gcodes/" + src, "dest": "gcodes/" + dest})
    _fl_invalidate()
    return {"ok": True}


@app.post("/api/printer/test")
async def printer_test(body: dict = Body(...)):
    """Teste une adresse Moonraker (sans l'enregistrer)."""
    u = norm_url(body.get("url"), 7125)
    if not u:
        return {"ok": False, "error": "Adresse vide"}
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(u + "/printer/info")
            r.raise_for_status()
            j = r.json()["result"]
        return {"ok": True, "hostname": j.get("hostname"), "klippy": j.get("state"), "software_version": j.get("software_version")}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200] or e.__class__.__name__}


async def sync_jobs(limit=50):
    res = await mr("/server/history/list", {"limit": limit})
    n = 0
    for j in res["jobs"]:
        md = j.get("metadata") or {}
        spool_ids = []
        for a in j.get("auxiliary_data") or []:
            if a.get("name") == "spool_ids":
                spool_ids = [x for x in (a.get("value") or []) if x]
        mm = j.get("filament_used") or 0
        thumbs = md.get("thumbnails") or []
        thumb = thumbs[0]["relative_path"] if thumbs else None
        old = row("SELECT job_id FROM jobs WHERE job_id=?", (j["job_id"],))
        vals = (j["filename"], j.get("status"), j.get("start_time"), j.get("end_time"), j.get("print_duration"), mm,
                weight_from_length(mm, 1.24, 1.75), thumb, json.dumps(spool_ids))
        if old:
            DB.execute("UPDATE jobs SET filename=?,status=?,start_time=?,end_time=?,print_duration=?,filament_mm=?,filament_g=?,thumb=?,spool_ids=? WHERE job_id=?", (*vals, j["job_id"]))
        else:
            DB.execute("INSERT INTO jobs(filename,status,start_time,end_time,print_duration,filament_mm,filament_g,thumb,spool_ids,job_id) VALUES(?,?,?,?,?,?,?,?,?,?)", (*vals, j["job_id"]))
            n += 1
    DB.commit()
    return n


GFILES = GFiles(db.DATA_DIR, moonraker_url)


def _hex_rgb(h):
    h = (h or "").lstrip("#")[:6]
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) if len(h) == 6 else None
    except ValueError:
        return None


def _family(m):
    m = (m or "").upper().replace(" ", "").replace("+", "")
    for f in ("PETG", "PCTG", "PLA", "ABS", "ASA", "TPU", "PC", "PA", "PVA", "HIPS"):
        if m.startswith(f) or f in m:
            return f
    return m


def _file_hist():
    """Historique Moonraker (table jobs) regroupé par nom de fichier."""
    out = {}
    for j in rows("SELECT filename,status,start_time,end_time,print_duration,filament_g FROM jobs ORDER BY start_time DESC"):
        h = out.setdefault(j["filename"], {"count": 0, "ok": 0, "last": None, "last_status": None, "durations": []})
        h["count"] += 1
        h["ok"] += j["status"] == "completed"
        if h["last"] is None:
            h["last"], h["last_status"] = j["start_time"], j["status"]
        if j["status"] == "completed" and j["print_duration"]:
            h["durations"].append(j["print_duration"])
    for h in out.values():
        d = h.pop("durations")
        h["real_duration"] = sum(d) / len(d) if d else None
    return out


async def _gdirs():
    """Tous les dossiers de gcodes/ (y compris vides), en parcours en largeur limité."""
    out, todo = [], [""]
    while todo and len(out) < 300:
        d = todo.pop(0)
        try:
            r = await mr("/server/files/directory", {"path": "gcodes" + ("/" + d if d else ""), "extended": "false"})
        except Exception:
            break
        for x in r.get("dirs", []):
            n = x["dirname"]
            if n.startswith("."):
                continue
            p = (d + "/" if d else "") + n
            out.append(p)
            todo.append(p)
    return sorted(out)


# Liste des fichiers de l'imprimante : Moonraker met ~1 s à la donner (et ~1 s de plus pour l'historique et les
# dossiers). On garde la dernière réponse : elle est servie tout de suite et rafraîchie en arrière-plan
# (la page relit une fois quand « stale » est vrai). Toute action sur les fichiers vide le cache.
_FL = {"t": 0, "data": None, "task": None}
FL_FRESH, FL_MAX = 20, 3600


async def _fl_refresh():
    async def jobs():
        try:
            await sync_jobs()
        except Exception:
            pass

    async def cur():
        try:
            return (await mr("/printer/objects/query", {"print_stats": "state,filename"}))["status"]["print_stats"]
        except Exception:
            return {}
    (files, pending), dirs, _, c = await asyncio.gather(GFILES.listing(), _gdirs(), jobs(), cur())
    _FL.update(t=time.time(), data=(files, pending, dirs, c))
    return _FL["data"]


async def _fl_warm():
    """Garde la liste des fichiers prête (lecture seule, toutes les 3 min) : les pages Fichiers et Impressions s'ouvrent sans attendre."""
    await asyncio.sleep(5)
    while True:
        try:
            if moonraker_url():
                await _fl_refresh()
                await _timelapses(force=True)
        except Exception:
            pass
        await asyncio.sleep(180)


def _fl_invalidate():
    _FL["t"] = 0


async def _fl_get():
    """Renvoie (files, pending, dirs, print_stats, stale)."""
    age = time.time() - _FL["t"]
    if _FL["data"] and age < FL_FRESH:
        return (*_FL["data"], False)
    if _FL["data"] and age < FL_MAX and _FL["t"]:
        if not _FL["task"] or _FL["task"].done():
            _FL["task"] = asyncio.create_task(_fl_refresh())
        return (*_FL["data"], True)
    if _FL["task"] and not _FL["task"].done():
        return (*(await _FL["task"]), False)
    _FL["task"] = asyncio.create_task(_fl_refresh())
    return (*(await _FL["task"]), False)


LIST_INFO_DROP = ("settings", "objects")


@app.get("/api/files")
async def gfiles_list():
    try:
        files, pending, dirs, cur, stale = await _fl_get()
    except Exception as e:
        return {"files": [], "error": str(e)[:200], "pending": 0}
    hist = _file_hist()
    out = []
    for f in files:
        info = GFILES.cached(f["path"], f["modified"])
        if info:      # la liste n'a pas besoin des réglages complets (lus par /api/files/detail)
            info = {k: v for k, v in info.items() if k not in LIST_INFO_DROP}
            if isinstance(info.get("moonraker"), dict):
                info["moonraker"] = {k: info["moonraker"].get(k) for k in ("estimated_time", "filament_weight_total")}
        out.append({"path": f["path"], "modified": f["modified"], "size": f["size"], "info": info,
                    "hist": hist.get(f["path"]), "printing": cur.get("state") in ("printing", "paused") and cur.get("filename") == f["path"]})
    return {"files": out, "dirs": dirs, "pending": pending, "progress": GFILES.progress, "error": None, "stale": stale or bool(pending),
            "write": bool(get_settings().get("printer_write"))}


@app.get("/api/files/thumb")
def gfiles_thumb(path: str):
    p = GFILES.thumb_path(path)
    if not p.exists():
        raise HTTPException(404, "Pas d'aperçu")
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/files/detail")
def gfiles_detail(path: str):
    k = GFILES._key(path)
    info = GFILES.mem.get(k)
    if info is None:
        f = GFILES.dir / (k + ".json")
        if not f.exists():
            raise HTTPException(404, "Fichier pas encore analysé")
        info = json.loads(f.read_text())
    jobs = rows("SELECT job_id,status,start_time,end_time,print_duration,filament_g FROM jobs WHERE filename=? ORDER BY start_time DESC LIMIT 50", (path,))
    tracks = rows("SELECT started,ended,status,parts,applied FROM tracks WHERE filename=? ORDER BY started DESC LIMIT 20", (path,))
    for t in tracks:
        t["parts"] = json.loads(t["parts"] or "[]")
    # bobines en stock qui correspondent à chaque filament du fichier (même famille de matière, couleur la plus proche)
    thr = get_settings()["low_threshold"]
    stock = [enrich_spool(s, thr) for s in rows(SPOOL_SQL + " WHERE s.archived=0")]
    match = []
    for fl in info.get("filaments") or []:
        c, fam, cands = _hex_rgb(fl.get("color")), _family(fl.get("type")), []
        for s in stock:
            if fam and _family(s["material"]) != fam:
                continue
            sc = _hex_rgb(s["color_hex"])
            d = math.dist(c, sc) if c and sc else 999
            if d <= 60:
                ppg = (s["price_eff"] / s["initial_weight"]) if s["price_eff"] and s["initial_weight"] else None
                cands.append({"id": s["id"], "filament_id": s["filament_id"], "name": s["filament_name"], "vendor": s["vendor_name"],
                              "color_hex": s["color_hex"], "remaining": s["remaining_weight"], "slot": s["slot"], "dist": round(d, 1), "ppg": ppg})
        cands.sort(key=lambda x: (x["dist"] > 12, x["slot"] is None, x["dist"]))
        match.append({"id": fl.get("id"), "spools": cands[:4]})
    return {"info": info, "jobs": jobs, "tracks": tracks, "match": match}


@app.get("/api/jobs")
async def jobs(refresh: int = 1):
    err = None
    if refresh:
        try:
            await sync_jobs()
        except Exception as e:
            err = str(e)[:200]
    items = rows("""SELECT j.*, COALESCE((SELECT SUM(weight) FROM usage u WHERE u.job_id=j.job_id),0) AS assigned_g
        FROM jobs j ORDER BY start_time DESC LIMIT 200""")
    trk = rows("SELECT filename, started, applied, parts FROM tracks WHERE status!='running'")
    for j in items:
        j["spool_ids"] = json.loads(j["spool_ids"] or "[]")
        j["tracked_g"] = None
        for t in trk:   # impression déjà comptée par le suivi automatique (même fichier, démarrée à ±5 min)
            if t["applied"] and t["filename"] == j["filename"] and j["start_time"] and abs((t["started"] or 0) - j["start_time"]) < 300:
                j["tracked_g"] = round(sum(p.get("weight") or 0 for p in json.loads(t["parts"] or "[]")), 1)
    return {"jobs": items, "error": err}


@app.post("/api/jobs/{job_id}/assign")
def job_assign(job_id: str, body: dict = Body(...)):
    """Impute le poids d'une impression à une ou plusieurs bobines (liste de {spool_id, weight})."""
    job = row("SELECT * FROM jobs WHERE job_id=?", (job_id,))
    if not job:
        raise HTTPException(404, "Impression inconnue")
    DB.execute("DELETE FROM usage WHERE job_id=?", (job_id,))
    DB.commit()
    for a in body.get("parts", []):
        use_spool(int(a["spool_id"]), float(a["weight"]), "impression", job_id, job["filename"])
    return {"ok": True}


# ---------- import Spoolman ----------

@app.post("/api/import/spoolman")
async def import_spoolman():
    SPOOLMAN = spoolman_url()
    if not SPOOLMAN:
        raise HTTPException(400, "Adresse de Spoolman non renseignée (Paramètres → Imprimante et intégrations)")
    async with httpx.AsyncClient(timeout=30) as c:
        vs = (await c.get(f"{SPOOLMAN}/api/v1/vendor")).json()
        fs = (await c.get(f"{SPOOLMAN}/api/v1/filament")).json()
        ss = (await c.get(f"{SPOOLMAN}/api/v1/spool", params={"allow_archived": "true"})).json()
    stat = {"vendors": 0, "filaments": 0, "spools": 0}
    vmap, fmap = {}, {}
    for v in vs:
        ex = row("SELECT id FROM vendors WHERE spoolman_id=? OR name=?", (v["id"], v["name"]))
        if ex:
            vmap[v["id"]] = ex["id"]
            DB.execute("UPDATE vendors SET spoolman_id=? WHERE id=?", (v["id"], ex["id"]))
        else:
            vmap[v["id"]] = _insert("vendors", {"name": v["name"], "comment": v.get("comment"), "spoolman_id": v["id"]})
            stat["vendors"] += 1
    for f in fs:
        ex = row("SELECT id FROM filaments WHERE spoolman_id=?", (f["id"],))
        extra = f.get("extra") or {}
        vals = {"vendor_id": vmap.get((f.get("vendor") or {}).get("id")), "name": f["name"], "material": f.get("material"),
                "color_hex": (f.get("color_hex") or "").upper() or None, "density": f.get("density") or 1.24,
                "diameter": f.get("diameter") or 1.75, "weight": f.get("weight") or 1000, "spool_weight": f.get("spool_weight"),
                "price": f.get("price"), "article_number": f.get("article_number"), "external_id": f.get("external_id"),
                "nozzle_min": f.get("settings_extruder_temp"), "bed_min": f.get("settings_bed_temp"),
                "comment": f.get("comment"), "spoolman_id": f["id"]}
        if f.get("multi_color_hexes"):
            vals["color_hexes"] = json.dumps(f["multi_color_hexes"].split(","))
        if ex:
            fmap[f["id"]] = ex["id"]
        else:
            fmap[f["id"]] = _insert("filaments", vals)
            stat["filaments"] += 1
    for s in ss:
        if row("SELECT id FROM spools WHERE spoolman_id=?", (s["id"],)):
            continue
        extra = s.get("extra") or {}
        fin = str(extra.get("finition", "")).strip('"')
        fid = fmap[s["filament"]["id"]]
        if fin:
            DB.execute("UPDATE filaments SET finish=COALESCE(finish,?) WHERE id=?", (fin, fid))
        _insert("spools", {"filament_id": fid, "initial_weight": s.get("initial_weight"), "used_weight": s.get("used_weight") or 0,
                           "price": s.get("price"), "location": s.get("location"), "lot_nr": s.get("lot_nr"),
                           "comment": s.get("comment"), "archived": 1 if s.get("archived") else 0,
                           "registered": (s.get("registered") or now_iso()), "first_used": s.get("first_used"),
                           "last_used": s.get("last_used"), "spoolman_id": s["id"]})
        stat["spools"] += 1
    DB.commit()
    return stat


# ---------- API compatible Spoolman (pour Moonraker, plus tard) ----------

def _sm_spool(s):
    return {"id": s["id"], "registered": s["registered"], "used_weight": s["used_weight"], "remaining_weight": s["remaining_weight"],
            "initial_weight": s["initial_weight"], "archived": bool(s["archived"]), "location": s["location"],
            "filament": {"id": s["filament_id"], "name": s["filament_name"], "material": s["material"], "color_hex": s["color_hex"],
                         "density": s["density"], "diameter": s["diameter"], "weight": s["filament_weight"],
                         "vendor": {"id": s["vendor_id"], "name": s["vendor_name"]}}}


@app.get("/api/v1/health")
def sm_health():
    return {"status": "healthy"}


@app.get("/api/v1/info")
def sm_info():
    return {"version": "0.27.1-printlab", "db_type": "sqlite"}


@app.get("/api/v1/spool")
def sm_spools():
    return [_sm_spool(s) for s in spools(all=1)]


@app.get("/api/v1/spool/{id}")
def sm_spool(id: int):
    return _sm_spool(get_spool(id))


@app.put("/api/v1/spool/{id}/use")
def sm_use(id: int, body: dict = Body(...)):
    w = body.get("use_weight")
    if w is None and body.get("use_length") is not None:
        s = get_spool(id)
        w = weight_from_length(float(body["use_length"]), s["density"], s["diameter"])
    return _sm_spool(use_spool(id, float(w or 0), "moonraker"))


# ---------- factures d'achat ----------
# Dépôt d'une facture PDF → lecture (app/invoices.py) → récapitulatif proposé → validation → bobines créées.
# Le PDF est gardé dans DATA_DIR/invoices/<id>.pdf. Rien n'est écrit dans le stock avant la validation.

def _inv_path(iid):
    return db.DATA_DIR / "invoices" / f"{iid}.pdf"


def _sku_base(s):
    return re.sub(r"-SPL(FREE)?$", "", (s or "").upper().replace(" ", ""))


def _cat_line(vendor, mat, fin):
    b = catalog_brand(vendor or "")
    for l in FCAT["brands"].get(b, []) if b else []:
        if (l.get("mat") or "").upper() == (mat or "").upper() and (l.get("finish") or None) == (fin or None):
            return l
    return None


def _inv_vendor_id(name):
    if not name:
        return None
    k = _BKEY(name)
    for v in rows("SELECT id, name FROM vendors"):
        if _BKEY(v["name"]) == k or (k.startswith("bambu") and _BKEY(v["name"]).startswith("bambu")):
            return v["id"]
    return None


def _inv_match(l, vendor_id, fils):
    """Filament déjà connu pour une ligne : code couleur, puis référence (SKU), puis nom anglais du catalogue."""
    cand = [f for f in fils if vendor_id and f["vendor_id"] == vendor_id] or []
    code, sku = l.get("code"), _sku_base(l.get("sku"))
    for f in cand:
        if code and (f.get("external_id") == code or re.search(rf"\({code}\)\s*$", f["name"] or "")):
            return f, "code couleur " + code
    for f in cand:
        if sku and _sku_base(f.get("article_number")) == sku:
            return f, "référence " + sku
    names = {n.lower() for n in [
        " ".join(x for x in [l.get("material"), l.get("finish"), l.get("color_en")] if x),
        " ".join(x for x in [l.get("material"), l.get("finish"), l.get("color")] if x),
        " ".join(x for x in [l.get("finish") or l.get("material"), l.get("color")] if x)] if n}
    for f in cand:
        if (f["name"] or "").lower() in names and (f.get("material") or "").upper() == (l.get("material") or "").upper():
            return f, "nom"
    return None, None


def _inv_new_filament(l, vendor):
    fin = l.get("finish")
    cat = _cat_line(vendor, l.get("material"), fin)
    if not fin and _cat_line(vendor, l.get("material"), "Basic"):
        fin, cat = "Basic", _cat_line(vendor, l.get("material"), "Basic")
    color = l.get("color") or ""
    if not re.search(r"[a-zàâçéèêëîïôûùüÿ]", color) or color == l.get("color_en"):
        color = " ".join(images.EN_FR.get(w.lower(), w) for w in color.split()).capitalize() if color else color
    name = " ".join(x for x in [fin or l.get("material"), color] if x) + (f" ({l['code']})" if l.get("code") else "")
    hexes = l.get("hexes") or []
    return {"name": name.strip() or l.get("product") or "Filament", "material": l.get("material"), "finish": fin,
            "color_hex": hexes[0] if hexes else None, "color_hexes": hexes if len(hexes) > 1 else None,
            "density": (cat or {}).get("density") or {"PLA": 1.24, "PETG": 1.27, "ABS": 1.04, "ASA": 1.07, "TPU": 1.21}.get(l.get("material") or "", 1.24),
            "nozzle_min": ((cat or {}).get("nozzle") or [None, None])[0], "nozzle_max": ((cat or {}).get("nozzle") or [None, None])[1],
            "bed_min": ((cat or {}).get("bed") or [None, None])[0], "bed_max": ((cat or {}).get("bed") or [None, None])[1],
            "weight": l.get("weight") or 1000, "spool_weight": (cat or {}).get("spool_weight"),
            "article_number": l.get("sku"), "external_id": l.get("code"), "price": l.get("paid_each") or None}


def _inv_img(iid, i):
    return db.DATA_DIR / "invoices" / "img" / f"{iid}_{i}.jpg"


def _inv_photos(iid):
    """Photo officielle de chaque article de la facture (pour le récapitulatif, puis le nouveau filament)."""
    inv = row("SELECT * FROM invoices WHERE id=?", (iid,))
    if not inv:
        return
    p = json.loads(inv["parsed"] or "{}")
    DB.execute("UPDATE invoices SET parsed=? WHERE id=?", (json.dumps({**p, "photos": "pending"}), iid))
    DB.commit()
    found = {}
    for i, l in enumerate(p.get("lines", [])):
        try:
            nf = _inv_new_filament(l, inv["vendor"])
            hit = images.find({"name": nf["name"], "material": nf["material"], "finish": nf["finish"]}, inv["vendor"] or "")
            if hit:
                images.download(hit[0], _inv_img(iid, i))
                found[i] = hit[1]
        except Exception as e:
            print(f"photo facture {iid} ligne {i} : {e}")
    cur = json.loads(row("SELECT parsed FROM invoices WHERE id=?", (iid,))["parsed"] or "{}")
    for i, src in found.items():
        cur["lines"][i]["photo"] = src
    cur["photos"] = "done"
    DB.execute("UPDATE invoices SET parsed=? WHERE id=?", (json.dumps(cur), iid))
    DB.commit()


def _inv_out(inv, full=False):
    p = json.loads(inv["parsed"] or "{}")
    out = {k: inv[k] for k in ("id", "filename", "uploaded", "vendor", "number", "order_nr", "date", "total", "currency", "status", "done_at")}
    out["spools"] = sum(l.get("qty") or 0 for l in p.get("lines", []))
    out["result"] = json.loads(inv["result"]) if inv.get("result") else None
    if inv["number"]:
        dup = row("SELECT id FROM invoices WHERE number=? AND id<>? AND status='done'", (inv["number"], inv["id"]))
        out["duplicate_of"] = dup["id"] if dup else None
    if full:
        vid = _inv_vendor_id(inv["vendor"])
        fils = rows("SELECT * FROM filaments")
        lines = []
        for i, l in enumerate(p.get("lines", [])):
            f, why = _inv_match(l, vid, fils)
            lines.append({**l, "i": i, "match": {"id": f["id"], "name": f["name"], "why": why, "image": f.get("image")} if f else None,
                          "new": _inv_new_filament(l, inv["vendor"])})
        out.update(lines=lines, totals=p.get("totals") or {}, factor=p.get("factor"), format=p.get("format"), photos=p.get("photos"),
                   vendor_id=vid, has_file=_inv_path(inv["id"]).exists())
    return out


@app.get("/api/invoices")
def invoices_list():
    return [_inv_out(i) for i in rows("SELECT * FROM invoices ORDER BY id DESC")]


@app.post("/api/invoices")
async def invoice_upload(bg: BackgroundTasks, file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(413, "Fichier trop lourd (25 Mo max)")
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "Envoie la facture au format PDF")
    try:
        p = invoices.parse(data)
    except Exception as e:
        raise HTTPException(400, f"PDF illisible : {e}")
    if p.get("lines"):
        p["photos"] = "pending"
    iid = _insert("invoices", {"filename": file.filename, "uploaded": now_iso(), "vendor": p.get("vendor"), "number": p.get("number"),
                               "order_nr": p.get("order"), "date": p.get("date"), "total": (p.get("totals") or {}).get("total"),
                               "currency": p.get("currency"), "status": "pending", "parsed": json.dumps(p)})
    path = _inv_path(iid)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    if p.get("lines"):
        bg.add_task(_inv_photos, iid)
    return _inv_out(row("SELECT * FROM invoices WHERE id=?", (iid,)), True)


def _inv(iid):
    inv = row("SELECT * FROM invoices WHERE id=?", (iid,))
    if not inv:
        raise HTTPException(404, "Facture inconnue")
    return inv


@app.get("/api/invoices/{iid}")
def invoice_get(iid: int):
    return _inv_out(_inv(iid), True)


@app.get("/api/invoices/{iid}/file")
def invoice_file(iid: int):
    inv = _inv(iid)
    p = _inv_path(iid)
    if not p.exists():
        raise HTTPException(404, "PDF absent")
    return FileResponse(p, media_type="application/pdf", filename=inv["filename"] or f"facture-{iid}.pdf", content_disposition_type="inline")


@app.get("/api/invoices/{iid}/img/{i}")
def invoice_img(iid: int, i: int):
    p = _inv_img(iid, i)
    if not p.exists():
        raise HTTPException(404, "Pas de photo")
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.put("/api/invoices/{iid}")
def invoice_edit(iid: int, body: dict = Body(...)):
    """Corrige l'en-tête (fournisseur, numéro, date) d'une facture en attente."""
    inv = _inv(iid)
    if inv["status"] == "done":
        raise HTTPException(409, "Facture déjà intégrée")
    _update("invoices", iid, {k: (body[k] or None) for k in ("vendor", "number", "date") if k in body})
    return _inv_out(_inv(iid), True)


@app.post("/api/invoices/{iid}/apply")
def invoice_apply(iid: int, bg: BackgroundTasks, body: dict = Body(...)):
    """Intègre les lignes validées : crée les filaments manquants puis les bobines (une par unité)."""
    inv = _inv(iid)
    if inv["status"] == "done":
        raise HTTPException(409, "Cette facture est déjà intégrée")
    if inv["number"] and row("SELECT id FROM invoices WHERE number=? AND id<>? AND status='done'", (inv["number"], iid)) and not body.get("force"):
        raise HTTPException(409, "Une facture avec ce numéro est déjà intégrée")
    lines = [l for l in body.get("lines", []) if l.get("include")]
    if not lines:
        raise HTTPException(400, "Aucune ligne à intégrer")
    location = (body.get("location") or "").strip() or None
    label = " ".join(x for x in [f"Facture {inv['number']}" if inv["number"] else "Facture", inv["vendor"], f"du {inv['date']}" if inv["date"] else None] if x)
    created_f, spool_ids, with_photo = [], [], set()
    try:
        vid = _inv_vendor_id(inv["vendor"])
        if not vid and inv["vendor"] and any(not l.get("filament_id") for l in lines):
            DB.execute("INSERT INTO vendors(name) VALUES(?)", (inv["vendor"],))
            vid = DB.execute("SELECT last_insert_rowid()").fetchone()[0]
        for l in lines:
            qty = max(1, min(int(l.get("qty") or 1), 100))
            fid = l.get("filament_id")
            if fid:
                if not row("SELECT 1 FROM filaments WHERE id=?", (fid,)):
                    raise HTTPException(400, f"Filament {fid} inconnu")
                # complète les infos manquantes du filament existant (code, référence) sans rien écraser
                f = row("SELECT * FROM filaments WHERE id=?", (fid,))
                fill = {k: l.get(src) for k, src in (("external_id", "code"), ("article_number", "sku")) if not f.get(k) and l.get(src)}
                if fill:
                    DB.execute(f"UPDATE filaments SET {','.join(k + '=?' for k in fill)} WHERE id=?", [*fill.values(), fid])
            else:
                nf = _vals(l.get("create") or {}, FILAMENT_F)
                if not nf.get("name"):
                    raise HTTPException(400, "Nom du nouveau filament manquant")
                nf["vendor_id"] = nf.get("vendor_id") or vid
                cols = ",".join(nf)
                fid = DB.execute(f"INSERT INTO filaments({cols}) VALUES({','.join('?' * len(nf))})", list(nf.values())).lastrowid
                created_f.append(fid)
                li = l.get("i")
                if isinstance(li, int) and _inv_img(iid, li).exists():
                    dest = _img_path(fid)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(_inv_img(iid, li).read_bytes())
                    src = ((json.loads(inv["parsed"] or "{}").get("lines") or [{}] * (li + 1))[li] or {}).get("photo")
                    DB.execute("UPDATE filaments SET image=?, image_src=? WHERE id=?", (f"f{fid}.jpg?v={int(time.time())}", src if isinstance(src, str) else None, fid))
                    with_photo.add(fid)
            price = l.get("price")
            extra = json.dumps({"invoice_id": iid, **({"recharge": True} if l.get("refill") else {})})
            for _ in range(qty):
                spool_ids.append(DB.execute(
                    "INSERT INTO spools(filament_id, initial_weight, used_weight, price, location, comment, registered, extra) VALUES(?,?,0,?,?,?,?,?)",
                    (fid, l.get("weight") or None, price, location, label, now_iso(), extra)).lastrowid)
        DB.execute("UPDATE invoices SET status='done', done_at=?, result=? WHERE id=?",
                   (now_iso(), json.dumps({"spools": spool_ids, "filaments": created_f, "vendor_id": vid}), iid))
        DB.commit()
    except Exception:
        DB.rollback()
        raise
    for fid in created_f:
        if fid not in with_photo:
            bg.add_task(_img_auto, fid)   # photo officielle des nouveaux filaments
    return {"ok": True, "spools": spool_ids, "filaments": created_f}


@app.post("/api/invoices/{iid}/undo")
def invoice_undo(iid: int):
    """Annule une intégration : retire les bobines créées (si elles n'ont pas encore servi) et les filaments créés pour l'occasion."""
    inv = _inv(iid)
    if inv["status"] != "done":
        raise HTTPException(409, "Facture non intégrée")
    res = json.loads(inv["result"] or "{}")
    ids = res.get("spools", [])
    used = [s["id"] for s in rows(f"SELECT id FROM spools WHERE id IN ({','.join('?' * len(ids))}) AND (used_weight>0 OR EXISTS(SELECT 1 FROM usage WHERE spool_id=spools.id))", ids)] if ids else []
    if used:
        raise HTTPException(409, f"Bobines déjà utilisées : {', '.join('#' + str(i) for i in used)}. Supprime-les ou corrige-les à la main.")
    try:
        for sid in ids:
            DB.execute("DELETE FROM slot_map WHERE spool_id=?", (sid,))
            DB.execute("DELETE FROM spools WHERE id=?", (sid,))
        for fid in res.get("filaments", []):
            if not row("SELECT 1 FROM spools WHERE filament_id=?", (fid,)):
                DB.execute("DELETE FROM filaments WHERE id=?", (fid,))
                _img_path(fid).unlink(missing_ok=True)
        DB.execute("UPDATE invoices SET status='pending', done_at=NULL, result=NULL WHERE id=?", (iid,))
        DB.commit()
    except Exception:
        DB.rollback()
        raise
    return {"ok": True, "removed": len(ids)}


@app.post("/api/invoices/{iid}/reject")
def invoice_reject(iid: int):
    if _inv(iid)["status"] == "done":
        raise HTTPException(409, "Annule d'abord l'intégration")
    DB.execute("UPDATE invoices SET status='rejected' WHERE id=?", (iid,))
    DB.commit()
    return {"ok": True}


@app.post("/api/invoices/{iid}/reopen")
def invoice_reopen(iid: int):
    if _inv(iid)["status"] != "rejected":
        raise HTTPException(409, "Facture non rejetée")
    DB.execute("UPDATE invoices SET status='pending' WHERE id=?", (iid,))
    DB.commit()
    return {"ok": True}


@app.delete("/api/invoices/{iid}")
def invoice_del(iid: int):
    if _inv(iid)["status"] == "done":
        raise HTTPException(409, "Annule d'abord l'intégration")
    DB.execute("DELETE FROM invoices WHERE id=?", (iid,))
    DB.commit()
    _inv_path(iid).unlink(missing_ok=True)
    for f in (db.DATA_DIR / "invoices" / "img").glob(f"{iid}_*.jpg"):
        f.unlink(missing_ok=True)
    return {"ok": True}


# ---------- pages ----------

def _asset_version():
    """Empreinte des fichiers statiques : change à chaque mise à jour, le navigateur recharge alors app.js / style.css."""
    return format(int(max((STATIC_DIR / f).stat().st_mtime for f in ("app.js", "style.css", "themes.css"))), "x")


@app.get("/")
def index():
    html = (STATIC_DIR / "index.html").read_text().replace("{{v}}", _asset_version())
    return Response(html, media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-cache"})



from .slicer.api import app as _slicer_app  # noqa: E402  (module « Découpe » : Orca, plateau, aperçu, envoi à l'imprimante)
from .slicer import moonraker as _slicer_mr  # noqa: E402
_slicer_mr.RESOLVE = moonraker_url  # le Slicer suit l'adresse réglée dans Paramètres
app.mount("/slicer", _slicer_app, name="slicer")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
