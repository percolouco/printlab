"""Temps restant et heure de fin d'une impression (lecture seule, calcul à partir de ce que remonte Moonraker).

Deux sources :
  - l'estimation du slicer (métadonnées du fichier, `estimated_time`), fiable dès le début mais qui ignore le
    comportement réel de la machine ;
  - l'extrapolation à partir de la progression réelle : durée écoulée × (1 − p) / p, de plus en plus fiable
    au fil de l'impression mais instable dans les premiers pourcents.
On utilise le slicer seul au début, l'extrapolation seule s'il n'y a pas d'estimation, et la moyenne des deux
entre les deux, avec un poids croissant pour l'extrapolation.
"""

# En dessous : on ne se fie qu'au slicer. Au-dessus de FULL : moyenne à parts égales.
MIN_PROGRESS = 0.03
FULL_PROGRESS = 0.15


def remaining(elapsed, progress, estimated=None):
    """→ (secondes restantes, source) ou (None, None) si on ne peut rien dire.

    elapsed   : durée d'impression écoulée en secondes (`print_stats.print_duration`, hors pauses et chauffe)
    progress  : avancement de 0 à 1
    estimated : durée totale estimée par le slicer en secondes, ou None
    """
    try:
        elapsed = float(elapsed or 0)
        progress = float(progress or 0)
    except (TypeError, ValueError):
        return None, None
    progress = max(0.0, min(1.0, progress))
    est = float(estimated) if estimated and float(estimated) > 0 else None
    by_slicer = max(0.0, est - elapsed) if est else None
    by_progress = elapsed * (1 - progress) / progress if progress >= MIN_PROGRESS and elapsed > 0 else None
    if by_slicer is not None and by_progress is not None:
        w = min(1.0, (progress - MIN_PROGRESS) / (FULL_PROGRESS - MIN_PROGRESS)) * 0.5
        return (1 - w) * by_slicer + w * by_progress, "slicer+progression"
    if by_slicer is not None:
        return by_slicer, "slicer"
    if by_progress is not None:
        return by_progress, "progression"
    return None, None
