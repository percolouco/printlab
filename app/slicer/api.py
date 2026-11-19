"""Orca Web : OrcaSlicer dans le navigateur, avec envoi à l'imprimante via Moonraker."""
import asyncio
import hmac
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic import BaseModel
import numpy as np

from . import models, moonraker, profiles, slicer

DATA_DIR = Path(os.environ.get("SLICER_DATA_DIR") or os.environ.get("DATA_DIR", "/data"))
STATIC_DIR = Path(__file__).parent / "static"
SCHEMA_PATH = Path(os.environ.get("SCHEMA_PATH", "/opt/orca/schema.json"))
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
API_TOKEN = os.environ.get("API_TOKEN", "")
DEFAULT_MACHINE = os.environ.get("DEFAULT_MACHINE", "Qidi X-Max 4 0.4 nozzle")
SESSION_DAYS = 30
COOKIE = "orca_session"

app = FastAPI(title="PrintLab – Slicer", docs_url=None, redoc_url=None)
JOBS = {}
PROJECTS_DIR = DATA_DIR / "projects"
_login_failures = {}


# ---------- authentification ----------

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
async def _revalidate_static(request: Request, call_next):
    """JS/CSS du Slicer : le navigateur revalide à chaque chargement (ETag), pour ne jamais garder une ancienne version."""
    resp = await call_next(request)
    p = request.url.path
    if "/static/js/" in p or p.endswith("/static/style.css"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# Authentification : assurée par PrintLab (session ou jeton API) avant d'arriver ici.


@app.get("/favicon.svg")
async def favicon():
    return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


# ---------- informations / profils ----------

@app.get("/api/info")
async def info():
    return {"orca_version": slicer.orca_version(), "default_machine": DEFAULT_MACHINE,
            "moonraker": (moonraker.RESOLVE() if moonraker.RESOLVE else moonraker.MOONRAKER_URL) or ""}


_SCHEMA_EN = None


def _schema_en():
    """Schéma en anglais : les libellés français viennent de la traduction d'Orca (fr/OrcaSlicer.mo) ; on retrouve
    l'original anglais par la même traduction, lue à l'envers."""
    global _SCHEMA_EN
    if _SCHEMA_EN is None:
        import gettext
        sch = json.loads(SCHEMA_PATH.read_text())
        rev = {}
        mo = Path(os.environ.get("ORCA_DIR", "/opt/orca")) / "resources" / "i18n" / "fr" / "OrcaSlicer.mo"
        try:
            with open(mo, "rb") as fh:
                cat = gettext.GNUTranslations(fh)._catalog
            for en, fr in cat.items():
                if isinstance(en, str) and isinstance(fr, str) and en and fr and fr not in rev:
                    rev[fr] = en
        except OSError:
            pass
        t = lambda x: rev.get(x, x) if isinstance(x, str) else x  # noqa: E731
        for o in sch["options"].values():
            for f in ("label", "full_label", "category", "tooltip", "sidetext"):
                if f in o:
                    o[f] = t(o[f])
            if "enum_labels" in o:
                o["enum_labels"] = [t(x) for x in o["enum_labels"]]
        for pages in sch["tabs"].values():
            for pg in pages:
                pg["title_fr"] = pg.get("title")
                for g in pg["groups"]:
                    g["title_fr"] = g.get("title")
        _SCHEMA_EN = sch
    return _SCHEMA_EN


@app.get("/api/schema")
async def schema(lang: str = "fr"):
    if not SCHEMA_PATH.exists():
        raise HTTPException(404, "schema.json absent (généré à la construction de l'image)")
    if lang == "en":
        return JSONResponse(await asyncio.to_thread(_schema_en), headers={"Cache-Control": "max-age=3600"})
    return FileResponse(SCHEMA_PATH, media_type="application/json", headers={"Cache-Control": "max-age=3600"})


@app.get("/api/profiles/machines")
async def machines():
    return await asyncio.to_thread(profiles.list_machines)


@app.get("/api/profiles/vendors")
async def vendor_list():
    return profiles.vendors()


@app.get("/api/profiles/processes")
async def processes(machine: str):
    return await asyncio.to_thread(profiles.list_processes, machine)


@app.get("/api/profiles/filaments")
async def filaments(machine: str):
    return await asyncio.to_thread(profiles.list_filaments, machine)


# Profils proposés dans les menus (comme « Sélectionner des filaments / imprimantes » d'Orca) : liste vide = tout afficher.
FAVS_FILES = {"filament": DATA_DIR / "filament_favorites.json", "machine": DATA_DIR / "machine_favorites.json"}


def _favs_read(kind):
    try:
        return {"names": json.loads(FAVS_FILES[kind].read_text()).get("names", [])}
    except (OSError, ValueError):
        return {"names": []}


async def _favs_write(kind, request):
    body = await request.json()
    names = body.get("names") if isinstance(body, dict) else None
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise HTTPException(400, "Liste de noms attendue")
    path = FAVS_FILES[kind]
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"names": sorted(set(names))}, ensure_ascii=False))
    tmp.replace(path)
    return {"names": sorted(set(names))}


@app.get("/api/filament-favorites")
async def filament_favorites():
    return _favs_read("filament")


@app.put("/api/filament-favorites")
async def filament_favorites_save(request: Request):
    return await _favs_write("filament", request)


@app.get("/api/machine-favorites")
async def machine_favorites():
    return _favs_read("machine")


@app.put("/api/machine-favorites")
async def machine_favorites_save(request: Request):
    return await _favs_write("machine", request)


@app.get("/api/profiles/{kind}/resolve")
async def resolve_profile(kind: str, name: str):
    if kind not in profiles.KINDS:
        raise HTTPException(404)
    try:
        cfg = await asyncio.to_thread(profiles.resolve, kind, name)
    except KeyError as e:
        raise HTTPException(404, str(e))
    user = profiles.load_user(kind, name)
    return {"name": name, "user": user is not None, "inherits": user["inherits"] if user else None,
            "settings": cfg}


class SaveProfile(BaseModel):
    name: str
    inherits: str
    settings: dict


@app.post("/api/profiles/{kind}")
async def save_profile(kind: str, body: SaveProfile):
    if kind not in profiles.KINDS:
        raise HTTPException(404)
    try:
        sys_names = profiles._instantiable()[kind]
    except Exception:
        sys_names = {}
    if body.name in sys_names:
        raise HTTPException(400, "Ce nom est celui d'un profil système, choisis-en un autre")
    return await asyncio.to_thread(profiles.save_user, kind, body.name, body.inherits, body.settings)


class FlushIn(BaseModel):
    machine: str
    filaments: list[str]
    colours: list[str]
    mixed: list[bool] = []


