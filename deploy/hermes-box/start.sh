#!/usr/bin/env bash
# Starts Bot HQ in its sidecar container (see Dockerfile). Settings live in /opt/hq/data/hq.env, which
# survives image rebuilds; the screens are started by the app itself (server/src/localscreens.ts).
set -euo pipefail
# The base image's Hermes settings belong to the main agent, not to this container.
unset HERMES_HOME HERMES_WRITE_SAFE_ROOT HERMES_UID HERMES_GID HERMES_DASHBOARD

ENV_FILE=/opt/hq/data/hq.env
mkdir -p /var/log/hq /root/bothq /opt/hq/data
chmod 700 /opt/hq/data

if [ ! -s "$ENV_FILE" ]; then
  echo "[hq] $ENV_FILE is missing or empty. Create it from hq.env.example, then restart this container."
  exec sleep infinity
fi
for k in XAI_API_KEY COMPOSIO_API_KEY SESSION_SECRET ALLOWED_EMAILS; do
  if ! grep -qE "^${k}=.+" "$ENV_FILE"; then
    echo "[hq] $k is not filled in in $ENV_FILE. Fill it in, then restart this container."
    exec sleep infinity
  fi
done

exec node --env-file="$ENV_FILE" /srv/hq-app/server/dist/index.js
