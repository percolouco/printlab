#!/usr/bin/env python3
"""Construit app/filament_catalog.json à partir de SpoolmanDB (https://github.com/Donkie/SpoolmanDB, licence MIT).

Usage : python3 scripts/build_catalog.py            (télécharge la dernière version)
        python3 scripts/build_catalog.py <dossier>  (dossier « filaments/ » déjà extrait)

Sortie : {"source", "built", "families": {famille: nb}, "brands": {marque: [gamme, …]}}
Chaque gamme : fam (PLA, PETG…), mat (matière exacte : PLA+, PLA-CF…), label (Matte, Silk, Standard…),
density, nozzle [min,max], bed [min,max], weights [g], spool_weight, colors [[nom, hex, hexes|None], …].
Seul le diamètre 1,75 mm est gardé.
"""
import io
import json
import re
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app" / "filament_catalog.json"
URL = "https://codeload.github.com/Donkie/SpoolmanDB/tar.gz/refs/heads/main"

FAM_RE = re.compile(r"^(PETG|PCTG|PET|PLA|ABS|ASA|TPU|TPE|TPC|PC|PAHT|PA\d*|PVA|PVB|HIPS|PPS|PP|PEEK|PEI|PEKK|PHA|CPE|PEBA)")
# Libellé de la gamme « sans préfixe » pour quelques marques (vocabulaire du fabricant)
STANDARD = {"Bambu Lab": "Basic"}


def family(mat):
    m = (mat or "").upper().replace(" ", "")
    m = re.sub(r"^(HT|EASY)", "", m)
    r = FAM_RE.match(m)
    if not r:
        return "Autre"
    f = r.group(1)
    return "PA" if f.startswith("PA") else f


def _rng(v, rng):
    if rng:
        return [rng[0], rng[1]]
    return [v, v] if v else None


def load_groups(src):
    if src:
        for fn in sorted(Path(src).glob("*.json")):
            yield json.loads(fn.read_text())
        return
    data = urllib.request.urlopen(URL, timeout=60).read()
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        for m in sorted(t.getmembers(), key=lambda m: m.name):
            if re.search(r"/filaments/[^/]+\.json$", m.name):
                yield json.load(t.extractfile(m))


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    brands, fams = {}, {}
    for doc in load_groups(src):
        brand = doc["manufacturer"]
        out = {}
        for g in doc["filaments"]:
            if 1.75 not in [float(d) for d in g.get("diameters", [])]:
                continue
            mat = (g["material"] or "").upper()
            fam = family(mat)
            affix = re.sub(r"\s+", " ", g["name"].replace("{color_name}", "").replace("\xa0", " ")).strip(" -")
            if not affix:
                cols = g["colors"]
                if g.get("pattern"):
                    affix = g["pattern"].title()
                elif g.get("multi_color_direction") or sum(1 for c in cols if c.get("hexes")) > len(cols) / 2:
                    affix = "Multicolore"
                elif g.get("translucent") or all(c.get("translucent") for c in cols):
                    affix = "Translucide"
                elif g.get("glow"):
                    affix = "Glow"
            parts = [mat] if mat != fam else []
            if affix:
                parts.append(affix)
            elif mat == fam:
                parts.append(STANDARD.get(brand, "Standard"))
            label = " ".join(parts)
            w = g.get("weights") or []
            key = (mat, label)
            cur = out.get(key)
            colors = [[c["name"], (c.get("hex") or (c.get("hexes") or [None])[0] or "888888").upper(),
                       [h.upper() for h in c["hexes"]] if c.get("hexes") else None] for c in g["colors"]]
            if cur:   # même gamme répartie sur plusieurs groupes : on fusionne les couleurs
                seen = {c[0].lower() for c in cur["colors"]}
                cur["colors"] += [c for c in colors if c[0].lower() not in seen]
                continue
            out[key] = {"fam": fam, "mat": mat, "label": label, "finish": affix or (STANDARD.get(brand) if mat == fam else None),
                        "density": g.get("density"),
                        "nozzle": _rng(g.get("extruder_temp"), g.get("extruder_temp_range")),
                        "bed": _rng(g.get("bed_temp"), g.get("bed_temp_range")),
                        "weights": sorted({int(x["weight"]) for x in w if x.get("weight")}),
                        "spool_weight": next((x.get("spool_weight") for x in w if x.get("spool_weight")), None),
                        "colors": colors}
        if out:
            lst = sorted(out.values(), key=lambda x: (x["fam"], x["label"]))
            brands.setdefault(brand, []).extend(lst)
            for x in lst:
                fams[x["fam"]] = fams.get(x["fam"], 0) + len(x["colors"])
    res = {"source": "SpoolmanDB (MIT) — github.com/Donkie/SpoolmanDB", "built": time.strftime("%Y-%m-%d"),
           "families": dict(sorted(fams.items(), key=lambda kv: -kv[1])), "brands": dict(sorted(brands.items(), key=lambda kv: kv[0].lower()))}
    OUT.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")))
    n = sum(len(g["colors"]) for b in brands.values() for g in b)
    print(f"{len(brands)} marques, {sum(map(len, brands.values()))} gammes, {n} couleurs → {OUT} ({OUT.stat().st_size // 1024} Ko)")


if __name__ == "__main__":
    main()
