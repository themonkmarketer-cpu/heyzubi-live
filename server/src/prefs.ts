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
}
const DEFAULTS: Prefs = { dictionary: [], tidyDictation: true, wallpaper: null, wallpaperDim: 0.2, wallpaperFile: null };
/** The built-in wallpapers (drawn by the web app; web/src/lib/wallpapers.ts has the same ids). */
export const WALLPAPERS = ['aurora', 'sunset', 'ocean', 'mesh', 'midnight', 'graphite', 'zubi', 'dots', 'waves', 'paper'];

export function getPrefs(userId: string): Prefs {
  const r = db.prepare('SELECT data FROM user_prefs WHERE user_id=?').get(userId) as { data: string } | undefined;
  try { return { ...DEFAULTS, ...(r ? JSON.parse(r.data) : {}) }; } catch { return { ...DEFAULTS }; }
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
  return c.json(savePrefs(user.id, {
    ...cur,
    dictionary: p.dictionary !== undefined ? cleanWords(p.dictionary) : cur.dictionary,
    tidyDictation: p.tidyDictation !== undefined ? p.tidyDictation === true : cur.tidyDictation,
    wallpaper,
    wallpaperDim: p.wallpaperDim !== undefined ? clampDim(p.wallpaperDim, cur.wallpaperDim) : cur.wallpaperDim,
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

prefsApi.delete('/wallpaper', (c) => {
  const user = c.get('user');
  try { fs.rmSync(wallDir(user.id), { recursive: true, force: true }); } catch { /* nothing there */ }
  const cur = getPrefs(user.id);
  return c.json(savePrefs(user.id, { ...cur, wallpaper: cur.wallpaper === 'custom' ? null : cur.wallpaper, wallpaperFile: null }));
});
