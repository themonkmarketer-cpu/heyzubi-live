import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { mayUsePrimary } from './engine.js';
import { db } from './db.js';
import { kanban, KanbanError } from './hermes-kanban.js';
import { askJson } from './reels/writer.js';
import { requireUser, type AuthVars } from './lib/auth.js';

/**
 * The Board view's routes: a thin pass-through to Hermes's own Kanban (hermes-kanban.ts). Hermes validates and
 * applies everything (its workflow decides which moves are allowed, its dispatcher picks up ready work); HeyZubi only
 * checks who may use the board and the shape of what is sent.
 *
 * The board is the computer's Hermes board, so it belongs to the owner, as the main agent does (mayUsePrimary).
 */
export const kanbanApi = new Hono<AuthVars>();
kanbanApi.use('*', requireUser);
kanbanApi.use('*', async (c, next) => {
  if (!mayUsePrimary(c.get('user').id)) return c.json({ error: 'The board belongs to this computer’s owner.' }, 403);
  return next();
});

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;

const boardOf = (c: Context) => {
  const b = c.req.query('board');
  return b && SLUG.test(b) ? b : undefined;
};

async function answer(c: Context, op: string, args: Record<string, unknown> = {}) {
  try {
    return c.json(await kanban(op, args));
  } catch (e: any) {
    const status = e instanceof KanbanError ? e.status : 500;
    return c.json({ error: String(e?.message ?? e) }, (status >= 400 && status < 600 ? status : 500) as any);
  }
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 1000 ? v : undefined);

kanbanApi.get('/boards', (c) => answer(c, 'boards'));
kanbanApi.get('/workflow', (c) => answer(c, 'workflow'));
kanbanApi.get('/board', (c) => answer(c, 'board', { board: boardOf(c) }));
kanbanApi.get('/cursor', (c) => answer(c, 'cursor', { board: boardOf(c) }));
kanbanApi.get('/assignees', (c) => answer(c, 'assignees', { board: boardOf(c) }));

kanbanApi.get('/tasks/:id', (c) => {
  const id = c.req.param('id');
  if (!TASK_ID.test(id)) return c.json({ error: 'bad task id' }, 400);
  return answer(c, 'task', { id, board: boardOf(c) });
});

/** New card. Hermes's own fields; Hermes decides its first column (a triage card starts in Triage). */
kanbanApi.post('/tasks', async (c) => {
  const p = await c.req.json().catch(() => null);
  const title = str(p?.title, 300)?.trim();
  if (!title) return c.json({ error: 'A card needs a title.' }, 400);
  const payload: Record<string, unknown> = { title };
  if (p.body !== undefined) payload.body = str(p.body, 20_000) ?? '';
  if (p.assignee !== undefined) payload.assignee = str(p.assignee, 120) || null;
  if (p.priority !== undefined) payload.priority = int(p.priority) ?? 0;
  if (p.triage === true) payload.triage = true;
  // A step in a chain: Hermes parks it in Todo until these cards are done, then moves it to Ready for its bot,
  // and gives that bot the earlier cards' results.
  if (p.parents !== undefined) {
    if (!Array.isArray(p.parents) || p.parents.length > 10 || !p.parents.every((x: unknown) => typeof x === 'string' && TASK_ID.test(x))) {
      return c.json({ error: 'bad parents' }, 400);
    }
    if (p.parents.length) payload.parents = p.parents;
  }
  // Hermes's own duplicate guard: a second create with the same key returns the first card instead of a new one.
  const key = str(p.key, 80);
  if (key && /^[A-Za-z0-9_-]{8,80}$/.test(key)) payload.idempotency_key = `heyzubi-${key}`;
  return answer(c, 'create', { board: boardOf(c), payload });
});

