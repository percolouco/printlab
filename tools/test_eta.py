#!/usr/bin/env python3
"""Tests du calcul du temps restant (app/eta.py). Usage : python3 tools/test_eta.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import eta  # noqa: E402


def close(a, b, tol=1.0):
    return a is not None and abs(a - b) <= tol


# début d'impression : l'estimation du slicer seule
r, s = eta.remaining(60, 0.01, 7200)
assert s == "slicer" and close(r, 7140), (r, s)

# sans estimation et sans progression : rien à dire
assert eta.remaining(0, 0, None) == (None, None)
assert eta.remaining(30, 0.01, None) == (None, None)   # trop tôt pour extrapoler

# sans estimation : extrapolation pure (50 % en 1 h → 1 h restante)
r, s = eta.remaining(3600, 0.5, None)
assert s == "progression" and close(r, 3600), (r, s)

# les deux concordent : même résultat quelle que soit la méthode
r, s = eta.remaining(3600, 0.5, 7200)
assert s == "slicer+progression" and close(r, 3600), (r, s)

# la machine est plus lente que prévu : le résultat se déplace vers l'extrapolation (3 600 s écoulées à 40 % → 5 400 s)
r, s = eta.remaining(3600, 0.4, 7200)   # slicer : 3 600 ; progression : 5 400 ; poids 0,5 → 4 500
assert close(r, 4500), r

# entre les seuils : poids intermédiaire (progression 9 % → poids 0,25)
r, s = eta.remaining(900, 0.09, 10000)   # slicer 9 100 ; progression 9 100 (identiques)
assert close(r, 9100), r
r, s = eta.remaining(900, 0.09, 6000)    # slicer 5 100 ; progression 9 100 ; poids 0,25 → 6 100
assert close(r, 6100), r

# jamais négatif : dépassement de l'estimation du slicer
r, s = eta.remaining(8000, 0.9, 7200)
assert r >= 0, r

# valeurs invalides
assert eta.remaining("x", 0.5, 100) == (None, None)
assert eta.remaining(None, None, None) == (None, None)
# progression hors bornes
r, _ = eta.remaining(100, 1.7, None)
assert r == 0, r

print("OK : eta.remaining")