@app.post("/api/flush-matrix")
async def flush_matrix(body: FlushIn):
    """Volumes de purge recalculés comme le bouton « Auto-calc » d'Orca."""
    if len(body.filaments) != len(body.colours) or not body.filaments:
        raise HTTPException(400, "Filaments et couleurs incohérents")
    try:
        mcfg = await asyncio.to_thread(profiles.resolve, "machine", body.machine)
        fcfgs = [await asyncio.to_thread(profiles.resolve, "filament", f) for f in body.filaments]
    except KeyError as e:
        raise HTTPException(404, str(e))
    return {"matrix": await asyncio.to_thread(slicer.flush_matrix_for, mcfg, fcfgs, body.colours, body.mixed or None)}


_ID_KEY = {"process": "print_settings_id", "filament": "filament_settings_id", "machine": "printer_settings_id"}


@app.get("/api/profiles/{kind}/export")
async def export_profile(kind: str, name: str):
    """Profil utilisateur au format des préréglages d'OrcaSlicer (importable par Fichier > Importer > Configurations)."""
    if kind not in profiles.KINDS:
        raise HTTPException(404)
    u = profiles.load_user(kind, name)
    if not u:
        raise HTTPException(404, "Seuls les profils utilisateur s'exportent")
    data = {"name": u["name"], "inherits": u["inherits"], "from": "User", "is_custom_defined": "0",
            "version": slicer.orca_version() + ".0", _ID_KEY[kind]: u["name"], **u.get("settings", {})}
    fn = re.sub(r"[^\w .@()+-]", "_", u["name"]) + ".json"
    return Response(json.dumps(data, indent=4, ensure_ascii=False), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{fn}"'})


@app.post("/api/profiles/{kind}/import")
async def import_profile(kind: str, file: UploadFile = File(...)):
    """Importe un préréglage utilisateur exporté d'OrcaSlicer (.json)."""
    if kind not in profiles.KINDS:
        raise HTTPException(404)
    try:
        data = json.loads((await file.read()).decode("utf-8-sig"))
        assert isinstance(data, dict)
    except Exception:
        raise HTTPException(400, "Fichier illisible : un préréglage Orca au format .json est attendu")
    name = str(data.get("name") or Path(file.filename or "profil").stem)
    inherits = str(data.get("inherits") or "")
    other = [k for kk, k in _ID_KEY.items() if kk != kind and k in data and _ID_KEY[kind] not in data]
    if other:
        raise HTTPException(400, "Ce fichier est un préréglage d'un autre type (process, filament ou imprimante)")
    if not inherits:
        raise HTTPException(400, "Ce préréglage n'hérite d'aucun profil : import non pris en charge")
    try:
        await asyncio.to_thread(profiles.resolve, kind, inherits)
    except KeyError:
        raise HTTPException(400, f"Profil parent introuvable : {inherits}")
    if name in profiles._instantiable()[kind]:
        raise HTTPException(400, "Ce nom est celui d'un profil système")
    settings = {k: v for k, v in data.items() if k not in profiles.META_KEYS and k not in ("name", *_ID_KEY.values())}
    return await asyncio.to_thread(profiles.save_user, kind, name, inherits, settings)


@app.get("/api/profiles/{kind}/compare")
async def compare_profiles(kind: str, a: str, b: str):
    """Différences entre deux profils (valeurs résolues, comme la fenêtre « Comparer les préréglages » d'Orca)."""
    if kind not in profiles.KINDS:
        raise HTTPException(404)
    try:
        ca, cb = await asyncio.gather(asyncio.to_thread(profiles.resolve, kind, a), asyncio.to_thread(profiles.resolve, kind, b))
    except KeyError as e:
        raise HTTPException(404, str(e))
    skip = profiles.META_KEYS | {"name", "compatible_printers", "compatible_printers_condition", "compatible_prints",
                                 "compatible_prints_condition", *_ID_KEY.values()}
    diff = [{"key": k, "a": ca.get(k), "b": cb.get(k)} for k in sorted(set(ca) | set(cb)) if k not in skip and ca.get(k) != cb.get(k)]
    return {"a": a, "b": b, "diff": diff}


@app.delete("/api/profiles/{kind}")
async def delete_profile(kind: str, name: str):
    if not profiles.delete_user(kind, name):
        raise HTTPException(404)
    return {"ok": True}


@app.get("/api/profiles/machine/cover")
async def machine_cover(name: str):
    p = profiles.machine_cover(name)
    if not p:
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "max-age=86400"})


@app.get("/api/profiles/machine/bed/{which}")
async def machine_bed(which: str, name: str):
    if which not in ("model", "texture"):
        raise HTTPException(404)
    p = profiles.machine_bed(name, which)
    if not p:
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "max-age=86400"})


# ---------- modèles ----------

@app.post("/api/models")
async def upload_model(file: UploadFile = File(...)):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in models.ALLOWED:
        raise HTTPException(400, f"Format non pris en charge : {suffix or '?'}")
    models.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=models.MODELS_DIR, suffix=suffix)
    with os.fdopen(fd, "wb") as out:
        while chunk := await file.read(1 << 20):
            out.write(chunk)
    try:
        return await asyncio.to_thread(models.import_file, Path(tmp), file.filename)
    except Exception as e:
        Path(tmp).unlink(missing_ok=True)
        raise HTTPException(400, f"Import impossible : {e}")


@app.post("/api/import-project")
async def import_project(file: UploadFile = File(...)):
    """Ouvre un projet .3mf complet (réglages, objets, pièces spéciales, plateaux)."""
    if Path(file.filename or "").suffix.lower() != ".3mf":
        raise HTTPException(400, "Un fichier .3mf est attendu")
    models.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=models.MODELS_DIR, suffix=".3mf")
    with os.fdopen(fd, "wb") as out:
        while chunk := await file.read(1 << 20):
            out.write(chunk)
    try:
        return await asyncio.to_thread(models.import_project, Path(tmp), file.filename)
    except Exception as e:
        Path(tmp).unlink(missing_ok=True)
        raise HTTPException(400, f"Ouverture impossible : {e}")


@app.post("/api/models/{model_id}/split/{index}")
async def split_model(model_id: str, index: int):
    try:
        models.get_meta(model_id)
    except KeyError:
        raise HTTPException(404)
    try:
        return await asyncio.to_thread(models.split_mesh, model_id, index)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/models/{model_id}/repair/{index}")
async def repair_model(model_id: str, index: int):
    try:
        models.get_meta(model_id)
    except KeyError:
        raise HTTPException(404)
    try:
        return await asyncio.to_thread(models.repair_mesh, model_id, index)
    except Exception as e:
        raise HTTPException(400, f"Réparation impossible : {e}")


