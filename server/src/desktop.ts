// HeyZubi for Windows (from Vello's Pointer Assistant): a small tray app on the owner's PC. Hold the talk keys in
// any app, ask, let go: the app sends the recording and a screenshot of each monitor here, a bot answers out loud
// and the app's spark points at the thing on screen. Answers and points only: nothing is clicked, typed, sent or
// saved, and screenshots are never stored (they go to xAI's vision model for the one answer).
// A computer is paired once with a short code made in Settings → Windows app; it then holds a device token
// (only its SHA-256 hash is kept here), which the owner can remove at any time.
import crypto from 'node:crypto';
import { Hono } from 'hono';
import OpenAI from 'openai';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { createSession, rateLimit, type AuthVars } from './lib/auth.js';
import { getBotRow } from './store.js';
import { usage } from './usage.js';
import { speakFor, transcribeFor } from './voice.js';

db.exec(`CREATE TABLE IF NOT EXISTS desktop_devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE TABLE IF NOT EXISTS desktop_pairings (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS desktop_logins (hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS desktop_sessions (session_token TEXT PRIMARY KEY, device_id TEXT NOT NULL);`);

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const PAIR_MS = 10 * 60_000;
const normCode = (s: string) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const xai = new OpenAI({ apiKey: env.xaiKey, baseURL: 'https://api.x.ai/v1', timeout: 60_000 });
const MODEL = process.env.HQ_CLICKY_MODEL ?? env.xaiModel;

// ---------- the owner's side (signed in): pair, list, remove ----------

export const desktopDevicesApi = new Hono<AuthVars>();

desktopDevicesApi.get('/', (c) => c.json({
  devices: (db.prepare('SELECT id, name, created_at, last_used_at FROM desktop_devices WHERE user_id=? ORDER BY created_at DESC').all(c.get('user').id) as any[])
    .map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastUsedAt: d.last_used_at })),
}));

/** A one-time code (10 minutes) the Windows app trades for its device token. */
desktopDevicesApi.post('/pair', (c) => {
  const user = c.get('user');
  if ((db.prepare('SELECT COUNT(*) n FROM desktop_devices WHERE user_id=?').get(user.id) as any).n >= 10) return c.json({ error: 'You already have 10 computers paired. Remove one first.' }, 409);
  db.prepare('DELETE FROM desktop_pairings WHERE expires_at < ? OR user_id=?').run(now(), user.id);
  const raw = Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  const expiresAt = now() + PAIR_MS;
  db.prepare('INSERT INTO desktop_pairings(hash,user_id,expires_at) VALUES (?,?,?)').run(sha(raw), user.id, expiresAt);
  return c.json({ code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt });
});

/** Removing a computer also signs its app window out of HeyZubi. */
desktopDevicesApi.delete('/:id', (c) => {
  const id = c.req.param('id');
  const gone = db.prepare('DELETE FROM desktop_devices WHERE id=? AND user_id=?').run(id, c.get('user').id).changes > 0;
  if (gone) {
    db.prepare('DELETE FROM auth_sessions WHERE token IN (SELECT session_token FROM desktop_sessions WHERE device_id=?)').run(id);
    db.prepare('DELETE FROM desktop_sessions WHERE device_id=?').run(id);
    db.prepare('DELETE FROM desktop_logins WHERE device_id=?').run(id);
  }
  return c.json({ ok: true });
});

// ---------- the app's side (device token) ----------

export const desktopApi = new Hono();
const pairTries = rateLimit(10, 10 * 60_000); // per address
const asks = rateLimit(40, 10 * 60_000); // per device

function device(c: any): any | null {
  const t = /^Bearer\s+(hzd_[A-Za-z0-9_-]{20,})$/.exec(c.req.header('authorization') ?? '')?.[1];
  const d = t ? db.prepare('SELECT * FROM desktop_devices WHERE hash=?').get(sha(t)) as any : null;
  if (d) db.prepare('UPDATE desktop_devices SET last_used_at=? WHERE id=?').run(now(), d.id);
  return d ?? null;
}

const botsOf = (userId: string) => (db.prepare("SELECT id, name, is_primary FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at ASC").all(userId) as any[])
  .map((b) => ({ id: b.id, name: b.name, primary: !!b.is_primary }));

