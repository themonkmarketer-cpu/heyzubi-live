import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Hono } from 'hono';
import { env } from './env.js';
import { hub } from './lib/hub.js';
import type { AuthVars } from './lib/auth.js';
import { getBotRow } from './store.js';
import type { ToolCtx, ToolResult } from './agent/tools.js';
import type { WaDraft } from './types.js';
import { genFile } from './generations.js';

/**
 * WhatsApp, send-only, shared with Zubi HQ's command center: the same Baileys bridge in the main
 * agent's Hermes home (`whatsapp-send`), the same paired account, the same send history, and so the
 * same daily cap and gap between messages. Like Zubi HQ's WhatsApp page, the window can pair a number by
 * QR, disconnect it, send text or an image with a caption, and show the whole sent history.
 *
 * A team member can only draft: the draft opens in the WhatsApp window in the app, where the owner
 * picks or checks who gets it, previews and presses Confirm. Only that Confirm sends, once.
 */
const DIR = path.join(env.hermesHome, 'whatsapp-send');
const SESSION = path.join(DIR, 'session');
const OUTBOX = path.join(DIR, 'outbox');

const PORT = Number(process.env.HQ_WA_PORT ?? 3011);
const BRIDGE = `http://127.0.0.1:${PORT}`;
const HISTORY = path.join(env.hermesHome, 'command-center', 'whatsapp-history.json');
const NODE = process.env.HQ_WA_NODE ?? '/usr/local/bin/node';
export const WA_CAP = 20;
const GAP_MS = 5000;
const TEXT_MAX = 4000;
const CAPTION_MAX = 1000;
const PREVIEW_MS = 10 * 60_000;
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

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
/** Files the bridge reads or writes belong to the owner of the WhatsApp folder (the Hermes user), not root. */
const owner = () => fs.statSync(DIR);
const giveToOwner = (p: string) => { try { const o = owner(); fs.chownSync(p, o.uid, o.gid); } catch { /* already theirs */ } };
const bridgeEnv = () => ({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: env.hermesHome, LANG: 'C.UTF-8', WHATSAPP_SEND_READ_RECEIPTS: 'false' });

