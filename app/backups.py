"""Sauvegardes des fichiers de l'imprimante (config Klipper/Moonraker, macros, Box...) dans PrintLab.

SÉCURITÉ IMPRIMANTE : lecture seule. Ce module ne fait que des GET sur Moonraker
(/server/files/list, /server/files/config/<fichier>, /server/database/item). Il n'écrit, ne modifie et ne supprime
rien sur l'imprimante. La restauration se fait à la main (téléchargement du fichier ou du ZIP).

Stockage : instantanés (table backup_snapshots / backup_files) + contenus dédupliqués par SHA-256 dans
DATA_DIR/backups/blobs/. Un fichier inchangé n'est stocké qu'une fois, quel que soit le nombre d'instantanés.
"""
import asyncio
import difflib
import hashlib
import io
import json
import time
import zipfile
from pathlib import Path
from urllib.parse import quote

import httpx

from . import db

MAX_FILE = 2_000_000                     # on ignore les fichiers de plus de 2 Mo (aucun fichier de config n'approche)
DB_NAMESPACES = ("fluidd", "moonraker", "webcams", "timelapse")   # réglages de l'interface, lisibles en JSON
AUTO_EVERY_S = 3600
KEEP_AUTO = 60                           # nombre d'instantanés automatiques conservés (les manuels sont gardés)
DBPREFIX = "_moonraker_database/"


def blob_path(sha):
    return db.DATA_DIR / "backups" / "blobs" / sha[:2] / sha