class CutIn(BaseModel):
    model_id: str
    index: int
    matrix: list[float]                  # matrice monde de l'objet (three.js, colonnes)
    point: list[float]                   # point du plan (repère du plateau)
    normal: list[float] = [0, 0, 1]
    options: dict = {}                   # keep_upper/lower, place_upper/lower, flip_upper/lower, connectors[]
    count: int = 0                       # section : nombre de connecteurs à placer automatiquement
    size: float = 2.5


def _world_mesh(body: CutIn):
    v, f = models.read_mesh(body.model_id, body.index)
    M = np.array(body.matrix, dtype=np.float64).reshape(4, 4).T
    return np.asarray(v, dtype=np.float64) @ M[:3, :3].T + M[:3, 3], np.asarray(f, dtype=np.int64), M


@app.post("/api/cut/section")
async def cut_section(body: CutIn):
    from . import cut as cutmod
    try:
        v, f, _ = _world_mesh(body)
        return await asyncio.to_thread(cutmod.section, v, f, body.point, body.normal, body.count, body.size)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/cut")
async def cut_object(body: CutIn):
    """Coupe comme l'outil Coupe d'Orca ; renvoie les nouveaux objets (maillages stockés dans un nouveau modèle)."""
    from . import cut as cutmod
    try:
        v, f, M = _world_mesh(body)
        if np.linalg.det(M[:3, :3]) < 0:
            f = f[:, ::-1]                # objet en miroir : faces retournées comme Orca (transform(..., true))
        res = await asyncio.to_thread(cutmod.cut, v, f, body.point, body.normal, body.options)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return await asyncio.to_thread(models.store_cut, res)


class OrientIn(BaseModel):
    model_id: str
    index: int
    parts: list[dict] = []             # pièces normales : {model_id, index, matrix (relative à l'objet)}
    overhang_angle: float = 30
    min_area: bool = True
    cooling_direction: list[float] | None = None


@app.post("/api/orient")
async def orient_object(body: OrientIn):
    """Orientation automatique d'Orca (Orient.cpp) ; renvoie la rotation à appliquer avant celle de l'objet."""
    from . import orient as orientmod
    try:
        v, f = models.read_mesh(body.model_id, body.index)
        vs, fs, off = [np.asarray(v, dtype=np.float64)], [np.asarray(f, dtype=np.int64)], len(v)
        for p in body.parts:
            pv, pf = models.read_mesh(p["model_id"], int(p["index"]))
            M = np.array(p["matrix"], dtype=np.float64).reshape(4, 4).T
            vs.append(np.asarray(pv, dtype=np.float64) @ M[:3, :3].T + M[:3, 3])
            fs.append(np.asarray(pf, dtype=np.int64) + off)
            off += len(pv)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404)
    R, best = await asyncio.to_thread(orientmod.orient, np.concatenate(vs), np.concatenate(fs), body.overhang_angle, body.min_area, body.cooling_direction)
    return {"rotation": np.asarray(R).tolist(), "orientation": best}


class BrimAutoIn(BaseModel):
    model_id: str
    index: int
    matrix: list[float]              # matrice monde de l'objet (colonne par colonne, comme three.js)
    parts: list[dict] = []           # [{model_id, index, matrix (relative à l'objet), subtype}]
    detection_radius: float = 1.0
    max_angle: float = 125.0


@app.post("/api/brim-ears/auto")
async def brim_ears_auto(body: BrimAutoIn):
    """Génération automatique des oreilles (GLGizmoBrimEars::auto_generate) ; points (x, y) dans le repère monde."""
    from . import brim
    try:
        W = np.array(body.matrix, dtype=np.float64).reshape(4, 4).T
        v, f = models.read_mesh(body.model_id, body.index)
        parts = [(np.asarray(v, dtype=np.float64) @ W[:3, :3].T + W[:3, 3], f, False)]
        for p in body.parts:
            if p.get("subtype") not in ("normal_part", "negative_part"):
                continue
            pv, pf = models.read_mesh(p["model_id"], int(p["index"]))
            M = W @ np.array(p["matrix"], dtype=np.float64).reshape(4, 4).T
            parts.append((np.asarray(pv, dtype=np.float64) @ M[:3, :3].T + M[:3, 3], pf, p.get("subtype") == "negative_part"))
    except (KeyError, FileNotFoundError):
        raise HTTPException(404)
    polys = await asyncio.to_thread(brim.first_layer, parts)
    pts = brim.auto_points(polys, body.detection_radius, body.max_angle)
    return {"points": pts, "detection_max": brim.detection_max(polys)}


class BoolVolume(BaseModel):
    model_id: str
    index: int
    matrix: list[float] | None = None     # relative à l'objet (None = maillage principal)


class BooleanIn(BaseModel):
    op: str                                # union | difference | intersection (GLGizmoMeshBoolean)
    a: BoolVolume
    b: BoolVolume


@app.post("/api/boolean")
async def mesh_boolean(body: BooleanIn):
    """Opération booléenne entre deux volumes d'un objet, dans le repère de l'objet (Orca : mcut, ici Manifold)."""
    if body.op not in ("union", "difference", "intersection"):
        raise HTTPException(400, "Opération inconnue")

    def load(vol):
        v, f = models.read_mesh(vol.model_id, vol.index)
        v = np.asarray(v, dtype=np.float64)
        f = np.asarray(f, dtype=np.int64)
        if vol.matrix:
            M = np.array(vol.matrix, dtype=np.float64).reshape(4, 4).T
            v = v @ M[:3, :3].T + M[:3, 3]
            if np.linalg.det(M[:3, :3]) < 0:
                f = f[:, ::-1]
        return v, f

    def run():
        import trimesh
        from manifold3d import Manifold, Mesh
        ms = []
        for vol in (body.a, body.b):
            v, f = load(vol)
            t = trimesh.Trimesh(v, f, process=True)
            m = Manifold(Mesh(vert_properties=np.ascontiguousarray(t.vertices, dtype=np.float32), tri_verts=np.ascontiguousarray(t.faces, dtype=np.uint32)))
            if m.is_empty():
                raise ValueError("Un des volumes n'est pas un solide fermé : répare-le d'abord (outil Réparer)")
            ms.append(m)
        a, b = ms
        r = a + b if body.op == "union" else a - b if body.op == "difference" else a ^ b
        mesh = r.to_mesh()
        v = np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3]
        f = np.asarray(mesh.tri_verts, dtype=np.int64)
        if not len(f):
            raise ValueError("Le résultat est vide (les volumes ne se touchent pas ?)")
        t = trimesh.Trimesh(v, f, process=True)       # sommets soudés (Manifold peut les dupliquer)
        return models.store_mesh(t.vertices, t.faces, f"booléen ({body.op})")
    try:
        return await asyncio.to_thread(run)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404)
    except ValueError as e:
        raise HTTPException(400, str(e))


