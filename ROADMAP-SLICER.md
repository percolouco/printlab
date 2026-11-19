# Slicer PrintLab — feuille de route vers la parité avec OrcaSlicer

Objectif (2026-11-14) : aucune différence d'usage avec OrcaSlicer officiel — toutes les fonctions, même qualité.
Principe : le **moteur** est le vrai Orca (CLI, sans GPU, déjà en place) ; on reconstruit l'**interface** (navigateur, 3D côté client) par paliers.
Méthode : pour chaque fonction → captures de l'Orca officiel (Xvfb ponctuel, hors production) → implémentation → comparaison côte à côte → case cochée.
Règle : une fonction n'est « faite » que si le résultat (G-code / 3MF) est identique à celui d'Orca pour le même projet.

## Palier 0 — Fondations (fait)
- [x] Moteur Orca 2.5.0 en CLI, profils système + utilisateur, héritage, schéma de réglages extrait des sources
- [x] Plateau 3D, import STL/3MF/STEP/OBJ, primitives, déplacer/pivoter/échelle/disposer, découpe, aperçu des couches, envoi Moonraker
- [x] Synchro Box (marque + matière + couleur), thèmes PrintLab, noms de plateau
- [x] Passage à Orca 2.5.1 (2026-11-14, test automatique OK)

## Palier 1 — Projet et plateau (fait le 2026-11-14)
- [x] Plusieurs plateaux en grille comme Orca : ajout, suppression, renommage, plateau actif, objets déplacés d'un plateau à l'autre (glisser ou liste « Plateau »), découpe d'un plateau ou de tous, aperçu par plateau
- [x] Ouverture d'un vrai .3mf Orca/QIDI/Bambu avec tous ses plateaux : objets, matrices, pièces spéciales, extrudeur et réglages par objet, filaments + couleurs, réglages modifiés, type de plateau
- [x] Enregistrement du projet en .3mf sans découper (Ctrl+S), tous plateaux, relu et découpé par le vrai Orca
- [x] Parité vérifiée : projet Master Spool (2 plateaux) → G-code identique à celui d'Orca 2.5.1, mouvement pour mouvement (les objets sont envoyés dans la grille de plateaux, découpe `--slice N`)
- [x] Type de plateau (PEI texturé, lisse, Cool, Engineering…) choisi dans l'interface, appliqué (`curr_bed_type`), alerte si le filament n'est pas prévu pour ce plateau
- [x] Réglages par objet / par pièce + fenêtre « Réglages modifiés » (process, filaments, imprimante, objets, pièces) avec retour à la valeur du profil
- [x] Séquence « par objet » : zone de dégagement de l'extrudeur autour de chaque objet (enveloppe convexe + extruder_clearance_max_radius / 2, grise, rouge si deux zones se chevauchent), séquence propre au plateau prise en compte
- [x] Profils : enregistrer (= dupliquer), supprimer, exporter / importer au format des préréglages Orca, comparer deux profils
- [x] Niveaux d'affichage Simple / Avancé / Développeur
- [x] Tests : `tools/test_project3mf.py` (relecture, plateaux), `tools/selftest.py` (découpe)
- Reporté aux paliers 3 et 4 (outils correspondants) : conserver à l'ouverture la peinture (supports, couture, couleurs), le texte éditable et les objets à plusieurs pièces normales non fusionnées

