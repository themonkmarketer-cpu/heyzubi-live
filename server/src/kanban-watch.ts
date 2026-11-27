import { db, now } from './db.js';
import { primaryBotId } from './engine.js';
import { kanban } from './hermes-kanban.js';
import { appendRow, emitBot, getBotRow } from './store.js';
import { enqueue, isBotBusy } from './agent/loop.js';
import { screenForWork } from './computer.js';

/**
 * Keeps the board moving while the owner is busy (checked every 15 minutes, on Hermes's own board):
 *
 * - Waiting on you: a card for "You" (the owner's review step) or a card a bot blocked because it needs something,
 *   left for 2 days, gets a reminder in Zubi's chat (again every 2 days), with how many tasks wait on it.
 * - Heartbeat and standup: work that looks stuck (a bot's card sitting in Ready unclaimed, a run going long with no
 *   heartbeat, failing runs, cards blocked for hours) is handed to Zubi, at most once an hour and only when the stuck
 *   set changed or 6 hours passed, to re-engage, reassign or tidy with her board tools. That turn is not the owner's
 *   words, so Zubi can't send or post anything in it. When nothing is stuck, nothing runs (no cost).
 */

db.exec('CREATE TABLE IF NOT EXISTS kanban_watch (key TEXT PRIMARY KEY, at INTEGER NOT NULL, sig TEXT)');
const seen = (key: string) => db.prepare('SELECT at, sig FROM kanban_watch WHERE key=?').get(key) as { at: number; sig: string | null } | undefined;
const mark = (key: string, sig: string | null = null) => db.prepare('INSERT INTO kanban_watch(key,at,sig) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at, sig=excluded.sig').run(key, now(), sig);

const DAY = 86_400_000, HOUR = 3_600_000;
const ago = (ms: number) => (ms >= DAY ? `${Math.round(ms / DAY)} day${Math.round(ms / DAY) === 1 ? '' : 's'}` : `${Math.max(1, Math.round(ms / HOUR))} hour${Math.round(ms / HOUR) === 1 ? '' : 's'}`);
const sec = (s: unknown) => (Number(s) > 0 ? Number(s) * 1000 : 0);

interface Card { id: string; title: string; status: string; assignee?: string | null; created_at?: number; started_at?: number; current_run_started_at?: number | null; last_heartbeat_at?: number | null; consecutive_failures?: number; last_failure_error?: string | null; block_kind?: string | null }

/** How many cards wait on this one, directly or further down the chain. */
export function downstream(id: string, links: [string, string][]): number {
  const kids = new Map<string, string[]>();
  for (const [p, c] of links) kids.set(p, [...(kids.get(p) ?? []), c]);
  const out = new Set<string>(), todo = [...(kids.get(id) ?? [])];
  while (todo.length) { const x = todo.pop()!; if (out.has(x)) continue; out.add(x); todo.push(...(kids.get(x) ?? [])); }
  return out.size;
}

/** When a card last changed (its newest event), from Hermes's task detail. */
async function lastChange(id: string): Promise<number> {
  try { const d = await kanban<any>('task', { id }); return Math.max(0, ...((d.events ?? []) as any[]).map((e) => sec(e.created_at))); } catch { return 0; }
}

