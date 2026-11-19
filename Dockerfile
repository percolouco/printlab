FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive TZ=UTC

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq xvfb xauth python3 python3-venv \
      libgtk-3-0t64 libwebkit2gtk-4.1-0 libglu1-mesa libgl1 libegl1 libosmesa6 \
      libsecret-1-0 libdbus-1-3 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
      libxkbcommon0 fonts-dejavu-core \
      python3-pyscard libpcsclite1 \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /venv
COPY requirements.txt /tmp/requirements.txt
RUN /venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

# Version d'OrcaSlicer : "latest" (dernière release GitHub) ou un tag précis (ex. v2.4.2).
# ORCA_REFRESH sert à invalider le cache Docker pour forcer le re-téléchargement.
ARG ORCA_VERSION=latest
ARG ORCA_REFRESH=0
COPY tools /opt/tools
RUN set -eux; \
    if [ "$ORCA_VERSION" = "latest" ]; then \
      tag=$(curl -sfL https://api.github.com/repos/OrcaSlicer/OrcaSlicer/releases/latest | jq -r .tag_name); \
    else tag="$ORCA_VERSION"; fi; \
    url="https://github.com/OrcaSlicer/OrcaSlicer/releases/download/${tag}/OrcaSlicer_Linux_AppImage_Ubuntu2404_V${tag#v}.AppImage"; \
    echo "OrcaSlicer ${tag} : ${url}"; \
    curl -fL -o /tmp/orca.AppImage "$url"; chmod +x /tmp/orca.AppImage; \
    cd /opt && /tmp/orca.AppImage --appimage-extract >/dev/null && mv squashfs-root orca && rm /tmp/orca.AppImage; \
    echo "$url" > /opt/orca/ORCA_URL; echo "$tag" > /opt/orca/ORCA_TAG; \
    /venv/bin/python /opt/tools/gen_schema.py "$tag" /opt/orca/schema.json; \
    mkdir -p /opt/orca/resources/profiles; \
    curl -fL "https://github.com/OrcaSlicer/OrcaSlicer/archive/refs/tags/${tag}.tar.gz" \
      | tar xz --strip-components=3 -C /opt/orca/resources/profiles --wildcards '*/resources/profiles/*'; \
    P=/opt/orca/resources/profiles/Qidi; \
    /venv/bin/python /opt/tools/gen_defaults.py /opt/orca/AppRun /opt/orca/schema.json /tmp/gd \
      "$P/machine/Qidi X-Max 4 0.4 nozzle.json" "$P/process/0.20mm Standard @X-Max 4.json" "$P/filament/QIDI PLA Rapido.json"; \
    rm -rf /tmp/gd /tmp/orcaslicer_model; \
    chmod -R a+rX /opt/orca

COPY app /app/app
WORKDIR /app
ENV DATA_DIR=/data SLICER_DATA_DIR=/data/slicer ORCA_DIR=/opt/orca PYTHONUNBUFFERED=1
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
EXPOSE 8000
# Traefik ignore les conteneurs tant qu'ils ne sont pas "healthy" : premier contrôle rapide
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=2s CMD curl -fs http://127.0.0.1:8000/healthz || exit 1
# En-têtes X-Forwarded-* acceptés uniquement des adresses listées dans FORWARDED_ALLOW_IPS (lu par uvicorn ; ex. "*" derrière un reverse proxy).
ENV FORWARDED_ALLOW_IPS=127.0.0.1
CMD ["/venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
