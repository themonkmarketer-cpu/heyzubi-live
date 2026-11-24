// Per-owner preferences that aren't about one bot: the personal dictionary (names and words dictation must
// spell right; passed to Sarvam as keyterms and to the tidy-up pass) and whether dictation is tidied up.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { db, now } from './db.js';
import { env } from './env.js';
import type { AuthVars } from './lib/auth.js';

db.exec('CREATE TABLE IF NOT EXISTS user_prefs (user_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)');

/**
 * Chat wallpaper: a built-in one (its id), "custom" (an uploaded picture, wallpaperFile), or null for the plain
 * background; wallpaperDim (0 to 0.8) lays the app's background colour over it so messages stay readable.
 */
export interface Prefs {
  dictionary: string[]; tidyDictation: boolean;
  wallpaper: string | null; wallpaperDim: number; wallpaperFile: string | null;
  /** The name shown in the sidebar's account row (a label only; the account's own name stays what the bots use). */
  displayName: string | null;
  /**
   * Products (after Theo's): the team is always on; the Pointer Assistant (the Windows app's talk keys) and Dictation
   * (dictate anywhere on Windows) can be switched off. Dictation is null until chosen: off for the Windows app, while
   * the chat's mic stays (it is hidden only when Dictation is switched off on purpose).
   */
  products: { pointer: boolean; dictation: boolean | null };
  pointer: PointerPrefs;
  dictation: DictationPrefs;
}

/** The hold-to-talk key combinations the Windows app knows (desktop/KeyboardHook.cs has the same ids). */
export const CHORDS: Record<string, string> = {
  ctrlWin: 'Ctrl + Win', ctrlAlt: 'Ctrl + Alt', ctrlShift: 'Ctrl + Shift', altShift: 'Alt + Shift', winAlt: 'Win + Alt', ctrlShiftSpace: 'Ctrl + Shift + Space',
};
export interface PointerPrefs {
  chord: string;
  /** The spark by the cursor: always there, only while listening and answering, or never (answers still show). */
  spark: 'always' | 'listening' | 'never';
  /** Who looks at the screen: xAI's Grok vision (fast) or the team member's own Claude through its engine. */
  brain: 'grok' | 'claude';
  /** An optional model name instead of the brain's default. */
  model: string;
  /** How answers are spoken: in the team member's own voice, a Windows voice on the PC, or not at all. */
  voice: 'bot' | 'windows' | 'off';
  windowsVoice: string;
}
export interface DictationPrefs {
  chord: string;
  /** A microphone on the paired PC by its Windows name ('' = the default one). */
  mic: string;
  /** Automatic: the server's speech to text (Sarvam or xAI); windows: Windows' own offline recognizer on the PC. */
  recognizer: 'auto' | 'windows';
  /** A language code, or 'auto'. */
  language: string;
}
const POINTER: PointerPrefs = { chord: 'ctrlWin', spark: 'listening', brain: 'grok', model: '', voice: 'bot', windowsVoice: '' };
const DICTATION: DictationPrefs = { chord: 'ctrlAlt', mic: '', recognizer: 'auto', language: 'auto' };
const DEFAULTS: Prefs = {
  dictionary: [], tidyDictation: true, wallpaper: null, wallpaperDim: 0.2, wallpaperFile: null, displayName: null,
  products: { pointer: true, dictation: null }, pointer: POINTER, dictation: DICTATION,
};
/** The built-in wallpapers (drawn by the web app; web/src/lib/wallpapers.ts has the same ids). */
export const WALLPAPERS = ['aurora', 'sunset', 'ocean', 'mesh', 'midnight', 'graphite', 'zubi', 'dots', 'waves', 'paper'];

export function getPrefs(userId: string): Prefs {
  const r = db.prepare('SELECT data FROM user_prefs WHERE user_id=?').get(userId) as { data: string } | undefined;
  try {
    const p = r ? JSON.parse(r.data) : {};
    return { ...DEFAULTS, ...p, products: { ...DEFAULTS.products, ...p.products }, pointer: { ...POINTER, ...p.pointer }, dictation: { ...DICTATION, ...p.dictation } };
  } catch { return { ...DEFAULTS }; }
}

const cleanWords = (v: unknown): string[] => {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[\n,]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of list) {
    const t = String(w ?? '').replace(/\s+/g, ' ').trim().slice(0, 64);
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    if (out.length >= 100) break;
  }
  return out;
};

export const prefsApi = new Hono<AuthVars>();

prefsApi.get('/', (c) => c.json(getPrefs(c.get('user').id)));

