#!/usr/bin/env bash
# Met à jour PrintLab vers la dernière version d'OrcaSlicer (ou une version précise).
#
#   scripts/update-orca.sh            # dernière release GitHub
#   scripts/update-orca.sh v2.5.0     # version précise
#   scripts/update-orca.sh --force    # reconstruit même si la version n'a pas changé
#
# Étapes : construction d'une nouvelle image -> test automatique (profils + découpe
# multi-filament) -> non-régression sur les plateaux de référence (tools/regress.py) -> bascule seulement si tout passe. Refuse de basculer pendant une impression.
set -euo pipefail

DEPLOY_DIR=${DEPLOY_DIR:-/opt/container/printlab}
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)
FORCE=0
TARGET=latest
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    v*) TARGET="$a" ;;
    *) echo "argument inconnu : $a" >&2; exit 2 ;;
  esac
done

if [ "$TARGET" = latest ]; then
  TARGET=$(curl -sfL https://api.github.com/repos/OrcaSlicer/OrcaSlicer/releases/latest | jq -r .tag_name)
fi
CURRENT=$(docker exec printlab cat /opt/orca/ORCA_TAG 2>/dev/null || echo "aucune")
echo "OrcaSlicer installé : $CURRENT — cible : $TARGET"
if [ "$CURRENT" = "$TARGET" ] && [ $FORCE = 0 ]; then
  echo "Déjà à jour."
  exit 0
fi

echo "Construction de l'image avec OrcaSlicer $TARGET…"
docker build -t printlab:candidate --build-arg ORCA_VERSION="$TARGET" --build-arg ORCA_REFRESH="$TARGET-$(date +%s)" "$SRC_DIR"

echo "Test de l'image…"
if ! docker run --rm --init printlab:candidate /venv/bin/python /opt/tools/selftest.py; then
  echo "Le test a échoué : la version actuelle est conservée." >&2
  exit 1
fi

echo "Non-régression : découpe du jeu de projets de référence (tools/regress)…"
if ! docker run --rm --init printlab:candidate /venv/bin/python /opt/tools/regress.py; then
  echo "Une découpe du jeu de référence a échoué : la version actuelle est conservée." >&2
  exit 1
fi
echo "(Les G-code « CHANGÉ » ci-dessus sont normaux si la nouvelle version d'Orca modifie le moteur : vérifie que filament et temps restent cohérents."
echo " Après la bascule, nouvelle référence : docker run --rm -u $(id -u) -e HOME=/tmp -v $SRC_DIR/tools:/opt/tools printlab:local /venv/bin/python /opt/tools/regress.py --record, puis commit de tools/regress/reference.json.)"

MR=${MOONRAKER_URL:-$(grep -hoP 'MOONRAKER_URL=\K\S+' "$DEPLOY_DIR/docker-compose.yml" "$DEPLOY_DIR/.env" 2>/dev/null | head -1 || true)}
STATE=inconnu
if [ -n "$MR" ]; then
  STATE=$(curl -s -m5 "$MR/printer/objects/query?print_stats" | jq -r '.result.status.print_stats.state' 2>/dev/null || echo inconnu)
else
  echo "MOONRAKER_URL inconnue : impossible de vérifier qu'aucune impression n'est en cours (exporte MOONRAKER_URL=http://ip:7125 pour activer la vérification)."
fi
if [ "$STATE" = printing ] || [ "$STATE" = paused ]; then
  echo "Impression en cours ($STATE) : bascule reportée. Relance le script plus tard." >&2
  exit 3
fi

docker tag printlab:candidate printlab:local
docker rmi printlab:candidate >/dev/null
cd "$DEPLOY_DIR"
docker compose up -d --no-build
echo "PrintLab utilise maintenant OrcaSlicer $TARGET."