async function check() {
  const zubi = primaryBotId();
  if (!zubi || !getBotRow(zubi)) return;
  const board = await kanban<any>('board', {});
  const cards: Card[] = ((board.columns ?? []) as any[]).flatMap((c) => (c.tasks ?? []) as Card[]);
  const links = ((await kanban<any>('links', {}).catch(() => ({ links: [] }))).links ?? []) as [string, string][];
  const t = now();

  // ---- waiting on you ----
  for (const c of cards.filter((x) => (x.status === 'ready' && x.assignee === 'owner') || x.status === 'blocked')) {
    const since = (await lastChange(c.id)) || sec(c.created_at);
    if (!since || t - since < 2 * DAY) continue;
    const last = seen(`remind:${c.id}`);
    if (last && t - last.at < 2 * DAY) continue;
    const n = downstream(c.id, links);
    const what = c.assignee === 'owner' ? 'your review step' : `blocked${c.assignee ? ` (${c.assignee})` : ''}, needs something from you`;
    appendRow(zubi, 'notice', { type: 'notice', tone: 'info', text: `Waiting on you for ${ago(t - since)}: “${c.title}”, ${what}${n ? `, and ${n} task${n === 1 ? '' : 's'} wait on it` : ''}. Open the Kanban to answer it.` });
    db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(zubi);
    emitBot(zubi);
    mark(`remind:${c.id}`);
  }

  // ---- stuck work: heartbeat and standup ----
  const stuck: string[] = [];
  for (const c of cards) {
    const who = c.assignee && c.assignee !== 'owner' ? c.assignee : null;
    if (c.status === 'ready' && who && !c.current_run_started_at && t - sec(c.created_at) > 30 * 60_000 && ((await lastChange(c.id)) || sec(c.created_at)) < t - 30 * 60_000) stuck.push(`- ${c.id} “${c.title}”: in Ready for ${who} for over 30 minutes and not picked up`);
    else if (c.status === 'running' && c.current_run_started_at && t - sec(c.current_run_started_at) > 45 * 60_000 && t - sec(c.last_heartbeat_at) > 10 * 60_000) stuck.push(`- ${c.id} “${c.title}”: ${who ?? 'a worker'} has been running it for ${ago(t - sec(c.current_run_started_at))} with no heartbeat for 10+ minutes`);
    else if ((c.consecutive_failures ?? 0) >= 2 && c.status !== 'done') stuck.push(`- ${c.id} “${c.title}”: ${c.consecutive_failures} failed runs in a row${c.last_failure_error ? ` (last: ${String(c.last_failure_error).slice(0, 140)})` : ''}`);
    else if (c.status === 'blocked' && c.assignee !== 'owner') { const since = (await lastChange(c.id)) || sec(c.created_at); if (t - since > 3 * HOUR) stuck.push(`- ${c.id} “${c.title}”: blocked for ${ago(t - since)}`); }
  }
  if (!stuck.length) return;
  const sig = stuck.map((s) => s.split(' ')[1]).sort().join(',');
  const last = seen('standup');
  if (last && (t - last.at < HOUR || (last.sig === sig && t - last.at < 6 * HOUR))) return;
  if (isBotBusy(zubi)) return; // try again at the next check
  mark('standup', sig);
  enqueue(zubi, {
    type: 'system',
    text: `Board check (automatic, hourly at most): some work on the team's Kanban looks stuck.\n${stuck.join('\n')}\n\nAs chief of staff, get it moving with your Kanban tools: look at each card (its comments and last run), then re-engage it (comment with a clearer next step), reassign it to the right team member, unblock it if what it waited for is there, or block it with one short question for Murtaza if only he can decide. Don't do the work yourself unless it's a two-minute fix, and don't create duplicate cards. Then reply with a 3-line standup: what you moved, what is still at risk, and what (if anything) Murtaza must decide.`,
  });
}

let busy = false;
export function initKanbanWatch() {
  if (process.env.HEYZUBI_NO_SCHEDULER) return;
  const run = () => {
    if (busy) return;
    busy = true;
    check().catch((e) => console.warn('[kanban-watch]', (e as Error)?.message ?? e)).finally(() => { busy = false; });
  };
  setTimeout(run, 3 * 60_000).unref?.();
  setInterval(run, 15 * 60_000).unref?.();
  // Board runs go straight from Hermes's dispatcher to the bot, not through a chat turn, so nothing else makes sure the
  // bot's screen and browser are up (after this server restarts they are not). Checked often, and cheap: a lookup and,
  // per bot with work, one quick question to its browser.
  setInterval(() => { void boardScreens().catch(() => {}); }, 20_000).unref?.();
}

/**
 * A line of linked cards (an assembly line) that just finished gets one message in Zubi's chat: what the line was, how
 * long it took, and its last step's result (each step passes the earlier lines on, so that result holds the whole line).
 * A line is finished when a card that waited on another one is Done and nothing on the board waits on it. Only lines
 * finished in the last hour are told, each once, so old work never floods the chat after a restart.
 */