function savePrefs(userId: string, next: Prefs): Prefs {
  db.prepare('INSERT INTO user_prefs(user_id,data,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at').run(userId, JSON.stringify(next), now());
  return next;
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const shortText = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

/** Merges a change into the pointer and dictation settings; refuses the same keys for both. */
function nextProductPrefs(cur: Prefs, p: any): Pick<Prefs, 'products' | 'pointer' | 'dictation'> | { error: string } {
  const chords = Object.keys(CHORDS);
  const products = { ...cur.products };
  if (p.products && typeof p.products === 'object') {
    if (typeof p.products.pointer === 'boolean') products.pointer = p.products.pointer;
    if (typeof p.products.dictation === 'boolean') products.dictation = p.products.dictation;
  }
  const q = p.pointer && typeof p.pointer === 'object' ? p.pointer : {};
  const pointer: PointerPrefs = {
    chord: q.chord !== undefined ? pick(q.chord, chords, cur.pointer.chord) : cur.pointer.chord,
    spark: q.spark !== undefined ? pick(q.spark, ['always', 'listening', 'never'] as const, cur.pointer.spark) : cur.pointer.spark,
    brain: q.brain !== undefined ? pick(q.brain, ['grok', 'claude'] as const, cur.pointer.brain) : cur.pointer.brain,
    model: q.model !== undefined ? shortText(q.model, 80).replace(/[^\w.:/-]/g, '') : cur.pointer.model,
    voice: q.voice !== undefined ? pick(q.voice, ['bot', 'windows', 'off'] as const, cur.pointer.voice) : cur.pointer.voice,
    windowsVoice: q.windowsVoice !== undefined ? shortText(q.windowsVoice, 120) : cur.pointer.windowsVoice,
  };
  const d = p.dictation && typeof p.dictation === 'object' ? p.dictation : {};
  const dictation: DictationPrefs = {
    chord: d.chord !== undefined ? pick(d.chord, chords, cur.dictation.chord) : cur.dictation.chord,
    mic: d.mic !== undefined ? shortText(d.mic, 120) : cur.dictation.mic,
    recognizer: d.recognizer !== undefined ? pick(d.recognizer, ['auto', 'windows'] as const, cur.dictation.recognizer) : cur.dictation.recognizer,
    language: d.language !== undefined ? (/^(auto|[a-z]{2}(-[A-Z]{2})?)$/.test(String(d.language)) ? String(d.language) : cur.dictation.language) : cur.dictation.language,
  };
  if (pointer.chord === dictation.chord && products.pointer && products.dictation) {
    return { error: `The Pointer Assistant and Dictation can’t both use ${CHORDS[pointer.chord]}. Pick different keys for each.` };
  }
  return { products, pointer, dictation };
}

const clampDim = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Math.min(0.8, Math.max(0, Math.round(Number(v) * 100) / 100)) : fallback);

