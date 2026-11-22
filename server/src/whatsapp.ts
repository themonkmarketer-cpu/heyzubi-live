import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { env } from './env.js';
import { hub } from './lib/hub.js';
import type { AuthVars } from './lib/auth.js';
import { getBotRow } from './store.js';
import type { ToolCtx, ToolResult } from './agent/tools.js';
import type { WaDraft } from './types.js';

/**
 * WhatsApp, send-only, shared with Zubi HQ's command center: the same Baileys bridge in the main
 * agent's Hermes home (`whatsapp-send`), the same paired account, the same send history, and so the
 * same daily cap and gap between messages. Pairing stays in Zubi HQ.
 *
 * A team member can only draft: the draft opens in the WhatsApp window in the app, where the owner
 * picks or checks who gets it, previews and presses Confirm. Only that Confirm sends, once.
 */
const DIR = path.join(env.hermesHome, 'whatsapp-send');
const SESSION = path.join(DIR, 'session');
const PORT = Number(process.env.HQ_WA_PORT ?? 3011);
const BRIDGE = `http://127.0.0.1:${PORT}`;
const HISTORY = path.join(env.hermesHome, 'command-center', 'whatsapp-history.json');
const NODE = process.env.HQ_WA_NODE ?? '/usr/local/bin/node';
export const WA_CAP = 20;
const GAP_MS = 5000;
const TEXT_MAX = 4000;
const PREVIEW_MS = 10 * 60_000;

async function call(method: string, p: string, body?: unknown, timeoutMs = 20_000): Promise<{ status: number; data: any }> {
  try {
    const r = await fetch(BRIDGE + p, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  } catch {
    return { status: 0, data: null };
  }
}

/** Baileys writes creds.json before a code is scanned; only a pairing fills `me` (same check as Zubi HQ). */
export function waPaired(): boolean {
  try { return !!JSON.parse(fs.readFileSync(path.join(SESSION, 'creds.json'), 'utf8')).me; } catch { return false; }
}

const up = async () => (await call('GET', '/health', undefined, 2000)).status === 200;

let starting: Promise<boolean> | null = null;
/** The bridge answers, or is started the way Zubi HQ starts it, as the owner of the session files. */
export function ensureBridge(): Promise<boolean> {
  if (!starting) {
    starting = (async () => {
      if (await up()) return true;
      if (!waPaired()) return false;
      const owner = fs.statSync(SESSION);
      const log = fs.openSync(path.join(DIR, 'bridge.log'), 'a');
      try {
        const child = spawn(NODE, ['bridge.js', '--port', String(PORT), '--session', SESSION], {
          cwd: DIR, detached: true, stdio: ['ignore', log, log], uid: owner.uid, gid: owner.gid,
          env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: env.hermesHome, LANG: 'C.UTF-8', WHATSAPP_SEND_READ_RECEIPTS: 'false' },
        });
        child.on('error', (e) => console.warn(`[whatsapp] bridge did not start: ${e.message}`));
        child.unref();
      } finally {
        fs.closeSync(log);
      }
      for (let i = 0; i < 60; i++) {
        if (await up()) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    })().finally(() => { starting = null; });
  }
  return starting;
}

// ---------- the history Zubi HQ keeps (one file, so the cap covers both apps) ----------

const pad = (n: number) => String(n).padStart(2, '0');
const day = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d = new Date()) => `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function history(): any[] {
  try { const h = JSON.parse(fs.readFileSync(HISTORY, 'utf8')); return Array.isArray(h) ? h : []; } catch { return []; }
}

function addHistory(entry: Record<string, unknown>) {
  const h = history();
  h.push(entry);
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  const owner = fs.existsSync(HISTORY) ? fs.statSync(HISTORY) : fs.statSync(SESSION);
  const tmp = `${HISTORY}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(h, null, 1), { mode: 0o600 });
  try { fs.chownSync(tmp, owner.uid, owner.gid); } catch { /* not root: the file is already ours */ }
  fs.renameSync(tmp, HISTORY);
}

export const sentToday = () => history().filter((e) => String(e.day) === day() && e.result !== 'blocked').length;

function msSinceLastSend(): number {
  const last = history().map((e) => Date.parse(String(e.ts).replace(' ', 'T'))).filter((t) => !Number.isNaN(t)).sort((a, b) => b - a)[0];
  return last ? Date.now() - last : Infinity;
}