class Backups:
    def __init__(self, conn, rows, row, moonraker_url, now_iso):
        self.db, self.rows, self.row, self.url, self.now = conn, rows, row, moonraker_url, now_iso
        self.lock = asyncio.Lock()

    # ---------- lecture de l'imprimante (GET uniquement) ----------
    async def fetch_live(self):
        base = self.url()
        if not base:
            raise RuntimeError("Imprimante non configurée (Paramètres → Imprimante)")
        out = {}
        sem = asyncio.Semaphore(4)
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(base + "/server/files/list", params={"root": "config"})
            r.raise_for_status()
            files = [f for f in r.json()["result"] if f.get("size", 0) <= MAX_FILE]

            async def get(path):
                async with sem:
                    rr = await c.get(base + "/server/files/config/" + quote(path))
                    rr.raise_for_status()
                    out[path] = rr.content

            async def get_db(ns):
                async with sem:
                    rr = await c.get(base + "/server/database/item", params={"namespace": ns})
                    if rr.status_code == 200:
                        val = rr.json()["result"].get("value")
                        out[f"{DBPREFIX}{ns}.json"] = json.dumps(val, indent=2, ensure_ascii=False, sort_keys=True).encode()

            await asyncio.gather(*[get(f["path"]) for f in files], *[get_db(n) for n in DB_NAMESPACES])
        return out

    async def fetch_one(self, path):
        """Contenu actuel d'un fichier de l'imprimante (pour comparer)."""
        base = self.url()
        if ".." in path.split("/") or path.startswith("/"):
            raise ValueError("Chemin invalide")
        async with httpx.AsyncClient(timeout=20) as c:
            if path.startswith(DBPREFIX):
                ns = path[len(DBPREFIX):-5]
                rr = await c.get(base + "/server/database/item", params={"namespace": ns})
                rr.raise_for_status()
                return json.dumps(rr.json()["result"].get("value"), indent=2, ensure_ascii=False, sort_keys=True).encode()
            rr = await c.get(base + "/server/files/config/" + quote(path))
            if rr.status_code == 404:
                return None
            rr.raise_for_status()
            return rr.content

    # ---------- instantanés ----------
    def _files(self, sid):
        return {r["path"]: r for r in self.rows("SELECT path, sha, size FROM backup_files WHERE snapshot_id=?", (sid,))}

    def latest(self):
        return self.row("SELECT * FROM backup_snapshots ORDER BY id DESC LIMIT 1")

    async def snapshot(self, label="", auto=False):
        async with self.lock:
            live = await self.fetch_live()
            shas = {p: hashlib.sha256(b).hexdigest() for p, b in live.items()}
            last = self.latest()
            prev = self._files(last["id"]) if last else {}
            changed = sum(1 for p, s in shas.items() if p not in prev or prev[p]["sha"] != s) + sum(1 for p in prev if p not in shas)
            if auto and last and changed == 0:
                return None
            for p, b in live.items():
                bp = blob_path(shas[p])
                if not bp.exists():
                    bp.parent.mkdir(parents=True, exist_ok=True)
                    bp.write_bytes(b)
            cur = self.db.execute("INSERT INTO backup_snapshots(ts,label,auto,nfiles,changed,total_size) VALUES(?,?,?,?,?,?)",
                                  (self.now(), (label or "").strip()[:80], 1 if auto else 0, len(live), changed if last else len(live),
                                   sum(len(b) for b in live.values())))
            sid = cur.lastrowid
            self.db.executemany("INSERT INTO backup_files(snapshot_id,path,sha,size) VALUES(?,?,?,?)",
                                [(sid, p, shas[p], len(live[p])) for p in live])
            self.db.commit()
            self.prune()
            return self.row("SELECT * FROM backup_snapshots WHERE id=?", (sid,))

    def prune(self):
        old = self.rows("SELECT id FROM backup_snapshots WHERE auto=1 ORDER BY id DESC LIMIT -1 OFFSET ?", (KEEP_AUTO,))
        for r in old:
            self.delete(r["id"], commit=False)
        self.db.commit()

    def delete(self, sid, commit=True):
        self.db.execute("DELETE FROM backup_files WHERE snapshot_id=?", (sid,))
        self.db.execute("DELETE FROM backup_snapshots WHERE id=?", (sid,))
        if commit:
            self.db.commit()
        used = {r["sha"] for r in self.rows("SELECT DISTINCT sha FROM backup_files")}
        root = db.DATA_DIR / "backups" / "blobs"
        if root.exists():
            for f in root.glob("*/*"):
                if f.name not in used:
                    f.unlink(missing_ok=True)

    def listing(self):
        return self.rows("SELECT * FROM backup_snapshots ORDER BY id DESC")

    def detail(self, sid):
        """Fichiers d'un instantané avec leur statut par rapport à l'instantané précédent."""
        snap = self.row("SELECT * FROM backup_snapshots WHERE id=?", (sid,))
        if not snap:
            return None
        cur = self._files(sid)
        p = self.row("SELECT id FROM backup_snapshots WHERE id<? ORDER BY id DESC LIMIT 1", (sid,))
        prev = self._files(p["id"]) if p else {}
        files = []
        for path in sorted(cur):
            st = "nouveau" if path not in prev else ("modifié" if prev[path]["sha"] != cur[path]["sha"] else "identique")
            files.append({"path": path, "size": cur[path]["size"], "status": st if p else "nouveau"})
        removed = [{"path": x, "size": prev[x]["size"], "status": "supprimé"} for x in sorted(prev) if x not in cur]
        return {"snapshot": snap, "previous": p["id"] if p else None, "files": files, "removed": removed}

    def content(self, sid, path):
        r = self.row("SELECT sha FROM backup_files WHERE snapshot_id=? AND path=?", (sid, path))
        if not r:
            return None
        bp = blob_path(r["sha"])
        return bp.read_bytes() if bp.exists() else None

    async def diff(self, sid, path, against):
        """against : 'prev' (instantané précédent), 'live' (imprimante maintenant) ou l'identifiant d'un autre instantané."""
        a = self.content(sid, path)
        if against == "live":
            b, lb = await self.fetch_one(path), "imprimante (maintenant)"
        elif against == "prev":
            p = self.row("SELECT id FROM backup_snapshots WHERE id<? ORDER BY id DESC LIMIT 1", (sid,))
            if not p:
                return {"same": False, "diff": "", "note": "Aucun instantané précédent."}
            a, b, lb = self.content(p["id"], path), a, f"instantané #{sid}"
            return self._udiff(a, b, f"instantané #{p['id']}", lb, path)
        else:
            b, lb = self.content(int(against), path), f"instantané #{int(against)}"
        return self._udiff(a, b, f"instantané #{sid}", lb, path)

    @staticmethod
    def _udiff(a, b, la, lb, path):
        if a is None and b is None:
            return {"same": True, "diff": "", "note": "Fichier absent des deux côtés."}
        ta = (a or b"").decode("utf-8", "replace").splitlines()
        tb = (b or b"").decode("utf-8", "replace").splitlines()
        d = list(difflib.unified_diff(ta, tb, f"{path} ({la})" + ("" if a is not None else " — absent"),
                                      f"{path} ({lb})" + ("" if b is not None else " — absent"), lineterm="", n=3))
        return {"same": a == b, "diff": "\n".join(d[:4000]), "note": "Identique." if a == b else None}

    def zip_snapshot(self, sid):
        snap = self.row("SELECT * FROM backup_snapshots WHERE id=?", (sid,))
        if not snap:
            return None
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for path in sorted(self._files(sid)):
                data = self.content(sid, path)
                if data is not None:
                    z.writestr(path, data)
        return buf.getvalue()

    async def run(self):
        await asyncio.sleep(90)
        while True:
            try:
                await self.snapshot(label="automatique", auto=True)
            except Exception:
                pass
            await asyncio.sleep(AUTO_EVERY_S)
