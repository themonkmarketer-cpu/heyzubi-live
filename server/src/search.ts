import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { db } from './db.js';
import { kanban } from './hermes-kanban.js';
import { libraryRoot } from './paths.js';
import { requireUser, type AuthVars } from './lib/auth.js';

/**
 * Search across everything ("/" or Ctrl+K): team members, chat messages, Kanban cards, Library files, clients and
 * routines. Each hit says where it is and how to open it. Read only.
 */

export const searchApi = new Hono<AuthVars>();
searchApi.use('*', requireUser);

interface Hit { kind: 'bot' | 'message' | 'card' | 'file' | 'client' | 'routine'; title: string; sub: string; botId?: string; seq?: number; card?: string; file?: string; client?: string; at?: number }

const snip = (text: string, q: string, n = 140) => {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  const from = Math.max(0, i - 50);
  return `${from ? '…' : ''}${text.slice(from, from + n).replace(/\s+/g, ' ').trim()}${from + n < text.length ? '…' : ''}`;
};

function libraryHits(botIds: { id: string; name: string }[], q: string): Hit[] {
  const out: Hit[] = [];
  const ql = q.toLowerCase();
  for (const b of botIds) {
    const root = path.join(libraryRoot(), b.id);
    const walk = (dir: string, depth: number) => {
      let ents: fs.Dirent[] = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (out.length >= 20 || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.isFile() && e.name.toLowerCase().includes(ql)) out.push({ kind: 'file', title: e.name, sub: `${b.name}’s Library`, botId: b.id, file: path.relative(root, p).split(path.sep).join('/') });
      }
    };
    walk(root, 0);
  }
  return out;
}

searchApi.get('/', async (c) => {
  const user = c.get('user').id;
  const q = String(c.req.query('q') ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
  if (q.length < 2) return c.json({ q, hits: [] });
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const bots = db.prepare("SELECT id, name, label, description, kind FROM bots WHERE user_id=? AND COALESCE(hidden,0)=0").all(user) as any[];
  const names = new Map(bots.map((b) => [b.id, b.name]));
  const hits: Hit[] = [];

  for (const b of bots) {
    const t = `${b.name} ${b.label ?? ''} ${b.description ?? ''}`;
    if (t.toLowerCase().includes(q.toLowerCase())) hits.push({ kind: 'bot', title: b.label ? `${b.name} · ${b.label}` : b.name, sub: b.kind === 'room' ? 'Group chat' : 'Team member', botId: b.id });
  }

  const msgs = db.prepare(`SELECT r.bot_id, r.seq, r.body, r.created_at FROM rows r JOIN bots b ON b.id=r.bot_id
    WHERE b.user_id=? AND COALESCE(b.hidden,0)=0 AND r.kind='message' AND r.generation=b.generation
      AND r.body LIKE ? ESCAPE '\\' ORDER BY r.created_at DESC LIMIT 60`).all(user, like) as any[];
  for (const m of msgs) {
    let body: any; try { body = JSON.parse(m.body); } catch { continue; }
    const text = String(body.text ?? '');
    if (!text.toLowerCase().includes(q.toLowerCase())) continue;
    hits.push({ kind: 'message', title: snip(text, q), sub: `${names.get(m.bot_id) ?? 'Chat'} · ${body.role === 'user' ? 'you' : body.from?.name ?? names.get(m.bot_id) ?? 'bot'}`, botId: m.bot_id, seq: m.seq, at: m.created_at });
    if (hits.filter((h) => h.kind === 'message').length >= 20) break;
  }

  try {
    const board = await kanban<any>('board', {});
    const cards = ((board.columns ?? []) as any[]).flatMap((col) => ((col.tasks ?? []) as any[]).map((t) => ({ ...t, col: col.name ?? col.id })));
    for (const t of cards) {
      const text = `${t.title ?? ''}\n${t.body ?? ''}`;
      if (text.toLowerCase().includes(q.toLowerCase())) hits.push({ kind: 'card', title: String(t.title ?? t.id), sub: `Kanban · ${t.col}${t.assignee ? ` · ${t.assignee}` : ''}`, card: t.id });
      if (hits.filter((h) => h.kind === 'card').length >= 15) break;
    }
  } catch { /* the board is optional */ }

  hits.push(...libraryHits(bots.filter((b) => b.kind !== 'room'), q));

  try {
    for (const cl of db.prepare("SELECT id, name, company, email FROM clients WHERE user_id=? AND (name LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\') LIMIT 10").all(user, like, like, like, like, like) as any[]) {
      hits.push({ kind: 'client', title: cl.name, sub: ['Client', cl.company, cl.email].filter(Boolean).join(' · '), client: cl.id });
    }
  } catch { /* no address book yet */ }

  for (const r of db.prepare("SELECT r.id, r.name, r.bot_id FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND (r.name LIKE ? ESCAPE '\\' OR r.prompt LIKE ? ESCAPE '\\') LIMIT 10").all(user, like, like) as any[]) {
    hits.push({ kind: 'routine', title: r.name, sub: `Routine · ${names.get(r.bot_id) ?? ''}`, botId: r.bot_id });
  }

  return c.json({ q, hits });
});
