// Episodes (one JSON document each) and the series they belong to. The series itself (its bible, cast, voices, music,
// sounds, past episodes) is the owner's own material: a private folder beside the database, never in the code.
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { hub } from '../lib/hub.js';
import { newId } from '../lib/ids.js';
import { STAGES, type Episode, type Slot, type StageId, type StageState } from './types.js';

db.exec(`CREATE TABLE IF NOT EXISTS reel_episodes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, num INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reel_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id TEXT NOT NULL REFERENCES reel_episodes(id) ON DELETE CASCADE, at INTEGER NOT NULL, stage TEXT, kind TEXT NOT NULL, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reel_events_ep ON reel_events(episode_id, id);`);

export class ReelError extends Error {}

export const socialDir = () => process.env.HQ_SOCIAL_DIR || path.join(path.dirname(env.dbPath), 'social');
export const seriesDir = () => path.join(socialDir(), 'series');
export const epDir = (num: number) => path.join(socialDir(), 'episodes', `ep${String(num).padStart(2, '0')}`);
/** A file inside an episode's folder, as the app knows it ("renders/part1-v1.mp4"). */
export const epFile = (ep: Episode, rel: string) => path.join(epDir(ep.num), rel);
export function ensureDir(f: string) { fs.mkdirSync(path.dirname(f), { recursive: true }); return f; }

const readJson = <T>(f: string, fallback: T): T => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T; } catch { return fallback; } };
export const seriesText = (f: string) => { try { return fs.readFileSync(path.join(seriesDir(), f), 'utf8'); } catch { return ''; } };

export interface SeriesCast { key: string; name: string; image: string; imageAsset: string; voice: string; voiceAsset: string; voiceSeconds: number; lock: string; castLine: string; about: string; voiceId?: string; voiceName?: string; stability?: number; similarity?: number }
export interface SeriesVoice { id: string; name: string; note: string }
export interface PastEpisode { num: number; title: string; trade: string; aiEmployee: string; lines: string[]; slot: string | null; usd: number | null; status: string; cast: string[]; hook: string[]; cover?: string; links?: Record<string, string>; youtubeAt?: string | null; youtubeTitle?: string; keyword?: string; platforms?: string[]; page?: string; pagePreview?: string }
export interface Series {
  name: string; handle: string; style: string; audio: string; sheetStyle: string; theme: string; refVideoAsset: string; refVideoNote: string;
  closing: string; courseLine: string; courseLineFacebook: string; hashtags: string; commentBase: string; commentBaseFacebook: string; youtubeLink: string;
  slots: { id: string; time: string; us: string }[]; cast: SeriesCast[]; voices: SeriesVoice[]; history: PastEpisode[]; assetsExpire: string; hookTypes: string[]; styleRefAsset: string; updatedAt: string; youtubePlaylist?: string;
  /** Landing pages of episodes made in HeyZubi, by episode number: the page and a small picture of it (series/pages/…). */
  pages?: Record<string, { url: string; preview?: string }>;
}
export function series(): Series {
  const s = readJson<Series | null>(path.join(seriesDir(), 'series.json'), null);
  if (!s) throw new ReelError('The series isn’t set up on the server yet (series.json is missing).');
  return s;
}
/** How the series tells its stories: who plays what, the beats, the lines every episode has. Private, like the rest of it. */
export interface Formula {
  roles: { hero: string; closer: string }; names: { hero: string; closer: string };
  storyEach: string; beats: string; voiceNote: string; castShape: string; clockShape: string; locks: string;
  fixedLines: string[]; mustSay: { label: string; text: string }; closing: { label: string; lines: string[][] }; closerLabel: string;
  hear: [string, string][]; packPrefix: string; turn: string; whatsappEnd: string; captionEnd: string; youtube: string[];
}
export function formula(): Formula {
  const f = readJson<Formula | null>(path.join(seriesDir(), 'formula.json'), null);
  if (!f) throw new ReelError('The series isn’t set up on the server yet (formula.json is missing).');
  return f;
}
export const seriesReady = () => ['series.json', 'formula.json'].every((f) => fs.existsSync(path.join(seriesDir(), f)));

// ---------- keys (typed in by the owner in the app; never sent back) ----------
const KEYS = () => path.join(socialDir(), 'keys.json');
export type KeyName = 'topview' | 'kie';
export const getKey = (k: KeyName): string => process.env[k === 'topview' ? 'TOPVIEW_API_PLATFORM_KEY' : 'KIE_API_KEY'] || readJson<Record<string, string>>(KEYS(), {})[k] || '';
export function setKey(k: KeyName, v: string) {
  const all = readJson<Record<string, string>>(KEYS(), {});
  if (v) all[k] = v; else delete all[k];
  fs.mkdirSync(socialDir(), { recursive: true });
  fs.writeFileSync(KEYS(), JSON.stringify(all), { mode: 0o600 });
  fs.chmodSync(KEYS(), 0o600);
}

// ---------- episodes ----------
const blankStages = () => Object.fromEntries(STAGES.map((s, i) => [s, { status: i === 0 ? 'ready' : 'idle' } as StageState])) as Record<StageId, StageState>;

