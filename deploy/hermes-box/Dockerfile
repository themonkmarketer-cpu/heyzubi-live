# Bot HQ beside an existing Hermes container, with local screens instead of Orgo (HQ_SCREENS=local).
#
# Built on the same image as the Hermes agent it serves, so the extra bots run the very same Hermes.
# Runs as a sidecar that shares that agent's network (compose: network_mode "service:hermes"), so the
# agent reaches /mcp on 127.0.0.1 and the app reaches the agent's API on 127.0.0.1.
#
#   docker build -t local/bot-hq:local-screens --build-arg HERMES_IMAGE=docker.io/nousresearch/hermes-agent:v0.22.5 .
#
# Needs hq-app.tgz (scripts/pack.sh) next to this file.
ARG HERMES_IMAGE=docker.io/nousresearch/hermes-agent:v0.22.5
FROM ${HERMES_IMAGE}

USER root
ENV DEBIAN_FRONTEND=noninteractive

# Screens (X server, window manager, VNC), what the box scripts draw with (GTK for Python, xdotool,
# wmctrl), a browser, a terminal for subscription sign-ins, and fonts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc xfwm4 xfconf dbus dbus-x11 x11-utils x11-xserver-utils wmctrl xdotool \
      python3 python3-gi python3-gi-cairo python3-yaml gir1.2-gtk-3.0 librsvg2-common \
      chromium xfce4-terminal xterm adwaita-icon-theme \
      fonts-inter fonts-dejavu-core fonts-noto-color-emoji fonts-liberation fonts-noto-cjk \
      openssl curl ca-certificates procps tini \
 && rm -rf /var/lib/apt/lists/*

# A private Node 22, as scripts/install-on-computer.sh uses (the SQLite package's ready-made binary targets it).
ARG NODE_V=v22.21.1
RUN mkdir -p /opt/hq-node \
 && curl -fsSL "https://nodejs.org/dist/${NODE_V}/node-${NODE_V}-linux-x64.tar.gz" | tar -xz -C /opt/hq-node --strip-components=1

COPY hq-app.tgz /tmp/hq-app.tgz
RUN mkdir -p /srv/hq-app \
 && tar -xzf /tmp/hq-app.tgz -C /srv/hq-app \
 && rm /tmp/hq-app.tgz \
 && cd /srv/hq-app \
 && PATH=/opt/hq-node/bin:$PATH npm ci --omit=dev -w server --ignore-scripts --no-audit --no-fund \
 && PATH=/opt/hq-node/bin:$PATH node -e "require('/srv/hq-app/node_modules/better-sqlite3')(':memory:').prepare('select 1').get()"

COPY start.sh /srv/hq-start.sh

# The screens' clocks and Chrome follow the machine's time zone (the box scripts pass no TZ along).
ARG TZ=Asia/Kolkata
RUN ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime && echo "${TZ}" > /etc/timezone

# The image's own settings are for the agent that runs as `hermes` in /opt/data; this container runs
# the app as root, and every extra bot gets its own Hermes home (ENGINES_DIR).
# The extra bots' gateways run as root here, each in its own home, so the image's root guard is lifted.
ENV HERMES_HOME= HERMES_WRITE_SAFE_ROOT= HERMES_UID= HERMES_GID= HERMES_DASHBOARD= \
    HERMES_ALLOW_ROOT_GATEWAY=1 \
    PATH=/opt/hq-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /srv/hq-app
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash", "/srv/hq-start.sh"]