class SimplifyIn(BaseModel):
    model_id: str
    index: int
    reduction: float = 0.5        # part des triangles retirés (0..0,99)


@app.post("/api/simplify")
async def simplify_mesh(body: SimplifyIn):
    """Réduction du nombre de triangles (outil Simplifier d'Orca : contraction d'arêtes quadrique).
    Orca utilise sa propre implémentation (QuadricEdgeCollapse.cpp) ; ici fast-simplification (même famille d'algorithme)."""
    def run():
        import fast_simplification
        import trimesh
        v, f = models.read_mesh(body.model_id, body.index)
        t = trimesh.Trimesh(np.asarray(v, dtype=np.float64), np.asarray(f, dtype=np.int64), process=True)
        r = min(max(float(body.reduction), 0.0), 0.99)
        if r <= 0:
            vs, fs = t.vertices, t.faces
        else:
            vs, fs = fast_simplification.simplify(np.ascontiguousarray(t.vertices, dtype=np.float32), np.ascontiguousarray(t.faces, dtype=np.int32), target_reduction=r)
        res = models.store_mesh(np.asarray(vs, dtype=np.float64), np.asarray(fs, dtype=np.int64), "simplifié")
        res["before"] = int(len(t.faces))
        return res
    try:
        return await asyncio.to_thread(run)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404)


@app.get("/api/textures")
async def textures_list():
    from . import texture
    return texture.list_textures()


@app.get("/api/textures/{name}")
async def texture_image(name: str):
    from . import texture
    try:
        return FileResponse(texture.texture_path(name), headers={"Cache-Control": "max-age=86400"})
    except ValueError:
        raise HTTPException(404)


class TextureIn(BaseModel):
    model_id: str
    index: int
    texture: str = ""              # texture d'Orca (nom), ou image fournie :
    image_b64: str = ""            # PNG / JPEG en base64 (texture personnelle)
    depth: float = 0.4             # TextureDisplacementLayer::depth_mm
    tile: float = 12.5             # tiling_scale (taille d'une tuile, mm)
    rotation: float = 0.0
    invert: bool = False
    midlevel: float = 0.0
    smoothing: float = 0.0
    zone: str = "all"              # all | sides | top
    keep_bottom: bool = True


@app.post("/api/texture")
async def texture_bake(body: TextureIn):
    """Applique une texture en relief au maillage (voir texture.py) ; renvoie un nouveau modèle."""
    import base64

    from . import texture
    if not (0.05 <= body.depth <= 5) or not (0.5 <= body.tile <= 500):
        raise HTTPException(400, "Profondeur (0,05–5 mm) ou taille de motif (0,5–500 mm) hors limites")
    try:
        data = base64.b64decode(body.image_b64) if body.image_b64 else texture.texture_path(body.texture).read_bytes()
        height = texture.load_height(data, body.smoothing)
        v, f = models.read_mesh(body.model_id, body.index)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404)
    except Exception as e:
        raise HTTPException(400, f"Texture illisible : {e}")

    def run():
        nv, nf = texture.displace(v, f, height, body.depth, body.tile, body.rotation, (0.0, 0.0), body.invert,
                                  body.midlevel, body.zone, body.keep_bottom)
        res = models.store_mesh(nv, nf, f"texture {body.texture or 'personnelle'}")
        res["before"] = int(len(f))
        return res
    return await asyncio.to_thread(run)


@app.get("/api/fonts")
async def font_list():
    from . import emboss
    return emboss.fonts()


class TextIn(BaseModel):
    text: str
    font: str = "DejaVuSans.ttf"
    size: float = 10.0          # FontProp::size_in_mm d'Orca
    depth: float = 1.0          # épaisseur (relief ou creux)
    char_gap: int = 0
    line_gap: int = 0


def _store_single(v, f, name, extra):
    import uuid as _uuid
    mid = _uuid.uuid4().hex[:12]
    d = models.MODELS_DIR / mid
    d.mkdir(parents=True)
    models._write_mesh(d / "mesh_0.bin", v, f)
    lo, hi = v.min(axis=0), v.max(axis=0)
    meta = {"id": mid, "file": name, "format": "emboss", "from_project": False, **extra,
            "objects": [{"index": 0, "name": name, "triangles": int(len(f)), "size": [round(x, 3) for x in (hi - lo)], "position": [0, 0, 0], "watertight": True}]}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    return meta


@app.post("/api/text")
async def text_mesh(body: TextIn):
    from . import emboss
    if not body.text.strip():
        raise HTTPException(400, "Texte vide")
    try:
        polys, _ = await asyncio.to_thread(emboss.text_polygons, body.text, body.font, body.size, body.char_gap, body.line_gap)
        v, f = await asyncio.to_thread(emboss.extrude, polys, body.depth)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _store_single(v, f, body.text.replace("\n", " ")[:40], {"text": body.model_dump()})


@app.post("/api/svg")
async def svg_mesh(file: UploadFile = File(...), width: float = 30.0, depth: float = 1.0):
    from . import emboss
    data = await file.read()
    try:
        polys = await asyncio.to_thread(emboss.svg_polygons, data, width)
        v, f = await asyncio.to_thread(emboss.extrude, polys, depth)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f"SVG illisible : {e}")
    return _store_single(v, f, Path(file.filename or "svg").stem[:40], {})


class LayerProfileIn(BaseModel):
    model_id: str = ""
    index: int = 0
    matrix: list[float] = []
    parts: list[dict] = []
    layer_height: float = 0.2
    first_layer: float = 0.2
    nozzle_min: float = 0.07
    nozzle_max: float = 0.0
    quality: float = 0.5
    profile: list[float] = []
    radius: int = 5
    keep_min: bool = False


def _lh_params(body: LayerProfileIn, height):
    from . import layerheight
    return layerheight.slicing_params(body.layer_height, body.first_layer, body.nozzle_min, body.nozzle_max, height)


@app.post("/api/layer-profile/adaptive")
async def layer_profile_adaptive(body: LayerProfileIn):
    """Profil adaptatif d'Orca (layer_height_profile_adaptive) pour un objet tel qu'il est posé sur le plateau."""
    from . import layerheight
    try:
        v, f = models.read_mesh(body.model_id, body.index)
        M = np.array(body.matrix, dtype=np.float64).reshape(4, 4).T
        vs, fs, off = [np.asarray(v, dtype=np.float64)], [np.asarray(f, dtype=np.int64)], len(v)
        for p in body.parts:
            pv, pf = models.read_mesh(p["model_id"], int(p["index"]))
            P = np.array(p["matrix"], dtype=np.float64).reshape(4, 4).T
            vs.append(np.asarray(pv, dtype=np.float64) @ P[:3, :3].T + P[:3, 3]); fs.append(np.asarray(pf, dtype=np.int64) + off); off += len(pv)
        v = np.concatenate(vs) @ M[:3, :3].T + M[:3, 3]
        f = np.concatenate(fs)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404)
    v[:, 2] -= v[:, 2].min()
    sp = _lh_params(body, float(v[:, 2].max()))
    prof = await asyncio.to_thread(layerheight.adaptive, v, f, sp, body.quality)
    return {"profile": prof, "params": sp}


