#!/usr/bin/env python3
"""Test de fonctionnement d'une image orca-web (utilisé avant de basculer sur une nouvelle version d'Orca).

Vérifie : lecture des profils, schéma des réglages, découpe multi-filament avec changements d'outil.
Code de sortie 0 si tout va bien.
"""
import asyncio
import json
import os
import re
import sys
import tempfile

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
sys.path.insert(0, "/app")

from app.slicer import profiles, slicer  # noqa: E402

MACHINE = os.environ.get("DEFAULT_MACHINE", "Qidi X-Max 4 0.4 nozzle")


def main():
    schema = json.load(open(os.environ.get("SCHEMA_PATH", "/opt/orca/schema.json")))
    nopt = len(schema["options"])
    assert nopt > 500, f"schéma incomplet ({nopt} options)"
    machines = profiles.list_machines()
    assert any(m["name"] == MACHINE for m in machines), f"imprimante {MACHINE} absente des profils"
    procs = profiles.list_processes(MACHINE)
    fils = [f for f in profiles.list_filaments(MACHINE) if f["vendor"] != profiles.COMMON_LIB]
    assert procs and len(fils) >= 2, "profils de réglages/filaments manquants"
    mcfg = profiles.resolve("machine", MACHINE)
    proc = mcfg.get("default_print_profile") if any(p["name"] == mcfg.get("default_print_profile") for p in procs) else procs[0]["name"]

    v = [(0, 0, 0), (20, 0, 0), (20, 20, 0), (0, 20, 0), (0, 0, 10), (20, 0, 10), (20, 20, 10), (0, 20, 10)]
    f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6),
         (3, 0, 4), (3, 4, 7)]
    pts = [tuple(map(float, p.split("x"))) for p in mcfg["printable_area"]]
    cx = (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2
    cy = (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2

    def m(x, y):
        return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]

    objs = [dict(name="A", vertices=v, faces=f, matrix=m(cx - 30, cy), extruder=1),
            dict(name="B", vertices=v, faces=f, matrix=m(cx + 10, cy), extruder=2)]
    cfg = slicer.build_config(MACHINE, proc, [fils[0]["name"], fils[1]["name"]], ["#FF0000", "#0000FF"])
    jid, d = slicer.new_job_dir()
    p = d / "plate.3mf"
    slicer.write_3mf(p, objs, cfg)
    gcode, info = asyncio.run(slicer.run_slice(d, p))
    txt = gcode.read_text(errors="replace")
    tools = sorted(set(re.findall(r"(?m)^T(\d+)$", txt)))
    stats = slicer.gcode_stats(gcode)
    assert len(tools) >= 2, f"pas de changement de filament dans le G-code (outils : {tools})"
    print(f"OK — Orca {slicer.orca_version()}, {nopt} options, {len(machines)} imprimantes, "
          f"découpe {info['duration']} s, outils {tools}, {stats.get('time')}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ÉCHEC : {e}")
        sys.exit(1)
