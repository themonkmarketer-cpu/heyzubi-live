# Hardening checklist for HeyZubi's own endpoints

HeyZubi's server answers on one address. Everything under `/api/` belongs to the signed-in owner, except a short list of routes that are open on purpose and protect themselves another way. This checklist says what each part relies on, and `scripts/audit-endpoints.mjs` checks the live server against it.

## Run the check

```sh
node scripts/audit-endpoints.mjs https://<your-heyzubi>:8443
```

It reads `server/src` to list every route (following each `app.route(...)` mount), calls each one **without signing in**, and calls every write again as a **cross-site request** (an `Origin` from another site). A route passes when it refuses (401, 403, 404, 405 or 410) or is on the open list below. It sends no cookies or keys, and its write requests carry a body that is not valid JSON, so a route that wrongly accepts one still has nothing to act on. It exits 1 when anything fails; run it after every change to the routes.

## The checklist

| # | Check | How HeyZubi does it |
|---|---|---|
| 1 | Every owner route needs a signed-in session | `requireUser` on each router (`api`, `configApi`, and each feature router: `hire`, `webhooks`, `workers`, `clients`, `shares`, `search`, `content`, `deleted`, `skill-reviews`, `bot-memory`, `kanban`, `rooms`, `telegram`) |
| 2 | Cookie writes can't come from another site | `sameOriginWrites` on `/api/*`: a write whose `Sec-Fetch-Site`/`Origin` is another site gets 403 |
| 3 | Each owner route checks the bot, card or file belongs to the signed-in owner | `ownBot` / `user_id = ?` in every query; a wrong id answers 404, not someone else's data |
| 4 | Open routes protect themselves | Webhooks: per-webhook bearer secret or HMAC-SHA256 of the body, compared in constant time. Outside programs: API keys. Share links: 192-bit random token, an expiry, can be turned off. Webhook results: random token. Windows app: one-time pairing code, then a device key. Agents' tools (`/mcp`): local requests only, per-bot token |
| 5 | Rate limits on anything open or expensive | Webhooks 60/min each; share links 120 views per 10 min per address; announcements 30/hour; desktop pairing 10 per 10 min; the voice helper 30 per 10 min |
| 6 | Size limits on what comes in | Webhook bodies 256 KB; hire files 1 MB; recordings 25 MB per piece; pictures 15 MB each, 6 per message |
| 7 | Nothing outside can make a bot act on its own | Webhooks and outside programs are marked as not the owner's words; the owner's-words hook refuses sends, posts and deletes in those runs |
| 8 | Files are served sealed | Library files and share links: `Content-Security-Policy` sandbox for HTML/SVG, `nosniff`, `no-referrer`; share links add `no-store` and `noindex` |
| 9 | Secrets never leave the server | Keys live in the server's env files; hire files and exports strip anything that looks like a key; webhook and API key secrets are shown once. A team member's Telegram bot token and the owner's Telegram ID go only into that member's own Hermes `.env` (mode 600): never into a chat message, a card or the model, never logged or sent back (`telegram-setup.ts`) |
| 10 | The app isn't on the open internet | The app is served on the private Tailscale network only (`tailscale serve`). The one public part is share links: Tailscale Funnel on its own port (10000) maps only `/s` to the server, so every other path there answers 404 and the app's own ports stay private. `SHARE_ORIGIN` in the server's env makes the app hand out links on that public address. To close it again: `tailscale funnel --https=10000 off` |

## Open on purpose

| Route | Why it is open | What protects it |
|---|---|---|
| `GET /api/health` | Liveness check | Says nothing private |
| `/api/auth/*` | Signing in | Google sign-in with short-lived attempts |
| `GET /api/me` | A signed-out page learns it is signed out | Answers only for the cookie's own user |
| `GET /api/apps/callback` | Page you land on after connecting an app | Acts only for the signed-in owner; checks the app name |
| `POST /api/inbound/*` | Outside programs and webhooks | API key, or the webhook's own secret or signature |
| `GET /api/inbound/hooks/result/:token` | A webhook caller checks its card | Random result token |
| `/api/desktop/*` | Pairing the Windows app | One-time code, then a device key |
| `/mcp/*` | The agents' own tools | Local requests only, per-bot token |
| `GET /s/:token` | A client opens a share link (public, through Funnel port 10000) | Random token, expiry, can be turned off; one file only; 120 views per 10 minutes per address |