// ---------- groups ----------

interface Group { id: string; name: string; size: number }
let groupCache: { at: number; groups: Group[] } | null = null;
async function groups(): Promise<Group[] | string> {
  if (groupCache && Date.now() - groupCache.at < 60_000) return groupCache.groups;
  const { status, data } = await call('GET', '/groups', undefined, 25_000);
  if (status !== 200) return 'Could not read the WhatsApp group list. Try again in a moment.';
  const list: Group[] = (data?.groups ?? []).map((g: any) => ({ id: String(g.id), name: String(g.name ?? ''), size: Number(g.size) || 0 }));
  groupCache = { at: Date.now(), groups: list };
  return list;
}

// ---------- the tool: a team member drafts, the window opens ----------

const drafts = new Map<string, WaDraft>(); // latest draft per owner

export async function whatsappDraft(a: { to_group?: string; to_number?: string; text?: string }, ctx: ToolCtx): Promise<ToolResult> {
  const text = String(a.text ?? '').trim();
  if (text.length > TEXT_MAX) return { output: `A WhatsApp message can be up to ${TEXT_MAX} characters (this one is ${text.length}). Shorten it.`, summary: 'Too long' };
  const bot = getBotRow(ctx.botId);
  const group = String(a.to_group ?? '').trim();
  const number = String(a.to_number ?? '').replace(/\D/g, '');
  const draft: WaDraft = {
    id: crypto.randomBytes(6).toString('hex'),
    botId: ctx.botId,
    botName: bot?.name ?? 'Your teammate',
    to: group ? { kind: 'group', name: group.slice(0, 120), number: '' } : number ? { kind: 'person', name: '', number: number.slice(0, 15) } : { kind: '', name: '', number: '' },
    text,
    at: Date.now(),
  };
  drafts.set(ctx.userId, draft);
  hub.emit(ctx.userId, { type: 'whatsapp', draft });
  const where = hub.isOnline(ctx.userId) ? 'It is open in the WhatsApp window in the app now' : 'It will open in the WhatsApp window when the owner opens the app';
  return {
    output: `${where}. The owner checks who gets it, previews and presses Confirm there; you cannot send it, so never say it was sent. Tell them the draft is waiting in the WhatsApp window.`,
    summary: 'Drafted a WhatsApp message',
  };
}

/** Close (hide) the WhatsApp window in the app. The draft stays, so opening it again shows the same message. */
export function whatsappClose(userId: string): ToolResult {
  hub.emit(userId, { type: 'whatsapp-close' });
  return { output: 'The WhatsApp window is closed. The draft is kept; nothing was sent.', summary: 'Closed the WhatsApp window' };
}

// ---------- the window's routes ----------

interface Preview { userId: string; kind: 'group' | 'person'; label: string; jid: string; text: string; exp: number }
const previews = new Map<string, Preview>();

export const whatsappApi = new Hono<AuthVars>();

whatsappApi.get('/status', async (c) => {
  const paired = waPaired();
  const ok = paired && (await ensureBridge());
  const h = ok ? await call('GET', '/health', undefined, 3000) : { status: 0, data: null };
  const state = !paired ? 'not_paired' : !ok ? 'offline' : String(h.data?.status ?? 'offline');
  return c.json({ state, phone: h.data?.me ? `+${h.data.me}` : '', sentToday: sentToday(), cap: WA_CAP });
});

whatsappApi.get('/groups', async (c) => {
  if (!(await ensureBridge())) return c.json({ error: 'WhatsApp is not connected. Connect it in Zubi HQ (Zubi Live, WhatsApp).' }, 409);
  const g = await groups();
  return typeof g === 'string' ? c.json({ error: g }, 502) : c.json({ groups: g });
});

/** The latest draft from a team member, so a window opened later still shows it. */
whatsappApi.get('/draft', (c) => c.json({ draft: drafts.get(c.get('user').id) ?? null }));

whatsappApi.get('/history', (c) => {
  const h = history().slice(-10).reverse().map((e) => ({ ts: String(e.ts ?? ''), to: String(e.to ?? ''), text: String(e.text ?? ''), result: String(e.result ?? ''), via: String(e.via ?? '') }));
  return c.json({ history: h });
});