/** Edit or move a card: only the fields sent change, through Hermes's own update (and its move rules). */
kanbanApi.patch('/tasks/:id', async (c) => {
  const id = c.req.param('id');
  if (!TASK_ID.test(id)) return c.json({ error: 'bad task id' }, 400);
  const p = await c.req.json().catch(() => null);
  if (!p || typeof p !== 'object') return c.json({ error: 'nothing to change' }, 400);
  const payload: Record<string, unknown> = {};
  if (p.title !== undefined) payload.title = str(p.title, 300);
  if (p.body !== undefined) payload.body = str(p.body, 20_000);
  if (p.status !== undefined) payload.status = str(p.status, 40);
  if (p.assignee !== undefined) payload.assignee = str(p.assignee, 120) ?? '';
  if (p.priority !== undefined) payload.priority = int(p.priority);
  if (p.block_reason !== undefined) payload.block_reason = str(p.block_reason, 2000);
  if (p.summary !== undefined) payload.summary = str(p.summary, 4000);
  for (const [k, v] of Object.entries(payload)) if (v === undefined) return c.json({ error: `bad ${k}` }, 400);
  if (!Object.keys(payload).length) return c.json({ error: 'nothing to change' }, 400);
  return answer(c, 'update', { id, board: boardOf(c), payload });
});

// ---------- attachments: Hermes's own upload, download and delete (its storage folder, name cleaning and 25 MB cap) ----------