async function announceFinishedLines(cards: Card[], links: [string, string][]) {
  const zubi = primaryBotId();
  if (!zubi || !getBotRow(zubi)) return;
  const byId = new Map(cards.map((c) => [c.id, c]));
  const parentsOf = new Map<string, string[]>(), kidsOf = new Map<string, string[]>();
  for (const [p, c] of links) {
    parentsOf.set(c, [...(parentsOf.get(c) ?? []), p]);
    kidsOf.set(p, [...(kidsOf.get(p) ?? []), c]);
  }
  const t = now();
  for (const c of cards) {
    if (c.status !== 'done' || !parentsOf.has(c.id)) continue;
    if ((kidsOf.get(c.id) ?? []).some((k) => byId.has(k))) continue; // a later step is still on the board
    if (seen(`line-done:${c.id}`)) continue;
    const d = await kanban<any>('task', { id: c.id }).catch(() => null);
    if (!d) continue;
    const runs = ((d.runs ?? []) as any[]).filter((r) => /complet|done/i.test(`${r.outcome} ${r.status}`));
    const last = runs.at(-1);
    const ended = sec(last?.ended_at ?? d.task?.completed_at);
    if (!ended || t - ended > 60 * 60_000) { mark(`line-done:${c.id}`); continue; }
    // Walk back to the line's first card for its start time and step count.
    let root = c.id, steps = 1;
    for (let n = 0; n < 30; n++) { const up = parentsOf.get(root)?.[0]; if (!up) break; root = up; steps++; }
    const first = root === c.id ? d : await kanban<any>('task', { id: root }).catch(() => null);
    const started = sec((((first?.runs ?? []) as any[])[0] ?? {}).started_at);
    const took = started && ended > started ? Math.round((ended - started) / 1000) : null;
    const name = String(byId.get(root)?.title ?? c.title).replace(/^▶\s*/, '').replace(/\s*·\s*\d+\/\d+\s.*$/, '').trim() || c.title;
    const result = String(last?.summary ?? d.task?.latest_summary ?? '').trim().slice(0, 3000);
    const tookText = took === null ? '' : took < 90 ? ` in ${took} s` : ` in ${Math.round(took / 60)} min`;
    appendRow(zubi, 'message', {
      type: 'message', role: 'assistant', streaming: false,
      text: `**Assembly line finished: ${name}**${tookText}, ${steps} step${steps === 1 ? '' : 's'}${c.assignee ? `, last step by ${getBotNameForProfile(c.assignee)}` : ''}.\n\n${result || 'The last step left no result text.'}\n\n_Open it on the Kanban board, Done › “${c.title}”, for each step's full report._`,
    });
    db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(zubi);
    emitBot(zubi);
    mark(`line-done:${c.id}`);
  }
}

const getBotNameForProfile = (p: string) => (p === 'owner' ? 'you' : p === 'default' ? 'Zubi' : ((db.prepare('SELECT name FROM bots WHERE hermes_profile=? AND deleted_at IS NULL').get(p) as { name?: string } | undefined)?.name ?? p));

let screensBusy = false;
/** Get the screen and browser ready for every team member with a card in Ready or Running, or next after a running one. */
async function boardScreens() {
  if (screensBusy) return;
  screensBusy = true;
  try {
    const board = await kanban<any>('board', {});
    const cards: Card[] = ((board.columns ?? []) as any[]).flatMap((c) => (c.tasks ?? []) as Card[]);
    const busyIds = new Set(cards.filter((c) => c.status === 'running').map((c) => c.id));
    const links = ((await kanban<any>('links', {}).catch(() => ({ links: [] }))).links ?? []) as [string, string][];
    await announceFinishedLines(cards, links).catch((e) => console.warn('[kanban-watch] line done:', (e as Error)?.message ?? e));
    const next = new Set(links.filter(([p]) => busyIds.has(p)).map(([, c]) => c));
    const profiles = new Set(cards.filter((c) => c.assignee && (c.status === 'ready' || c.status === 'running' || (c.status === 'todo' && next.has(c.id)))).map((c) => c.assignee as string));
    for (const p of profiles) {
      const b = db.prepare("SELECT id, user_id FROM bots WHERE hermes_profile=? AND engine='managed' AND deleted_at IS NULL").get(p) as { id: string; user_id: string } | undefined;
      if (b) await screenForWork(b.user_id, b.id).catch((e) => console.warn(`[kanban-watch] screen for ${p}: ${(e as Error)?.message ?? e}`));
    }
  } finally { screensBusy = false; }
}
