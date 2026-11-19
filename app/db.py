"""Base SQLite de PrintLab."""
import os
import sqlite3
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "printlab.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS vendors(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, website TEXT, comment TEXT,
  empty_spool_weight REAL, spoolman_id INTEGER);
CREATE TABLE IF NOT EXISTS filaments(
  id INTEGER PRIMARY KEY, vendor_id INTEGER REFERENCES vendors(id), name TEXT NOT NULL,
  material TEXT, finish TEXT, color_hex TEXT, color_hexes TEXT, density REAL DEFAULT 1.24,
  diameter REAL DEFAULT 1.75, weight REAL DEFAULT 1000, spool_weight REAL, price REAL,
  article_number TEXT, nozzle_min INTEGER, nozzle_max INTEGER, bed_min INTEGER, bed_max INTEGER,
  low_threshold REAL, comment TEXT, external_id TEXT, spoolman_id INTEGER);
CREATE TABLE IF NOT EXISTS spools(
  id INTEGER PRIMARY KEY, filament_id INTEGER NOT NULL REFERENCES filaments(id),
  initial_weight REAL, used_weight REAL NOT NULL DEFAULT 0, price REAL, location TEXT,
  lot_nr TEXT, comment TEXT, archived INTEGER NOT NULL DEFAULT 0,
  registered TEXT, first_used TEXT, last_used TEXT, spoolman_id INTEGER);
CREATE TABLE IF NOT EXISTS usage(
  id INTEGER PRIMARY KEY, spool_id INTEGER NOT NULL REFERENCES spools(id) ON DELETE CASCADE,
  ts TEXT NOT NULL, weight REAL NOT NULL, source TEXT, job_id TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS usage_spool ON usage(spool_id);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
CREATE TABLE IF NOT EXISTS jobs(
  job_id TEXT PRIMARY KEY, filename TEXT, status TEXT, start_time REAL, end_time REAL,
  print_duration REAL, filament_mm REAL, filament_g REAL, thumb TEXT, spool_ids TEXT);
CREATE TABLE IF NOT EXISTS slot_map(slot INTEGER PRIMARY KEY, spool_id INTEGER REFERENCES spools(id));
CREATE TABLE IF NOT EXISTS tracks(
  id INTEGER PRIMARY KEY, filename TEXT, started REAL, ended REAL, status TEXT, last_fu REAL DEFAULT 0,
  slots_mm TEXT DEFAULT '{}', slot_map TEXT DEFAULT '{}', partial INTEGER DEFAULT 0, applied INTEGER DEFAULT 0, parts TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS rfid_tags(
  spool_id INTEGER PRIMARY KEY REFERENCES spools(id) ON DELETE CASCADE, material INTEGER, color INTEGER, vendor INTEGER,
  sig TEXT, uid TEXT, written TEXT);
CREATE TABLE IF NOT EXISTS backup_snapshots(
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, label TEXT, auto INTEGER NOT NULL DEFAULT 0,
  nfiles INTEGER, changed INTEGER, total_size INTEGER);
CREATE TABLE IF NOT EXISTS backup_files(
  snapshot_id INTEGER NOT NULL REFERENCES backup_snapshots(id) ON DELETE CASCADE, path TEXT NOT NULL,
  sha TEXT NOT NULL, size INTEGER, PRIMARY KEY(snapshot_id, path));
CREATE INDEX IF NOT EXISTS backup_files_sha ON backup_files(sha);
CREATE TABLE IF NOT EXISTS invoices(
  id INTEGER PRIMARY KEY, filename TEXT, uploaded TEXT, vendor TEXT, number TEXT, order_nr TEXT, date TEXT,
  total REAL, currency TEXT, status TEXT NOT NULL DEFAULT 'pending', parsed TEXT, result TEXT, done_at TEXT);
"""


def connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init():
    c = connect()
    c.executescript(SCHEMA)
    for t in ("vendors", "filaments", "spools"):
        if "extra" not in [r[1] for r in c.execute(f"PRAGMA table_info({t})")]:
            c.execute(f"ALTER TABLE {t} ADD COLUMN extra TEXT")
    fcols = [r[1] for r in c.execute("PRAGMA table_info(filaments)")]
    for col in ("image", "image_src"):   # photo locale (nom de fichier?v=horodatage) et page d'origine
        if col not in fcols:
            c.execute(f"ALTER TABLE filaments ADD COLUMN {col} TEXT")
    if "events" not in [r[1] for r in c.execute("PRAGMA table_info(tracks)")]:
        c.execute("ALTER TABLE tracks ADD COLUMN events TEXT")   # fins de bobine détectées pendant le print
    if "meta" not in [r[1] for r in c.execute("PRAGMA table_info(tracks)")]:
        c.execute("ALTER TABLE tracks ADD COLUMN meta TEXT")     # {elec: {kwh, eur}, rating, note}
    c.commit()
    return c