whatsappApi.post('/preview', async (c) => {
  const user = c.get('user');
  const b = await c.req.json<{ kind?: string; group?: string; number?: string; text?: string }>().catch(() => ({} as any));
  const text = String(b.text ?? '').trim();
  if (!text) return c.json({ error: 'Write the message first.' }, 400);
  if (text.length > TEXT_MAX) return c.json({ error: `Up to ${TEXT_MAX} characters.` }, 400);
  if (!(await ensureBridge())) return c.json({ error: 'WhatsApp is not connected. Connect it in Zubi HQ (Zubi Live, WhatsApp).' }, 409);
  let target: Omit<Preview, 'userId' | 'text' | 'exp'>;
  if (b.kind === 'group') {
    const g = await groups();
    if (typeof g === 'string') return c.json({ error: g }, 502);
    const hit = g.find((x) => x.id === String(b.group ?? ''));
    if (!hit) return c.json({ error: 'Pick the group from the list.' }, 400);
    target = { kind: 'group', label: `Group: ${hit.name} (${hit.size} members)`, jid: hit.id };
  } else {
    const num = String(b.number ?? '').replace(/\D/g, '');
    if (!/^[1-9]\d{7,14}$/.test(num)) return c.json({ error: 'Give the number with its country code, digits only, for example 919783555153.' }, 400);
    const r = await call('POST', '/check', { number: num }, 20_000);
    if (r.status !== 200) return c.json({ error: String(r.data?.error ?? 'Could not check that number on WhatsApp.') }, 502);
    if (!r.data?.exists) return c.json({ error: `+${num} is not on WhatsApp.` }, 400);
    target = { kind: 'person', label: `+${num}`, jid: String(r.data.jid) };
  }
  for (const [k, v] of previews) if (v.exp < Date.now() || v.userId === user.id) previews.delete(k); // one live preview per owner
  const token = crypto.randomBytes(16).toString('hex');
  previews.set(token, { ...target, userId: user.id, text, exp: Date.now() + PREVIEW_MS });
  return c.json({ token, recipient: target.label, text, remaining: Math.max(0, WA_CAP - sentToday()) });
});

whatsappApi.post('/send', async (c) => {
  const user = c.get('user');
  const b = await c.req.json<{ token?: string; confirm?: boolean }>().catch(() => ({} as any));
  const p = b.token ? previews.get(String(b.token)) : undefined;
  if (!b.confirm || !p || p.userId !== user.id) return c.json({ ok: false, result: 'failed', error: 'Preview again, then confirm.' }, 400);
  previews.delete(String(b.token)); // one use, whatever happens next
  if (p.exp < Date.now()) return c.json({ ok: false, result: 'failed', error: 'The preview expired. Preview again.' }, 400);
  if (sentToday() >= WA_CAP) return c.json({ ok: false, result: 'failed', error: `The daily limit of ${WA_CAP} is reached (shared with Zubi HQ). It resets at midnight.` }, 429);
  const health = await call('GET', '/health', undefined, 3000);
  if (health.data?.status !== 'connected') return c.json({ ok: false, result: 'failed', error: 'WhatsApp is reconnecting. Nothing was sent; try again in a minute.' }, 503);
  const wait = GAP_MS - msSinceLastSend();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const entry: Record<string, unknown> = {
    id: crypto.randomBytes(5).toString('hex'), ts: stamp(), day: day(), kind: p.kind, to: p.label, jid: p.jid,
    type: 'text', text: p.text.slice(0, 200), image: '', via: 'heyzubi',
  };
  const r = await call('POST', '/send', { chatId: p.jid, message: p.text }, 60_000);
  if (r.status === 200 && r.data?.success) Object.assign(entry, { result: 'sent', message_id: r.data?.messageId ?? '' });
  else if (r.status === 0) Object.assign(entry, { result: 'unknown', error: 'No answer from WhatsApp. It may or may not have been sent: check the chat before sending again' });
  else Object.assign(entry, { result: 'failed', error: String(r.data?.error ?? `HTTP ${r.status}`).slice(0, 200) });
  addHistory(entry);
  if (entry.result === 'sent') drafts.delete(user.id);
  return c.json({ ok: entry.result === 'sent', result: entry.result, error: entry.error ?? null, to: p.label, left: Math.max(0, WA_CAP - sentToday()) });
});
