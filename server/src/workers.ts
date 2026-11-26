import path from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { db, now } from './db.js';
import { env } from './env.js';
import { primaryBotId } from './engine.js';
import { kanban } from './hermes-kanban.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { appendRow, emitBot } from './store.js';

/**
 * One-job workers with spending caps. A worker is one Kanban card for one team member, with three limits:
 *  - a run-time limit and a turn limit, which Hermes itself enforces (max_runtime_seconds, goal_max_turns);
 *  - a spending cap in dollars, which HeyZubi enforces: every 15 seconds it reads what the card's run has cost so far
 *    (Hermes's own estimate in the profile's state.db) and, at the cap, blocks the card, which stops its worker.
 * The card says what it is for; when it ends, the summary is on the card as usual.
 */

db.exec(`CREATE TABLE IF NOT EXISTS worker_caps (task_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, profile TEXT NOT NULL, title TEXT NOT NULL,
  cap_usd REAL NOT NULL, created_at INTEGER NOT NULL, spent_usd REAL NOT NULL DEFAULT 0, stopped_at INTEGER, stop_reason TEXT)`);

interface Cap { task_id: string; user_id: string; profile: string; title: string; cap_usd: number; created_at: number; spent_usd: number; stopped_at: number | null; stop_reason: string | null }

const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const homeOf = (profile: string) => (profile === 'default' ? env.hermesHome : path.join(env.hermesHome, 'profiles', profile));

/** What a card's runs have cost so far: its own session, or the profile's board sessions with its title since it was made. */
export function spentOn(profile: string, sessionId: string | null, title: string, sinceMs: number): number {
  let d: Database.Database | null = null;
  try {
    d = new Database(path.join(homeOf(profile), 'state.db'), { readonly: true, fileMustExist: true });
    const r = d.prepare(`SELECT COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)), 0) s FROM sessions
      WHERE (id = ? OR (source = 'kanban' AND title = ? AND started_at >= ?))`).get(sessionId ?? '', title, sinceMs / 1000 - 5) as { s: number };
    return Number(r?.s ?? 0);
  } catch { return 0; } finally { d?.close(); }
}

export const workersApi = new Hono<AuthVars>();
workersApi.use('*', requireUser);

const view = (w: Cap) => ({ card: w.task_id, profile: w.profile, title: w.title, capUsd: w.cap_usd, spentUsd: Math.round(w.spent_usd * 10000) / 10000, createdAt: w.created_at, stoppedAt: w.stopped_at, stopReason: w.stop_reason });

workersApi.get('/', (c) => c.json({ workers: (db.prepare('SELECT * FROM worker_caps WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(c.get('user').id) as Cap[]).map(view) }));

/** Start a worker: one card, ready for its team member, with its limits. */
workersApi.post('/', async (c) => {
  const p = await c.req.json().catch(() => ({})) as any;
  const title = String(p.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const brief = String(p.brief ?? '').trim().slice(0, 12_000);
  const profile = String(p.bot ?? '');
  const cap = Number(p.capUsd);
  const minutes = Math.round(Number(p.maxMinutes ?? 30));
  const turns = Math.round(Number(p.maxTurns ?? 40));
  if (!title) return c.json({ error: 'Say what the one job is.' }, 400);
  if (!PROFILE.test(profile)) return c.json({ error: 'Pick the team member who does it.' }, 400);
  if (!(cap > 0 && cap <= 50)) return c.json({ error: 'The spending cap must be between $0.01 and $50.' }, 400);
  if (!(minutes >= 1 && minutes <= 240)) return c.json({ error: 'The time limit must be 1 to 240 minutes.' }, 400);
  if (!(turns >= 1 && turns <= 200)) return c.json({ error: 'The step limit must be 1 to 200.' }, 400);
  const body = [
    brief || title,
    `This is a one-job worker card: do only this job, then finish with a short summary. Limits: ${minutes} minutes, ${turns} steps, and a spending cap of $${cap.toFixed(2)}; at the cap HeyZubi stops the card.`,
    'Don’t send, post, publish, pay or delete anything: prepare it and leave it for review.',
  ].join('\n\n');
  try {
    const r = await kanban<any>('create', { payload: { title, body, assignee: profile, max_runtime_seconds: minutes * 60, goal_max_turns: turns } });
    const t = r.task;
    if (!t?.id) return c.json({ error: 'The card couldn’t be made.' }, 503);
    db.prepare('INSERT INTO worker_caps(task_id,user_id,profile,title,cap_usd,created_at) VALUES (?,?,?,?,?,?)').run(t.id, c.get('user').id, profile, t.title ?? title, cap, now());
    return c.json({ worker: view(db.prepare('SELECT * FROM worker_caps WHERE task_id=?').get(t.id) as Cap) });
  } catch (e: any) {
    return c.json({ error: `The card couldn’t be made: ${String(e?.message ?? e).slice(0, 200)}` }, 503);
  }
});

/** Every 15 seconds: what each live worker has spent; block any at its cap (one step can still overshoot a little). */
async function check() {
  const live = db.prepare('SELECT * FROM worker_caps WHERE stopped_at IS NULL').all() as Cap[];
  for (const w of live) {
    let t: any;
    try { t = (await kanban<any>('task', { id: w.task_id })).task; } catch { continue; }
    if (!t) continue;
    const spent = spentOn(w.profile, t.session_id ?? null, w.title, w.created_at);
    db.prepare('UPDATE worker_caps SET spent_usd=? WHERE task_id=?').run(spent, w.task_id);
    if (['done', 'archived', 'review'].includes(t.status)) {
      const over = spent > w.cap_usd ? `, but went $${(spent - w.cap_usd).toFixed(2)} over its cap before the next check` : '';
      db.prepare('UPDATE worker_caps SET stopped_at=?, stop_reason=? WHERE task_id=?').run(now(), `finished (${t.status})${over}`, w.task_id);
      continue;
    }
    if (spent < w.cap_usd) continue;
    const why = `Spending cap reached: $${spent.toFixed(2)} of $${w.cap_usd.toFixed(2)}.`;
    try { await kanban('update', { id: w.task_id, payload: { status: 'blocked', block_reason: why } }); } catch (e: any) { console.warn('[workers] block failed:', e?.message ?? e); continue; }
    db.prepare('UPDATE worker_caps SET stopped_at=?, stop_reason=? WHERE task_id=?').run(now(), why, w.task_id);
    const zubi = primaryBotId();
    if (zubi) {
      appendRow(zubi, 'notice', { type: 'notice', tone: 'info', text: `The worker card “${w.title}” (${w.profile}) was stopped. ${why} It’s in Blocked on the Kanban; raise the cap or move it back to Ready if you want it to carry on.` });
      emitBot(zubi);
    }
  }
}

export function initWorkers() {
  if (process.env.HEYZUBI_NO_SCHEDULER) return;
  let busy = false;
  setInterval(() => { if (busy) return; busy = true; check().catch((e) => console.warn('[workers]', e?.message ?? e)).finally(() => { busy = false; }); }, 15_000).unref();
}
