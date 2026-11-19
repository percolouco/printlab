# Changelog

Toutes les évolutions notables de PrintLab. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versions selon [SemVer](https://semver.org/lang/fr/).

## [1.0.0] — 2026-11-19

Première version publique.

### Ajouté
- Gestion des bobines, filaments et fabricants : assistant avec catalogue intégré (SpoolmanDB), pesée, fiabilité du poids,
  photos officielles, historique modifiable, export CSV, alertes de stock bas.
- Factures PDF : lecture, récapitulatif à valider, intégration au stock avec le prix réellement payé.
- Imprimante Klipper/Moonraker : vue en direct dessinée, caméra, temps restant fiable, fichiers à imprimer, journal des impressions
  (coût matière et électrique), sauvegardes de configuration, actions d'écriture optionnelles avec garde-fous.
- QIDI Box : vue dessinée avec niveau des bobines, association emplacement ↔ bobine, synchronisation avec l'imprimante,
  bobine de relais, suivi de consommation par emplacement, séchage, étiquettes RFID.
- Slicer web basé sur le moteur OrcaSlicer : plateaux multiples, projets 3MF compatibles Orca, multi-couleurs, peinture,
  outils 3D, aperçu des couches, calibrations, envoi à l'imprimante avec choix des emplacements de la Box.
- Atelier (entretien), recherche de modèles 3D, alertes Home Assistant, API compatible Spoolman, import Spoolman, thèmes.
