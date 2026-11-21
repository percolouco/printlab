# Étiquettes RFID pour la QIDI Box

Page PrintLab : **Box → Étiquettes RFID** (`#/rfid`), utilisable depuis le téléphone.

## Principe
- La QIDI Box lit des étiquettes **MIFARE Classic 1K** (13,56 MHz). Format repris de BoxRFID (TinkerBarn) :
  bloc 4, clé A `D3F7D3F7D3F7` (puis `FFFFFFFFFFFF`), octet 0 = matière, 1 = couleur, 2 = marque, le reste à 0.
- Les codes sont ceux de `officiall_filas_list.cfg` de l'imprimante (`[filaN]`, `[colordict]`, `[vendor_list]`), lus par
  Moonraker en lecture seule (copie locale dans `data/officiall_filas_list.cfg`, copie d'origine `app/qidi_filas_default.cfg`).
- L'étiquette ne contient pas d'identifiant de bobine : à l'écriture, PrintLab mémorise la signature (marque, matière,
  couleur telles que la Box les affichera) dans la table `rfid_tags`. Quand la Box lit une étiquette
  (`box0_filament_info_N_info_from_rfid = 1`), PrintLab associe l'emplacement à la bobine dont la signature correspond
  (`rfid_autolink`, appelé par `/api/box` et toutes les 20 s en tâche de fond). Deux bobines identiques : on garde celle
  déjà associée, sinon la page Box demande de choisir.
- Rien n'est écrit sur l'imprimante : seule l'association PrintLab (`slot_map`) change.

## Pourquoi pas directement l'iPhone
iOS (Core NFC) et Safari ne savent ni lire ni écrire le MIFARE Classic : il faut un encodeur. L'iPhone pilote l'écriture
depuis la page web.

## Encodeurs pris en charge (réglage `rfid_writer`)
1. **Lecteur USB PC/SC (ACR122U)** sur le serveur — réglage « Lecteur USB ».
   - Sur l'hôte : `sudo apt install pcscd libacsccid1` (ou `libccid`), puis `sudo systemctl enable --now pcscd`.
   - Dans `docker-compose.yml` de PrintLab, ajouter le volume `- /run/pcscd:/run/pcscd` et redémarrer.
   - Le conteneur contient déjà `python3-pyscard` / `libpcsclite1`.
2. **Module Wi-Fi ESP32 + PN532** — réglage « Module Wi-Fi », adresse `http://<ip>`.
   - Croquis Arduino : `firmware/printlab-rfid/printlab-rfid.ino` (Wi-Fi à renseigner ; PN532 en I2C, SDA 27 / SCL 22
     comme le CYD de BoxRFID-Touch). Non testé sur matériel à ce jour.
3. **Étiquette simulée** (`mock`) pour essayer l'interface sans matériel.

## Fichiers
- `app/rfid.py` : codes, suggestions (matière, couleur la plus proche, marque), signature, correspondance.
- `app/rfid_writer.py` : pilotes (PC/SC, HTTP, simulé).
- `app/main.py` : `/api/rfid`, `/api/rfid/suggest/{id}`, `/api/rfid/write`, `/api/rfid/read`, `/api/rfid/tags/{id}`.

## Puces d'origine Bambu Lab (micrologiciel Box de Valve Oil) / Original Bambu Lab chips

> **EN** — With the QIDI Box firmware from [Valve Oil](https://github.com/thelegendtubaguy/valve-oil) (GPL-3.0, by thelegendtubaguy),
> the Box reads the **original RFID chips of Bambu Lab spools**, and PrintLab links the slot to the matching spool of your stock.
> PrintLab neither ships nor flashes this firmware: install it with Valve Oil's own tools (steps below). Setting `rfid_bambu` (on by default).

### Pourquoi un autre micrologiciel ?
Les puces Bambu Lab sont des MIFARE Classic chiffrées avec une clé propre à chaque puce (dérivée de son UID). Le micrologiciel QIDI de
la Box ne sait lire qu'avec la clé par défaut. Le micrologiciel Box de **Valve Oil** ajoute deux commandes bas niveau au lecteur ; la
lecture et le décodage se font ensuite dans Klipper par le module `box_rfid` de Valve Oil. **Tout le mérite de la lecture revient au
projet Valve Oil** : PrintLab se contente d'exploiter ce que la Box annonce.

### Installation (partie RFID seule, testée avec Valve Oil 26.11.18.2 sur Max 4)
Deux possibilités :
- **Valve Oil complet** (`./install.sh`) : installe tout, RFID compris. Rien d'autre à faire. Attention, il modifie beaucoup de choses
  sur l'imprimante (Fluidd, Moonraker, services) ; lis sa documentation.
- **Seulement la lecture RFID**, en SSH sur l'imprimante, imprimante au repos :
  1. Télécharge et décompresse la release de Valve Oil (`valve-oil-<version>.tar.gz`, vérifie le `.sha256`).
  2. Sauvegarde ta config : `tar -czf ~/avant-rfid.tgz -C ~ printer_data/config QIDI_Client/resource/filament_config`.
  3. Flashe la Box : `./box-firmware.sh install --box 1` (le micrologiciel QIDI d'origine est sauvegardé par l'outil).
  4. Copie les deux modules Klipper de la release en les renommant :
     `installer/klipper/extras/box_rfid.py` → `~/klipper/klippy/extras/tltg_box_rfid.py` et
     `installer/klipper/extras/filament_catalog.py` → `~/klipper/klippy/extras/tltg_filament_catalog.py`.
  5. Crée `~/printer_data/config/bambu_rfid.cfg` contenant la ligne `[tltg_box_rfid]`, ajoute `[include bambu_rfid.cfg]` dans
     `printer.cfg` **après** `[include box.cfg]`, puis redémarre Klipper.
  6. Vérifie : `./box-firmware.sh status` doit afficher une version `…-valve-oil…`. La commande G-code `VO_BOX_RFID_REPORT SLOT=0 SECONDS=8`
     lit la puce de l'emplacement 1A sans aucun mouvement (fais tourner la bobine à la main devant le lecteur).
- **Retour arrière** : `./box-firmware.sh restore`, puis retire l'inclusion, `bambu_rfid.cfg` et les deux modules.

Au démarrage, le module ajoute à la base de filaments QIDI les filaments Bambu Lab (et Anycubic, Elegoo, Creality) manquants, sans
toucher aux entrées existantes.

### Ce que fait PrintLab
La Box annonce la marque (`Bambu`), le nom (`PLA Basic`…), la matière et la couleur lues sur la puce (elle ne marque pas ces bobines
comme « lues par RFID », d'où une logique propre). PrintLab associe l'emplacement à la bobine **de ton stock** de marque Bambu Lab,
de même matière et de couleur la plus proche, en préférant le même nom/finition et une bobine déjà entamée, et garde la bobine déjà
associée si elle correspond. La page Box affiche un badge « RFID Bambu », et un avertissement si aucune bobine du stock ne correspond.
Réglage `rfid_bambu` (activé par défaut). **PrintLab n'écrit rien sur l'imprimante pour cela.**
