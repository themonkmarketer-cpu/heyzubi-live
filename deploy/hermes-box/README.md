# HeyZubi beside a Hermes container, without Orgo

This runs HeyZubi on a machine that already runs Hermes in Docker (here: hermes-box, Hermes in the
`hermes` service of `~/ops/compose.yml`). Orgo is not used: with `HQ_SCREENS=local` every bot's screen
is an X display on this machine (Xvfb, xfwm4, x11vnc), started by the app (`server/src/localscreens.ts`).

## How it fits

- The app runs in its own container, `heyzubi-live`, built on the same Hermes image as the agent.
- `heyzubi-live` shares the agent's network (`network_mode: "service:hermes"`). The agent reaches the app's tools
  at `http://127.0.0.1:8787/mcp/primary`, and the app reaches the agent's API at `http://127.0.0.1:8642`.
  `/mcp` only answers loopback calls, and this is what keeps that true.
- `heyzubi-live` mounts the agent's Hermes home (read for its API key, model settings and memory). It does not
  mount the Obsidian vault or the brain socket.
- Extra bots are Hermes gateways started by the app inside `heyzubi-live`, each with its own home under
  `/opt/hq/data/engines`. They start from the agent's model settings and keys.
- The app is reached over Tailscale only: `tailscale serve` gives it an HTTPS address on the tailnet.

## Compose

Add to the `hermes` service:

```yaml
    ports:
      - "127.0.0.1:8787:8787"     # HeyZubi, published here because heyzubi-live shares this service's network
```

Add a service and two volumes:

```yaml
  heyzubi-live:
    image: local/heyzubi-live:local-screens
    build: ./heyzubi-live
    network_mode: "service:hermes"
    depends_on: [hermes]
    restart: unless-stopped
    shm_size: "2gb"                # Chrome needs more than Docker's 64 MB default
    environment:
      - TZ=Asia/Kolkata
    volumes:
      - /home/hermes/.hermes:/opt/data
      - heyzubi_data:/opt/hq/data
      - heyzubi_files:/root/heyzubi
    deploy:
      resources:
        limits:
          memory: 6G

volumes:
  heyzubi_data:
  heyzubi_files:
```

An install from before the rename (service `hq`, volumes `hq_data` and `hq_files`) keeps its data: give the new
volume keys the old volumes' names (`heyzubi_data: { name: ops_hq_data }`, `heyzubi_files: { name: ops_hq_files }`).
The app finds the old `/root/bothq` folder too, but mounting the files volume at `/root/heyzubi` is all it takes.

If the `hermes` container is recreated, recreate `heyzubi-live` too (`docker compose up -d heyzubi-live`): it lives in that
container's network.

## First start

1. `scripts/pack.sh deploy/hermes-box/hq-app.tgz`, then copy this folder to `~/ops/heyzubi-live` on the machine.
2. `docker compose up -d --build heyzubi-live`. It waits until its settings exist.
3. Settings: copy `hq.env.example` to `/opt/hq/data/hq.env` in the container, fill in `SESSION_SECRET`
   (`openssl rand -hex 32`), the addresses and the URL, then the owner types in `XAI_API_KEY` and
   `COMPOSIO_API_KEY`. `docker compose restart heyzubi-live`.
4. `tailscale serve --bg --https=8443 http://127.0.0.1:8787` on the host.
5. Give the agent the app's tools: `docker compose exec heyzubi-live python3 /srv/hq-app/scripts/add-hq-to-hermes.py
   --config /opt/data/config.yaml --entry /opt/hq/data/hermes-mcp-hq.yaml` (the entry file is written by
   the setup step; see below). Hermes picks it up without a restart.
6. So the agent's browser is the one on its screen: set `browser.cdp_url: http://127.0.0.1:9299` in its
   `config.yaml` (9299 is the DevTools port of the default screen's Chrome).

The MCP entry for step 5 (the token is the HMAC of `mcp:primary` with `SESSION_SECRET`):

```bash
tok=$(printf 'mcp:primary' | openssl dgst -sha256 -hmac "$SESSION_SECRET" -r | cut -d' ' -f1)
cat > /opt/hq/data/hermes-mcp-hq.yaml <<EOF
  hq:
    url: http://127.0.0.1:8787/mcp/primary
    headers:
      Authorization: Bearer $tok
    timeout: 1800
    connect_timeout: 30
EOF
```

## Ports inside the shared network

8787 the app · 8650+ extra bots' gateways · 7391 the home screen page · 9299, 9300+ Chrome DevTools
per screen · 15999, 16000+ VNC per screen (127.0.0.1 only, password-protected).
