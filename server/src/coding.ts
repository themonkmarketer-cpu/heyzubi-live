// Coding runs (from Theo's coding agent, Murtaza 2026-11-23: "Zubi's own engine", code lands as a pull request).
// The owner asks a bot to change a GitHub repo; the bot's own Hermes engine does the work in a separate
// engine conversation (hq-code-<runId>) in the background, on a new branch, and opens a pull request into the
// base branch. It never pushes to the base branch and never merges: the owner reviews and merges on GitHub.
// HeyZubi writes a "coding" marker for that conversation; the hq_owner_words hook then refuses merges,
// force pushes, pushes to the base branch and sending or deleting anything while the run works.
import { dropOneOff, hideOneOff } from './engine-sessions.js';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import type { AuthVars } from './lib/auth.js';
import { appendRow, emitBot, getBotRow } from './store.js';
import { engineFor } from './engine.js';
import { sseEvents } from './agent/loop.js';

db.exec(`CREATE TABLE IF NOT EXISTS coding_runs (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, user_id TEXT NOT NULL, repo TEXT NOT NULL, base TEXT NOT NULL,
  branch TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL, pr_url TEXT, summary TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER)`);
// A restart ends any run that was working (its engine request is gone with the process).
db.prepare("UPDATE coding_runs SET status='stopped', summary=COALESCE(summary,'HeyZubi restarted while this run was working.'), finished_at=? WHERE status='running'").run(now());

const RUN_LIMIT_MS = 45 * 60_000;
const running = new Map<string, AbortController>();

export interface CodingRun {
  id: string; botId: string; repo: string; base: string; branch: string; task: string;
  status: 'running' | 'done' | 'no-pr' | 'failed' | 'stopped'; prUrl: string | null; summary: string | null;
  startedAt: number; finishedAt: number | null;
}

const toRun = (r: any): CodingRun => ({
  id: r.id, botId: r.bot_id, repo: r.repo, base: r.base, branch: r.branch, task: r.task, status: r.status,
  prUrl: r.pr_url, summary: r.summary, startedAt: r.started_at, finishedAt: r.finished_at,
});

export function listCodingRuns(userId: string, botId?: string, limit = 10): CodingRun[] {
  const rows = botId
    ? db.prepare('SELECT * FROM coding_runs WHERE user_id=? AND bot_id=? ORDER BY started_at DESC LIMIT ?').all(userId, botId, limit)
    : db.prepare('SELECT * FROM coding_runs WHERE user_id=? ORDER BY started_at DESC LIMIT ?').all(userId, limit);
  return (rows as any[]).map(toRun);
}

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;

/** "owner/name", a github.com URL or a .git URL → "owner/name", or null. */
export function cleanRepo(v: string): string | null {
  const s = v.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/^git@github\.com:/i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return REPO_RE.test(s) && !s.includes('..') ? s : null;
}