const MAX_ATTACHMENT = 25 * 1024 * 1024; // Hermes's KANBAN_ATTACHMENT_MAX_BYTES
const ATT_ID = /^\d{1,12}$/;
/** Shown in the page only for plain raster images; everything else always downloads. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

kanbanApi.get('/tasks/:id/attachments', (c) => {
  const id = c.req.param('id');
  if (!TASK_ID.test(id)) return c.json({ error: 'bad task id' }, 400);
  return answer(c, 'attachments', { id, board: boardOf(c) });
});

kanbanApi.post('/tasks/:id/attachments', async (c) => {
  const id = c.req.param('id');
  if (!TASK_ID.test(id)) return c.json({ error: 'bad task id' }, 400);
  if (Number(c.req.header('content-length') ?? 0) > MAX_ATTACHMENT + 64 * 1024) return c.json({ error: 'The file is over Hermes’s 25 MB limit.' }, 413);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'Send the file as multipart form data (field "file").' }, 400);
  if (file.size > MAX_ATTACHMENT) return c.json({ error: 'The file is over Hermes’s 25 MB limit.' }, 413);
  if (!file.size) return c.json({ error: 'The file is empty.' }, 400);
  // A private temp copy the Hermes user can read; Hermes copies it into its own folder, then it's removed.
  const dir = await mkdtemp(path.join(tmpdir(), 'heyzubi-kanban-'));
  const tmp = path.join(dir, 'upload');
  try {
    await chmod(dir, 0o755);
    await writeFile(tmp, Buffer.from(await file.arrayBuffer()), { mode: 0o644 });
    return await answer(c, 'attach', {
      id, board: boardOf(c), path: tmp, filename: String(file.name || 'file').slice(0, 200),
      content_type: String(file.type || 'application/octet-stream').slice(0, 120), author: String(c.get('user').name || 'HeyZubi').slice(0, 80),
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** Hermes says which file it is (and checks it still lives in its attachments folder); HeyZubi sends it. */
kanbanApi.get('/attachments/:aid', async (c) => {
  const aid = c.req.param('aid');
  if (!ATT_ID.test(aid)) return c.json({ error: 'bad attachment id' }, 400);
  let f: { path: string; filename: string; media_type: string };
  try { f = await kanban('attachment_file', { attachment: aid, board: boardOf(c) }); } catch (e: any) {
    const status = e instanceof KanbanError ? e.status : 500;
    return c.json({ error: String(e?.message ?? e) }, (status >= 400 && status < 600 ? status : 500) as any);
  }
  const real = await realpath(f.path).catch(() => null);
  const st = real ? await stat(real).catch(() => null) : null;
  if (!real || !st?.isFile() || !real.includes(`${path.sep}kanban${path.sep}`)) return c.json({ error: 'attachment file unavailable' }, 404);
  const type = String(f.media_type || 'application/octet-stream');
  const inline = c.req.query('inline') === '1' && INLINE_TYPES.has(type);
  const name = String(f.filename || 'file');
  const ascii = name.replace(/[^\x20-\x7E]+/g, '_').replace(/["\\]/g, '_');
  return new Response(Readable.toWeb(createReadStream(real)) as unknown as ReadableStream, {
    headers: {
      'Content-Type': inline ? type : 'application/octet-stream',
      'Content-Length': String(st.size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
});

kanbanApi.delete('/attachments/:aid', (c) => {
  const aid = c.req.param('aid');
  if (!ATT_ID.test(aid)) return c.json({ error: 'bad attachment id' }, 400);
  return answer(c, 'detach', { attachment: aid, board: boardOf(c) });
});

kanbanApi.post('/tasks/:id/comments', async (c) => {
  const id = c.req.param('id');
  if (!TASK_ID.test(id)) return c.json({ error: 'bad task id' }, 400);
  const p = await c.req.json().catch(() => null);
  const body = str(p?.body, 10_000)?.trim();
  if (!body) return c.json({ error: 'The comment is empty.' }, 400);
  // Signed with the person's name, as Hermes's own board signs its comments.
  return answer(c, 'comment', { id, board: boardOf(c), payload: { body, author: String(c.get('user').name || 'HeyZubi').slice(0, 80) } });
});

/** Every parent -> child link on the board, so a card can show how many tasks wait on it. */
kanbanApi.get('/links', (c) => answer(c, 'links', { board: boardOf(c) }));

// ---------- a report for each run of a card ----------

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const when = (sec?: number | null) => (sec ? new Date(sec * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST' : '–');
const took = (a?: number | null, b?: number | null) => { if (!a || !b) return '–'; const s = Math.max(0, b - a); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };

/**
 * One card's work as a readable page: what was asked, each run (who, how long, how it ended, its summary), what happened
 * during it, the comments, and the end of the worker's log. Failed runs get the same page. Text only, nothing runs.
 */
kanbanApi.get('/tasks/:id/report', async (c) => {
  const id = c.req.param('id');
  if (!TASK_ID.test(id)) return c.json({ error: 'bad task id' }, 400);
  let d: any, log = '';
  try {
    d = await kanban('task', { id, board: boardOf(c) });
    log = String((await kanban<any>('log', { id, board: boardOf(c), tail: 30000 }).catch(() => null))?.content ?? '');
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, (e instanceof KanbanError ? e.status : 500) as any);
  }
  const t = d.task ?? {};
  const want = Number(c.req.query('run'));
  const runs = ((d.runs ?? []) as any[]).filter((r) => !want || r.id === want).sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
  const tone = (r: any) => (/fail|error|crash|timed|gave_up|reclaim/i.test(`${r.outcome} ${r.status}`) ? 'bad' : /complet|done/i.test(`${r.outcome} ${r.status}`) ? 'good' : 'mid');
  const runHtml = runs.map((r) => {
    const evs = ((d.events ?? []) as any[]).filter((e) => e.run_id === r.id);
    return `<section class="run ${tone(r)}"><h2>Run ${esc(r.id)} · ${esc(r.profile ?? 'unassigned')} · ${esc(r.outcome ?? r.status ?? '')}</h2>
<dl><dt>Started</dt><dd>${esc(when(r.started_at))}</dd><dt>Ended</dt><dd>${esc(when(r.ended_at))}</dd><dt>Took</dt><dd>${esc(took(r.started_at, r.ended_at))}</dd>${r.error ? `<dt>Error</dt><dd class="err">${esc(r.error)}</dd>` : ''}</dl>
${r.summary ? `<h3>Summary</h3><pre>${esc(r.summary)}</pre>` : ''}${r.metadata && Object.keys(r.metadata).length ? `<h3>Handoff details</h3><pre>${esc(JSON.stringify(r.metadata, null, 2))}</pre>` : ''}
${evs.length ? `<h3>What happened</h3><ol class="evs">${evs.map((e) => `<li><b>${esc(e.kind)}</b> <span>${esc(when(e.created_at))}</span></li>`).join('')}</ol>` : ''}</section>`;
  }).join('\n');
  const comments = ((d.comments ?? []) as any[]).map((m) => `<li><b>${esc(m.author || 'Someone')}</b> <span>${esc(when(m.created_at))}</span><pre>${esc(m.body)}</pre></li>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.title ?? id)} · report</title>
<style>body{font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;max-width:860px;margin:0 auto;padding:28px 20px;color:#1d2230;background:#f7f7f9}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:0 0 8px}h3{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin:16px 0 6px}
.sub{color:#6b7280;margin:0 0 18px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin:0;font:13px/1.5 ui-monospace,Consolas,monospace}
.run{background:#fff;border:1px solid #e5e7eb;border-left:4px solid #9ca3af;border-radius:10px;padding:16px 18px;margin:14px 0}.run.good{border-left-color:#16a34a}.run.bad{border-left-color:#dc2626}
dl{display:grid;grid-template-columns:auto 1fr;gap:2px 14px;margin:0}dt{color:#6b7280}dd{margin:0}.err{color:#b91c1c}ol,ul{padding-left:20px;margin:0}.evs li span,li span{color:#6b7280;font-size:13px}.log{max-height:520px;overflow:auto}</style></head><body>
<h1>${esc(t.title ?? id)}</h1><p class="sub">${esc(id)} · now ${esc(t.status ?? '')}${t.assignee ? ` · ${esc(t.assignee)}` : ''} · created ${esc(when(t.created_at))}</p>
${t.body ? `<h3>What was asked</h3><pre>${esc(t.body)}</pre>` : ''}
${runHtml || '<p class="sub">No run yet: no team member has worked on this card.</p>'}
${comments ? `<h3>Comments</h3><ul>${comments}</ul>` : ''}
${log.trim() ? `<h3>End of the worker's log</h3><pre class="log">${esc(log.slice(-30000))}</pre>` : ''}
</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', // Shown inside HeyZubi itself (the board's report viewer), so only this app may frame it.
'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } });
});

// ---------- the prep assistant ----------

/**
 * Turns the owner's quick one-liner into a self-contained brief for the bot (what to do, what done looks like, limits),
 * using the team's roles and the board's recent cards as context. Read-only: it writes nothing; the owner reviews it.
 */
kanbanApi.post('/brief', async (c) => {
  const p = await c.req.json().catch(() => null);
  const title = str(p?.title, 300)?.trim() ?? '', body = str(p?.body, 4000)?.trim() ?? '', assignee = str(p?.assignee, 120) ?? '';
  if (!title && !body) return c.json({ error: 'Write a line first.' }, 400);
  const team = (db.prepare("SELECT name, label, hermes_profile, engine FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0").all(c.get('user').id) as any[])
    .map((b) => `- ${b.name}${b.label ? ` (${b.label})` : ''}${(b.engine === 'primary' ? 'default' : b.hermes_profile) === assignee ? ' ← this card is for them' : ''}`).join('\n');
  let recent = '';
  try {
    const board = await kanban<any>('board', { board: boardOf(c) });
    recent = ((board.columns ?? []) as any[]).flatMap((col) => (col.tasks ?? []).map((t: any) => `- [${col.name}] ${t.title}`)).slice(0, 25).join('\n');
  } catch { /* the board isn't reachable: brief without it */ }
  try {
    const r = await askJson<{ title: string; body: string }>({
      instructions: 'You prepare task briefs for an owner\'s AI team. You only rewrite; you never do the task, call tools or invent facts.',
      prompt: `The owner typed this quick task for the team's board:\nTitle: ${title}\n${body ? `Notes: ${body}\n` : ''}\nThe team:\n${team || '(unknown)'}\n\nOther cards on the board (for context; don't repeat their work):\n${recent || '(none)'}\n\nRewrite it as one self-contained brief the assigned team member can act on without asking. Keep the owner's intent exactly; where something is unknown, write it as a short question for the owner instead of guessing. Return JSON only: {"title": "<clear title, under 80 characters>", "body": "<the brief in plain text: Goal (1-2 sentences); What to do (short steps); Done when (what finished looks like); Limits (draft only, no sending/posting/paying unless the owner said so; anything else stated); Questions for the owner (only if needed)>"}`,
      check: (v) => [...(typeof v?.title === 'string' && v.title.trim() ? [] : ['title is missing']), ...(typeof v?.body === 'string' && v.body.trim().length > 40 ? [] : ['body is missing or too short'])],
      tries: 2, minutes: 3,
    });
    return c.json({ title: r.title.trim().slice(0, 300), body: r.body.trim().slice(0, 20_000) });
  } catch (e: any) {
    return c.json({ error: `The brief couldn’t be written: ${String(e?.message ?? e).slice(0, 200)}` }, 502);
  }
});
