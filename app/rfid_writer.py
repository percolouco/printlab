"""Lecteurs / encodeurs d'étiquettes MIFARE Classic pour la QIDI Box.

Réglage « rfid_writer » de PrintLab :
  ""                 aucun lecteur
  "pcsc"             lecteur USB PC/SC branché sur le serveur (ACR122U…), via pyscard
  "http://adresse"   module ESP32 + PN532 sur le réseau (API ci-dessous)
  "mock"             étiquette simulée (tests)

API attendue d'un module réseau (JSON) :
  GET  /status  → {"ok": true, "card": bool, "uid": "hex"}
  POST /read    {"block": 4, "keys": ["D3F7…", "FFFF…"]}            → {"ok": true, "uid": "hex", "data": "32 hex"}
  POST /write   {"block": 4, "keys": [...], "data": "32 hex"}      → {"ok": true, "uid": "hex"}
"""
import asyncio
import json
from pathlib import Path

import httpx

from .rfid import BLOCK, KEYS


class WriterError(Exception):
    pass


class MockWriter:
    name = "Étiquette simulée"

    def __init__(self, path: Path):
        self.path = path

    async def status(self):
        return {"ok": True, "card": True, "uid": "04A1B2C3", "name": self.name}

    async def read(self):
        try:
            data = json.loads(self.path.read_text()).get("data", "00" * 16)
        except (OSError, ValueError):
            data = "00" * 16
        return {"uid": "04A1B2C3", "data": bytes.fromhex(data)}

    async def write(self, data: bytes):
        self.path.write_text(json.dumps({"data": data.hex()}))
        return {"uid": "04A1B2C3"}


class HttpWriter:
    def __init__(self, url):
        self.url = url.rstrip("/")
        self.name = "Module réseau " + self.url

    async def _call(self, method, path, body=None):
        try:
            async with httpx.AsyncClient(timeout=8) as c:
                r = await (c.get(self.url + path) if method == "GET" else c.post(self.url + path, json=body))
                r.raise_for_status()
                j = r.json()
        except httpx.HTTPError as e:
            raise WriterError(f"Module RFID injoignable ({self.url}) : {e}") from e
        if not j.get("ok", False):
            raise WriterError(j.get("error") or "Le module RFID a refusé l'opération")
        return j

    async def status(self):
        try:
            j = await self._call("GET", "/status")
        except WriterError as e:
            return {"ok": False, "error": str(e), "name": self.name}
        return {"ok": True, "card": bool(j.get("card")), "uid": j.get("uid"), "name": self.name}

    async def read(self):
        j = await self._call("POST", "/read", {"block": BLOCK, "keys": list(KEYS)})
        return {"uid": j.get("uid"), "data": bytes.fromhex(j["data"])}

    async def write(self, data: bytes):
        j = await self._call("POST", "/write", {"block": BLOCK, "keys": list(KEYS), "data": data.hex()})
        return {"uid": j.get("uid")}


class PcscWriter:
    """ACR122U et lecteurs PC/SC compatibles (commandes « pseudo-APDU » FF xx du standard PC/SC partie 3)."""
    name = "Lecteur USB (PC/SC)"

    def _conn(self):
        try:
            import sys
            if "/usr/lib/python3/dist-packages" not in sys.path:   # paquet Ubuntu python3-pyscard (pas de roue pip)
                sys.path.append("/usr/lib/python3/dist-packages")
            from smartcard.System import readers
        except ImportError as e:
            raise WriterError("Pilote PC/SC absent (pyscard / pcscd)") from e
        try:
            rs = readers()
        except Exception as e:
            raise WriterError("Service PC/SC indisponible : pcscd doit tourner sur le serveur (socket /run/pcscd monté dans le conteneur)") from e
        if not rs:
            raise WriterError("Aucun lecteur USB détecté")
        self.name = str(rs[0])
        c = rs[0].createConnection()
        try:
            c.connect()
        except Exception as e:
            raise WriterError("Pose l'étiquette sur le lecteur") from e
        return c

    @staticmethod
    def _tx(c, apdu, what):
        data, sw1, sw2 = c.transmit(apdu)
        if (sw1, sw2) != (0x90, 0x00):
            raise WriterError(f"{what} : refus du lecteur ({sw1:02X}{sw2:02X})")
        return bytes(data)

    def _auth(self, c):
        for k in KEYS:
            self._tx(c, [0xFF, 0x82, 0x00, 0x00, 0x06] + list(bytes.fromhex(k)), "Chargement de la clé")
            try:
                self._tx(c, [0xFF, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, BLOCK, 0x60, 0x00], "Authentification")
                return
            except WriterError:
                continue
        raise WriterError("Étiquette refusée : ce n'est pas une MIFARE Classic 1K ou ses clés ont été changées")

    def _uid(self, c):
        return self._tx(c, [0xFF, 0xCA, 0x00, 0x00, 0x00], "Lecture de l'UID").hex().upper()

    def _read_sync(self):
        c = self._conn()
        try:
            uid = self._uid(c)
            self._auth(c)
            return {"uid": uid, "data": self._tx(c, [0xFF, 0xB0, 0x00, BLOCK, 0x10], "Lecture")}
        finally:
            c.disconnect()

    def _write_sync(self, data):
        c = self._conn()
        try:
            uid = self._uid(c)
            self._auth(c)
            self._tx(c, [0xFF, 0xD6, 0x00, BLOCK, 0x10] + list(data), "Écriture")
            if self._tx(c, [0xFF, 0xB0, 0x00, BLOCK, 0x10], "Relecture") != bytes(data):
                raise WriterError("Relecture différente de ce qui a été écrit")
            return {"uid": uid}
        finally:
            c.disconnect()

    async def status(self):
        try:
            c = await asyncio.to_thread(self._conn)
            uid = await asyncio.to_thread(self._uid, c)
            c.disconnect()
            return {"ok": True, "card": True, "uid": uid, "name": self.name}
        except WriterError as e:
            msg = str(e)
            return {"ok": msg.startswith("Pose"), "card": False, "error": None if msg.startswith("Pose") else msg, "name": self.name}

    async def read(self):
        return await asyncio.to_thread(self._read_sync)

    async def write(self, data: bytes):
        return await asyncio.to_thread(self._write_sync, data)


def make(setting: str, data_dir: Path):
    s = (setting or "").strip()
    if not s:
        return None
    if s == "mock":
        return MockWriter(data_dir / "rfid_mock.json")
    if s == "pcsc":
        return PcscWriter()
    if s.startswith("http"):
        return HttpWriter(s)
    return None