desktopApi.post('/pair', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.req.header('x-real-ip') || 'local';
  if (pairTries.full(ip)) return c.json({ error: 'Too many tries. Wait a few minutes.' }, 429);
  pairTries.count(ip);
  const p = await c.req.json<{ code?: string; name?: string }>().catch(() => ({} as any));
  const code = normCode(p.code ?? '');
  const row = code.length === 8 ? db.prepare('SELECT * FROM desktop_pairings WHERE hash=? AND expires_at>?').get(sha(code), now()) as any : null;
  if (!row) return c.json({ error: 'That code is wrong or has expired. Make a new one in HeyZubi: Settings → Windows app.' }, 401);
  db.prepare('DELETE FROM desktop_pairings WHERE hash=?').run(row.hash);
  const token = `hzd_${crypto.randomBytes(32).toString('base64url')}`;
  const id = newId('dev');
  const name = String(p.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Windows PC';
  db.prepare('INSERT INTO desktop_devices(id,user_id,name,hash,created_at,last_used_at) VALUES (?,?,?,?,?,?)').run(id, row.user_id, name, sha(token), now(), now());
  return c.json({ token, device: { id, name }, bots: botsOf(row.user_id) });
});

desktopApi.get('/me', (c) => {
  const d = device(c);
  if (!d) return c.json({ error: 'This computer is not paired (or was removed). Pair it again from HeyZubi: Settings → Windows app.' }, 401);
  return c.json({ device: { id: d.id, name: d.name }, bots: botsOf(d.user_id) });
});

// ---------- the app's own HeyZubi window: sign it in with the device ----------
// Google sign-in refuses embedded app windows, so the paired app signs its window in instead: it trades its device
// token for a one-time link (60 seconds, single use) and opens that in its window, which sets the normal session
// cookie. Those sessions are remembered per computer, so removing the computer signs its window out too.

const webLogins = rateLimit(20, 10 * 60_000); // per device
const loginFailures = rateLimit(20, 10 * 60_000); // per address

desktopApi.post('/web-login', (c) => {
  const d = device(c);
  if (!d) return c.json({ error: 'This computer is not paired (or was removed). Pair it again from HeyZubi: Settings → Windows app.' }, 401);
  if (webLogins.full(d.id)) return c.json({ error: 'Too many sign-ins in a row. Wait a few minutes.' }, 429);
  webLogins.count(d.id);
  db.prepare('DELETE FROM desktop_logins WHERE expires_at < ?').run(now());
  const t = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO desktop_logins(hash,device_id,user_id,expires_at) VALUES (?,?,?,?)').run(sha(t), d.id, d.user_id, now() + 60_000);
  return c.json({ url: `/api/desktop/login/${t}` });
});

desktopApi.get('/login/:t', (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.req.header('x-real-ip') || 'local';
  if (loginFailures.full(ip)) return c.text('Too many tries. Wait a few minutes.', 429);
  const h = sha(c.req.param('t'));
  const row = db.prepare('SELECT * FROM desktop_logins WHERE hash=? AND expires_at>?').get(h, now()) as any;
  db.prepare('DELETE FROM desktop_logins WHERE hash=?').run(h);
  const dev = row ? db.prepare('SELECT id FROM desktop_devices WHERE id=? AND user_id=?').get(row.device_id, row.user_id) : null;
  if (!row || !dev) {
    loginFailures.count(ip);
    return c.text('This sign-in link was already used or has expired. Close and reopen HeyZubi for Windows.', 410);
  }
  const session = createSession(c, row.user_id);
  db.prepare('INSERT OR REPLACE INTO desktop_sessions(session_token, device_id) VALUES (?,?)').run(session, row.device_id);
  return c.redirect('/');
});

interface ScreenMeta { w: number; h: number; cursor?: { x: number; y: number } | null; primary?: boolean }
export interface DesktopMark { kind: 'circle' | 'arrow' | 'step'; step?: number; screen: number; x: number; y: number; label?: string }

