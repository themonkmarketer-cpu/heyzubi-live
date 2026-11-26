import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { db, now } from './db.js';
import { engineHome, engineKind, forgetEngineOptions, restartEngine } from './engine.js';
import { configureProfile, describeProfile, profileNameFor } from './hermes-profile.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { agentSkillFiles, SECRET_LIKE, skillFront } from './routes-config.js';
import { appendRow, emitBot, getBotRow } from './store.js';
import { isBotBusy } from './agent/loop.js';

/**
 * Skills a bot writes stay off until the owner approves them. Hermes lets an agent save skills in its own home
 * (skills/<name>/SKILL.md). Every few minutes HeyZubi looks at each team member's skills: the first look approves what is
 * already there; after that, a new skill, or a skill whose text changed, is switched off in the bot's Hermes profile
 * and waits in its settings (and with a notice in its chat) for the owner to approve or keep it off.
 */

db.exec(`CREATE TABLE IF NOT EXISTS skill_reviews (bot_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, sha TEXT NOT NULL,
  status TEXT NOT NULL, secret_like INTEGER NOT NULL DEFAULT 0, seen_at INTEGER NOT NULL, decided_at INTEGER, PRIMARY KEY (bot_id, name))`);

interface Review { bot_id: string; name: string; path: string; sha: string; status: 'approved' | 'pending' | 'rejected'; secret_like: number; seen_at: number; decided_at: number | null }

function skillsOf(botId: string): { name: string; path: string; sha: string; secret: boolean }[] {
  const home = engineHome(botId);
  if (!home) return [];
  const root = path.join(home, 'skills');
  return agentSkillFiles(home).map((file) => {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8').slice(0, 400_000); } catch { /* unreadable */ }
    const rel = path.relative(root, file).split(path.sep).join('/');
    const parts = rel.split('/');
    return { name: skillFront(text, 'name') || parts[parts.length - 2] || rel, path: rel, sha: crypto.createHash('sha256').update(text).digest('hex').slice(0, 24), secret: SECRET_LIKE.test(text) };
  });
}

/** Switch skills off (or back on) in the bot's Hermes profile, keeping every other choice as it is. */
async function setOff(botId: string, names: string[], off: boolean) {
  const snap = await describeProfile(botId);
  const known = new Set(snap.skills.map((s) => s.name));
  const disabled = new Set(snap.skills.filter((s) => !s.enabled).map((s) => s.name));
  for (const n of names) if (known.has(n)) { if (off) disabled.add(n); else disabled.delete(n); }
  await configureProfile(botId, { disabled_skills: [...disabled] });
  if (engineKind(botId) === 'managed' && !isBotBusy(botId)) { forgetEngineOptions(botId); await restartEngine(botId).catch(() => {}); }
}

async function checkBot(botId: string) {
  if (!profileNameFor(botId)) return;
  const found = skillsOf(botId);
  const known = new Map((db.prepare('SELECT * FROM skill_reviews WHERE bot_id=?').all(botId) as Review[]).map((r) => [r.name, r]));
  const first = known.size === 0;
  const fresh: string[] = [];
  for (const s of found) {
    const r = known.get(s.name);
    if (!r) {
      db.prepare('INSERT INTO skill_reviews(bot_id,name,path,sha,status,secret_like,seen_at,decided_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(botId, s.name, s.path, s.sha, first ? 'approved' : 'pending', s.secret ? 1 : 0, now(), first ? now() : null);
      if (!first) fresh.push(s.name);
    } else if (r.sha !== s.sha && r.status !== 'pending') {
      db.prepare("UPDATE skill_reviews SET sha=?, path=?, status='pending', secret_like=?, seen_at=?, decided_at=NULL WHERE bot_id=? AND name=?").run(s.sha, s.path, s.secret ? 1 : 0, now(), botId, s.name);
      fresh.push(s.name);
    }
  }
  if (!fresh.length) return;
  await setOff(botId, fresh, true);
  appendRow(botId, 'notice', { type: 'notice', tone: 'info', text: `New or changed skill${fresh.length === 1 ? '' : 's'} waiting for your OK: ${fresh.join(', ')}. ${fresh.length === 1 ? 'It stays' : 'They stay'} off until you approve in this team member’s settings → Skills.` });
  emitBot(botId);
}

async function sweep() {
  for (const b of db.prepare("SELECT id FROM bots WHERE COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0").all() as any[]) {
    await checkBot(b.id).catch((e) => console.warn('[skills] review check failed:', e?.message ?? e));
  }
}

export function initSkillReview() {
  if (process.env.HEYZUBI_NO_SCHEDULER) return;
  setTimeout(() => void sweep(), 2 * 60_000).unref();
  setInterval(() => void sweep(), 5 * 60_000).unref();
}

export const skillReviewApi = new Hono<AuthVars>();
skillReviewApi.use('*', requireUser);
const own = (userId: string, id: string) => { const b = getBotRow(id); return b && b.user_id === userId ? b : null; };

/** Skills waiting for the owner (all team members, or one with ?bot=). */
skillReviewApi.get('/', (c) => {
  const user = c.get('user').id;
  const bot = c.req.query('bot');
  const rows = db.prepare(`SELECT r.*, b.name bot_name FROM skill_reviews r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? ${bot ? 'AND r.bot_id=?' : ''} AND r.status IN ('pending','rejected') ORDER BY r.seen_at DESC`)
    .all(...(bot ? [user, bot] : [user])) as (Review & { bot_name: string })[];
  return c.json({ reviews: rows.map((r) => ({ botId: r.bot_id, botName: r.bot_name, name: r.name, path: r.path, status: r.status, secretLike: !!r.secret_like, seenAt: r.seen_at })) });
});

/** Approve (switch on) or keep off a waiting skill. */
skillReviewApi.post('/:bot/decide', async (c) => {
  const b = own(c.get('user').id, c.req.param('bot'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const p = await c.req.json().catch(() => ({})) as any;
  const name = String(p.name ?? '');
  const approve = p.decision === 'approve';
  const r = db.prepare('SELECT * FROM skill_reviews WHERE bot_id=? AND name=?').get(b.id, name) as Review | undefined;
  if (!r) return c.json({ error: 'not found' }, 404);
  try { await setOff(b.id, [name], !approve); } catch (e: any) { return c.json({ error: String(e?.message ?? e).slice(0, 200) }, 502); }
  db.prepare('UPDATE skill_reviews SET status=?, decided_at=? WHERE bot_id=? AND name=?').run(approve ? 'approved' : 'rejected', now(), b.id, name);
  return c.json({ ok: true, status: approve ? 'approved' : 'rejected' });
});

/** Run the check now (also used by tests). */
skillReviewApi.post('/check', async (c) => { await sweep(); return c.json({ ok: true }); });
