import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { db, now } from './db.js';
import { env } from './env.js';
import { requireUser, rateLimit, type AuthVars } from './lib/auth.js';
import { openAs, openHeaders } from './library-open.js';
import { libraryFile, safeRel } from './routes-config.js';
import { getBotRow } from './store.js';

/**
 * Expiring share links for clients: the owner shares one file from a team member's Library with a link that works
 * until it expires (1 hour to 30 days) or is turned off. Whoever has the link can view or download that one file and
 * nothing else; nothing in HeyZubi becomes reachable through it. Every view is counted.
 */

db.exec(`CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, bot_id TEXT NOT NULL, rel TEXT NOT NULL,
  expires_at INTEGER NOT NULL, revoked_at INTEGER, views INTEGER NOT NULL DEFAULT 0, last_view_at INTEGER, created_at INTEGER NOT NULL)`);

interface Share { token: string; user_id: string; bot_id: string; rel: string; expires_at: number; revoked_at: number | null; views: number; last_view_at: number | null; created_at: number }

const HOURS = [1, 24, 72, 168, 720];
const view = (s: Share) => ({ token: s.token, botId: s.bot_id, file: s.rel, path: `/s/${s.token}`, url: env.shareOrigin ? `${env.shareOrigin}/s/${s.token}` : null, public: !!env.shareOrigin, expiresAt: s.expires_at, revoked: !!s.revoked_at, live: !s.revoked_at && s.expires_at > now(), views: s.views, lastViewAt: s.last_view_at, createdAt: s.created_at });

export const sharesApi = new Hono<AuthVars>();
sharesApi.use('*', requireUser);

sharesApi.get('/', (c) => c.json({ shares: (db.prepare('SELECT * FROM shares WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(c.get('user').id) as Share[]).map(view) }));

/** Make a link to one Library file. */
sharesApi.post('/', async (c) => {
  const user = c.get('user').id;
  const p = await c.req.json().catch(() => ({})) as any;
  const b = getBotRow(String(p.botId ?? ''));
  if (!b || b.user_id !== user) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(String(p.file ?? ''));
  if (!rel || !libraryFile(b.id, rel)) return c.json({ error: 'That file isn’t in the Library.' }, 404);
  const hours = HOURS.includes(Number(p.hours)) ? Number(p.hours) : 72;
  if ((db.prepare('SELECT COUNT(*) n FROM shares WHERE user_id=? AND revoked_at IS NULL AND expires_at>?').get(user, now()) as any).n >= 100) return c.json({ error: 'You have 100 live links. Turn some off first.' }, 409);
  const token = `hzs_${crypto.randomBytes(24).toString('base64url')}`;
  db.prepare('INSERT INTO shares(token,user_id,bot_id,rel,expires_at,created_at) VALUES (?,?,?,?,?,?)').run(token, user, b.id, rel, now() + hours * 3_600_000, now());
  return c.json({ share: view(db.prepare('SELECT * FROM shares WHERE token=?').get(token) as Share) });
});

/** Turn a link off for good. */
sharesApi.delete('/:token', (c) => {
  db.prepare('UPDATE shares SET revoked_at=? WHERE token=? AND user_id=? AND revoked_at IS NULL').run(now(), c.req.param('token'), c.get('user').id);
  return c.json({ ok: true });
});

// ---------- the link itself (no sign-in) ----------

export const sharePublic = new Hono();
const views = rateLimit(120, 10 * 60_000);

const gone = (c: any, msg: string) => c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Link not available</title><body style="font:16px/1.5 system-ui;max-width:32rem;margin:15vh auto;padding:0 16px;color:#333"><h1 style="font-size:20px">This link isn’t available</h1><p>${msg}</p></body>`, 410, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });

sharePublic.get('/:token', (c) => {
  const token = c.req.param('token');
  if (!/^hzs_[\w-]{20,64}$/.test(token)) return gone(c, 'The link is not valid.');
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'anon';
  if (views.full(ip)) return c.text('Too many requests; try again shortly.', 429);
  views.count(ip);
  const s = db.prepare('SELECT * FROM shares WHERE token=?').get(token) as Share | undefined;
  if (!s) return gone(c, 'The link is not valid.');
  if (s.revoked_at) return gone(c, 'The sender turned this link off.');
  if (s.expires_at <= now()) return gone(c, 'This link has expired. Ask the sender for a new one.');
  const file = libraryFile(s.bot_id, s.rel);
  if (!file) return gone(c, 'The file is no longer there.');
  db.prepare('UPDATE shares SET views=views+1, last_view_at=? WHERE token=?').run(now(), token);
  const name = s.rel.split('/').pop()!;
  const size = fs.statSync(file).size;
  const as = c.req.query('download') ? null : openAs(name);
  const headers: Record<string, string> = as
    ? openHeaders(name, as, size)
    : { 'content-type': 'application/octet-stream', 'content-length': String(size), 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  headers['cache-control'] = 'no-store';
  headers['x-robots-tag'] = 'noindex, nofollow';
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers });
});
