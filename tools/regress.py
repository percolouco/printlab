#!/usr/bin/env python3
"""Tests de non-régression du Slicer (à lancer à chaque mise à jour d'OrcaSlicer).

Jeu de projets : tools/regress/*.3mf, enregistrés par le Slicer de PrintLab pendant les paliers 1 à 4 (multi-plateaux,
couleurs et tour de purge, changements par couche, filament mixte, pièces, coupe avec connecteurs, texte, peinture,
hauteur de couche adaptative…). Chaque plateau est découpé par le moteur d'Orca (CLI), puis on compare à la référence
(tools/regress/reference.json) : nombre de couches, filament consommé, temps estimé, nombre de mouvements et empreinte
des mouvements (G-code sans commentaires).

  regress.py            compare à la référence ; code 1 si une découpe échoue, 0 sinon (écarts signalés)
  regress.py --record   enregistre la référence pour la version d'Orca installée
  regress.py --strict   code 1 aussi si une empreinte change
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent / "regress"
REF = HERE / "reference.json"
ORCA = "/opt/orca/AppRun"


def plates_of(path):
    with zipfile.ZipFile(path) as z:
        n = sum(1 for x in z.namelist() if re.match(r"Metadata/plate_\d+\.json$", x))
        if not n:
            cfg = z.read("Metadata/model_settings.config").decode(errors="replace") if "Metadata/model_settings.config" in z.namelist() else ""
            n = max(1, cfg.count("<plate>"))
    return n


def metrics(gcode):
    text = Path(gcode).read_text(errors="replace")
    layers = text.count("\n;LAYER_CHANGE")
    fil = re.search(r"; total filament used \[g\] = ([\d.]+)", text) or re.search(r"; filament used \[g\] = ([\d., ]+)", text)
    tm = re.search(r"; estimated printing time \(normal mode\) = ([^\n]+)", text)
    moves = [ln.split(";")[0].strip() for ln in text.splitlines() if ln.startswith(("G0 ", "G1 ", "G2 ", "G3 "))]
    grams = sum(float(x) for x in fil.group(1).split(",") if x.strip()) if fil else 0.0
    return {"layers": layers, "grams": round(grams, 2), "time": tm.group(1).strip() if tm else "?", "moves": len(moves),
            "hash": hashlib.sha256("\n".join(moves).encode()).hexdigest()[:16]}


def slice_all():
    out = {}
    for p in sorted(HERE.glob("*.3mf")):
        for i in range(1, plates_of(p) + 1):
            key = f"{p.stem}#{i}"
            with tempfile.TemporaryDirectory() as td:
                Path(f"{td}/dd").mkdir(); Path(f"{td}/o").mkdir()
                env = dict(os.environ, HOME=td, XDG_RUNTIME_DIR="/tmp")
                r = subprocess.run(["xvfb-run", "-a", ORCA, "--datadir", f"{td}/dd", "--allow-newer-file", "--slice", str(i),
                                    "--outputdir", f"{td}/o", str(p)], capture_output=True, text=True, timeout=1800, cwd=td, env=env)
                g = sorted(Path(f"{td}/o").glob("*.gcode"))
                if r.returncode != 0 or not g:
                    out[key] = {"error": (r.stderr or r.stdout)[-400:]}
                else:
                    out[key] = metrics(g[0])
            print(f"  {key:38s} {json.dumps(out[key], ensure_ascii=False)}", flush=True)
    return out


def main():
    tag = Path("/opt/orca/ORCA_TAG").read_text().strip() if Path("/opt/orca/ORCA_TAG").exists() else "?"
    print(f"OrcaSlicer {tag} — découpe du jeu de projets")
    cur = slice_all()
    if "--record" in sys.argv:
        REF.write_text(json.dumps({"orca": tag, "plates": cur}, indent=1, ensure_ascii=False))
        print(f"Référence enregistrée ({len(cur)} plateaux).")
        return 0 if not any("error" in v for v in cur.values()) else 1
    ref = json.loads(REF.read_text())
    fails, changed = 0, 0
    print(f"\nComparaison avec la référence (OrcaSlicer {ref['orca']}) :")
    for key, v in cur.items():
        r = ref["plates"].get(key)
        if "error" in v:
            fails += 1; print(f"  ÉCHEC   {key} : {v['error'][-200:]}"); continue
        if not r or "error" in r:
            print(f"  NOUVEAU {key}"); continue
        if v["hash"] == r["hash"]:
            print(f"  identique {key}"); continue
        changed += 1
        dg = (v["grams"] - r["grams"]) / r["grams"] * 100 if r["grams"] else 0
        print(f"  CHANGÉ  {key} : couches {r['layers']}→{v['layers']}, filament {r['grams']}→{v['grams']} g ({dg:+.1f} %), "
              f"temps {r['time']}→{v['time']}, mouvements {r['moves']}→{v['moves']}")
    print(f"\n{len(cur)} plateaux : {fails} échec(s), {changed} G-code(s) différent(s) de la référence.")
    if fails or ("--strict" in sys.argv and changed):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
