#!/usr/bin/env python3
"""Génère schema.json à partir des sources d'OrcaSlicer de la version installée.

- PrintConfig.cpp : définition de chaque option (type, libellé, info-bulle, unité, min/max, valeurs possibles)
- Tab.cpp         : organisation des onglets/pages/groupes de l'interface (Qualité, Résistance, Vitesse…)
- OrcaSlicer_fr.po: traduction française des libellés

Ainsi l'écran de réglages reprend exactement la structure de l'interface d'Orca, et se met
à jour tout seul à chaque nouvelle version.

Usage : gen_schema.py <tag, ex. v2.4.2> <sortie.json>
"""
import json
import re
import sys
import urllib.request

RAW = "https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer/{tag}/{path}"


def fetch(tag, path):
    with urllib.request.urlopen(RAW.format(tag=tag, path=path), timeout=120) as r:
        return r.read().decode("utf-8", errors="replace")


def c_string(expr):
    """Concatène les littéraux C++ "..." "..." et dé-échappe."""
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', expr)
    s = "".join(parts)
    # Orca 2.5 : séquences \uXXXX dans les littéraux -> caractères réels avant le décodage
    s = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), s)
    return bytes(s, "utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8", errors="replace")


def parse_po(text):
    tr = {}
    for block in re.split(r"\n\s*\n", text):
        m_id = re.search(r'^msgid ((?:".*"\s*)+)', block, re.M)
        m_str = re.search(r'^msgstr ((?:".*"\s*)+)', block, re.M)
        if m_id and m_str and "#, fuzzy" not in block:
            k, v = c_string(m_id.group(1)), c_string(m_str.group(1))
            if k and v:
                tr[k] = v
    return tr


def parse_print_config(src):
    opts = {}
    chunks = re.split(r'\n[^\n]*?\bdef\s*=\s*this->add(?:_nullable)?\(\s*"', src)
    for ch in chunks[1:]:
        m = re.match(r'([a-zA-Z0-9_]+)"\s*,\s*(co\w+)\s*\)', ch)
        if not m:
            continue
        key, typ = m.group(1), m.group(2)
        body = ch[m.end():]
        # s'arrêter à la fin de la définition (prochaine instruction hors def->)
        end = re.search(r'\n\s*(?!def->)(?:[A-Za-z_][\w:<>]*\s*\(|for\s*\(|//\s*-{5,}|\})', body)
        body = body[: end.start()] if end else body[:4000]
        o = {"type": typ}

        def grab(field):
            r = re.search(r"def->" + field + r"\s*=\s*((?:L\()?\s*(?:\"(?:[^\"\\]|\\.)*\"\s*)+\)?)\s*;", body, re.S)
            return c_string(r.group(1)) if r else None

        for f in ("label", "full_label", "category", "tooltip", "sidetext"):
            v = grab(f)
            if v:
                o[f] = v
        for f in ("min", "max"):
            r = re.search(r"def->" + f + r"\s*=\s*(-?[0-9.]+)", body)
            if r:
                o[f] = float(r.group(1))
        r = re.search(r"def->mode\s*=\s*com(\w+)", body)
        o["mode"] = (r.group(1).lower() if r else "simple")
        vals = re.findall(r'def->enum_values\.(?:push|emplace)_back\(\s*"([^"]*)"\s*\)', body)
        labels = [c_string(x) for x in re.findall(r'def->enum_labels\.(?:push|emplace)_back\(\s*(?:L\()?\s*("(?:[^"\\]|\\.)*")', body)]
        se = re.search(r"def->set_enum<\w+>\(\s*\{(.*?)\}\s*\)\s*;", body, re.S)
        if se:
            for a, b in re.findall(r'\{\s*"([^"]*)"\s*,\s*(?:L\()?\s*"((?:[^"\\]|\\.)*)"', se.group(1)):
                vals.append(a)
                labels.append(c_string('"' + b + '"'))
        sv = re.search(r"def->set_enum_values\(\s*(?:ConfigOptionDef::GUIType::\w+\s*,\s*)?\{(.*?)\}\s*\)\s*;", body, re.S)
        if sv:
            for a, b in re.findall(r'\{\s*"([^"]*)"\s*,\s*(?:L\()?\s*"((?:[^"\\]|\\.)*)"', sv.group(1)):
                vals.append(a)
                labels.append(c_string('"' + b + '"'))
        if vals:
            o["enum"] = vals
            o["enum_labels"] = labels if len(labels) == len(vals) else vals
        r = re.search(r"def->gui_type\s*=\s*ConfigOptionDef::GUIType::(\w+)", body)
        if r:
            o["gui_type"] = r.group(1)
        if "def->readonly = true" in body:
            o["readonly"] = True
        if "multiline = true" in body:
            o["multiline"] = True
        opts.setdefault(key, o)
    return opts


