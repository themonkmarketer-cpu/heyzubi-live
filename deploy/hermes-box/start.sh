#!/usr/bin/env bash
# Starts HeyZubi in its sidecar container (see Dockerfile). Settings live in /opt/hq/data/hq.env, which
# survives image rebuilds; the screens are started by the app itself (server/src/localscreens.ts).
set -euo pipefail
# The base image's Hermes settings belong to the main agent, not to this container.
unset HERMES_HOME HERMES_WRITE_SAFE_ROOT HERMES_UID HERMES_GID HERMES_DASHBOARD

ENV_FILE=/opt/hq/data/hq.env
mkdir -p /var/log/hq /root/heyzubi /opt/hq/data
chmod 700 /opt/hq/data

# Team members that are Hermes profiles run as the user who owns the main agent's home (uid 1000 on hermes-box).
# The main agent's container maps its "hermes" user to that uid at start; do the same here, or tools like git
# refuse to work ("cannot find name for user ID").
HERMES_DIR=/opt/data
if [ -d "$HERMES_DIR" ]; then
  owner_uid=$(stat -c %u "$HERMES_DIR"); owner_gid=$(stat -c %g "$HERMES_DIR")
  if [ "$owner_uid" != 0 ] && ! getent passwd "$owner_uid" >/dev/null; then
    if getent passwd hermes >/dev/null; then
      sed -i -E "s/^hermes:x:[0-9]+:[0-9]+:/hermes:x:${owner_uid}:${owner_gid}:/" /etc/passwd
      sed -i -E "s/^hermes:x:[0-9]+:/hermes:x:${owner_gid}:/" /etc/group
    else
      getent group "$owner_gid" >/dev/null || echo "hermes:x:${owner_gid}:" >> /etc/group
      echo "hermes:x:${owner_uid}:${owner_gid}:Hermes:${HERMES_DIR}:/bin/sh" >> /etc/passwd
    fi
  fi
fi

if [ ! -s "$ENV_FILE" ]; then
  echo "[heyzubi] $ENV_FILE is missing or empty. Create it from hq.env.example, then restart this container."
  exec sleep infinity
fi
for k in XAI_API_KEY COMPOSIO_API_KEY SESSION_SECRET ALLOWED_EMAILS; do
  if ! grep -qE "^${k}=.+" "$ENV_FILE"; then
    echo "[heyzubi] $k is not filled in in $ENV_FILE. Fill it in, then restart this container."
    exec sleep infinity
  fi
done

exec node --env-file="$ENV_FILE" /srv/hq-app/server/dist/index.js
