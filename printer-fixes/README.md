# Correctifs côté imprimante (QIDI X-Max 4)

## eject_slot_fix.py — déchargement Box qui met Klipper en shutdown

- **Symptôme** : « Décharger » un slot de la QIDI Box → `!! Internal error on command:"EJECT_FILAMENT_CONTROL"`, Klipper en shutdown
  (`TypeError: can only concatenate str (not "NoneType") to str`, `BoxAdapterV1.eject`, ligne 1106). Vu le 2026-11-03 et le 2026-11-10.
- **Cause** (firmware SOC 01.01.07.01, `multi_color_controller.so`) : quand rien n'est chargé dans la tête (`last_load_slot = slot16`)
  et que le capteur de sortie de la Box est libre, `flow_decision_func('EJECT', slot)` choisit le flux 0 sans renseigner
  `task_queue_manager.targer_eject_slot` ; `eject()` fait ensuite `'box_stepper ' + None`.
- **Correctif** : module Klipper (dossier `eject_slot_fix/`) qui enveloppe `flow_decision_func` et renseigne la cible `slotN` si elle est restée vide. Il n'échoue jamais : en cas de souci il écrit dans klippy.log et ne fait rien.
- **Installation** : copier le dossier `eject_slot_fix/` dans `~/klipper/klippy/extras/` sur l'imprimante, puis ajouter dans `printer.cfg`, après `[multi_color_controller]` :
  `[include /home/qidi/klipper/klippy/extras/eject_slot_fix/*.cfg]`, puis `FIRMWARE_RESTART`.
- **Sans dépendance après une mise à jour QIDI** : la section `[eject_slot_fix]` est dans `eject_slot_fix.cfg`, à côté du code, et `printer.cfg` l'inclut par un motif (`*.cfg`).
  Klipper accepte un motif qui ne trouve rien : si la mise à jour efface le dossier, Klipper démarre normalement, sans le correctif. Si elle le garde, le correctif continue de fonctionner.
  Vérifié avec le parseur de config de Klipper (dossier présent / dossier effacé).