const slug = (t: string) => t.replace(/^\s*(the\s+)?base\s+branch\s*(is|:)?\s*[\w./-]+[.,:;]?\s*/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'change';

function instructions(r: { repo: string; base: string; branch: string; workdir: string }) {
  return `You are working as a careful coding agent on the GitHub repository ${r.repo}. The owner asked for the change below.

How to work:
- Work only in ${r.workdir} (create it). Clone the repository there with git when it is public (git clone --depth 50 -b ${r.base} https://github.com/${r.repo}.git); when it is private or cloning fails, read files through the connected GitHub app tools instead.
- Read enough of the code to understand it before changing anything. Keep the change small and focused on the task; match the existing style.
- Run the project's tests or type checks when there are any and you can run them; say honestly which you ran and what happened.
- Deliver the change as a pull request: create the branch ${r.branch} from ${r.base}, commit the changed files to ${r.branch} (the GitHub app's tools work without a git login), then open a pull request from ${r.branch} into ${r.base} with a clear title and a description of what changed, why, and how it was checked.
- Never push or commit to ${r.base}, never force-push, never merge a pull request, never delete branches or files outside the change, and never send, post or share anything else. The owner reviews and merges.
- Never print tokens or keys.
- If you cannot finish, stop and explain what blocked you.

End your final message with one line exactly like "PR: <url of the pull request>" (or "PR: none" if you opened none), after a short summary of the change and the checks you ran.`;
}

function finish(id: string, botId: string, userId: string, patch: { status: CodingRun['status']; prUrl?: string | null; summary: string }) {
  db.prepare('UPDATE coding_runs SET status=?, pr_url=?, summary=?, finished_at=? WHERE id=?').run(patch.status, patch.prUrl ?? null, patch.summary.slice(0, 4000), now(), id);
  const r = toRun(db.prepare('SELECT * FROM coding_runs WHERE id=?').get(id));
  const head = patch.status === 'done' ? `Coding run finished: pull request ready for your review on ${r.repo}.\n${r.prUrl}`
    : patch.status === 'stopped' ? `Coding run on ${r.repo} stopped.`
      : patch.status === 'no-pr' ? `Coding run on ${r.repo} ended without a pull request.`
        : `Coding run on ${r.repo} failed.`;
  appendRow(botId, 'message', { type: 'message', role: 'assistant', text: `${head}\n\n${patch.summary.trim().slice(0, 3000)}`, streaming: false });
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
  emitBot(botId);
  hub.emit(userId, { type: 'coding', botId } as any);
}

/** Start a coding run in the background. Returns the run, or an error message for the agent. */
export async function startCodingRun(userId: string, botId: string, a: { repo: string; task: string; base?: string }): Promise<CodingRun | string> {
  const repo = cleanRepo(String(a.repo ?? ''));
  if (!repo) return 'The repository must be "owner/name" on GitHub (or its github.com link).';
  const task = String(a.task ?? '').trim().slice(0, 6000);
  if (task.length < 8) return 'Describe the change in a sentence or two.';
  const base = String(a.base ?? '').trim() || 'main';
  if (!BRANCH_RE.test(base) || base.includes('..')) return 'That base branch name is not valid.';
  if (db.prepare("SELECT 1 FROM coding_runs WHERE bot_id=? AND status='running'").get(botId)) return 'A coding run is already working for this bot; wait for it to finish or stop it first.';

  const engine = await engineFor(botId);
  const id = newId('code');
  const branch = `zubi/${slug(task)}-${id.slice(-5).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  const workdir = path.posix.join(engine.home, 'coding', id);
  const conversation = `hq-code-${id}`;
  db.prepare("INSERT INTO coding_runs(id,bot_id,user_id,repo,base,branch,task,status,started_at) VALUES (?,?,?,?,?,?,?,'running',?)").run(id, botId, userId, repo, base, branch, task, now());

  // The hook reads this while the run works (see deploy/hermes-box/agent-hooks/hq_owner_words.py).
  const guardDir = path.join(engine.home, 'hq-guard');
  const marker = path.join(guardDir, `${conversation}.json`);
  try {
    fs.mkdirSync(guardDir, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ conversation, kind: 'coding', base, branch, why: 'a coding run', since: Date.now(), until: Date.now() + RUN_LIMIT_MS + 5 * 60_000 }));
  } catch (e) { console.warn('[coding] marker not written:', (e as Error).message); }

  const ctrl = new AbortController();
  running.set(id, ctrl);
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), RUN_LIMIT_MS);
  const bot = getBotRow(botId);

  void (async () => {
    let text = '';
    let res: Response | null = null;
    try {
      res = await fetch(`${engine.url}/v1/responses`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(engine.key ? { authorization: `Bearer ${engine.key}` } : {}) },
        body: JSON.stringify({
          model: bot?.model || 'hermes-agent',
          ...(bot?.provider ? { provider: bot.provider } : {}),
          input: `Task for ${repo} (base branch ${base}):\n\n${task}`,
          instructions: instructions({ repo, base, branch, workdir }),
          conversation,
          stream: true,
          store: true,
          model_options: { reasoning_effort: 'high' },
        }),
      });
      hideOneOff(botId, engine, res);
      if (!res.ok || !res.body) throw new Error(`engine answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      for await (const ev of sseEvents(res.body)) {
        if (ev.type === 'response.output_text.delta' && typeof ev.data?.delta === 'string') text += ev.data.delta;
        else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error(String(ev.data?.response?.error?.message ?? ev.data?.error?.message ?? ev.data?.message ?? 'the engine reported an error'));
      }
      const pr = /PR:\s*(https:\/\/github\.com\/[^\s)>\]]+\/pull\/\d+)/i.exec(text)?.[1]
        ?? new RegExp(`https://github\\.com/${repo.replace(/[.]/g, '\\.')}/pull/\\d+`, 'i').exec(text)?.[0] ?? null;
      const summary = text.replace(/\n?PR:\s*\S+\s*$/i, '').trim() || 'No summary.';
      finish(id, botId, userId, pr ? { status: 'done', prUrl: pr, summary } : { status: 'no-pr', summary });
    } catch (e: any) {
      const stopped = ctrl.signal.aborted;
      const why = stopped ? (String(ctrl.signal.reason?.message ?? '') === 'timeout' ? 'It ran past 45 minutes and was stopped.' : 'Stopped by you.') : String(e?.message ?? e);
      finish(id, botId, userId, { status: stopped ? 'stopped' : 'failed', summary: [text.trim().slice(-1500), why].filter(Boolean).join('\n\n') });
    } finally {
      clearTimeout(timer);
      running.delete(id);
      dropOneOff(engine, res); // the run's session goes; the team member keeps only its chat
      try { fs.unlinkSync(marker); } catch { /* gone */ }
      try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* the engine's files; harmless if left */ }
    }
  })();

  return toRun(db.prepare('SELECT * FROM coding_runs WHERE id=?').get(id));
}

export function stopCodingRun(userId: string, id: string): boolean {
  const r = db.prepare("SELECT 1 FROM coding_runs WHERE id=? AND user_id=? AND status='running'").get(id, userId);
  const c = running.get(id);
  if (!r || !c) return false;
  c.abort(new Error('stopped'));
  return true;
}

// ---------- API (signed-in owner) ----------

export const codingApi = new Hono<AuthVars>();

codingApi.get('/', (c) => c.json({ runs: listCodingRuns(c.get('user').id, c.req.query('botId') || undefined, 20) }));

codingApi.post('/:id/stop', (c) => (stopCodingRun(c.get('user').id, c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'That run is not working.' }, 404)));
