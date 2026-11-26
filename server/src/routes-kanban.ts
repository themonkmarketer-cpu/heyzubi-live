import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { mayUsePrimary } from './engine.js';
import { kanban, KanbanError } from './hermes-kanban.js';
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
