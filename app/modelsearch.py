"""Recherche de modèles 3D sur plusieurs sites.

Seul Printables expose une API publique utilisable côté serveur (GraphQL) : ses résultats s'affichent dans PrintLab.
Les autres sites (MakerWorld, Cults, Thangs…) sont protégés contre les robots : PrintLab ne fait que construire
l'adresse de recherche, que le navigateur ouvre.
"""
from urllib.parse import quote

import httpx

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) PrintLab/1.0", "Content-Type": "application/json"}
Q = "query($q:String!,$n:Int!){searchPrints2(query:$q,limit:$n){items{id name slug likesCount downloadCount image{filePath} user{publicUsername}}}}"


def printables(q: str, limit: int = 24):
    r = httpx.post("https://api.printables.com/graphql/", headers=UA, timeout=15, json={"query": Q, "variables": {"q": q, "n": limit}})
    r.raise_for_status()
    items = (((r.json().get("data") or {}).get("searchPrints2")) or {}).get("items") or []
    return [{"title": i["name"], "url": f"https://www.printables.com/model/{i['id']}-{i['slug']}",
             "image": f"https://media.printables.com/{i['image']['filePath']}" if i.get("image") else None,
             "author": (i.get("user") or {}).get("publicUsername"), "likes": i.get("likesCount"), "downloads": i.get("downloadCount")} for i in items]


def thingiverse(q: str, token: str, limit: int = 24):
    """API officielle (jeton d'application gratuit, en-tête Authorization : la variante ?access_token= est bloquée par Cloudflare)."""
    r = httpx.get("https://api.thingiverse.com/search/" + quote(q, safe=""), params={"type": "things", "per_page": limit, "sort": "relevant"},
                  headers={"Authorization": f"Bearer {token}", "User-Agent": "PrintLab/1.0"}, timeout=15)
    r.raise_for_status()
    return [{"title": h["name"], "url": h["public_url"], "image": h.get("preview_image") or h.get("thumbnail"),
             "author": (h.get("creator") or {}).get("name"), "likes": h.get("like_count"), "downloads": None} for h in r.json().get("hits", [])]
