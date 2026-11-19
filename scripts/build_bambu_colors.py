"""Génère app/bambu_colors.json depuis la table officielle de Bambu Studio.

code couleur (10502…) → [gamme, nom FR, nom EN, [couleurs hex]]
Sert à l'import des factures Bambu Lab (nom français + vraie teinte).
Usage : python3 scripts/build_bambu_colors.py
"""
import json
import urllib.request
from pathlib import Path

SRC = "https://raw.githubusercontent.com/bambulab/BambuStudio/master/resources/profiles/BBL/filament/filaments_color_codes.json"
OUT = Path(__file__).resolve().parent.parent / "app" / "bambu_colors.json"

data = json.load(urllib.request.urlopen(SRC, timeout=30))["data"]
out = {}
for e in data:
    n = e.get("fila_color_name") or {}
    hx = [h.lstrip("#")[:6].upper() for h in e.get("fila_color") or [] if h]
    out[e["fila_color_code"]] = [e.get("fila_type"), n.get("fr") or n.get("en"), n.get("en"), hx]
OUT.write_text(json.dumps({"source": "BambuStudio resources/profiles/BBL/filament/filaments_color_codes.json", "colors": out},
                          ensure_ascii=False, separators=(",", ":")))
print(f"{len(out)} couleurs → {OUT}")