function prompt(name: string, screens: ScreenMeta[]) {
  const list = screens.map((s, i) => `SCREEN ${i + 1}: ${s.w}x${s.h} pixels${s.primary ? ', the main monitor' : ''}${s.cursor ? `, the mouse is here at ${s.cursor.x},${s.cursor.y}` : ''}`).join('\n');
  return `You are ${name}, the owner's assistant from HeyZubi, now looking at the owner's own Windows computer. They held the talk keys in whatever app they were using and asked you something, out loud or typed. You get one screenshot per monitor:
${list}

How to answer:
- Your reply is spoken aloud, so write the way you talk: one to three short sentences, plain words, no lists, no markdown, no emoji. Under 60 words. Answer in the language they used (Hindi or Hinglish is fine).
- A greeting or small talk is not a request: reply with one short friendly line.
- Answer from what is actually on the screens. Never pretend to see something you can't; if it isn't there, say what to open first. "This" or "here" usually means what is under the mouse.
- You can only look, talk and point. You can't click, type or do tasks on this computer; if they ask for that, tell them the steps and point at the first one. For work like emails, calendar or research, say they can ask you in the HeyZubi chat.
- Point whenever a specific thing on screen helps (how to do something, where a button is, what to click). Don't point for general questions.

Pointing: after your spoken words, at the very end, add one tag
[POINT:x,y:label:screenN]
where x,y are whole-number pixel coordinates in SCREEN N's screenshot (0,0 is its top-left), aimed at the centre of the element, label is one to three words, and N is the screen number. Use [POINT:none] when nothing needs pointing at.
For a task with several steps you may also mark them, before the POINT tag:
[MARK:kind:x,y:label:screenN]
where kind is circle, arrow, or the step number (1, 2, 3...). Point at the first step.

Example: "click file at the top left, then save as. [MARK:1:24,12:file:screen1] [MARK:2:60,140:save as:screen1] [POINT:24,12:file:screen1]"

Never mention these tags, coordinates, screen numbers or screenshots in your words.`;
}