## Palier 2 — Couleurs, matériaux, purge (fait le 2026-11-14)
- [x] Volumes de purge calculés exactement comme « Auto-calc » d'Orca (`app/slicer/flush.py`, transposition de FlushVolCalc/FlushVolPredictor) : 0 écart sur 9 000 paires face au code C++ d'Orca compilé ; test `tools/test_flush.py`
- [x] Multiplicateur de purge du projet (0,3 par défaut comme un nouveau projet Orca 2.5 ; repris d'un .3mf ouvert)
- [x] Tour de purge : affichée quand un plateau utilise ≥ 2 filaments, position par défaut d'Orca (165, 250, ramenée sur le plateau), déplaçable à la souris, une position par plateau (`wipe_tower_x/y`)
- [x] Changements par couche (curseur de l'aperçu) : pause, changement de filament (règle d'Orca : plateau mono-filament), G-code personnalisé, modèle de G-code ; `Metadata/custom_gcode_per_layer.xml`
- [x] Filaments mixtes d'Orca 2.5 : composants, proportions, dégradé (sens, par pièce), purge 280 pour ces emplacements ; relus depuis un .3mf
- [x] Lien bobines PrintLab : bobine par emplacement de la Box (même association que la page Box), reprise couleur + profil, consommation prévue / poids restant, alerte avant impression
- [x] Parité vérifiée par G-code identique au vrai Orca (CLI) : 2 couleurs + tour, changements par couche, filament mixte
- Écarts connus : couleur d'aperçu d'un mélange approchée (modèle de pigments d'Orca non repris, affichage seulement) ; éditeur de courbe de dégradé personnalisée non repris (dégradé linéaire seulement) ; profondeur de la tour affichée approchée (Orca l'estime d'après les volumes, la découpe reste exacte) ; Orca ne permet pas de réordonner les filaments, nous non plus

## Palier 3 — Outils d'édition 3D (fait le 2026-11-14)
- [x] Objets à plusieurs pièces : pièces normales conservées à l'ouverture d'un .3mf (filament par pièce), « Séparer » en objets / en pièces, « Assembler » (Ctrl+clic)
- [x] Coupe (`app/slicer/cut.py`) : repère, options et valeurs par défaut de l'outil Coupe d'Orca (haut posé sur la coupe, bas d'origine, retourner, couper en pièces) ; connecteurs tenon / goujon, prisme / tronc, cercle / carré / hexagone / triangle, tolérances, placement automatique dans la section ; connecteurs en pièces (solide / négative) comme Orca, maillages unitaires d'Orca ; Manifold pour la coupe
- [x] Volumes modificateurs / négatifs / bloqueurs / forceurs / pièces : formes simples ou depuis un fichier
- [x] Texte 3D (`app/slicer/emboss.py`) : taille = size_in_mm / unités par em comme Orca (10 mm, 1 mm par défaut), relief / creux / modificateur, posé d'un clic sur une face ; SVG idem
- [x] Orientation automatique (`app/slicer/orient.py`) : transposition d'Orient.cpp (paramètres « surface d'interface minimale » de l'interface, angle de surplomb du process, rotation vers le ventilateur auxiliaire)
- [x] Disposition avec options (espacement, rotation), « Poser sur une face », miroir X/Y/Z, réparation du maillage, outil de mesure
- [x] Parité vérifiée par G-code identique au vrai Orca (CLI) : objet 2 pièces / 2 filaments, coupe avec 3 tenons, texte en relief 2ᵉ filament, objet réparé + miroir + volume négatif depuis un fichier ; tests `tools/test_tools3d.py`
- Écarts connus : disposition en rangées (Orca : imbrication libnest2d, placement différent) ; réparation sans traitement des auto-intersections (Orca : CGAL) ; orientation non comparée au C++ compilé (dépendances lourdes), validée sur formes types ; plan de coupe réglé par hauteur + inclinaisons (pas de poignée 3D) ; texte non rééditable après pose et pas encore projeté sur surface courbe ; polices du serveur seulement (DejaVu)

## Palier 4 — Peinture (fait le 2026-11-14)
- [x] Peinture des supports (forcer / bloquer), de la couture (forcer / bloquer), des couleurs (filament n°) et du fuzzy skin (`static/js/paint.js`)
- [x] Format de TriangleSelector d'Orca repris à l'identique : subdivision récursive (1/2/3 côtés, règles de perform_split), codage hexadécimal par triangle (`paint_supports`, `paint_seam`, `paint_color`, `paint_fuzzy_skin`), relu depuis / écrit vers le .3mf ; chaînes réelles d'Orca relues et réécrites à l'identique
- [x] Pinceau sphérique avec subdivision au bord du pinceau, remplissage par angle (triangles reliés), « Peindre les surplombs » (seuil d'angle), effacement (Maj), tout effacer ; couleurs peintes visibles en permanence
- [x] Hauteur de couche variable (`app/slicer/layerheight.py`) : profil adaptatif (SlicingAdaptive, qualité 0–1, pas de variation 0,04 mm), lissage gaussien (6 passes, rayon, garder le minimum), édition à la souris, réinitialisation ; `Metadata/layer_heights_profile.txt` lu et écrit comme Orca
- [x] Parité vérifiée par G-code identique au vrai Orca (CLI) : sphère peinte (surplombs en support forcé + zone en filament 2), sphère à hauteur de couche adaptative lissée
- Écarts connus : pinceau sphérique seulement (Orca : aussi cercle projeté, « remplissage intelligent » au niveau des sous-triangles, pinceau « triangle », hauteur limite) ; le remplissage agit sur des triangles entiers ; édition manuelle du profil à la souris approchée (Orca : adjust_layer_height_profile) ; peinture de texture (paint_texture_*) non reprise

## Palier 5 — Aperçu et contrôle (fait le 2026-11-14)
- [x] Les 14 vues d'aperçu d'Orca (type de ligne, vitesse, débit, largeur, hauteur, température, ventilateur, accélération, jerk, PA, temps de couche, outil, couleur…) avec la palette d'Orca et les options (déplacements, rétractions, coutures…)
- [x] Curseurs de couches et de mouvements, lecture animée, statistiques par type / par filament (longueur, poids, coût), temps estimé détaillé
- [x] Export G-code / 3MF, impression directe, file d'attente Moonraker (ajout, démarrage, pause, suppression)
- Écarts connus : vue « vitesse réelle » reprise au palier 8 ; avertissements de découpe = ceux du moteur d'Orca (pas d'analyse de collision propre)

## Palier 6 — Calibrations (fait le 2026-11-14)
- [x] Menu « Calibration… » du Slicer (`app/slicer/calib.py`, `POST /slicer/api/calib/{kind}`) : température (préréglages par matière d'Orca), débit passes 1 et 2, tour de pressure advance, tour de rétraction, débit volumétrique max, VFA, input shaping (fréquence, amortissement), jerk / SCV
- [x] Modèles d'Orca (`resources/calib/*.drc`, décodés avec DracoPy ; tests de débit lus dans les .3mf d'Orca, débit par nom d'objet), découpes, réglages d'objet / process / filament / imprimante repris de `Plater::calib_*`
- [x] Les « paramètres de calibration » d'Orca n'existent que dans l'interface (Print::set_calib_params) : reproduits par G-code de couche (M104, SET_PRESSURE_ADVANCE, SET_INPUT_SHAPER, SET_VELOCITY_LIMIT avec la formule interpolate_value_across_layers) et par post-traitement du G-code (longueur de rétraction selon z, vitesse de paroi extérieure selon z ou par paliers)
- [x] Les 10 calibrations testées de bout en bout (préparation, découpe, valeurs relevées dans le G-code)
- Écarts connus : pressure advance « ligne » et « motif » non repris (G-code généré en dur par Orca) ; débit linéaire YOLO, tolérance, test de « fast tower » d'input shaping non repris ; les commandes de couche sont insérées au changement de couche (Orca : au même endroit, sans tête de commentaire) ; amortissement : fréquence X et Y en une seule commande SET_INPUT_SHAPER (effet identique)

## Palier 7 — Finitions (fait le 2026-11-14)
- [x] Raccourcis clavier = liste officielle d'Orca 2.5 (`src/slic3r/GUI/Shortcuts.cpp`) : projet (Ctrl+N/O/S/Maj+S/I), découpe (Ctrl+R/G/Maj+G), édition (Ctrl+Z/Y, Ctrl+A, Ctrl+C/X/V, Suppr, Ctrl+D, Ctrl+K, +/−, 1–9), placement (A, Q, flèches 10 mm / Maj 1 mm, Page↑/↓ 45°), outils (M R S F C T U, peinture L P N H), vues (Ctrl+0–7, I/O, Tab, Maj+Tab, Ctrl+F), aperçu (↑↓ ←→, Début/Fin, L, Maj+G, Espace) ; fenêtre « Raccourcis » (?)
- [x] Annuler / rétablir sans limite de nombre (limite mémoire ~150 Mo) : chaque état du projet (objets, peinture, réglages, filaments, plateaux) ; boutons ↶ ↷
- [x] Glisser-déposer n'importe où dans la fenêtre ; un .3mf seul : « Ouvrir comme projet » ou « Géométrie seule » (comme Orca)
- [x] Mobile / tablette : liste des objets et panneau d'objet repliables, pas de débordement horizontal (testé Pixel 7, iPad)
- [x] Visite guidée au premier lancement (9 étapes), relançable par le bouton « Aide »
- [x] Gros modèles : three-mesh-bvh (MIT, `vendor/addons/three-mesh-bvh.js`, mode indirect qui garde l'ordre des triangles) pour sélection / peinture / mesure — 10 coups de pinceau sur 1,3 M triangles : 11,6 s → 0,57 s
- [x] Non-régression : `tools/regress.py` découpe 11 plateaux de référence (`tools/regress/*.3mf`, paliers 1 à 4) et compare couches / filament / temps / empreinte des mouvements à `tools/regress/reference.json` ; appelé par `scripts/update-orca.sh` avant toute bascule (Orca 2.5.1 : 11/11 identiques, découpe déterministe)
- Écarts connus (repris au palier 8 : anglais, raccourcis personnalisables, B / E / D / Y) ; sur Ctrl+V les copies sont placées à côté (Orca : décalage puis disposition)

## Palier 8 — Outils et calibrations restants, langue, raccourcis (fait le 2026-11-15)
- [x] Oreilles de bordure (E, `app/slicer/brim.py`) : pose / suppression, rayon (Ctrl+molette, défaut = largeur 1re couche × 8), génération automatique de GLGizmoBrimEars (section à 0,1 mm, fermeture 0,1 et décalage 0,05, Douglas-Peucker, sommets convexes / concaves selon l'angle max), passage en bordure « peinte » ; `Metadata/brim_ear_points.txt` écrit / relu **dans le repère recentré** qu'Orca applique à un objet à un seul volume (sinon le moteur ignore les oreilles) — test `tools/test_brim.py` (oreilles présentes dans le G-code d'Orca)
- [x] Booléen (B) : union / différence / intersection entre deux pièces d'un objet (Manifold ; Orca : mcut), « supprimer la pièce d'entrée » comme Orca
- [x] Simplifier (niveau de détail ou taux de réduction ; fast-simplification, Orca : QuadricEdgeCollapse)
- [x] Aligner / répartir (GLGizmoAlignment) : X / Y min-centre-max, répartir, ensemble sur le plateau
- [x] Assemblage (Y) « face contre face » (GLGizmoAssembly) : normales opposées, points confondus ou non, écart
- [x] Texture en relief (D, `app/slicer/texture.py`) avec les 44 textures d'Orca 2.5 ou une image : subdivision uniforme, projection tri-planaire, profondeur / taille / rotation / niveau neutre / adoucir, zone côtés / tout / dessus, base plane
- [x] Vue « Vitesse réelle » (planificateur trapézoïdal avec anticipation, jonctions façon Klipper)
- [x] Calibrations PA « lignes » (post-traitement : le test remplace la 1re couche, comme GCode.cpp) et « motif » (G-code de couche autour de la poignée), port de `calib.cpp` (`app/slicer/calib_pa.py`) ; débit YOLO et YOLO perfectionniste (Orca-LinearFlow)
- [x] « Disposer » calculé par le vrai moteur d'Orca (`--arrange 1`, libnest2d), plateaux ajoutés comme Orca si tout ne tient pas ; rangées en repli
- [x] Raccourcis personnalisables (liste des raccourcis → ✎) ; Échap ferme les fenêtres
- [x] Interface en anglais (Projet → Langue) : réglages avec les libellés anglais officiels d'Orca (fr/OrcaSlicer.mo lu à l'envers), interface traduite à la volée
- [x] Non-régression : 11/11 plateaux identiques à la référence
- Écarts connus : texture en relief calculée par PrintLab (Orca : bake avec subdivision adaptive, LSCM, calques, masque peint — maillage différent au bit près, découpe identique pour un maillage donné) ; booléen et simplification par d'autres bibliothèques (Manifold, fast-simplification) ; assemblage « point contre point » non repris ; PA motif : un seul test (une vitesse, une accélération) ; temps estimé du test PA « lignes » = celui du modèle de remplacement ; anglais : quelques messages détaillés restent en français ; raccourcis personnalisables limités aux touches simples (avec Ctrl / Maj)

## Palier 9 — Passe de vérification face à Orca (fait le 2026-11-15)
- [x] Modificateurs par plage de hauteur (outil « Plages ») : `Metadata/layer_config_ranges.xml` écrit / relu comme Orca ; `layer_height` toujours présent dans une plage (sans lui, le moteur d'Orca plante — Slicing.cpp le lit sans vérifier) ; vérifié : 100 % de remplissage entre 3 et 6 mm appliqué par Orca
- [x] Réglages par plateau (⚙ près des plateaux) : type de plateau, séquence d'impression, vase spirale, enregistrés dans les métadonnées du plateau (`bed_type`, `print_sequence`, `spiral_mode`) et appliqués par Orca à la découpe
- [x] Export STL du plateau ou de tous les objets (Projet → Exporter)
- [x] Non-régression : 11/11 plateaux identiques

## Suivi
- Une section « Parité » dans les paramètres du Slicer listera ce qui est fait/manque (alimentée par ce fichier).
- Chaque palier se termine par : tests automatiques (découpe de 5 projets de référence, comparaison G-code), captures, commit, mise en prod, note dans la mémoire du projet.