@app.post("/api/layer-profile/smooth")
async def layer_profile_smooth(body: LayerProfileIn):
    from . import layerheight
    if len(body.profile) < 4:
        raise HTTPException(400, "Profil vide")
    sp = _lh_params(body, body.profile[-2])
    return {"profile": await asyncio.to_thread(layerheight.smooth, body.profile, sp, body.radius, body.keep_min)}


class CalibIn(BaseModel):
    machine: str
    process: str
    filament: str
    params: dict = {}


@app.post("/api/calib/{kind}")
async def calibration(kind: str, body: CalibIn):
    """Prépare une calibration d'Orca : modèle(s), réglages, G-code de couche et post-traitement."""
    from . import calib
    try:
        m = await asyncio.to_thread(profiles.resolve, "machine", body.machine)
        p = await asyncio.to_thread(profiles.resolve, "process", body.process)
        f = await asyncio.to_thread(profiles.resolve, "filament", body.filament)
    except KeyError as e:
        raise HTTPException(404, str(e))
    try:
        r = await asyncio.to_thread(calib.build, kind, body.params, m, p, f)
    except ValueError as e:
        raise HTTPException(400, str(e))
    import uuid as _uuid
    mid = _uuid.uuid4().hex[:12]
    d = models.MODELS_DIR / mid
    d.mkdir(parents=True)
    objs, metas = [], []
    for i, o in enumerate(r["objects"]):
        v = np.asarray(o["vertices"], dtype=np.float64)
        lo, hi = v.min(axis=0), v.max(axis=0)
        c = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])
        models._write_mesh(d / f"mesh_{i}.bin", v - c, o["faces"])
        metas.append({"index": i, "name": o["name"], "triangles": int(len(o["faces"])), "size": [round(x, 3) for x in (hi - lo)], "position": c.tolist(), "watertight": True})
        objs.append({"index": i, "name": o["name"], "settings": o["settings"], "center": c.tolist(), "abs_xy": o.get("abs_xy")})
    (d / "meta.json").write_text(json.dumps({"id": mid, "file": r["name"], "format": "calib", "from_project": False, "objects": metas}, ensure_ascii=False))
    return {"model_id": mid, "name": r["name"], "objects": objs, "process": r["process"], "filament": r["filament"], "machine": r["machine"],
            "layer_gcodes": r["layer_gcodes"], "post": r["post"]}


class PrimitiveIn(BaseModel):
    shape: str = "box"
    size: list[float] = [20, 20, 20]


@app.post("/api/models/primitive")
async def model_primitive(body: PrimitiveIn):
    if body.shape not in ("box", "cylinder", "sphere") or len(body.size) != 3 or min(body.size) <= 0:
        raise HTTPException(400, "Forme invalide")
    return await asyncio.to_thread(models.create_primitive, body.shape, body.size)


@app.get("/api/models")
async def model_list():
    return models.list_models()


@app.get("/api/models/{model_id}")
async def model_meta(model_id: str):
    try:
        return models.get_meta(model_id)
    except KeyError:
        raise HTTPException(404)


@app.get("/api/models/{model_id}/mesh/{index}")
async def model_mesh(model_id: str, index: int):
    try:
        models.get_meta(model_id)
    except KeyError:
        raise HTTPException(404)
    p = models.mesh_path(model_id, index)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="application/octet-stream", headers={"Cache-Control": "max-age=31536000, immutable"})


@app.get("/api/models/{model_id}/source")
async def model_source(model_id: str):
    try:
        meta = models.get_meta(model_id)
    except KeyError:
        raise HTTPException(404)
    p = next((models.MODELS_DIR / model_id).glob("source.*"))
    return FileResponse(p, filename=meta["file"])


# ---------- découpe ----------

class PartIn(BaseModel):
    model_id: str
    index: int
    name: str = ""
    matrix: list[float]
    subtype: str = "normal_part"   # normal_part, modifier_part, support_blocker, support_enforcer, negative_part
    extruder: int = 0
    settings: dict = {}
    paint: dict = {}               # {"supports"|"seam"|"color"|"fuzzy": {triangle: chaîne hexa d'Orca}}


class ObjectIn(BaseModel):
    model_id: str
    index: int
    name: str
    matrix: list[float]
    extruder: int = 1
    settings: dict = {}
    parts: list[PartIn] = []
    paint: dict = {}
    layer_profile: list[float] = []   # hauteur de couche variable [z0, h0, z1, h1, …]
    brim_points: list[list[float]] = []   # oreilles de bordure [[x, y, z, rayon], …] dans le repère de l'objet
    layer_ranges: list[dict] = []         # modificateurs par plage de hauteur [{min_z, max_z, settings}]


class SliceIn(BaseModel):
    post: dict | None = None       # calibration : post-traitement du G-code (rétraction, vitesse de paroi)
    machine: str
    process: str
    filaments: list[str]
    colours: list[str]
    objects: list[ObjectIn]
    overrides: dict = {}
    flush: list[str] | None = None
    plate_name: str = "Plateau 1"
    plate_index: int = 0         # plateau découpé (les objets sont dans la grille de plateaux d'Orca)
    plate_count: int = 1
    layer_gcodes: dict[str, list[dict]] = {}   # {index de plateau: [{z, type, extruder, color, extra}]}
    plate_settings: dict = {}      # réglages du plateau découpé (bed_type, print_sequence, spiral_mode…)


class PlateIn(BaseModel):
    name: str = ""
    objects: list[int] = []      # index dans ProjectIn.objects
    settings: dict = {}          # réglages du plateau (comme la boîte « Réglages du plateau » d'Orca)


class ProjectIn(SliceIn):
    plates: list[PlateIn] = []
    modified: dict = {}          # {"process": [clés], "machine": [clés], "filament": [[clés], ...]}
    name: str = "projet"


def _job_public(j):
    return {k: v for k, v in j.items() if not k.startswith("_")}


