import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { env } from './env.js';
import type { AuthVars } from './lib/auth.js';
import { usage } from './usage.js';

/**
 * Generations: the gallery of AI-made images and videos in the main agent's Hermes home (~/.hermes/generations,
 * shared with Murtaza's PC through Syncthing). Same folder, same rules and the same star list as Zubi HQ's
 * Generations page, so a star made in one app shows in the other. Top level and refs/ only; references can be
 * added (images, 15 MB). Nothing is deleted from here.
 */
const GEN = path.join(env.hermesHome, 'generations');
/** The "Zubi inbox" folder on the network drive Murtaza maps on his PC (L:\Zubi inbox = ~/.hermes/content/Zubi inbox). */
const INBOX = path.join(env.hermesHome, 'content', 'Zubi inbox');
const STARS = path.join(GEN, 'data', 'generation-starred.json');
const MEDIA = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp4', '.webm', '.mov']);
const VIDEO = new Set(['.mp4', '.webm', '.mov']);
const UPLOAD = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

export interface GenItem { name: string; rel: string; type: 'gen' | 'ref' | 'inbox'; media: 'image' | 'video'; modified: number; size: number; starred: boolean }

/**
 * A gallery file from its relative path: top level, refs/ or styles/ of Generations, or inbox/ (the Zubi inbox on the
 * network drive). Media types only; nothing outside those folders.
 */
export function genFile(rel: string): string | null {
  const r = String(rel || '');
  if (r.startsWith('inbox/')) {
    const f = path.resolve(INBOX, r.slice(6));
    return path.dirname(f) === INBOX && MEDIA.has(path.extname(f).toLowerCase()) ? f : null;
  }
  const f = path.resolve(GEN, r);
  const parts = path.relative(GEN, f).split(path.sep);
  if (parts[0] === '..' || path.isAbsolute(parts[0]) || !MEDIA.has(path.extname(f).toLowerCase())) return null;
  if (parts.length > 2 || (parts.length === 2 && parts[0] !== 'refs' && parts[0] !== 'styles')) return null;
  return f;
}

function items(folder: string, type: GenItem['type'], prefix: string): Omit<GenItem, 'starred'>[] {
  const out: Omit<GenItem, 'starred'>[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(folder); } catch { return out; }
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const ext = path.extname(n).toLowerCase();
    if (!MEDIA.has(ext)) continue;
    try {
      const st = fs.statSync(path.join(folder, n));
      if (st.isFile()) out.push({ name: n, rel: prefix + n, type, media: VIDEO.has(ext) ? 'video' : 'image', modified: st.mtimeMs, size: st.size });
    } catch { /* gone */ }
  }
  return out;
}

