"""Atelier : entretien, firmware, santé de la QIDI Max 4 / QIDI Box, mods et astuces de la communauté.

Sources (2026-11) : wiki officiel QIDI (Max4 Maintenance Manual, filtre charbon, Box), wiki communautaire
github.com/thelegendtubaguy/QidiMax4CommunityWiki et le suivi des firmwares github.com/thelegendtubaguy/Qidi-Max4-Defaults.
Tout est en lecture seule vis-à-vis de l'imprimante : rien n'est envoyé à Klipper.
"""
import time

WIKI = "https://github.com/thelegendtubaguy/QidiMax4CommunityWiki/blob/main/docs/"
QWIKI = "https://wiki.qidi3d.com/en/"

# every_h : heures d'impression ; every_d : jours calendaires (le premier atteint compte)
TASKS = [
    {"id": "rails_xy", "name": "Graisser les tiges / rails X et Y", "every_d": 21,
     "info": "Graisse au lithium blanche sur les chariots. La graisse d'usine tient mal dans une chambre à 65 °C (mouvements qui « crissent »). QIDI : toutes les 2 à 4 semaines.",
     "link": QWIKI + "Max4/Maintenance-Manual"},
    {"id": "z_screws", "name": "Graisser les vis Z", "every_d": 60, "info": "QIDI : tous les 1 à 3 mois.", "link": QWIKI + "Max4/Maintenance-Manual"},
    {"id": "carbon_filter", "name": "Remplacer le filtre 3 en 1 (préfiltre G3, HEPA H12, charbon)", "every_h": 1440,
     "info": "Le charbon s'épuise sans signe visible : à changer à l'échéance (~10 €).", "link": QWIKI + "Max4/Activated-Carbon-Air-Filter"},
    {"id": "belts", "name": "Contrôler la tension des courroies", "every_h": 300,
     "info": "Tendeurs automatiques : desserrer les vis des poulies, amener la tête aux 4 coins, resserrer, puis calibration complète.",
     "link": QWIKI + "Max4/Adjustment-belt"},
    {"id": "sock", "name": "Vérifier la chaussette silicone de la buse", "every_h": 150,
     "info": "Prévue pour 300 °C alors que la buse monte à 370 °C : elle se dégrade sur les longues impressions chaudes et peut traîner sur la pièce.",
     "link": "https://www.reddit.com/r/QIDI_Max4/comments/1rgvuas/things_to_know_about_high_temp_printing_in_the/"},
    {"id": "board_fan", "name": "Écouter / contrôler le ventilateur de la carte mère", "every_h": 150,
     "info": "Ventilateur 24 V bridé à 60 % dans le firmware ; le processeur dépasse 70 °C chambre chaude. Roulement usé = bruit : à remplacer (QX8025M24B).",
     "link": WIKI + "internals.md"},
    {"id": "desiccant", "name": "Régénérer / changer le dessiccant de la QIDI Box", "every_d": 30,
     "info": "Garder l'humidité de la Box sous 40 %. Un réservoir de dessiccant plus grand existe (à imprimer en matière résistante à 65 °C).",
     "link": "https://www.printables.com/model/1636883-qidi-box-desiccant-vessel-qidi-q2-qidi-plus-4-qidi"},
    {"id": "bed_clean", "name": "Nettoyer le plateau (eau + liquide vaisselle, pas de solvant sur la Cool Plate)", "every_d": 14,
     "info": "Le PEI texturé accroche fort : pour le PLA la communauté conseille +0,03 à +0,05 mm de décalage Z et ~10 °C de moins au plateau.",
     "link": "https://www.reddit.com/r/QIDI_Max4/comments/1tf55ug/max_4_bed_adhesion_with_pla_is_way_too_strong/"},
    {"id": "thermal_paste", "name": "Pâte thermique de la tête (si la chauffe ralentit)", "every_h": 1000,
     "info": "À refaire quand la buse met plus de temps à chauffer qu'avant.", "link": WIKI + "faq.md"},
]