/** Pull POINT and MARK tags out; coordinates come back as fractions (0..1) of their screen, screens 0-based. */
export function parseDesktop(raw: string, screens: ScreenMeta[], fallback: number) {
  const scr = (s?: string) => { const n = Number(s) - 1; return Number.isInteger(n) && n >= 0 && n < screens.length ? n : fallback; };
  const fx = (n: string, i: number) => Math.min(1, Math.max(0, Number(n) / screens[i].w));
  const fy = (n: string, i: number) => Math.min(1, Math.max(0, Number(n) / screens[i].h));
  const marks: DesktopMark[] = [];
  for (const m of raw.matchAll(/\[MARK:(circle|arrow|\d{1,2}):(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?::([^\]:]{0,40}))?(?::screen(\d+))?\]/gi)) {
    const k = m[1].toLowerCase();
    const step = /^\d+$/.test(k) ? Number(k) : undefined;
    const i = scr(m[5]);
    marks.push({ kind: step ? 'step' : (k as 'circle' | 'arrow'), step, screen: i, x: fx(m[2], i), y: fy(m[3], i), label: m[4]?.trim() || undefined });
    if (marks.length >= 8) break;
  }
  let point: { screen: number; x: number; y: number; label?: string } | null = null;
  const p = raw.match(/\[POINT:(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?::([^\]:]{0,40}))?(?::screen(\d+))?\]/i);
  if (p) { const i = scr(p[4]); point = { screen: i, x: fx(p[1], i), y: fy(p[2], i), label: p[3]?.trim() || undefined }; }
  const text = raw.replace(/\[(POINT|MARK):[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim();
  return { text, point, marks };
}

/**
 * One question: optional recording (WAV) or typed text, plus up to 4 monitor screenshots (JPEG).
 * Returns what was heard, the spoken answer (text and MP3 in the bot's voice), and where to point.
 */
desktopApi.post('/ask', async (c) => {
  const d = device(c);
  if (!d) return c.json({ error: 'This computer is not paired (or was removed). Pair it again from HeyZubi: Settings → Windows app.' }, 401);
  if (asks.full(d.id)) return c.json({ error: 'That’s a lot of questions in a row. Give it a few minutes.' }, 429);
  asks.count(d.id);
  const userId: string = d.user_id;
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'Send the question as multipart form data.' }, 400);

  const wanted = String(form.get('botId') ?? '');
  const bots = botsOf(userId);
  const pick = bots.find((b) => b.id === wanted) ?? bots.find((b) => b.primary) ?? bots[0];
  const bot = pick ? getBotRow(pick.id) : null;
  if (!bot) return c.json({ error: 'No bot to answer.' }, 404);

  let meta: { screens?: ScreenMeta[]; history?: { q: string; a: string }[]; speak?: boolean } = {};
  try { meta = JSON.parse(String(form.get('meta') ?? '{}')); } catch { /* defaults */ }
  const screens = (Array.isArray(meta.screens) ? meta.screens : []).slice(0, 4).map((s) => ({
    w: Math.max(1, Math.round(Number(s?.w) || 0)), h: Math.max(1, Math.round(Number(s?.h) || 0)), primary: !!s?.primary,
    cursor: s?.cursor && Number.isFinite(Number(s.cursor.x)) ? { x: Math.round(Number(s.cursor.x)), y: Math.round(Number(s.cursor.y)) } : null,
  }));
  const images: string[] = [];
  for (let i = 0; i < screens.length; i++) {
    const f = form.get(`screen${i}`);
    if (!f || typeof f === 'string' || f.size > 6 * 1024 * 1024) return c.json({ error: `Screenshot ${i + 1} is missing or too big.` }, 400);
    images.push(`data:image/jpeg;base64,${Buffer.from(await f.arrayBuffer()).toString('base64')}`);
  }
  if (!images.length) return c.json({ error: 'No screenshot came with the question.' }, 400);

  // What they asked: typed, or heard from the recording.
  let question = String(form.get('question') ?? '').trim().slice(0, 1000);
  let heard = '';
  const audio = form.get('audio');
  if (!question && audio && typeof audio !== 'string') {
    if (audio.size > 10 * 1024 * 1024) return c.json({ error: 'That recording is too long.' }, 413);
    const ms = Math.min(120_000, Number(form.get('ms')) || 0);
    if (audio.size > 2000) {
      const t = await transcribeFor(userId, bot, audio, 'question.wav', ms, 'Windows app');
      if ('error' in t) return c.json({ error: t.error }, 502);
      heard = t.text;
    }
    question = heard;
  }
  if (!question) return c.json({ heard: '', text: '', point: null, marks: [], audio: null, note: 'Didn’t catch that. Hold the keys while you talk.' });

  const cursorScreen = Math.max(0, screens.findIndex((s) => s.cursor));
  const history = (Array.isArray(meta.history) ? meta.history : []).slice(-4)
    .map((t) => `Owner: ${String(t?.q ?? '').slice(0, 300)}\n${bot.name}: ${String(t?.a ?? '').slice(0, 400)}`).join('\n');
  try {
    const res: any = await xai.responses.create({
      model: MODEL,
      store: false,
      reasoning: { effort: 'low' }, // spoken: it has to answer in a few seconds
      input: [
        { role: 'system', content: prompt(bot.name, screens) },
        {
          role: 'user',
          content: [
            ...(history ? [{ type: 'input_text', text: `Earlier in this conversation (text only):\n${history}` }] : []),
            ...images.flatMap((url, i) => [
              { type: 'input_text', text: `SCREEN ${i + 1} (${screens[i].w}x${screens[i].h} pixels):` },
              { type: 'input_image', image_url: url, detail: 'high' },
            ]),
            { type: 'input_text', text: question },
          ],
        },
      ],
    } as any);
    usage.grok(userId, res.usage, 'Windows app');
    const raw = String(res.output_text ?? '').trim();
    if (!raw) return c.json({ error: 'No answer this time. Ask again.' }, 502);
    const out = parseDesktop(raw, screens, cursorScreen);
    if (!out.text) out.text = out.point?.label ? `Here: ${out.point.label}.` : 'Here.';
    let mp3: string | null = null;
    if (meta.speak !== false) {
      const s = await speakFor(userId, bot, out.text, 'Windows app');
      if (!('error' in s)) mp3 = s.mp3.toString('base64');
    }
    return c.json({ heard, question, botName: bot.name, ...out, audio: mp3 });
  } catch (e: any) {
    console.warn('[desktop] answer failed:', e?.status, e?.message);
    if (/credits|spending limit/i.test(String(e?.message ?? ''))) return c.json({ error: 'Paused: the xAI account is out of credits or at its monthly spending limit.' }, 502);
    return c.json({ error: 'Couldn’t get an answer just now. Try again.' }, 502);
  }
});
