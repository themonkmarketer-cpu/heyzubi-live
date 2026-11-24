// Outside programs can message bots (from Theo's local API): n8n, a script or another app posts a message
// with an API key the owner made in Settings → Outside programs. The message lands in the bot's chat marked
// as coming from that program, and the turn is NOT the owner's words, so the owner's rule applies (it can look
// things up and draft, never send, share, post or delete). Keys are stored only as a SHA-256 hash.
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { rateLimit, type AuthVars } from './lib/auth.js';
import { appendRow, emitBot } from './store.js';
import { enqueue, isBotBusy } from './agent/loop.js';

db.exec('CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER)');

const hash = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

// ---------- keys (signed-in owner) ----------

export const apiKeysApi = new Hono<AuthVars>();

apiKeysApi.get('/', (c) => c.json({
  keys: (db.prepare('SELECT id, name, created_at, last_used_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC').all(c.get('user').id) as any[])
    .map((k) => ({ id: k.id, name: k.name, createdAt: k.created_at, lastUsedAt: k.last_used_at })),
}));

/** Make a key. It is returned this once and never again (only its hash is kept). */
apiKeysApi.post('/', async (c) => {
  const user = c.get('user');
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: '' }));
  const label = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Outside program';
  if ((db.prepare('SELECT COUNT(*) n FROM api_keys WHERE user_id=?').get(user.id) as any).n >= 20) return c.json({ error: 'You already have 20 keys. Remove one first.' }, 409);
  const key = `hzk_${crypto.randomBytes(32).toString('base64url')}`;
  const id = newId('key');
  db.prepare('INSERT INTO api_keys(id,user_id,name,hash,created_at) VALUES (?,?,?,?,?)').run(id, user.id, label, hash(key), now());
  return c.json({ id, name: label, key });
});

apiKeysApi.delete('/:id', (c) => {
  db.prepare('DELETE FROM api_keys WHERE id=? AND user_id=?').run(c.req.param('id'), c.get('user').id);
  return c.json({ ok: true });
});

// ---------- messages (key-authenticated) ----------

export const inboundApi = new Hono();
const limit = rateLimit(30, 60_000); // per key

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

inboundApi.post('/messages', async (c) => {
  const auth = c.req.header('authorization') ?? '';
  const key = /^Bearer\s+(hzk_[A-Za-z0-9_-]{20,})$/.exec(auth)?.[1];
  const row = key ? db.prepare('SELECT * FROM api_keys WHERE hash=?').get(hash(key)) as any : null;
  if (!row) return c.json({ error: 'A valid API key is needed: Authorization: Bearer hzk_…' }, 401);
  if (limit.full(row.id)) return c.json({ error: 'Too many messages; try again shortly.' }, 429, { 'Retry-After': String(limit.retryAfter(row.id)) });
  limit.count(row.id);

  const p = await c.req.json<{ bot?: string; text?: string; source?: string; wait?: boolean }>().catch(() => ({} as any));
  const text = String(p.text ?? '').trim().slice(0, 8000);
  if (!text) return c.json({ error: 'text is required' }, 400);
  const want = String(p.bot ?? '').trim();
  const bot = (want
    ? db.prepare("SELECT * FROM bots WHERE user_id=? AND (id=? OR lower(name)=lower(?)) AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0").get(row.user_id, want, want)
    : db.prepare('SELECT * FROM bots WHERE user_id=? AND is_primary=1').get(row.user_id)) as any;
  if (!bot) return c.json({ error: `No bot called "${want}".` }, 404);
  const source = String(p.source ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || row.name;
  db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now(), row.id);

  const msg = appendRow(bot.id, 'message', { type: 'message', role: 'user', text, from: { kind: 'program', id: row.id, name: source } });
  emitBot(bot.id);
  enqueue(bot.id, { type: 'program', source, text });
  if (p.wait !== true) return c.json({ ok: true, bot: bot.name, seq: msg.seq });

  // Wait up to 2 minutes for the bot's reply.
  for (const until = Date.now() + 120_000; Date.now() < until;) {
    await sleep(1500);
    if (isBotBusy(bot.id)) continue;
    const reply = (db.prepare("SELECT body FROM rows WHERE bot_id=? AND seq>? AND kind='message' ORDER BY seq").all(bot.id, msg.seq) as any[])
      .map((r) => JSON.parse(r.body)).filter((b) => b.role === 'assistant' && !b.streaming && b.text?.trim());
    if (reply.length) return c.json({ ok: true, bot: bot.name, seq: msg.seq, reply: reply.map((b) => b.text).join('\n\n') });
  }
  return c.json({ ok: true, bot: bot.name, seq: msg.seq, reply: null, note: 'Still working; the reply will be in the chat.' });
});