def parse_tab(src, start_markers):
    """Pages > groupes > options, dans l'ordre de l'interface."""
    pages = []
    for marker in start_markers:
        i = src.find(marker)
        if i < 0:
            continue
        j = re.search(r"\n(void|bool|int|std::\S+|wxSizer\*|static)\s+\w*[\w:]*::?\w+\(", src[i + len(marker):])
        body = src[i: i + len(marker) + (j.start() if j else 60000)]
        page = group = None
        tok = re.compile(
            r'add_options_page\(\s*(?:L\("([^"]+)"\)|page_name)'
            r'|new_optgroup\(\s*L\("([^"]+)"\)'
            r'|(?:append_single_option_line|get_option|get_option_and_append|append_option_line)\(\s*"([a-z0-9_]+)"'
            r'|append_option_line\(\s*optgroup\s*,\s*"([a-z0-9_]+)"'
            r'|create_line_with_widget\(\s*optgroup\.get\(\)\s*,\s*"([a-z0-9_]+)"')
        for m in tok.finditer(body):
            if m.group(0).startswith("add_options_page"):
                page = {"title": m.group(1) or "Extruder", "groups": []}
                if not any(p["title"] == page["title"] for p in pages):
                    pages.append(page)
                else:
                    page = next(p for p in pages if p["title"] == page["title"])
                group = None
            elif m.group(2):
                if page is None:
                    continue
                group = {"title": m.group(2), "options": []}
                page["groups"].append(group)
            else:
                key = m.group(3) or m.group(4) or m.group(5)
                if group is not None and key not in group["options"]:
                    group["options"].append(key)
    return [p for p in pages if any(g["options"] for g in p["groups"])]


def main():
    tag, out = sys.argv[1], sys.argv[2]
    pc = fetch(tag, "src/libslic3r/PrintConfig.cpp")
    tab = fetch(tag, "src/slic3r/GUI/Tab.cpp")
    try:
        fr = parse_po(fetch(tag, "localization/i18n/fr/OrcaSlicer_fr.po"))
    except Exception:
        fr = {}
    opts = parse_print_config(pc)
    tabs = {
        "process": parse_tab(tab, ["void TabPrint::build()"]),
        "filament": parse_tab(tab, ["void TabFilament::build()"]),
        "machine": parse_tab(tab, ["void TabPrinter::build_fff()", "void TabPrinter::build_unregular_pages("]),
    }

    def t(s):
        return fr.get(s, s) if s else s

    for o in opts.values():
        for f in ("label", "full_label", "category", "tooltip", "sidetext"):
            if f in o:
                o[f] = t(o[f])
        if "enum_labels" in o:
            o["enum_labels"] = [t(x) for x in o["enum_labels"]]
    for pages in tabs.values():
        for p in pages:
            p["title_fr"] = t(p["title"])
            for g in p["groups"]:
                g["title_fr"] = t(g["title"])
    schema = {"version": tag, "options": opts, "tabs": tabs}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(schema, f, ensure_ascii=False)
    n = {k: sum(len(g["options"]) for p in v for g in p["groups"]) for k, v in tabs.items()}
    print(f"schema {tag}: {len(opts)} options, {len(fr)} traductions, onglets {n}")


if __name__ == "__main__":
    main()
