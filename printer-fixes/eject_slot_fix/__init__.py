# Correctif du déchargement QIDI Box (firmware SOC 01.01.07.01, multi_color_controller.so)
#
# Bug : EJECT_FILAMENT_CONTROL SLOT=n, quand rien n'est chargé dans la tête
# (last_load_slot = slot16) et que le capteur de sortie de la Box est libre,
# BoxAdapterV1.flow_decision_func choisit le flux 0 sans renseigner
# task_queue_manager.targer_eject_slot. eject() fait alors
# 'box_stepper ' + None -> TypeError -> Klipper en shutdown.
#
# Correctif : après la décision, si la cible est vide, on la renseigne avec le
# slot demandé ('slot%d'). Rien d'autre n'est modifié.
#
# Sans dépendance : la section [eject_slot_fix] est dans eject_slot_fix.cfg, dans
# CE dossier, et printer.cfg l'inclut par un motif (glob). Si une mise à jour QIDI
# efface le dossier, le motif ne trouve rien et Klipper démarre normalement (le
# correctif est simplement perdu). Le module n'échoue jamais : en cas de souci il
# écrit dans klippy.log et ne fait rien.
import importlib
import logging


def _wrap(cls):
    orig = cls.__dict__.get('flow_decision_func')
    if orig is None or getattr(orig, '_eject_fix', False):
        return False

    def flow_decision_func(self, flow, *args, **kwargs):
        ret = orig(self, flow, *args, **kwargs)
        try:
            slot = args[0] if args else kwargs.get('slot')
            tqm = getattr(self, 'task_queue_manager', None)
            if (flow == 'EJECT' and tqm is not None and isinstance(slot, int) and slot >= 0
                    and getattr(tqm, 'targer_eject_slot', None) is None):
                tqm.targer_eject_slot = 'slot%d' % slot
                logging.info("eject_slot_fix: targer_eject_slot vide, renseigné à slot%d", slot)
        except Exception:
            logging.exception("eject_slot_fix")
        return ret

    flow_decision_func._eject_fix = True
    setattr(cls, 'flow_decision_func', flow_decision_func)
    return True


class EjectSlotFix:
    def __init__(self, config):
        try:
            mcc = importlib.import_module('extras.multi_color_controller')
            done = [name for name in ('BoxAdapterV1', 'BoxAdapterV2')
                    if hasattr(mcc, name) and _wrap(getattr(mcc, name))]
            logging.info("eject_slot_fix: correctif appliqué à %s", ', '.join(done) or 'rien')
        except Exception:
            logging.exception("eject_slot_fix: non appliqué (module QIDI changé ?)")


def load_config(config):
    return EjectSlotFix(config)
