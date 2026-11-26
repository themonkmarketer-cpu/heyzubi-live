import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { db, now } from './db.js';
import { engineHome } from './engine.js';
import { newId } from './lib/ids.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { getBotRow } from './store.js';

/**
 * Two additions to a bot's memory:
 *  - Pinned rules: short rules the owner pins; they ride along with every turn of that bot, so they are never pushed
 *    out the way the agent's own notes are when its memory fills up.
 *  - A gauge of how full its memory is: Hermes keeps the agent's notes (MEMORY.md) and what it knows about the owner
 *    (USER.md) under a character limit each (memory_char_limit / user_char_limit in its config.yaml). When a file is
 *    near its limit, new things push old ones out.
 */

db.exec('CREATE TABLE IF NOT EXISTS bot_pins (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)');

export interface Pin { id: string; text: string; createdAt: number }
export const listPins = (botId: string): Pin[] =>
  (db.prepare('SELECT id, text, created_at FROM bot_pins WHERE bot_id=? ORDER BY created_at ASC').all(botId) as any[]).map((r) => ({ id: r.id, text: r.text, createdAt: r.created_at }));

/** The pinned rules as a block for the bot's instructions, or '' when it has none. */
export function pinnedBlock(botId: string): string {
  const pins = listPins(botId);
  if (!pins.length) return '';
  return `## Pinned rules from the owner (always follow these; they outrank anything in your memory)\n${pins.map((p) => `- ${p.text}`).join('\n')}`;
}

const DEFAULTS = { memory: 2200, user: 1375 };

/** How full the bot's two memory files are, against the limits in its Hermes config. */
export function memoryUsage(botId: string) {
  const home = engineHome(botId);
  if (!home) return null;
  let cfg = '';
  try { cfg = fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'); } catch { /* defaults */ }
  const limit = (key: string, fallback: number) => { const m = new RegExp(`^\\s*${key}:\\s*(\\d+)`, 'm').exec(cfg); return m ? Number(m[1]) : fallback; };
  const size = (file: string) => { try { return fs.readFileSync(path.join(home, 'memories', file), 'utf8').length; } catch { return 0; } };
  const part = (used: number, max: number) => ({ used, limit: max, percent: max ? Math.min(100, Math.round((used / max) * 100)) : 0 });
  return { notes: part(size('MEMORY.md'), limit('memory_char_limit', DEFAULTS.memory)), user: part(size('USER.md'), limit('user_char_limit', DEFAULTS.user)) };
}

export const memoryApi = new Hono<AuthVars>();
memoryApi.use('*', requireUser);
const own = (userId: string, id: string) => { const b = getBotRow(id); return b && b.user_id === userId && b.kind !== 'room' ? b : null; };

memoryApi.get('/:id/pins', (c) => {
  const b = own(c.get('user').id, c.req.param('id'));
  return b ? c.json({ pins: listPins(b.id) }) : c.json({ error: 'not found' }, 404);
});

memoryApi.post('/:id/pins', async (c) => {
  const b = own(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const text = String((await c.req.json().catch(() => ({})) as any).text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!text) return c.json({ error: 'Write the rule first.' }, 400);
  if (listPins(b.id).length >= 20) return c.json({ error: 'A bot can have 20 pinned rules. Remove one first.' }, 409);
  const id = newId('pin');
  db.prepare('INSERT INTO bot_pins(id,bot_id,text,created_at) VALUES (?,?,?,?)').run(id, b.id, text, now());
  return c.json({ pins: listPins(b.id) });
});

memoryApi.delete('/:id/pins/:pin', (c) => {
  const b = own(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('DELETE FROM bot_pins WHERE id=? AND bot_id=?').run(c.req.param('pin'), b.id);
  return c.json({ pins: listPins(b.id) });
});

memoryApi.get('/:id/memory-usage', (c) => {
  const b = own(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ usage: memoryUsage(b.id) });
});