export function newEpisode(userId: string, o: { num: number; brief: string; hookStyle: string; capUsd: number }): Episode {
  const ep: Episode = {
    id: newId('reel'), num: o.num, title: `Episode ${o.num}`, createdAt: now(), updatedAt: now(), capUsd: o.capUsd, auto: true,
    stages: blankStages(), ledger: [],
    story: { brief: o.brief, hookStyle: o.hookStyle, options: [], picked: null }, script: null, checks: [], cast: [], screens: [], storyboard: null,
    render: { parts: [{ versions: [], picked: null }, { versions: [], picked: null }], provider: 'topview' }, review: [null, null],
    edit: { options: { musicDb: -11, trimStart: 0, trimEnd: 0, dropShots: [], screens: {}, captionFixes: [] }, final: null, version: 0, checks: [] },
    cover: { candidates: [], picked: null }, pack: null, schedule: { method: null, results: {} },
  };
  db.prepare('INSERT INTO reel_episodes(id,user_id,num,data,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(ep.id, userId, ep.num, JSON.stringify(ep), now(), now());
  fs.mkdirSync(epDir(ep.num), { recursive: true });
  return ep;
}

const parse = (r: any): Episode => JSON.parse(r.data);
export const ownerOf = (id: string): string | null => (db.prepare('SELECT user_id FROM reel_episodes WHERE id=?').get(id) as any)?.user_id ?? null;
export function getEpisode(id: string): Episode | null {
  const r = db.prepare('SELECT data FROM reel_episodes WHERE id=?').get(id);
  return r ? parse(r) : null;
}
export const listEpisodes = (userId: string): Episode[] => (db.prepare('SELECT data FROM reel_episodes WHERE user_id=? ORDER BY num DESC, created_at DESC').all(userId) as any[]).map(parse);
export const allEpisodes = (): Episode[] => (db.prepare('SELECT data FROM reel_episodes').all() as any[]).map(parse);

/** Change an episode: always read fresh, changed and written in one step, so a running stage and a click never undo each other. */
export function patch(id: string, fn: (ep: Episode) => void): Episode {
  const run = db.transaction(() => {
    const ep = getEpisode(id);
    if (!ep) throw new ReelError('That episode is gone.');
    fn(ep);
    ep.updatedAt = now();
    db.prepare('UPDATE reel_episodes SET num=?, data=?, updated_at=? WHERE id=?').run(ep.num, JSON.stringify(ep), ep.updatedAt, id);
    return ep;
  });
  const ep = run.immediate();
  const u = ownerOf(id);
  if (u) hub.emit(u, { type: 'social', episodeId: id });
  return ep;
}
export function deleteEpisode(id: string) { db.prepare('DELETE FROM reel_episodes WHERE id=?').run(id); }

export function log(id: string, stage: StageId | null, kind: 'info' | 'run' | 'approve' | 'spend' | 'error' | 'change', text: string) {
  db.prepare('INSERT INTO reel_events(episode_id,at,stage,kind,text) VALUES (?,?,?,?,?)').run(id, now(), stage, kind, text.slice(0, 1200));
}
export const events = (id: string) => db.prepare('SELECT id, at, stage, kind, text FROM reel_events WHERE episode_id=? ORDER BY id DESC LIMIT 200').all(id) as { id: number; at: number; stage: string | null; kind: string; text: string }[];

export const spent = (ep: Episode) => ep.ledger.filter((l) => l.state !== 'failed').reduce((a, l) => a + (l.usd || l.estimate || 0), 0);

/** The next number: after everything made here and everything in the series' history. */
export function nextNum(userId: string): number {
  const hist = seriesReady() ? series().history.map((h) => h.num) : [];
  return Math.max(0, ...hist, ...listEpisodes(userId).map((e) => e.num)) + 1;
}

// ---------- posting slots (IST) ----------
const IST = 5.5 * 3600_000;
const pad = (n: number) => String(n).padStart(2, '0');
/** "2026-11-28T22:30" in IST as a moment. */
export const istToMs = (at: string) => Date.parse(`${at}:00Z`) - IST;
export function slotLabel(at: string): { label: string; us: string } {
  const ms = istToMs(at);
  const f = (tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);
  return { label: `${f('Asia/Kolkata')} IST`, us: `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(ms)} New York` };
}
/** The coming slots, with what's in them: slots fill in order, earliest empty first. */
export function slots(userId: string, days = 10, exceptId?: string): Slot[] {
  const taken = new Map<string, string>();
  if (seriesReady()) for (const h of series().history) if (h.slot) taken.set(h.slot, `Ep ${h.num}`);
  for (const e of listEpisodes(userId)) if (e.id !== exceptId && e.pack?.slot && !e.archived) taken.set(e.pack.slot, `Ep ${e.num}`);
  for (const [at, why] of Object.entries(readJson<Record<string, string>>(path.join(socialDir(), 'blocked-slots.json'), {}))) taken.set(at, why);
  const out: Slot[] = [];
  const today = new Date(Date.now() + IST);
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + d));
    for (const s of seriesReady() ? series().slots : []) {
      const at = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}T${s.time}`;
      if (istToMs(at) < Date.now() + 30 * 60_000) continue;
      out.push({ at, ...slotLabel(at), ...(taken.has(at) ? { taken: taken.get(at) } : {}) });
    }
  }
  return out;
}
export function blockSlot(at: string, why: string | null) {
  const f = path.join(socialDir(), 'blocked-slots.json');
  const all = readJson<Record<string, string>>(f, {});
  if (why) all[at] = why.slice(0, 60); else delete all[at];
  fs.mkdirSync(socialDir(), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(all));
}
