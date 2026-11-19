#!/usr/bin/env python3
"""Ajoute à schema.json la valeur par défaut de chaque option.

Les profils Orca ne contiennent que les options qui diffèrent des valeurs par défaut du
code. Pour les afficher quand même, on découpe un petit cube avec la configuration par
défaut d'Orca et on lit le bloc de configuration complet écrit à la fin du G-code.

La configuration par défaut brute n'étant pas découpable, on charge un profil
imprimante + réglages + filament réel ; les options absentes de ces profils gardent
leur valeur par défaut d'Orca.

Usage : gen_defaults.py <orca AppRun> <schema.json> <dossier de travail> <machine.json> <process.json> <filament.json>
"""
import json
import subprocess
import sys
from pathlib import Path


def cube_stl(path):
    v = [(0, 0, 0), (20, 0, 0), (20, 20, 0), (0, 20, 0), (0, 0, 20), (20, 0, 20), (20, 20, 20), (0, 20, 20)]
    f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6),
         (3, 0, 4), (3, 4, 7)]
    with open(path, "w") as o:
        o.write("solid c\n")
        for t in f:
            o.write("facet normal 0 0 0\nouter loop\n")
            for i in t:
                o.write("vertex %s %s %s\n" % (v[i][0] + 100, v[i][1] + 100, v[i][2]))
            o.write("endloop\nendfacet\n")
        o.write("endsolid c\n")


def parse_value(raw, typ):
    vector = typ.endswith("s") and typ not in ("coPointsGroups",) or typ in ("coPoints",)
    if typ in ("coString", "coEnum", "coFloatOrPercent", "coPercent", "coFloat", "coInt", "coBool", "coPoint", "coPoint3"):
        return raw.replace("\\n", "\n")
    if typ == "coStrings":
        if raw.startswith('"'):
            parts, cur, inq = [], "", False
            i = 0
            while i < len(raw):
                ch = raw[i]
                if ch == '"' and (i == 0 or raw[i - 1] != "\\"):
                    inq = not inq
                elif ch == ";" and not inq:
                    parts.append(cur)
                    cur = ""
                else:
                    cur += ch
                i += 1
            parts.append(cur)
            return [p.replace("\\n", "\n").replace('\\"', '"') for p in parts]
        return [x for x in raw.split(";")] if raw else []
    if vector:
        return raw.split(",") if raw != "" else []
    return raw


def main():
    orca, schema_path, work = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    machine, process, filament = sys.argv[4:7]
    work.mkdir(parents=True, exist_ok=True)
    cube_stl(work / "cube.stl")
    subprocess.run(["xvfb-run", "-a", orca, "--datadir", str(work / "dd"), "--slice", "0", "--outputdir",
                    str(work / "out"), "--load-settings", f"{machine};{process}", "--load-filaments", filament,
                    str(work / "cube.stl")], check=False, timeout=600, cwd=str(work),
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    gcodes = list((work / "out").glob("*.gcode"))
    schema = json.loads(schema_path.read_text())
    if not gcodes:
        print("gen_defaults : aucune sortie, valeurs par défaut non ajoutées")
        return
    text = gcodes[0].read_text(errors="replace")
    block = text[text.find("; CONFIG_BLOCK_START"): text.find("; CONFIG_BLOCK_END")]
    n = 0
    for line in block.splitlines()[1:]:
        if not line.startswith("; ") or " = " not in line:
            continue
        k, raw = line[2:].split(" = ", 1)
        o = schema["options"].get(k)
        if o is not None:
            o["default"] = parse_value(raw, o["type"])
            n += 1
    schema_path.write_text(json.dumps(schema, ensure_ascii=False))
    print(f"gen_defaults : {n} valeurs par défaut")


if __name__ == "__main__":
    main()