prefsApi.patch('/', async (c) => {
  const user = c.get('user');
  const p = await c.req.json().catch(() => ({} as any));
  const cur = getPrefs(user.id);
  let wallpaper = cur.wallpaper;
  if (p.wallpaper !== undefined) {
    if (p.wallpaper === null || WALLPAPERS.includes(p.wallpaper)) wallpaper = p.wallpaper;
    else if (p.wallpaper === 'custom' && cur.wallpaperFile) wallpaper = 'custom';
    else return c.json({ error: 'Unknown wallpaper.' }, 400);
  }
  const prod = nextProductPrefs(cur, p);
  if ('error' in prod) return c.json(prod, 409);
  return c.json(savePrefs(user.id, {
    ...cur,
    ...prod,
    dictionary: p.dictionary !== undefined ? cleanWords(p.dictionary) : cur.dictionary,
    tidyDictation: p.tidyDictation !== undefined ? p.tidyDictation === true : cur.tidyDictation,
    wallpaper,
    wallpaperDim: p.wallpaperDim !== undefined ? clampDim(p.wallpaperDim, cur.wallpaperDim) : cur.wallpaperDim,
    displayName: p.displayName !== undefined ? (String(p.displayName ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || null) : cur.displayName,
  }));
});

// ---------- your own wallpaper picture ----------
// The browser shrinks the picture first (to at most 2560 px); the server checks it really is a JPEG, PNG or WebP by its
// first bytes, keeps one per person under a content-hash name in the data folder, and serves it only to them.

const WALL_MAX = 5 * 1024 * 1024;
const wallDir = (userId: string) => path.join(path.dirname(env.dbPath), 'wallpapers', userId.replace(/[^\w-]/g, '_'));
const WALL_FILE = /^[a-f0-9]{20}\.(jpg|png|webp)$/;
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function imageKind(b: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

prefsApi.put('/wallpaper', async (c) => {
  const user = c.get('user');
  if (Number(c.req.header('content-length') ?? 0) > WALL_MAX) return c.json({ error: 'That picture is too big (5 MB at most).' }, 413);
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (!buf.length) return c.json({ error: 'No picture came through.' }, 400);
  if (buf.length > WALL_MAX) return c.json({ error: 'That picture is too big (5 MB at most).' }, 413);
  const kind = imageKind(buf);
  if (!kind) return c.json({ error: 'That file isn’t a JPEG, PNG or WebP picture.' }, 415);
  const dir = wallDir(user.id);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 20)}.${kind}`;
  fs.writeFileSync(path.join(dir, name), buf, { mode: 0o600 });
  for (const f of fs.readdirSync(dir)) if (f !== name) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* gone */ } }
  const cur = getPrefs(user.id);
  return c.json(savePrefs(user.id, { ...cur, wallpaper: 'custom', wallpaperFile: name }));
});

prefsApi.get('/wallpaper/:file', (c) => {
  const file = c.req.param('file');
  if (!WALL_FILE.test(file)) return c.json({ error: 'not found' }, 404);
  try {
    const buf = fs.readFileSync(path.join(wallDir(c.get('user').id), file));
    // The name is the content's hash, so the browser may keep it for good.
    return c.body(buf, 200, { 'Content-Type': MIME[file.split('.').pop()!], 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  } catch { return c.json({ error: 'not found' }, 404); }
});

// ---------- your profile photo (the account row in the sidebar) ----------
// Same rules as the wallpaper: the browser shrinks it first (256 px); the server checks the bytes, keeps one per person
// under a content-hash name, and serves it only to them. users.avatar_url points at it.

const PHOTO_MAX = 2 * 1024 * 1024;
const photoDir = (userId: string) => path.join(path.dirname(env.dbPath), 'photos', userId.replace(/[^\w-]/g, '_'));

/** Save a profile photo for a person; returns the URL the app shows it from. Also used to set one from the server. */
export function savePhoto(userId: string, buf: Buffer): string {
  const kind = imageKind(buf);
  if (!kind) throw new Error('That file isn’t a JPEG, PNG or WebP picture.');
  const dir = photoDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 20)}.${kind}`;
  fs.writeFileSync(path.join(dir, name), buf, { mode: 0o600 });
  for (const f of fs.readdirSync(dir)) if (f !== name) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* gone */ } }
  const url = `/api/prefs/photo/${name}`;
  db.prepare('UPDATE users SET avatar_url=? WHERE id=?').run(url, userId);
  return url;
}

prefsApi.put('/photo', async (c) => {
  const user = c.get('user');
  if (Number(c.req.header('content-length') ?? 0) > PHOTO_MAX) return c.json({ error: 'That picture is too big (2 MB at most).' }, 413);
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (!buf.length) return c.json({ error: 'No picture came through.' }, 400);
  if (buf.length > PHOTO_MAX) return c.json({ error: 'That picture is too big (2 MB at most).' }, 413);
  try { return c.json({ avatarUrl: savePhoto(user.id, buf) }); }
  catch (e) { return c.json({ error: (e as Error).message }, 415); }
});

prefsApi.get('/photo/:file', (c) => {
  const file = c.req.param('file');
  if (!WALL_FILE.test(file)) return c.json({ error: 'not found' }, 404);
  try {
    const buf = fs.readFileSync(path.join(photoDir(c.get('user').id), file));
    return c.body(buf, 200, { 'Content-Type': MIME[file.split('.').pop()!], 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  } catch { return c.json({ error: 'not found' }, 404); }
});

prefsApi.delete('/photo', (c) => {
  const user = c.get('user');
  try { fs.rmSync(photoDir(user.id), { recursive: true, force: true }); } catch { /* nothing there */ }
  db.prepare('UPDATE users SET avatar_url=NULL WHERE id=?').run(user.id);
  return c.json({ avatarUrl: null });
});

prefsApi.delete('/wallpaper', (c) => {
  const user = c.get('user');
  try { fs.rmSync(wallDir(user.id), { recursive: true, force: true }); } catch { /* nothing there */ }
  const cur = getPrefs(user.id);
  return c.json(savePrefs(user.id, { ...cur, wallpaper: cur.wallpaper === 'custom' ? null : cur.wallpaper, wallpaperFile: null }));
});
