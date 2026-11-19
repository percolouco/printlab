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
