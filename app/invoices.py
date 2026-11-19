"""Lecture des factures d'achat de filament (PDF).

parse(pdf) → {"vendor", "number", "order", "date", "currency", "lines": [...], "totals": {...}, "format"}
Chaque ligne : produit (gamme), sku, variante, code couleur, quantité, prix unitaire, sous-total payé,
poids d'une bobine, recharge ou non. Rien n'est écrit en base ici : l'intégration se fait après validation.

Formats reconnus : Bambu Lab (boutique EU). Pour un autre fournisseur, la facture est gardée et
le récapitulatif permet d'ajouter les lignes à la main.
"""
import io
import json
import re
from pathlib import Path

from pypdf import PdfReader

BAMBU_COLORS = {}
try:
    BAMBU_COLORS = json.loads((Path(__file__).parent / "bambu_colors.json").read_text())["colors"]
except Exception:
    pass

MONEY = r"(-?[€$£]?\s?-?\d[\d\s.,]*\d|\d)\s?(?:€|EUR)?"


def text_of(data: bytes) -> str:
    r = PdfReader(io.BytesIO(data))
    return "\n".join((p.extract_text() or "") for p in r.pages)


def money(s):
    """« €1 234,56 » / « 1,234.56 € » / « 9.08 » → 1234.56"""
    if s is None:
        return None
    s = re.sub(r"[^\d.,-]", "", str(s))
    if not s:
        return None
    if "," in s and "." in s:
        s = s.replace(",", "") if s.rfind(".") > s.rfind(",") else s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".") if len(s.split(",")[-1]) <= 2 else s.replace(",", "")
    try:
        return round(float(s), 2)
    except ValueError:
        return None


def weight_of(txt):
    """Poids d'une bobine lu dans la variante : « 1 kg », « 0.5kg », « 250 g »."""
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(kg|g)\b", txt or "", re.I)
    if not m:
        return None
    v = float(m.group(1).replace(",", "."))
    return v * 1000 if m.group(2).lower() == "kg" else v


def split_product(title):
    """« PLA Basic » → (PLA, Basic) ; « ABS » → (ABS, None) ; « PETG HF » → (PETG, HF) ; « PLA-CF » → (PLA-CF, None)."""
    t = (title or "").strip()
    parts = t.split(None, 1)
    if not parts:
        return None, None
    return parts[0].upper(), (parts[1].strip() if len(parts) > 1 else None)


# ---------- Bambu Lab ----------

ROW = re.compile(r"^(\d+)\s+€\s?([\d.,]+)\s+€\s?([\d.,]+)(?:\s+.*?)?\s+€\s?([\d.,]+)\s+€\s?([\d.,]+)\s*$")


def parse_bambu(t):
    lines = [l.strip() for l in t.splitlines()]
    head = lambda rx: (re.search(rx, t) or [None, None])[1]
    out = {"format": "bambu", "vendor": "Bambu Lab", "currency": "EUR",
           "number": head(r"Invoice Number:\s*(\S+)"), "order": head(r"Order Number:\s*(\S+)"),
           "date": head(r"Invoice Date:\s*(\d{4}-\d{2}-\d{2})"), "lines": []}
    i = 0
    while i < len(lines):
        if not lines[i].startswith("SKU:"):
            i += 1
            continue
        # produit = ligne non vide juste avant ; « Gift » éventuel encore avant
        j = i - 1
        while j >= 0 and not lines[j]:
            j -= 1
        product = lines[j] if j >= 0 else ""
        gift = j > 0 and lines[j - 1].lower() == "gift"
        sku = lines[i][4:].strip()
        k = i + 1
        while k < len(lines) and not lines[k].startswith("Variant:"):
            if ROW.match(lines[k]):
                break
            sku += lines[k].strip()
            k += 1
        variant = ""
        if k < len(lines) and lines[k].startswith("Variant:"):
            variant = lines[k][8:].strip()
            k += 1
        while k < len(lines) and not ROW.match(lines[k]):
            if lines[k].startswith("SKU:") or lines[k].startswith("Items"):
                break
            variant += " " + lines[k].strip()
            k += 1
        m = ROW.match(lines[k]) if k < len(lines) else None
        if m:
            qty = int(m.group(1))
            price, disc, sub = money(m.group(2)), money(m.group(3)), money(m.group(5))
            variant = re.sub(r"\s+", " ", variant).strip()
            code = (re.search(r"\((\d{5})\)", variant) or [None, None])[1]
            vparts = [p.strip() for p in variant.split("/")]
            color = re.sub(r"\s*\(\d{5}\)\s*", "", vparts[0]).strip() if vparts else ""
            mat, fin = split_product(product)
            ref = BAMBU_COLORS.get(code) if code else None
            if ref and ref[0]:
                mat, fin = split_product(ref[0])
            out["lines"].append({
                "product": product, "sku": sku, "variant": variant, "code": code,
                "color": (ref[1] if ref and ref[1] else color), "color_en": ref[2] if ref else None,
                "hexes": ref[3] if ref else [], "material": mat, "finish": fin,
                "qty": qty, "unit_price": price, "discount": disc, "subtotal": sub, "gift": gift,
                "weight": weight_of(variant) or 1000, "refill": bool(re.search(r"recharge|refill", variant, re.I)) or sku.endswith("SPLFREE"),
            })
            i = k + 1
        else:
            i += 1
    tot = lambda label: money((re.search(label + r"\s*([€$£]?\s?-?[\d.,]+)", t) or [None, None])[1])
    out["totals"] = {"items": tot(r"Items Subtotal"), "discount": tot(r"Order Discount"), "shipping": tot(r"Shipping"),
                     "total": tot(r"Net payment") or tot(r"Grand total"), "tax": tot(r"Tax\s+FR TVA\(\d+%\)")}
    return out


def parse(data: bytes):
    t = text_of(data)
    if re.search(r"bambu ?lab", t, re.I) and "SKU:" in t:
        r = parse_bambu(t)
    else:
        r = {"format": None, "vendor": None, "number": None, "order": None, "date": None, "currency": "EUR", "lines": [], "totals": {}}
        r["number"] = (re.search(r"(?:Facture|Invoice)\s*(?:n[°o]|number|num[ée]ro)?\s*[:#]?\s*([A-Z0-9-]{5,})", t, re.I) or [None, None])[1]
        d = re.search(r"(\d{4}-\d{2}-\d{2})|(\d{2})/(\d{2})/(\d{4})", t)
        if d:
            r["date"] = d.group(1) or f"{d.group(4)}-{d.group(3)}-{d.group(2)}"
    allocate(r)
    r["text"] = t[:20000]
    return r


def allocate(r):
    """Prix réellement payé par bobine : sous-total de la ligne (remises produit déduites) / quantité,
    puis la réduction de commande et les frais de port répartis au prorata."""
    items = sum(l["subtotal"] or 0 for l in r["lines"])
    total = (r.get("totals") or {}).get("total")
    factor = total / items if items and total is not None else 1
    for l in r["lines"]:
        unit = (l["subtotal"] or 0) / l["qty"] if l["qty"] else 0
        l["paid_each"] = round(unit * factor, 2)
    r["factor"] = round(factor, 4)