let bridgeChild: ChildProcess | null = null;
let starting: Promise<boolean> | null = null;
/** The bridge answers, or is started the way Zubi HQ starts it, as the owner of the session files. */
export function ensureBridge(): Promise<boolean> {
  if (!starting) {
    starting = (async () => {
      if (await up()) return true;
      if (!waPaired()) return false;
      const o = owner();
      const log = fs.openSync(path.join(DIR, 'bridge.log'), 'a');
      try {
        const child = spawn(NODE, ['bridge.js', '--port', String(PORT), '--session', SESSION], {
          cwd: DIR, detached: true, stdio: ['ignore', log, log], uid: o.uid, gid: o.gid, env: bridgeEnv(),
        });
        child.on('error', (e) => console.warn(`[whatsapp] bridge did not start: ${e.message}`));
        child.on('exit', () => { if (bridgeChild === child) bridgeChild = null; });
        child.unref();
        bridgeChild = child;
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

function stopOurBridge() {
  for (const p of [bridgeChild, pairProc]) {
    if (p && p.exitCode === null) { try { process.kill(-p.pid!, 'SIGTERM'); } catch { try { p.kill(); } catch { /* gone */ } } }
  }
  bridgeChild = null;
}

// ---------- pairing by QR (Zubi HQ: node bridge.js --pair-only --pair-json) ----------

type PairState = 'idle' | 'starting' | 'qr' | 'connected' | 'error';
const pair: { state: PairState; svg: string; error: string; user: string } = { state: 'idle', svg: '', error: '', user: '' };
let pairProc: ChildProcess | null = null;

/** A session folder that never finished pairing is thrown away, so the next try starts clean. */
function dropUnpaired() {
  if (!waPaired()) { try { fs.rmSync(SESSION, { recursive: true, force: true }); } catch { /* none */ } }
}

async function pairStart(): Promise<PairState> {
  if (waPaired() && (await up())) { Object.assign(pair, { state: 'connected', svg: '', error: '' }); return 'connected'; }
  if (pairProc && pairProc.exitCode === null) return pair.state;
  stopOurBridge();
  fs.mkdirSync(SESSION, { recursive: true, mode: 0o700 });
  giveToOwner(SESSION);
  const o = owner();
  const log = fs.openSync(path.join(DIR, 'pair.log'), 'a');
  const proc = spawn(NODE, ['bridge.js', '--pair-only', '--pair-json', '--session', SESSION], {
    cwd: DIR, detached: true, stdio: ['ignore', 'pipe', log], uid: o.uid, gid: o.gid, env: bridgeEnv(),
  });
  fs.closeSync(log);
  pairProc = proc;
  Object.assign(pair, { state: 'starting', svg: '', error: '', user: '' });
  readline.createInterface({ input: proc.stdout! }).on('line', (line) => {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.event === 'qr') Object.assign(pair, { state: 'qr', svg: String(ev.svg ?? '') });
    else if (ev.event === 'connected') {
      const u = typeof ev.user === 'object' ? ev.user?.id : ev.user;
      Object.assign(pair, { state: 'connected', svg: '', user: String(u ?? '').split(':')[0].split('@')[0] });
    } else if ((ev.event === 'error' || ev.event === 'disconnected') && pair.state !== 'connected') {
      Object.assign(pair, { state: 'error', svg: '', error: String(ev.error ?? ev.reason ?? 'disconnected') });
    }
  });
  proc.on('exit', () => {
    if (pairProc === proc) pairProc = null;
    if (pair.state === 'connected' || waPaired()) { pair.state = 'connected'; void ensureBridge(); }
    else {
      if (pair.state === 'starting' || pair.state === 'qr') Object.assign(pair, { state: 'error', svg: '', error: 'Pairing stopped before the code was scanned.' });
      dropUnpaired();
    }
  });
  // A code nobody scans must not run forever (same 3 minutes as Zubi HQ).
  setTimeout(() => { if (proc.exitCode === null && (pair.state === 'starting' || pair.state === 'qr')) { try { process.kill(-proc.pid!, 'SIGTERM'); } catch { proc.kill(); } } }, 180_000).unref();
  return 'starting';
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
  const o = fs.existsSync(HISTORY) ? fs.statSync(HISTORY) : owner();
  const tmp = `${HISTORY}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(h, null, 1), { mode: 0o600 });
  try { fs.chownSync(tmp, o.uid, o.gid); } catch { /* not root: the file is already ours */ }
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

// ---------- images: an upload from this computer, or a picture from Generations ----------

type Img = { upload?: string; gen?: string } | null | undefined;

/** The file an image choice points at, or a reason it can't be used. */
function imagePath(img: Img): { file: string; name: string } | string | null {
  if (!img) return null;
  if (img.upload) {
    const id = String(img.upload).replace(/[^a-f0-9]/g, '').slice(0, 12);
    let hit: string | undefined;
    try { hit = id ? fs.readdirSync(OUTBOX).find((f) => f.startsWith(`${id}.`)) : undefined; } catch { /* no outbox */ }
    return hit ? { file: path.join(OUTBOX, hit), name: hit } : 'That uploaded image is gone. Upload it again.';
  }
  if (img.gen) {
    // Generations (top level, refs/) or the Zubi inbox on the network drive (inbox/).
    const f = genFile(String(img.gen));
    if (!f || !IMG_EXT.has(path.extname(f).toLowerCase()) || !fs.existsSync(f)) {
      return 'That picture was not found in Generations or the Zubi inbox, or is not a PNG, JPG, WebP or GIF.';
    }
    return { file: f, name: path.basename(f) };
  }
  return 'Unknown image.';
}

// ---------- the tool: a team member drafts, the window opens ----------

const drafts = new Map<string, WaDraft>(); // latest draft per owner

export async function whatsappDraft(a: { to_group?: string; to_number?: string; text?: string; image?: string }, ctx: ToolCtx): Promise<ToolResult> {
  const text = String(a.text ?? '').trim();
  if (text.length > TEXT_MAX) return { output: `A WhatsApp message can be up to ${TEXT_MAX} characters (this one is ${text.length}). Shorten it.`, summary: 'Too long' };
  const bot = getBotRow(ctx.botId);
  const group = String(a.to_group ?? '').trim();
  const number = String(a.to_number ?? '').replace(/\D/g, '');
  const image = String(a.image ?? '').trim();
  const imageOk = !!image && typeof imagePath({ gen: image }) === 'object';
  const draft: WaDraft = {
    id: crypto.randomBytes(6).toString('hex'),
    botId: ctx.botId,
    botName: bot?.name ?? 'Your teammate',
    to: group ? { kind: 'group', name: group.slice(0, 120), number: '' } : number ? { kind: 'person', name: '', number: number.slice(0, 15) } : { kind: '', name: '', number: '' },
    text,
    ...(imageOk ? { image } : {}),
    at: Date.now(),
  };
  drafts.set(ctx.userId, draft);
  hub.emit(ctx.userId, { type: 'whatsapp', draft });
  const where = hub.isOnline(ctx.userId) ? 'It is open in the WhatsApp window in the app now' : 'It will open in the WhatsApp window when the owner opens the app';
  const imgNote = image && !imageOk ? ' (The image you named was not found in Generations, so the draft has no image.)' : '';
  return {
    output: `${where}.${imgNote} The owner checks who gets it, previews and presses Confirm there; you cannot send it, so never say it was sent. Tell them the draft is waiting in the WhatsApp window.`,
    summary: 'Drafted a WhatsApp message',
  };
}

/** Close (hide) the WhatsApp window in the app. The draft stays, so opening it again shows the same message. */
export function whatsappClose(userId: string): ToolResult {
  hub.emit(userId, { type: 'whatsapp-close' });
  return { output: 'The WhatsApp window is closed. The draft is kept; nothing was sent.', summary: 'Closed the WhatsApp window' };
}

// ---------- the window's routes ----------

interface Preview { userId: string; kind: 'group' | 'person'; label: string; jid: string; text: string; image: { file: string; name: string } | null; exp: number }
const previews = new Map<string, Preview>();

export const whatsappApi = new Hono<AuthVars>();

whatsappApi.get('/status', async (c) => {
  // Uploads nobody sent are cleared after 3 days (as in Zubi HQ).
  try { for (const f of fs.readdirSync(OUTBOX)) { const p = path.join(OUTBOX, f); if (Date.now() - fs.statSync(p).mtimeMs > 3 * 86400_000) fs.rmSync(p, { force: true }); } } catch { /* no outbox */ }
  const paired = waPaired();
  const ok = paired && (await ensureBridge());
  const h = ok ? await call('GET', '/health', undefined, 3000) : { status: 0, data: null };
  const state = !paired ? (pair.state === 'idle' || pair.state === 'connected' ? 'not_paired' : `pair_${pair.state}`) : !ok ? 'offline' : String(h.data?.status ?? 'offline');
  return c.json({
    state, paired, phone: h.data?.me ? `+${h.data.me}` : '', sentToday: sentToday(), cap: WA_CAP,
    pair: { state: pair.state, svg: pair.state === 'qr' && pair.svg.trim().startsWith('<svg') ? pair.svg : '', error: pair.error },
  });
});

/** Show a QR code to link a WhatsApp number (Linked devices → Link a device on the phone). */
whatsappApi.post('/pair/start', async (c) => c.json({ ok: true, state: await pairStart() }));

whatsappApi.post('/pair/cancel', (c) => {
  if (pairProc && pairProc.exitCode === null) { try { process.kill(-pairProc.pid!, 'SIGTERM'); } catch { pairProc.kill(); } }
  dropUnpaired();
  Object.assign(pair, { state: 'idle', svg: '', error: '' });
  return c.json({ ok: true });
});

/** Unlink this number and delete the saved session (the history stays). Needs {confirm: true}. */
whatsappApi.post('/disconnect', async (c) => {
  const b = await c.req.json<{ confirm?: boolean }>().catch(() => ({} as any));
  if (b.confirm !== true) return c.json({ error: 'Confirm the disconnect.' }, 400);
  if (await up()) await call('POST', '/logout', {}, 5000);
  stopOurBridge();
  try { fs.rmSync(SESSION, { recursive: true, force: true }); } catch { /* none */ }
  Object.assign(pair, { state: 'idle', svg: '', error: '' });
  groupCache = null;
  return c.json({ ok: true });
});

whatsappApi.get('/groups', async (c) => {
  if (!(await ensureBridge())) return c.json({ error: 'WhatsApp is not connected. Connect it first.' }, 409);
  const g = await groups();
  return typeof g === 'string' ? c.json({ error: g }, 502) : c.json({ groups: g });
});

/** An image from this computer for a send: {name, data} (base64 or a data: URL). PNG, JPG, WebP or GIF, 15 MB. */
whatsappApi.post('/upload', async (c) => {
  const b = await c.req.json<{ name?: string; data?: string }>().catch(() => ({} as any));
  const name = String(b.name ?? '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80).replace(/^\.+/, '');
  const ext = path.extname(name).toLowerCase();
  if (!IMG_EXT.has(ext)) return c.json({ error: 'Use a PNG, JPG, WebP or GIF image.' }, 400);
  const raw = String(b.data ?? '').replace(/^data:[^,]*,/, '');
  const blob = Buffer.from(raw, 'base64');
  if (!blob.length || blob.length > 15 * 1024 * 1024) return c.json({ error: 'Images up to 15 MB.' }, 413);
  const magic = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x52, 0x49, 0x46, 0x46], [0x47, 0x49, 0x46, 0x38]];
  if (!magic.some((m) => m.every((x, i) => blob[i] === x))) return c.json({ error: 'That file is not a real image.' }, 400);
  fs.mkdirSync(OUTBOX, { recursive: true });
  giveToOwner(OUTBOX);
  const id = crypto.randomBytes(6).toString('hex');
  const file = path.join(OUTBOX, `${id}${ext === '.jpeg' ? '.jpg' : ext}`);
  fs.writeFileSync(file, blob, { mode: 0o600 });
  giveToOwner(file);
  return c.json({ ok: true, id, name, size: blob.length });
});

/** The latest draft from a team member, so a window opened later still shows it. */
whatsappApi.get('/draft', (c) => c.json({ draft: drafts.get(c.get('user').id) ?? null }));

/** The whole sent history, newest first (shared with Zubi HQ). */
whatsappApi.get('/history', (c) => {
  const limit = Math.max(1, Math.min(500, Number(c.req.query('limit')) || 200));
  const all = history();
  const h = all.slice(-limit).reverse().map((e) => ({
    ts: String(e.ts ?? ''), to: String(e.to ?? ''), text: String(e.text ?? ''), result: String(e.result ?? ''), via: String(e.via ?? ''),
    type: String(e.type ?? 'text'), image: String(e.image ?? ''), error: String(e.error ?? ''),
  }));
  return c.json({ history: h, total: all.length, today: sentToday(), cap: WA_CAP });
});

whatsappApi.post('/preview', async (c) => {
  const user = c.get('user');
  const b = await c.req.json<{ kind?: string; group?: string; number?: string; text?: string; image?: Img }>().catch(() => ({} as any));
  const text = String(b.text ?? '').trim();
  const img = imagePath(b.image);
  if (typeof img === 'string') return c.json({ error: img }, 400);
  if (!text && !img) return c.json({ error: 'Write the message, or add an image.' }, 400);
  if (img && text.length > CAPTION_MAX) return c.json({ error: `An image caption can be up to ${CAPTION_MAX} characters (yours is ${text.length}).` }, 400);
  if (text.length > TEXT_MAX) return c.json({ error: `Up to ${TEXT_MAX} characters.` }, 400);
  if (!(await ensureBridge())) return c.json({ error: 'WhatsApp is not connected. Connect it first.' }, 409);
  let target: Pick<Preview, 'kind' | 'label' | 'jid'>;
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
  previews.set(token, { ...target, userId: user.id, text, image: img, exp: Date.now() + PREVIEW_MS });
  return c.json({ token, recipient: target.label, text, hasImage: !!img, imageName: img?.name ?? '', remaining: Math.max(0, WA_CAP - sentToday()) });
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
    type: p.image ? 'image' : 'text', text: p.text.slice(0, 200), image: p.image?.name ?? '', via: 'heyzubi',
  };
  const r = p.image
    ? await call('POST', '/send-media', { chatId: p.jid, filePath: p.image.file, mediaType: 'image', caption: p.text || undefined }, 90_000)
    : await call('POST', '/send', { chatId: p.jid, message: p.text }, 60_000);
  if (r.status === 200 && r.data?.success) Object.assign(entry, { result: 'sent', message_id: r.data?.messageId ?? '' });
  else if (r.status === 0) Object.assign(entry, { result: 'unknown', error: 'No answer from WhatsApp. It may or may not have been sent: check the chat before sending again' });
  else Object.assign(entry, { result: 'failed', error: String(r.data?.error ?? `HTTP ${r.status}`).slice(0, 200) });
  addHistory(entry);
  if (entry.result === 'sent') drafts.delete(user.id);
  return c.json({ ok: entry.result === 'sent', result: entry.result, error: entry.error ?? null, to: p.label, left: Math.max(0, WA_CAP - sentToday()) });
});