MODS = [
    {"id": "purge_chute", "cat": "Imprimante", "name": "Goulotte de purge avec bac amovible", "why": "Récupère les crottes de purge (à imprimer en PETG / ABS / ASA, la sortie est chaude).",
     "link": "https://www.printables.com/model/1594320-qidi-max-4-purge-poop-chute-by-sac3d"},
    {"id": "box_saver", "cat": "QIDI Box", "name": "Guide « filament saver » des entrées de la Box", "why": "Supprime l'angle vif qui râpe le filament ; la V3 accepte un tube PTFE de 4 mm.",
     "link": "https://makerworld.com/en/models/1899113-filament-saver-for-qidi-box-v3-ptfe-guide"},
    {"id": "box_spacer", "cat": "QIDI Box", "name": "Entretoise de pression des engrenages", "why": "Évite que le filament se déroule dans la Box à la rétraction (ABS/ASA, 7 mm).",
     "link": "https://www.printables.com/model/1654607-qidi-box-filament-retraction-fix-gear-pressure-spa"},
    {"id": "box_fan", "cat": "QIDI Box", "name": "Seuil du ventilateur de la Box", "why": "35 °C par défaut (Box1.cfg via Fluidd) : plus haut = plus silencieux, mais le filament ramollit dans une Box chaude fermée.",
     "link": QWIKI + "QIDIBOX/adjust-fan-auto-temp"},
    {"id": "cutter_handle", "cat": "Imprimante", "name": "Poussoir du couteau en PC-GF", "why": "Celui d'origine se déforme quand la chambre est chaude.",
     "link": "https://www.printables.com/model/1628435-qidi-max-4-filament-cutter-handlebutton"},
    {"id": "aux_nozzle", "cat": "Imprimante", "name": "Buse du ventilateur auxiliaire", "why": "Renvoie l'air du ventilateur latéral sur le plateau plutôt que sur la vitre.",
     "link": "https://www.printables.com/model/1761149-qidi-max4-x-max-4-aux-fan-nozzle"},
    {"id": "riser", "cat": "Imprimante", "name": "Rehausse de capot ventilée (PLA) ou pleine (Polar Cooler)", "why": "Limite le « heat creep » du PLA en chambre chaude ; à imprimer en PA / ASA.",
     "link": "https://www.printables.com/model/1604271-qidi-max-4-vented-riser-by-sac3d"},
    {"id": "alu_tension", "cat": "Imprimante", "name": "Barre de tension d'extrudeur en aluminium", "why": "La barre plastique peut se cintrer ou casser et provoquer de la sous-extrusion.",
     "link": "https://www.reddit.com/r/QidiTech3D/comments/1vdrh8j/just_wanted_to_remind_folks_i_make_aluminum/"},
    {"id": "optimized", "cat": "Logiciel", "name": "Macros optimisées + G-code de démarrage (KAMP)", "why": "Environ 10 min gagnées par impression (purge, homing, déplacements) ; maillage adaptatif. ⚠ une mise à jour du firmware les efface.",
     "link": "https://github.com/thelegendtubaguy/Qidi-Max-4-Optimized"},
    {"id": "client_cpu", "cat": "Logiciel", "name": "Écran tactile moins gourmand", "why": "Remplace les animations de l'interface : le client QIDI passe de ~55 % à ~4 % d'un cœur.",
     "link": WIKI + "mods/making_qidiclient_suck_less.md"},
    {"id": "hardening", "cat": "Logiciel", "name": "Durcir le système (avancé)", "why": "DNS codés en dur, service de détection sur le port 9010, mot de passe root identique sur toutes les machines : garder l'imprimante sur le réseau local.",
     "link": WIKI + "mods/process_hardening_optimiztion.md"},
    {"id": "second_plate", "cat": "Accessoires", "name": "Deuxième plateau (PEI lisse ou Cool Plate Pro)", "why": "Changer de matière sans attendre le refroidissement ; la Cool Plate Pro décolle le PLA seule à 30–45 °C.",
     "link": "https://us.qidi3d.com/products/qidi-cool-plate-pro"},
    {"id": "carbide", "cat": "Accessoires", "name": "Buse carbure de tungstène", "why": "Pour PA-CF / PET-CF / PPS-CF ; serrer à chaud à 1,5–2 N·m. Les buses Plus4 / Q2 ne vont pas sur la Max 4.",
     "link": "https://us.qidi3d.com/products/max4-tungsten-carbide-bimetal-nozzle-1pc"},
]