const readStars = (): string[] => { try { const s = JSON.parse(fs.readFileSync(STARS, 'utf8')); return Array.isArray(s) ? s.map(String) : []; } catch { return []; } };
function writeStars(list: string[]) {
  fs.mkdirSync(path.dirname(STARS), { recursive: true });
  const tmp = `${STARS}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  try { const o = fs.statSync(GEN); fs.chownSync(tmp, o.uid, o.gid); } catch { /* not root */ }
  fs.renameSync(tmp, STARS);
}

export function listGenerations(o: { media?: string; type?: string; q?: string; starred?: boolean; sort?: string } = {}): GenItem[] {
  const star = new Set(readStars());
  let all: GenItem[] = [...items(GEN, 'gen', ''), ...items(path.join(GEN, 'refs'), 'ref', 'refs/'), ...items(INBOX, 'inbox', 'inbox/')].map((i) => ({ ...i, starred: star.has(i.rel) || star.has(i.name) }));
  if (o.type === 'gen' || o.type === 'ref' || o.type === 'inbox') all = all.filter((i) => i.type === o.type);
  if (o.media === 'image' || o.media === 'video') all = all.filter((i) => i.media === o.media);
  if (o.q) { const q = o.q.toLowerCase(); all = all.filter((i) => i.name.toLowerCase().includes(q)); }
  if (o.starred) all = all.filter((i) => i.starred);
  const sign = o.sort === 'oldest' ? 1 : -1;
  // Starred first, then newest (or oldest), like Zubi HQ.
  return all.sort((a, b) => Number(b.starred) - Number(a.starred) || sign * (a.modified - b.modified));
}

// ---------- creating a picture on the spot (xAI Grok Imagine), saved into the gallery ----------

const IMG_MODEL = process.env.HQ_IMAGE_MODEL ?? 'grok-imagine-image-2.0';
const ASPECTS = new Set(['1:1', '4:5', '3:4', '9:16', '16:9', '4:3', '3:2', '2:3']);

/** Make one picture from a prompt and save it at the top of Generations. ~$0.04, logged under "image". */
export async function createImage(userId: string, prompt: string, aspect?: string): Promise<{ rel: string; name: string } | { error: string }> {
  const p = String(prompt ?? '').trim().slice(0, 1500);
  if (!p) return { error: 'Describe the picture first.' };
  if (!env.xaiKey) return { error: 'Image creation needs the xAI key.' };
  let r: Response;
  try {
    r = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${env.xaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: IMG_MODEL, prompt: p, n: 1, response_format: 'b64_json', ...(aspect && ASPECTS.has(aspect) ? { aspect_ratio: aspect } : {}) }),
    });
  } catch (e: any) {
    return { error: e?.name === 'TimeoutError' ? 'The picture took too long. Try again.' : 'Couldn’t reach xAI.' };
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = String(j?.error?.message ?? j?.error ?? j?.code ?? `HTTP ${r.status}`);
    console.warn('[generations] create failed', r.status, msg.slice(0, 200));
    return { error: /credits|spending limit/i.test(msg) ? 'The xAI account is out of credits or at its spending limit.' : /safety|policy|moderat/i.test(msg) ? 'xAI refused that prompt. Try describing it differently.' : 'Couldn’t create the picture just now.' };
  }
  const item = j?.data?.[0] ?? {};
  let blob: Buffer | null = null;
  if (item.b64_json) blob = Buffer.from(String(item.b64_json), 'base64');
  else if (item.url && /^https:\/\//.test(String(item.url))) {
    const f = await fetch(String(item.url), { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (f?.ok) blob = Buffer.from(await f.arrayBuffer());
  }
  if (!blob?.length) return { error: 'xAI sent no picture back.' };
  const ext = blob[0] === 0x89 ? '.png' : blob[0] === 0xff ? '.jpg' : blob[0] === 0x52 ? '.webp' : '.png';
  const slug = p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `${slug}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${ext}`;
  fs.mkdirSync(GEN, { recursive: true });
  const file = path.join(GEN, name);
  fs.writeFileSync(file, blob);
  try { const o = fs.statSync(GEN); fs.chownSync(file, o.uid, o.gid); } catch { /* not root */ }
  usage.image(userId, 1);
  return { rel: name, name };
}

export const generationsApi = new Hono<AuthVars>();

/** Create a picture from a prompt: {prompt, aspect?}. Saved into Generations; about $0.04 at xAI. */
generationsApi.post('/create', async (c) => {
  const b = await c.req.json<{ prompt?: string; aspect?: string }>().catch(() => ({} as any));
  const r = await createImage(c.get('user').id, String(b.prompt ?? ''), b.aspect);
  return 'error' in r ? c.json(r, 502) : c.json({ ok: true, ...r });
});

generationsApi.get('/list', (c) => {
  const q = c.req.query();
  const all = listGenerations({ media: q.media, type: q.type, q: q.q, starred: q.starred === '1', sort: q.sort });
  const limit = Math.max(1, Math.min(300, Number(q.limit) || 120));
  const page = Math.max(1, Number(q.page) || 1);
  const start = (page - 1) * limit;
  return c.json({ items: all.slice(start, start + limit), total: all.length, page, hasMore: start + limit < all.length });
});

/** The file itself (sandboxed, so an SVG can't run script). ?download=1 saves it instead. */
generationsApi.get('/file/*', (c) => {
  const rel = decodeURIComponent(c.req.path.replace(/^.*?\/generations\/file\//, ''));
  const f = genFile(rel);
  if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return c.json({ error: 'Not in the gallery' }, 404);
  const st = fs.statSync(f);
  const headers: Record<string, string> = {
    'Content-Type': TYPES[path.extname(f).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(st.size),
    'Cache-Control': 'private, max-age=300',
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
  };
  if (c.req.query('download') === '1') headers['Content-Disposition'] = `attachment; filename="${path.basename(f).replace(/"/g, '')}"`;
  return new Response(Readable.toWeb(fs.createReadStream(f)) as unknown as ReadableStream, { status: 200, headers });
});

generationsApi.post('/star', async (c) => {
  const b = await c.req.json<{ rel?: string; starred?: boolean }>().catch(() => ({} as any));
  const rel = String(b.rel ?? '');
  if (!genFile(rel)) return c.json({ error: 'Not in the gallery' }, 404);
  const list = readStars().filter((x) => x !== rel);
  if (b.starred) list.push(rel);
  writeStars(list);
  return c.json({ ok: true, starred: !!b.starred });
});

/** Add a reference image: {name, data} (base64 or a data: URL). PNG, JPG, WebP or GIF, 15 MB. */
generationsApi.post('/refs', async (c) => {
  const b = await c.req.json<{ name?: string; data?: string }>().catch(() => ({} as any));
  const name = String(b.name ?? '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120).replace(/^\.+/, '');
  if (!name || !UPLOAD.has(path.extname(name).toLowerCase())) return c.json({ error: 'Use a PNG, JPG, WebP or GIF image.' }, 400);
  const blob = Buffer.from(String(b.data ?? '').replace(/^data:[^,]*,/, ''), 'base64');
  if (!blob.length || blob.length > 15 * 1024 * 1024) return c.json({ error: 'Images up to 15 MB.' }, 413);
  const magic = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x52, 0x49, 0x46, 0x46], [0x47, 0x49, 0x46, 0x38]];
  if (!magic.some((m) => m.every((x, i) => blob[i] === x))) return c.json({ error: 'That file is not a real image.' }, 400);
  const dir = path.join(GEN, 'refs');
  fs.mkdirSync(dir, { recursive: true });
  let f = path.join(dir, name);
  if (fs.existsSync(f)) { const e = path.extname(name); f = path.join(dir, `${path.basename(name, e)}-${Date.now().toString(36)}${e}`); }
  fs.writeFileSync(f, blob);
  try { const o = fs.statSync(GEN); fs.chownSync(f, o.uid, o.gid); } catch { /* not root */ }
  return c.json({ ok: true, rel: `refs/${path.basename(f)}` });
});
