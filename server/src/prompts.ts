// Each team member's saved prompts: the chips above its message box. A chip fills the box and never sends by itself, so
// the owner always sees the words first. The owner adds, edits and deletes them in the app; a team member can do the
// same with its own (agent/tools.ts), only in a turn that came from the owner's own words.
import { Hono } from 'hono';
import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import type { AuthVars } from './lib/auth.js';
import type { SavedPrompt } from './types.js';

db.exec(`CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  by_bot INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS prompts_bot ON prompts(bot_id);`);

export const PROMPTS_MAX = 30, TITLE_MAX = 40, TEXT_MAX = 2000;
export class PromptError extends Error {}

// No hidden or direction-changing characters: what the owner sees in the box is all there is.
const clean = (v: unknown) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f­​‎‏‪-‮⁠-⁩﻿]/g, '').trim();
function fields(title: unknown, text: unknown) {
  const body = clean(text);
  if (!body) throw new PromptError('A prompt needs some words.');
  if (body.length > TEXT_MAX) throw new PromptError(`A prompt can be ${TEXT_MAX} characters at most.`);
  const t = clean(title).replace(/\s+/g, ' ') || body.replace(/\s+/g, ' ');
  return { title: [...t].length > TITLE_MAX ? `${[...t].slice(0, TITLE_MAX - 1).join('').trim()}…` : t, text: body };
}

const toPrompt = (r: any): SavedPrompt => ({ id: r.id, botId: r.bot_id, title: r.title, text: r.text, byBot: !!r.by_bot, uses: r.uses, lastUsedAt: r.last_used_at ?? null });
const get = (botId: string, id: string) => db.prepare('SELECT * FROM prompts WHERE id=? AND bot_id=?').get(id, botId) as any;
const changed = (botId: string) => { const b = db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as any; if (b) hub.emit(b.user_id, { type: 'prompts', botId }); };

/** Most used first; the newest of those never used. */
export const listPrompts = (botId: string): SavedPrompt[] =>
  (db.prepare('SELECT * FROM prompts WHERE bot_id=? ORDER BY uses DESC, COALESCE(last_used_at, 0) DESC, created_at DESC').all(botId) as any[]).map(toPrompt);

export function addPrompt(botId: string, title: unknown, text: unknown, byBot = false): SavedPrompt {
  const f = fields(title, text);
  if (db.prepare('SELECT 1 FROM prompts WHERE bot_id=? AND text=?').get(botId, f.text)) throw new PromptError('That prompt is already saved.');
  if ((db.prepare('SELECT COUNT(*) n FROM prompts WHERE bot_id=?').get(botId) as any).n >= PROMPTS_MAX) throw new PromptError(`That’s ${PROMPTS_MAX} prompts, the most a team member can have. Delete one first.`);
  const id = newId('pr');
  db.prepare('INSERT INTO prompts(id,bot_id,title,text,by_bot,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, botId, f.title, f.text, byBot ? 1 : 0, now(), now());
  changed(botId);
  return toPrompt(get(botId, id));
}

export function updatePrompt(botId: string, id: string, p: { title?: unknown; text?: unknown }, byBot = false): SavedPrompt {
  const cur = get(botId, id);
  if (!cur) throw new PromptError('No such prompt.');
  const f = fields(p.title ?? cur.title, p.text ?? cur.text);
  if (db.prepare('SELECT 1 FROM prompts WHERE bot_id=? AND text=? AND id<>?').get(botId, f.text, id)) throw new PromptError('That prompt is already saved.');
  db.prepare('UPDATE prompts SET title=?, text=?, by_bot=?, updated_at=? WHERE id=?').run(f.title, f.text, byBot ? 1 : cur.by_bot, now(), id);
  changed(botId);
  return toPrompt(get(botId, id));
}

export function deletePrompt(botId: string, id: string): SavedPrompt {
  const cur = get(botId, id);
  if (!cur) throw new PromptError('No such prompt.');
  db.prepare('DELETE FROM prompts WHERE id=?').run(id);
  changed(botId);
  return toPrompt(cur);
}

export const promptsApi = new Hono<AuthVars>();
const own = (userId: string, botId: string) => !!db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=? AND COALESCE(hidden,0)=0').get(botId, userId);

promptsApi.use('/:bot/*', async (c, next) => (own(c.get('user').id, c.req.param('bot')) ? next() : c.json({ error: 'not found' }, 404)));
promptsApi.onError((e, c) => {
  if (e instanceof PromptError) return c.json({ error: e.message }, 400);
  console.warn('[prompts] failed:', e?.message ?? e);
  return c.json({ error: 'That couldn’t be saved just now.' }, 500);
});
const body = async (c: any) => (await c.req.json().catch(() => null)) ?? {};

promptsApi.get('/:bot', (c) => c.json({ prompts: listPrompts(c.req.param('bot')) }));
promptsApi.post('/:bot', async (c) => { const b = await body(c); return c.json({ prompt: addPrompt(c.req.param('bot'), b.title, b.text) }); });
promptsApi.patch('/:bot/:id', async (c) => { const b = await body(c); return c.json({ prompt: updatePrompt(c.req.param('bot'), c.req.param('id'), { title: b.title, text: b.text }) }); });
promptsApi.delete('/:bot/:id', (c) => { deletePrompt(c.req.param('bot'), c.req.param('id')); return c.json({ ok: true }); });
/** The owner sent a message that started from this chip. */
promptsApi.post('/:bot/:id/used', (c) => {
  const id = c.req.param('id'), bot = c.req.param('bot');
  if (!get(bot, id)) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE prompts SET uses=uses+1, last_used_at=? WHERE id=?').run(now(), id);
  changed(bot);
  return c.json({ ok: true });
});
