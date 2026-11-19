"""Photos officielles des filaments.

Recherche la photo du fabricant pour un filament, la réduit et la garde dans DATA_DIR/images
(PrintLab ne dépend plus du site ensuite).
- Bambu Lab : pages produit de la boutique EU ; chaque variante porte son code couleur (10100…) et sa photo.
- Boutiques Shopify (Artillery, Sunlu, QIDI, Elegoo…) : catalogue public /products.json, variante dont la couleur correspond.
"""
import io
import json
import re
import time
import unicodedata

import httpx
from PIL import Image, ImageOps

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) PrintLab/1.0", "Accept-Language": "en"}
BAMBU = "https://eu.store.bambulab.com"
# boutiques Shopify connues (clé = nom de marque normalisé) ; sinon on essaie le site web saisi pour la marque
SHOPS = {"artillery": "https://artillery3d.com", "sunlu": "https://store.sunlu.com", "qidi": "https://qidi3d.com", "qiditech": "https://qidi3d.com",
         "elegoo": "https://us.elegoo.com", "anycubic": "https://store.anycubic.com", "polymaker": "https://us.polymaker.com",
         "kingroon": "https://kingroon.com", "jayo": "https://jayo3d.com", "eryone": "https://eryone3d.com", "geeetech": "https://www.geeetech.com"}
# couleurs françaises → anglais (les boutiques sont en anglais)
FR_EN = {"blanc": "white", "noir": "black", "gris": "grey", "rouge": "red", "bleu": "blue", "vert": "green", "jaune": "yellow", "orange": "orange",
         "rose": "pink", "violet": "purple", "marron": "brown", "beige": "beige", "argent": "silver", "argente": "silver", "or": "gold", "dore": "gold",
         "transparent": "clear", "naturel": "natural", "cyan": "cyan", "magenta": "magenta", "turquoise": "turquoise", "bronze": "bronze",
         "clair": "light", "fonce": "dark", "kaki": "khaki", "ivoire": "ivory", "cuivre": "copper", "bordeaux": "burgundy"}
# anglais → français (noms de couleur absents en français, ex. cadeau « White » sur une facture Bambu)
EN_FR = {**{v: k for k, v in FR_EN.items() if k not in ("argente", "dore", "fonce", "or", "argent")},
         "gray": "gris", "silver": "argenté", "gold": "doré", "dark": "foncé", "light": "clair"}
BAD = re.compile(r"resin|bundle|pack|combo|set\b|sample|connector|heater|dryer|large spool|[35] ?kg|10 ?kg|2 ?kg|value|gift|box\b|kit\b|nozzle|plate", re.I)

_cache = {}


