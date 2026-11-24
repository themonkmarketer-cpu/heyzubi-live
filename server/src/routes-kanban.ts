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

kanbanApi.post('/tasks/:id/comments', async (c) => {
  const id = c.req.param('id');
  if (!TASK_ID.test(id)) return c.json({ error: 'bad task id' }, 400);
  const p = await c.req.json().catch(() => null);
  const body = str(p?.body, 10_000)?.trim();
  if (!body) return c.json({ error: 'The comment is empty.' }, 400);
  // Signed with the person's name, as Hermes's own board signs its comments.
  return answer(c, 'comment', { id, board: boardOf(c), payload: { body, author: String(c.get('user').name || 'HeyZubi').slice(0, 80) } });
});