TIPS = [
    {"title": "Décalage Z qui « s'oublie »", "text": "Après un réglage pendant la 1re couche : SAVE_CONFIG puis redémarrage de Klipper, sinon la valeur n'est pas gardée.",
     "link": WIKI + "faq/z_offset.md"},
    {"title": "Ventilateurs (console)", "text": "M106 = pièce · M106 P2 = les deux auxiliaires · M106 P3 = extraction de la chambre · M106 P4 = Polar Cooler. L'objet « chamber circulation fan » est en fait l'extraction.",
     "link": WIKI + "fan_assignments.md"},
    {"title": "Imprimer hors Box (TPU, fibres, phosphorescent)", "text": "Une variable enregistrée à 0 bascule le démarrage et la détection de fin de filament sur la bobine externe ; les déchargements complets passent toujours par le menu de l'imprimante.",
     "link": WIKI + "faq.md"},
    {"title": "Séchage pendant l'impression", "text": "La Box règle sa température sur la bobine la plus fragile : ~45 °C seulement avec des bobines standard (65 °C maxi).",
     "link": QWIKI + "QIDIBOX/drying-while-printing"},
    {"title": "Pertes de pas", "text": "Le contrôle en boucle fermée (FOC) ne corrige pas la position Klipper : un pas perdu reste un décalage de couche. Firmwares 01.01.06.02 et .04 améliorent ce point.",
     "link": WIKI + "faq/max4_closed_loop_step_loss.md"},
    {"title": "Mise à jour du firmware", "text": "Pas de retour en arrière possible ; couper la Box pendant la mise à jour ; les configs personnelles (macros, corrections) sont effacées : les sauvegardes PrintLab permettent de les retrouver.",
     "link": QWIKI + "Max4/firmware-update"},
    {"title": "Dérive dimensionnelle", "text": "Sur les grandes pièces, des écarts jusqu'à 0,33 mm en X et 0,15 mm en Y ont été mesurés : corriger par un facteur d'échelle dans le slicer après mesure.",
     "link": "https://www.ixbt.com/live/3d-modelling/obzor-3d-printera-qidi-max4-chto-daet-bolshoy-format-krome-cifr-v-harakteristikah.html"},
]

FW_RELEASES = "https://api.github.com/repos/thelegendtubaguy/Qidi-Max4-Defaults/releases?per_page=5"


def task_status(task, state, hours_now, now=None):
    """Avancement d'une tâche (0 = vient d'être faite, 1 = échéance atteinte)."""
    now = now or time.time()
    st = state.get(task["id"]) or {}
    done_t, done_h = st.get("t"), st.get("h")
    parts = []
    if task.get("every_h"):
        base = done_h if done_h is not None else 0.0
        parts.append(((hours_now - base) / task["every_h"], f"{max(0.0, task['every_h'] - (hours_now - base)):.0f} h d'impression"))
    if task.get("every_d"):
        if done_t:
            parts.append(((now - done_t) / 86400 / task["every_d"], f"{max(0, task['every_d'] - (now - done_t) / 86400):.0f} jour(s)"))
        else:
            parts.append((1.0, "jamais noté"))
    ratio, left = max(parts, key=lambda p: p[0]) if parts else (0.0, "")
    return {**task, "ratio": round(ratio, 3), "left": left, "done_t": done_t, "done_h": done_h, "due": ratio >= 1.0}