def _load_objects(objects):
    objs = []
    for o in objects:
        v, f = models.read_mesh(o.model_id, o.index)
        parts = []
        for p in o.parts:
            pv, pf = models.read_mesh(p.model_id, p.index)
            parts.append({"name": p.name or "pièce", "vertices": pv.tolist(), "faces": pf.tolist(),
                          "matrix": p.matrix, "subtype": p.subtype, "extruder": p.extruder,
                          "settings": p.settings, "paint": p.paint})
        objs.append({"name": o.name, "vertices": v.tolist(), "faces": f.tolist(), "matrix": o.matrix,
                     "extruder": o.extruder, "settings": o.settings, "parts": parts, "paint": o.paint,
                     "layer_profile": o.layer_profile, "brim_points": o.brim_points, "layer_ranges": o.layer_ranges})
    return objs


def _write_project(body: ProjectIn, path):
    """Projet .3mf complet (tous les plateaux), lisible par OrcaSlicer."""
    cfg = slicer.build_config(body.machine, body.process, body.filaments, body.colours, body.overrides, body.flush)
    n = len(body.filaments)
    mod = body.modified or {}
    fil = list(mod.get("filament") or [])
    cfg["different_settings_to_system"] = ([";".join(mod.get("process") or [])] +
                                           [";".join(fil[i]) if i < len(fil) else "" for i in range(n)] +
                                           [";".join(mod.get("machine") or [])])
    # profils utilisateur : Orca retrouve le profil système parent grâce à inherits_group
    inh = []
    for kind, name in [("process", body.process)] + [("filament", f) for f in body.filaments] + [("machine", body.machine)]:
        u = profiles.load_user(kind, name)
        inh.append(u.get("inherits", "") if u else "")
    cfg["inherits_group"] = inh
    plates = [{"name": p.name, "objects": p.objects, "settings": p.settings} for p in body.plates] or None
    slicer.write_3mf(path, _load_objects(body.objects), cfg, body.plate_name, plates, body.layer_gcodes)


@app.post("/api/project3mf")
async def project_3mf(body: ProjectIn):
    """Enregistre le projet courant en .3mf, sans découpe."""
    if not body.objects:
        raise HTTPException(400, "Le projet est vide")
    if len(body.filaments) != len(body.colours) or not body.filaments:
        raise HTTPException(400, "Filaments et couleurs incohérents")
    d = Path(tempfile.mkdtemp(dir=slicer.JOBS_DIR.parent if slicer.JOBS_DIR.parent.exists() else None))
    out = d / "projet.3mf"
    try:
        await asyncio.to_thread(_write_project, body, out)
    except Exception as e:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, f"Enregistrement impossible : {e}")
    data = out.read_bytes()
    shutil.rmtree(d, ignore_errors=True)
    name = re.sub(r"[^\w .()+-]", "_", body.name)[:80] or "projet"
    return Response(data, media_type="model/3mf", headers={"Content-Disposition": f'attachment; filename="{name}.3mf"'})


async def _do_slice(jid, job_dir, body: SliceIn):
    job = JOBS[jid]
    try:
        objs = await asyncio.to_thread(_load_objects, body.objects)
        cfg = await asyncio.to_thread(slicer.build_config, body.machine, body.process, body.filaments,
                                      body.colours, body.overrides, body.flush)
        project = job_dir / "plate.3mf"
        count = max(1, body.plate_count)
        pidx = min(max(0, body.plate_index), count - 1)
        plates = [{"name": body.plate_name if i == pidx else "", "objects": list(range(len(objs))) if i == pidx else [],
                   "settings": body.plate_settings if i == pidx else {}} for i in range(count)]
        lg = {k: v for k, v in (body.layer_gcodes or {}).items() if str(k) == str(pidx)}
        await asyncio.to_thread(slicer.write_3mf, project, objs, cfg, body.plate_name, plates, lg)
        job["state"] = "slicing"
        gcode, info = await slicer.run_slice(job_dir, project, pidx + 1)
        if body.post:
            from . import calib
            await asyncio.to_thread(calib.post_process, gcode, body.post)
        stats = await asyncio.to_thread(slicer.gcode_stats, gcode)
        name = re.sub(r"[^\w.+-]", "_", (body.objects[0].name if body.objects else "plateau"))[:60]
        final = job_dir / f"{name}_{jid}.gcode"
        gcode.replace(final)
        job.update(state="done", stats=stats, gcode=final.name, info=info, finished=time.time())
        job["_gcode"] = str(final)
        job["_plate"] = pidx + 1
    except Exception as e:
        job.update(state="error", error=str(e), finished=time.time())


class ArrangeIn(SliceIn):
    rotate: bool = False


@app.post("/api/arrange")
async def arrange_plate(body: ArrangeIn):
    """Disposition par le vrai moteur d'Orca (ligne de commande --arrange 1, libnest2d) ; objets en coordonnées du plateau.
    Renvoie pour chaque objet sa nouvelle matrice et le plateau (0 = celui-ci, 1… = plateaux supplémentaires créés par Orca)."""
    import re as _re
    import zipfile
    from . import brim as brimmod
    if not body.objects:
        raise HTTPException(400, "Le plateau est vide")
    cfg = slicer.build_config(body.machine, body.process, body.filaments, body.colours, body.overrides, body.flush)
    objs = _load_objects(body.objects)
    d = Path(tempfile.mkdtemp(dir=slicer.JOBS_DIR.parent))
    try:
        await asyncio.to_thread(slicer.write_3mf, d / "in.3mf", objs, cfg, body.plate_name)
        cmd = ["xvfb-run", "-a", str(slicer.ORCA_BIN), "--datadir", str(slicer.ORCA_DATADIR), "--allow-newer-file",
               "--arrange", "1"] + (["--allow-rotations"] if body.rotate else []) + ["--export-3mf", str(d / "out.3mf"), str(d / "in.3mf")]
        proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(d), env=dict(os.environ, HOME=str(slicer.DATA_DIR), XDG_RUNTIME_DIR="/tmp"),
                                                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        await asyncio.wait_for(proc.wait(), timeout=120)
        if not (d / "out.3mf").exists():
            raise HTTPException(500, "Orca n'a pas pu disposer le plateau")
        with zipfile.ZipFile(d / "out.3mf") as z:
            model = z.read("3D/3dmodel.model").decode("utf-8", "replace")
            settings = z.read("Metadata/model_settings.config").decode("utf-8", "replace")
    finally:
        shutil.rmtree(d, ignore_errors=True)
    items = [[float(x) for x in t.split()] for t in _re.findall(r'<item [^>]*?transform="([^"]*)"', model)]
    ids = _re.findall(r'<item objectid="(\d+)"', model)
    plate_of, cur = {}, 0
    for m in _re.finditer(r'plater_id" value="(\d+)"|object_id" value="(\d+)"', settings):
        if m.group(1):
            cur = int(m.group(1)) - 1
        else:
            plate_of[m.group(2)] = cur
    out = []
    for i, o in enumerate(objs):
        if i >= len(items):
            break
        t = items[i]
        T = np.eye(4)
        T[:3, 0], T[:3, 1], T[:3, 2], T[:3, 3] = t[0:3], t[3:6], t[6:9], t[9:12]
        # repère d'Orca recentré pour un objet à un seul volume (voir brim.orca_frame_shift)
        c = brimmod.orca_frame_shift(o["vertices"], 1 + len(o.get("parts") or []))
        S = np.eye(4)
        S[:3, 3] = -c
        M = T @ S
        out.append({"matrix": M.T.flatten().tolist(), "plate": plate_of.get(ids[i] if i < len(ids) else "", 0)})
    return {"objects": out}