def _norm(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _get(url, ttl=6 * 3600, as_json=False):
    hit = _cache.get(url)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    r = httpx.get(url, headers=UA, timeout=25, follow_redirects=True)
    r.raise_for_status()
    val = r.json() if as_json else r.text
    _cache[url] = (time.time(), val)
    return val


def color_words(f):
    """Nom de couleur d'un filament, sans matière, finition ni code : « Basic Blanc de jade (10100) » → « blanc de jade »."""
    n = re.sub(r"\(\d{3,}\)", " ", f.get("name") or "")
    n = _norm(n)
    for w in [f.get("material"), f.get("finish"), "basic", "standard", "filament", "plus"]:
        for t in _norm(w).split():
            n = re.sub(rf"\b{re.escape(t)}\b", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def _en(words):
    return " ".join(FR_EN.get(w, w) for w in words.split() if w not in ("de", "du", "des", "la", "le"))


def _color_match(variant, color):
    if not color:
        return False
    v = _norm(variant).replace("gray", "grey")
    c = color.replace("gray", "grey")
    return bool(re.search(rf"\b{re.escape(c)}\b", v)) or all(re.search(rf"\b{re.escape(t)}\b", v) for t in c.split())


# ---------- Bambu Lab ----------

def _bambu_slugs():
    xml = _get(BAMBU + "/sitemap_products_1.xml", ttl=7 * 86400)
    slugs = re.findall(r"<loc>https://eu\.store\.bambulab\.com/products/([^<]+)</loc>", xml)
    return [s for s in slugs if re.match(r"(pla|petg|pet|abs|asa|tpu|pc|pa|ppa|pps|hips|pva|support)", s)]


def _bambu_variants(slug):
    """[(nom de variante, url photo)] depuis le JSON-LD de la page produit."""
    html = _get(f"{BAMBU}/products/{slug}", ttl=7 * 86400).replace('\\"', '"')
    return re.findall(r'"image":\s*"(https://[^"]+)",\s*"name":\s*"([^"]+)"', html)


def find_bambu(f):
    code = (re.search(r"\((\d{5})\)", f.get("name") or "") or [None, None])[1]
    mat, fin = _norm(f.get("material")), _norm(f.get("finish"))
    color = _en(color_words(f))
    slugs = _bambu_slugs()
    # pages les plus probables d'abord : matière + finition dans le slug
    def score(s):
        t = s.replace("-", " ")
        return (mat.split()[0] in t.split()[:1]) * 4 + (bool(fin) and all(w in t for w in fin.split())) * 3 + ("filament" in t) * 1 - len(t.split()) * .1
    for slug in sorted(slugs, key=score, reverse=True)[:8]:
        try:
            vs = _bambu_variants(slug)
        except Exception:
            continue
        for img, name in vs:
            if code and f"({code})" in name:
                return img, f"{BAMBU}/products/{slug}"
        if not code and score(slug) >= 4:
            for img, name in vs:
                if _color_match(name.split(" - ", 1)[-1].split(" / ")[0], color):
                    return img, f"{BAMBU}/products/{slug}"
    return None


# ---------- Shopify ----------

def _shop_products(base):
    out = []
    for page in range(1, 5):
        d = _get(f"{base}/products.json?limit=250&page={page}", as_json=True)
        out += d.get("products", [])
        if len(d.get("products", [])) < 250:
            break
    return out


def find_shopify(base, f):
    mat = (f.get("material") or "").upper()
    fin = _norm(f.get("finish"))
    color = _en(color_words(f))
    if not mat or not color:
        return None
    mre = re.compile(rf"(?<![\w-]){re.escape(mat)}(?![\w-])", re.I)
    cands = []
    for p in _shop_products(base):
        t = p.get("title") or ""
        if not mre.search(t) or BAD.search(t) or "resin" in p.get("handle", ""):
            continue
        s = 10 + (3 if fin and fin not in ("basic", "standard") and fin in _norm(t) else 0) - len(t) / 40
        if fin in ("basic", "standard", "") and re.search(r"silk|matte|marble|wood|glow|rainbow|dual|tri|gradient|cf\b|gf\b|carbon|easy|\+|plus|meta|high speed", t, re.I):
            s -= 4
        cands.append((s, p))
    for _, p in sorted(cands, key=lambda x: -x[0]):
        imgs = {i["id"]: i["src"] for i in p.get("images", [])}
        for v in p.get("variants", []):
            if _color_match(v.get("title", ""), color):
                fi = v.get("featured_image") or {}
                src = fi.get("src") or imgs.get(v.get("image_id"))
                if src:
                    return src, f"{base}/products/{p['handle']}"
        for i in p.get("images", []):
            if _color_match(i.get("alt") or "", color):
                return i["src"], f"{base}/products/{p['handle']}"
    return None


def find(f, vendor_name, website=None):
    """Retourne (url de la photo, page source) ou None."""
    key = _norm(vendor_name).replace(" ", "")
    if key in ("bambulab", "bambu"):
        return find_bambu(f)
    bases = [SHOPS[key]] if key in SHOPS else []
    if website and website.startswith("http"):
        bases.append(website.rstrip("/"))
    for b in bases:
        try:
            r = find_shopify(b, f)
            if r:
                return r
        except Exception:
            continue
    return None


def download(url, dest):
    r = httpx.get(url, headers=UA, timeout=30, follow_redirects=True)
    r.raise_for_status()
    if len(r.content) > 15 * 1024 * 1024:
        raise ValueError("image trop lourde")
    save_bytes(r.content, dest)


def save_bytes(data, dest, size=480):
    """Recadre en carré, réduit et écrit un JPEG (fond blanc sous la transparence)."""
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    im = im.convert("RGBA")
    bg = Image.new("RGB", im.size, (255, 255, 255))
    bg.paste(im, mask=im.split()[3])
    w, h = bg.size
    c = min(w, h)
    bg = bg.crop(((w - c) // 2, (h - c) // 2, (w + c) // 2, (h + c) // 2))
    bg.thumbnail((size, size), Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    bg.save(tmp, "JPEG", quality=84, optimize=True)
    tmp.replace(dest)
