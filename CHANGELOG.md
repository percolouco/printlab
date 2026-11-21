# Changelog

Toutes les évolutions notables de PrintLab. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versions selon [SemVer](https://semver.org/lang/fr/).

## [Non publié]

### Ajouté
- **Appli installable (PWA)** : icône sur l'écran d'accueil (iOS, Android), plein écran, barre d'onglets en bas sur téléphone,
  session prolongée à chaque utilisation.

### Modifié
- Le choix de la langue passe de la barre du haut à **Paramètres → Apparence → Langue**.
- README et docs/RFID.md : nouvelles fonctions décrites, guide d'installation de la lecture des puces Bambu Lab avec le micrologiciel
  de Box de Valve Oil, crédits Valve Oil.

## [1.2.0] — 2026-11-21

### Ajouté
- **Séchage au lancement d'une impression** : dans la fenêtre « Lancer l'impression », sécher la Box **avant** (l'impression
  démarre automatiquement à la fin du séchage, avec une alerte) ou **pendant** l'impression. Température et durée proposées
  selon les matières du fichier ; impression programmée visible et annulable sur la page Box.
- **RFID Bambu Lab** : avec le micrologiciel de Box Valve Oil, les puces d'origine des bobines Bambu Lab sont lues et la bobine
  correspondante du stock est associée automatiquement à l'emplacement (voir docs/RFID.md).
- **Fichiers à imprimer** : glisser-déposer vers un dossier, fenêtre « Déplacer » avec arborescence, vignette de dossier en
  mosaïque, actions au survol (sélection, imprimer, renommer, supprimer) et actions groupées.

### Corrigé
- Erreurs 500 aléatoires : une connexion SQLite par thread.
- Unités Mo/Go/Ko affichées MB/GB/KB en anglais.

## [1.1.0] — 2026-11-20

### Ajouté
- **Interface en anglais** : bouton EN / FR dans la barre du haut, pour toute l'application, Slicer compris
  (langue du navigateur par défaut). Pages, fenêtres, confirmations, messages d'erreur du serveur et contenus de l'Atelier.
- Dates et nombres affichés au format de la langue choisie.
- README en anglais ([README.en.md](README.en.md)).

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