@app.post("/api/export-stl")
async def export_stl(body: SliceIn):
    """Exporte les objets (maillage principal et pièces normales) en un STL binaire, repère du plateau."""
    import struct

    def run():
        tris = []
        for o in body.objects:
            M = np.array(o.matrix, dtype=np.float64).reshape(4, 4).T
            v, f = models.read_mesh(o.model_id, o.index)
            vols = [(np.asarray(v, dtype=np.float64), np.asarray(f, dtype=np.int64), np.eye(4))]
            for pt in o.parts:
                if pt.subtype == "normal_part":
                    pv, pf = models.read_mesh(pt.model_id, pt.index)
                    vols.append((np.asarray(pv, dtype=np.float64), np.asarray(pf, dtype=np.int64), np.array(pt.matrix, dtype=np.float64).reshape(4, 4).T))
            for vv, ff, P in vols:
                W = M @ P
                w = vv @ W[:3, :3].T + W[:3, 3]
                if np.linalg.det(W[:3, :3]) < 0:
                    ff = ff[:, ::-1]
                tris.append(w[ff])
        t = np.concatenate(tris).astype(np.float32)
        n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-20)
        rec = np.zeros(len(t), dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", 9), ("a", "<u2")]))
        rec["n"], rec["v"] = n, t.reshape(-1, 9)
        return b"PrintLab Slicer STL".ljust(80, b" ") + struct.pack("<I", len(t)) + rec.tobytes()
    try:
        data = await asyncio.to_thread(run)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404)
    name = re.sub(r"[^\w.+-]", "_", body.plate_name or "plateau")[:60] or "plateau"
    return Response(data, media_type="model/stl", headers={"Content-Disposition": f'attachment; filename="{name}.stl"'})


@app.post("/api/slice")
async def slice_plate(body: SliceIn):
    if not body.objects:
        raise HTTPException(400, "Le plateau est vide")
    if len(body.filaments) != len(body.colours) or not body.filaments:
        raise HTTPException(400, "Filaments et couleurs incohérents")
    for o in body.objects:
        if o.extruder < 1 or o.extruder > len(body.filaments):
            raise HTTPException(400, f"Filament {o.extruder} invalide pour l'objet {o.name}")
    jid, job_dir = slicer.new_job_dir()
    JOBS[jid] = {"id": jid, "state": "preparing", "created": time.time(), "machine": body.machine,
                 "process": body.process, "filaments": body.filaments, "colours": body.colours,
                 "_dir": str(job_dir)}
    (job_dir / "request.json").write_text(body.model_dump_json())
    asyncio.create_task(_do_slice(jid, job_dir, body))
    return {"id": jid}


def _job(jid):
    j = JOBS.get(jid)
    if not j:
        d = slicer.JOBS_DIR / jid
        if not re.fullmatch(r"[\w-]+", jid) or not d.is_dir():
            raise HTTPException(404, "Tâche inconnue")
        g = next(d.glob("*.gcode"), None)
        j = {"id": jid, "state": "done" if g else "error", "_dir": str(d)}
        if g:
            j.update(gcode=g.name, _gcode=str(g), stats=slicer.gcode_stats(g))
        JOBS[jid] = j
    return j


@app.get("/api/jobs/{jid}")
async def job_status(jid: str):
    return _job_public(_job(jid))


@app.get("/api/jobs/{jid}/gcode")
async def job_gcode(jid: str, download: bool = False):
    j = _job(jid)
    if j.get("state") != "done":
        raise HTTPException(409, "Découpe non terminée")
    return FileResponse(j["_gcode"], media_type="text/plain", filename=j["gcode"] if download else None)


@app.get("/api/jobs/{jid}/project")
async def job_project(jid: str):
    j = _job(jid)
    p = Path(j["_dir"]) / "plate.3mf"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, filename=f"plateau_{jid}.3mf")


@app.get("/api/jobs/{jid}/log")
async def job_log(jid: str):
    p = Path(_job(jid)["_dir"]) / "slice.log"
    return Response(p.read_text() if p.exists() else "", media_type="text/plain")


class PrintIn(BaseModel):
    start: bool = True
    queue: bool = False            # ajouter à la file d'attente de Moonraker au lieu de lancer
    thumbnails: list[dict] = []   # [{w, h, data(base64 png)}]
    filename: str | None = None
    mapping: dict[int, int] = {}   # outil du G-code → emplacement de la Box (0-15, 16 = bobine externe)


@app.post("/api/jobs/{jid}/print")
async def job_print(jid: str, body: PrintIn):
    j = _job(jid)
    if j.get("state") != "done":
        raise HTTPException(409, "Découpe non terminée")
    gpath = Path(j["_gcode"])
    if body.thumbnails and not j.get("_thumbs"):
        await asyncio.to_thread(slicer.inject_thumbnails, gpath, body.thumbnails)
        j["_thumbs"] = True
    fname = body.filename or j["gcode"]
    fname = re.sub(r"\.(gcode\.3mf|gcode|3mf)$", "", fname)
    fname = re.sub(r"[^\w.+-]", "_", fname) + ".gcode.3mf"
    # format Orca / QIDI Studio : c'est lui que l'écran de l'imprimante sait afficher (aperçu, filaments)
    pkg = Path(j["_dir"]) / "print.gcode.3mf"
    await asyncio.to_thread(slicer.package_gcode_3mf, Path(j["_dir"]), gpath, body.thumbnails, j.get("_plate", 1),
                            j.get("stats") or {}, pkg)
    mapping = None
    if body.start or body.queue:
        tools = [t for t in await asyncio.to_thread(moonraker.tools_used, gpath) if t < 16]
        try:
            mapping = await moonraker.sync_tool_mapping(tools, body.mapping)
        except Exception as e:
            raise HTTPException(409, f"Association des bobines impossible ({e}) : impression non lancée")
    try:
        res = await moonraker.upload_and_print(pkg, fname, body.start and not body.queue)
        if body.queue:
            await moonraker.queue_add(fname)
    except Exception as e:
        raise HTTPException(502, f"Envoi à l'imprimante impossible : {e}")
    return {"ok": True, "filename": fname, "started": body.start and not body.queue, "queued": body.queue, "mapping": mapping, "moonraker": res}


