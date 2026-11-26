import { Hono } from 'hono';
import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { requireUser, type AuthVars } from './lib/auth.js';

/**
 * A small client address book: name, company, email, phone, tags and notes per client. The window lists and edits
 * them; "Catch me up" asks Zubi to gather everything about one client (Gmail, calendar, the Kanban, these notes) into
 * a short brief. The team can read the book through HeyZubi's own tools (see mcp.ts: list_clients / get_client).
 */

db.exec(`CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, company TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);

export interface Client { id: string; name: string; company: string; email: string; phone: string; tags: string[]; notes: string; createdAt: number; updatedAt: number }
const view = (r: any): Client => ({ id: r.id, name: r.name, company: r.company, email: r.email, phone: r.phone, tags: r.tags ? r.tags.split(',') : [], notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at });
const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

export function listClients(userId: string, q = ''): Client[] {
  const like = `%${q.replace(/[%_]/g, '')}%`;
  return (db.prepare(`SELECT * FROM clients WHERE user_id=? AND (?='' OR name LIKE ? OR company LIKE ? OR email LIKE ? OR tags LIKE ? OR notes LIKE ?)
    ORDER BY updated_at DESC LIMIT 200`).all(userId, q, like, like, like, like, like) as any[]).map(view);
}
export const getClient = (userId: string, id: string) => { const r = db.prepare('SELECT * FROM clients WHERE id=? AND user_id=?').get(id, userId); return r ? view(r) : null; };

function fields(p: any, cur?: Client) {
  const pick = (k: string, max: number) => (p[k] !== undefined ? clean(p[k], max) : (cur as any)?.[k] ?? '');
  const tags = p.tags !== undefined
    ? (Array.isArray(p.tags) ? p.tags : String(p.tags).split(',')).map((t: unknown) => clean(t, 30).toLowerCase()).filter(Boolean).slice(0, 10).join(',')
    : (cur?.tags ?? []).join(',');
  return { name: pick('name', 100), company: pick('company', 100), email: pick('email', 200).toLowerCase(), phone: pick('phone', 40), notes: pick('notes', 8000), tags };
}

/** What Zubi is asked when the owner presses "Catch me up". */
export function catchUpPrompt(c: Client): string {
  const who = [c.name, c.company && `(${c.company})`, c.email && `<${c.email}>`].filter(Boolean).join(' ');
  return [
    `Catch me up on my client ${who}.`,
    'Look through what you can reach: recent Gmail threads with them, past and upcoming calendar events with them, Kanban cards that mention them, and my notes below.',
    'Then give me a short brief: where things stand, the last thing each side said or did, anything waiting on me, and one suggested next step. Read only: don’t send, reply or change anything.',
    c.notes ? `My notes on them:\n${c.notes}` : '',
  ].filter(Boolean).join('\n\n');
}

export const clientsApi = new Hono<AuthVars>();
clientsApi.use('*', requireUser);

clientsApi.get('/', (c) => c.json({ clients: listClients(c.get('user').id, clean(c.req.query('q'), 80)) }));

clientsApi.post('/', async (c) => {
  const user = c.get('user').id;
  const f = fields(await c.req.json().catch(() => ({})));
  if (!f.name) return c.json({ error: 'A client needs a name.' }, 400);
  if ((db.prepare('SELECT COUNT(*) n FROM clients WHERE user_id=?').get(user) as any).n >= 2000) return c.json({ error: 'The address book is full (2,000 clients).' }, 409);
  const id = newId('cli');
  db.prepare('INSERT INTO clients(id,user_id,name,company,email,phone,tags,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, user, f.name, f.company, f.email, f.phone, f.tags, f.notes, now(), now());
  return c.json({ client: getClient(user, id) });
});

clientsApi.patch('/:id', async (c) => {
  const user = c.get('user').id;
  const cur = getClient(user, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  const f = fields(await c.req.json().catch(() => ({})), cur);
  if (!f.name) return c.json({ error: 'A client needs a name.' }, 400);
  db.prepare('UPDATE clients SET name=?, company=?, email=?, phone=?, tags=?, notes=?, updated_at=? WHERE id=?').run(f.name, f.company, f.email, f.phone, f.tags, f.notes, now(), cur.id);
  return c.json({ client: getClient(user, cur.id) });
});

clientsApi.delete('/:id', (c) => {
  db.prepare('DELETE FROM clients WHERE id=? AND user_id=?').run(c.req.param('id'), c.get('user').id);
  return c.json({ ok: true });
});

clientsApi.get('/:id/catch-up', (c) => {
  const cl = getClient(c.get('user').id, c.req.param('id'));
  return cl ? c.json({ prompt: catchUpPrompt(cl) }) : c.json({ error: 'not found' }, 404);
});