@app.get("/api/printer-queue")
async def printer_queue():
    try:
        return await moonraker.queue_status()
    except Exception as e:
        raise HTTPException(502, str(e))


@app.delete("/api/printer-queue/{job_id}")
async def printer_queue_remove(job_id: str):
    return await moonraker.queue_remove(job_id)


@app.post("/api/printer-queue/{what}")
async def printer_queue_control(what: str):
    if what not in ("start", "pause"):
        raise HTTPException(404)
    return await moonraker.queue_control(what)


# ---------- projets (plateaux enregistrés, partagés entre utilisateurs) ----------

def _project_path(name):
    safe = re.sub(r"[^\w .()+-]", "_", name).strip()[:80]
    if not safe:
        raise HTTPException(400, "Nom invalide")
    return PROJECTS_DIR / f"{safe}.json"


@app.get("/api/projects")
async def project_list():
    if not PROJECTS_DIR.is_dir():
        return []
    out = []
    for p in sorted(PROJECTS_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        out.append({"name": p.stem, "modified": p.stat().st_mtime})
    return out


@app.get("/api/projects/{name}")
async def project_get(name: str):
    p = _project_path(name)
    if not p.exists():
        raise HTTPException(404)
    return json.loads(p.read_text())


@app.put("/api/projects/{name}")
async def project_put(name: str, request: Request):
    data = await request.json()
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    _project_path(name).write_text(json.dumps(data, ensure_ascii=False))
    return {"ok": True}


@app.delete("/api/projects/{name}")
async def project_delete(name: str):
    p = _project_path(name)
    p.unlink(missing_ok=True)
    return {"ok": True}


# ---------- imprimante ----------

@app.get("/api/printer/status")
async def printer_status():
    try:
        return await moonraker.status()
    except Exception as e:
        raise HTTPException(502, f"Imprimante injoignable : {e}")


@app.post("/api/printer/{name}")
async def printer_action(name: str):
    if name not in ("pause", "resume", "cancel", "emergency_stop", "firmware_restart"):
        raise HTTPException(404)
    try:
        return {"ok": True, "result": await moonraker.action(name)}
    except Exception as e:
        raise HTTPException(502, str(e))


class GcodeIn(BaseModel):
    script: str


@app.post("/api/printer-gcode")
async def printer_gcode(body: GcodeIn):
    try:
        return {"ok": True, "result": await moonraker.gcode(body.script)}
    except Exception as e:
        raise HTTPException(502, str(e))


@app.get("/api/printer-console")
async def printer_console(count: int = 50):
    try:
        return await moonraker.gcode_store(count)
    except Exception as e:
        raise HTTPException(502, str(e))


@app.get("/api/printer-files")
async def printer_files():
    try:
        return await moonraker.files()
    except Exception as e:
        raise HTTPException(502, str(e))


class StartFileIn(BaseModel):
    filename: str


@app.post("/api/printer-files/start")
async def printer_start_file(body: StartFileIn):
    try:
        return {"ok": True, "result": await moonraker.start_file(body.filename)}
    except Exception as e:
        raise HTTPException(502, str(e))


@app.get("/api/printer-history")
async def printer_history():
    try:
        return await moonraker.history()
    except Exception as e:
        raise HTTPException(502, str(e))


@app.get("/api/printer-thumbnail")
async def printer_thumbnail(path: str):
    try:
        data, ctype = await moonraker.fetch_raw("/server/files/gcodes/" + path.lstrip("/"))
    except Exception:
        raise HTTPException(404)
    return Response(data, media_type=ctype, headers={"Cache-Control": "max-age=3600"})


@app.get("/api/webcam/snapshot")
async def webcam_snapshot():
    try:
        cams = await moonraker.webcams()
        url = cams[0]["snapshot_url"] if cams else "/webcam/?action=snapshot"
        data, ctype = await moonraker.fetch_raw(url)
    except Exception as e:
        raise HTTPException(502, str(e))
    return Response(data, media_type=ctype, headers={"Cache-Control": "no-store"})


@app.get("/api/webcam/stream")
async def webcam_stream():
    try:
        cams = await moonraker.webcams()
        url = cams[0]["stream_url"] if cams else "/webcam/?action=stream"
        client, resp = await moonraker.stream_raw(url)
    except Exception as e:
        raise HTTPException(502, str(e))

    async def gen():
        try:
            async for chunk in resp.aiter_raw():
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(gen(), media_type=resp.headers.get("content-type", "multipart/x-mixed-replace"),
                             headers={"Cache-Control": "no-store"})


# ---------- API simplifiée pour l'assistant (découpe + impression en un appel) ----------

class AgentPrintIn(BaseModel):
    model_ids: list[str]
    machine: str | None = None
    process: str | None = None
    filaments: list[str] | None = None
    colours: list[str] | None = None
    extruders: list[int] | None = None
    overrides: dict = {}
    start: bool = False


@app.post("/api/agent/slice")
async def agent_slice(body: AgentPrintIn):
    """Place les modèles en ligne au centre du plateau, découpe, et envoie si start=True."""
    machine = body.machine or DEFAULT_MACHINE
    mcfg = profiles.resolve("machine", machine)
    process = body.process or mcfg.get("default_print_profile")
    fil = body.filaments or [profiles.list_filaments(machine)[0]["name"]]
    cols = body.colours or ["#FFFFFF"] * len(fil)
    pts = [tuple(map(float, p.split("x"))) for p in mcfg.get("printable_area", ["0x0", "200x200"])]
    cx = (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2
    cy = (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2
    objs, items = [], []
    for mid in body.model_ids:
        meta = models.get_meta(mid)
        for o in meta["objects"]:
            items.append((mid, o))
    total_w = sum(o["size"][0] + 10 for _, o in items) - 10
    x = cx - total_w / 2
    for k, (mid, o) in enumerate(items):
        ox = x + o["size"][0] / 2
        x += o["size"][0] + 10
        ext = (body.extruders[k] if body.extruders and k < len(body.extruders) else 1)
        objs.append(ObjectIn(model_id=mid, index=o["index"], name=o["name"],
                             matrix=[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ox, cy, 0, 1], extruder=ext))
    req = SliceIn(machine=machine, process=process, filaments=fil, colours=cols, objects=objs,
                  overrides=body.overrides)
    res = await slice_plate(req)
    jid = res["id"]
    while JOBS[jid]["state"] not in ("done", "error"):
        await asyncio.sleep(0.5)
    j = JOBS[jid]
    if j["state"] == "error":
        raise HTTPException(500, j.get("error"))
    out = _job_public(j)
    if body.start:
        out["print"] = await job_print(jid, PrintIn(start=True))
    return out


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
