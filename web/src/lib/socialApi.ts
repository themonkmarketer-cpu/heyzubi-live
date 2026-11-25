// Reels Factory's API. Types mirror server/src/reels/types.ts.
import { lsGet, lsSet } from './storage';
export const STAGES = ['story', 'script', 'cast', 'screens', 'storyboard', 'render', 'review', 'edit', 'cover', 'package', 'schedule'] as const;
export type StageId = (typeof STAGES)[number];
export type StageStatus = 'idle' | 'ready' | 'running' | 'needs_you' | 'done' | 'failed' | 'stale';
export interface StageState { status: StageStatus; progress?: string; error?: string; startedAt?: number; endedAt?: number; approvedAt?: number; approval?: string }
export interface Check { id: string; label: string; ok: boolean; level: 'must' | 'should'; detail?: string }
export interface StoryOption { title: string; who: string; trade: string; aiEmployee: string; problem: string; hookSpeaker: string; hookLine: string; secondSpeaker: string; secondLine: string; unexpected: string; why: string }
export interface Shot { n: number; start: number; end: number; camera: string; picture: string; speaker?: string; delivery?: string; line?: string; caption?: string; screen?: string; clock?: string; sound?: string; offscreen?: boolean }
export interface Cast { key: string; name: string; kind: 'series' | 'sheet' | 'ref' | 'described'; castLine: string; lock: string; imagePrompt?: string; image?: string; voiceFile?: string; voiceSeconds?: number; imageUsd?: number; voice?: { voiceId: string; voiceName: string; stability: number; sample: string } }
export interface Version { v: number; kind: 'part' | 'shot' | 'import' | 'voice'; provider: string; state: string; file?: string; usd?: number; estimate?: number; note?: string; at: number; shot?: number; error?: string }
export interface Review { cuts: number[]; frames: number; fps: number; sheet: string; notes: string[]; hookAt: number; secondVoiceAt: number; shotStarts: number[]; asl: number; lines: { speaker: string; text: string; heard: string; score: number; start: number; end: number; shot: number; pitch?: number; refPitch?: number; lips?: boolean }[] }
export interface Pack { instagram: string; facebook: string; commentInstagram: string; commentFacebook: string; whatsapp?: string; youtubeComment?: string; altText: string; keywords: string[]; facebookTags: string[]; youtubeTitle: string; youtubeDescription: string; youtubeTags: string[]; keywordPlaces: string[]; slot: string | null; platforms: string[]; checks: Check[]; folder: string | null }
export interface Script { title: string; trade: string; logline: string; aiEmployee: { name: string; icon: string; color: string; does: string[]; howItWorks: string }; honesty: string; tip: string; forward: string; unexpected: string; runningGag: string; tradePhysics: string; keywords: { primary: string; ownerSide: string; secondary: string[]; evidence: string[]; facebookTags: string[]; youtubeTitle: string }; location: string; parts: { light: string; audio: string; props: string; time: string; shots: Shot[] }[]; screens: Record<string, any>; caption: { line1: string; story: string }; question: string; altText: string }
export interface Episode {
  id: string; num: number; title: string; createdAt: number; updatedAt: number; capUsd: number; auto: boolean; archived?: boolean; aiConfirmed?: 'yes' | 'later'; comments?: Comment[]; spent: number; running: StageId | null; blocked: Record<StageId, string>;
  stages: Record<StageId, StageState>; events: { id: number; at: number; stage: string | null; kind: string; text: string }[];
  ledger: { at: number; what: string; provider: string; model?: string; usd: number; estimate?: number; state: string }[];
  story: { brief: string; hookStyle: string; options: StoryOption[]; picked: StoryOption | null };
  script: Script | null; checks: Check[]; cast: Cast[]; screens: { id: string; kind: string; title: string; png: string }[];
  storyboard: { prompts: string[]; chars: number[]; checks: Check[]; quoteUsd: number | null; usualUsd?: number; refs: { images: string[]; audio: string[]; video: string }[] } | null;
  render: { parts: { versions: Version[]; picked: number | null }[]; provider: 'topview' | 'kie'; lead?: { v: number; key: string; file: string; doubt?: string } };
  review: (Review | null)[]; studio?: StudioState | null;
  edit: { studioSig?: string; partFiles?: string[]; options: { musicDb: number; trimStart: number; trimEnd: number; dropShots: { part: number; shot: number }[]; brighten?: { part: number; shot: number }[]; trims?: { part: number; shot: number; in: number; out: number }[]; screenOn?: Record<string, string>; screens: Record<string, { on: boolean; f0?: number; f1?: number; motion?: string }>; captionFixes: [string, string][] }; final: string | null; seconds?: number; lufs?: number; peak?: number; version: number; checks: Check[]; previews?: string[]; screenStats?: Record<string, any> };
  cover: { candidates: { t: number; file: string }[]; picked: string | null }; pack: Pack | null;
  schedule: { method: 'zubi' | 'self' | null; askedAt?: number; results: Record<string, { status: string; link?: string; note?: string; at: number }> };
}
/** The HyperFrames project of an episode's cut; null when the editor isn't set up on the server. */
export interface StudioState { ready: boolean; made: boolean; changedAt?: number; seconds?: number; shots?: number; clips?: { id: string; part: number; shot: number; start: number; dur: number }[]; gone?: { part: number; shot: number }[]; sig?: string }
export interface StudioOpen { state: 'open' | 'working' | 'failed'; note?: string; url?: string }
export interface Comment { id: string; at: number; text: string; part?: number; shot?: number; t?: number; x?: number; y?: number; done?: boolean }
export interface ChatState { agent: string; online: boolean; talk: number; talks: { talk: number; at: number; n: number; title: string }[]; did: string[]; busy: string | null; step?: { stage: StageId; text: string } | null; waiting?: string[]; messages: { id: number; at: number; role: 'you' | 'agent'; text: string; data: { did?: string[]; no?: string[]; tokens?: number; images?: string[]; error?: boolean; step?: boolean; proposals?: { label: string; why?: string; kind: string; usd?: number; state: 'open' | 'done' | 'no' | 'old' }[] } }[] }
export interface Slot { at: string; label: string; us: string; taken?: string }
export interface Brief { id: string; num: number; title: string; updatedAt: number; createdAt: number; archived: boolean; stages: Record<StageId, StageStatus>; progress: string | null; spent: number; cap: number; cover: string | null; slot: string | null; trade: string; aiEmployee: string; keyword: string; cast: string[]; platforms: string[]; links: Record<string, string>; scheduled: boolean }
export interface Past { num: number; title: string; trade: string; aiEmployee: string; slot: string | null; usd: number | null; status: string; cast: string[]; hook: string[]; cover: string | null; links: Record<string, string>; youtubeAt: string | null; youtubeTitle: string; keyword: string; platforms: string[] }
export interface CastInfo { key: string; name: string; about: string; image: string; look: string; voice: string; role?: 'hero' | 'closer' | '' }
export interface Home {
  ready: boolean; series: { name: string; handle: string; hookTypes: string[]; assetsExpire: string; cast: CastInfo[]; voices: number } | null;
  episodes: Brief[]; history: Past[]; slots: Slot[]; next: number; keys: { topview: boolean; kie: boolean };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/social${path}`, { method, credentials: 'include', headers: body instanceof Blob ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body instanceof Blob ? body : body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any).error || 'That didn’t work just now.');
  return j as T;
}
type Ep = { episode: Episode; slots?: Slot[] };
const ep = (id: string, p = '') => `/episodes/${encodeURIComponent(id)}${p}`;
export const socialApi = {
  home: () => call<Home>('GET', ''),
  get: (id: string) => call<Ep>('GET', ep(id)),
  create: (b: { brief: string; hookStyle: string; num?: number }) => call<Ep>('POST', '/episodes', b),
  remove: (id: string, num: number) => call<{ ok: true }>('DELETE', `${ep(id)}?confirm=${num}`),
  archive: (id: string, on: boolean) => call('POST', ep(id, '/archive'), { on }),
  auto: (id: string, on: boolean) => call<Ep>('POST', ep(id, '/auto'), { on }),
  cap: (id: string, usd: number) => call<Ep>('POST', ep(id, '/cap'), { usd }),
  run: (id: string, stage: StageId, b: Record<string, unknown> = {}) => call<Ep>('POST', ep(id, `/stages/${stage}/run`), b),
  stop: (id: string) => call('POST', ep(id, '/stop')),
  approve: (id: string, stage: StageId, b: Record<string, unknown>) => call<Ep>('POST', ep(id, `/stages/${stage}/approve`), b),
  reopen: (id: string, stage: StageId) => call<Ep>('POST', ep(id, `/stages/${stage}/reopen`)),
  script: (id: string, b: Record<string, unknown>) => call<Ep>('PATCH', ep(id, '/script'), b),
  screen: (id: string, s: string, data: unknown) => call<Ep>('PATCH', ep(id, `/screens/${s}`), { data }),
  quoteRetake: (id: string, b: { part: number; shot?: number; note: string }) => call<{ usd: number; left: number }>('POST', ep(id, '/retake/quote'), b),
  shot: (id: string, part: number, shot: number, set: Record<string, unknown>) => call<Ep>('PATCH', ep(id, '/shot'), { part, shot, set }),
  shotTime: (id: string, part: number, shot: number, end: number) => call<Ep>('POST', ep(id, '/shot/time'), { part, shot, end }),
  comment: (id: string, c: { text: string; part?: number; shot?: number; t?: number; x?: number; y?: number }) => call<Ep>('POST', ep(id, '/comments'), c),
  setComment: (id: string, cid: string, b: { done?: boolean; text?: string }) => call<Ep>('PATCH', ep(id, `/comments/${cid}`), b),
  dropComment: (id: string, cid: string) => call<Ep>('DELETE', ep(id, `/comments/${cid}`)),
  chat: (id: string, talk?: number | null) => call<ChatState>('GET', ep(id, `/chat${talk ? `?talk=${talk}` : ''}`)),
  say: (id: string, text: string, talk?: number | null) => call<ChatState>('POST', ep(id, '/chat'), { text, talk }),
  chatStop: (id: string) => call('POST', ep(id, '/chat/stop')),
  decide: (id: string, msg: number, i: number, yes: boolean) => call<ChatState>('POST', ep(id, '/chat/decide'), { msg, i, yes }),
  quoteRender: (id: string) => call<{ parts: number[]; usd: number; left: number }>('POST', ep(id, '/render/quote')),
  revoice: (id: string, part: number, shot: number) => call<Ep>('POST', ep(id, '/revoice'), { part, shot }),
  aiEmployee: (id: string) => call<Ep>('POST', ep(id, '/ai-employee')),
  retake: (id: string, b: { part: number; shot?: number; note: string; confirmUsd: number }) => call<Ep>('POST', ep(id, '/retake'), b),
  version: (id: string, part: number, v: number) => call<Ep>('POST', ep(id, '/version'), { part, v }),
  provider: (id: string, provider: string) => call<Ep>('POST', ep(id, '/provider'), { provider }),
  importPart: (id: string, part: number, f: File) => call<Ep>('PUT', ep(id, `/import/${part}`), f),
  editor: (id: string, b: { again: boolean; fresh?: boolean }) => call<Ep & StudioOpen>('POST', ep(id, '/editor'), b),
  putBack: (id: string, part: number, shot: number) => call<Ep>('POST', ep(id, '/editor/put-back'), { part, shot }),
  edit: (id: string, b: Record<string, unknown>) => call<Ep>('PATCH', ep(id, '/edit'), b),
  cover: (id: string, t: number) => call<Ep>('POST', ep(id, '/cover'), { t }),
  pack: (id: string, b: Record<string, unknown>) => call<Ep>('PATCH', ep(id, '/pack'), b),
  schedule: (id: string, b: Record<string, unknown>) => call<Ep>('POST', ep(id, '/schedule'), b),
  mark: (id: string, b: { platform: string; status: string; link?: string; note?: string }) => call<Ep>('POST', ep(id, '/schedule/mark'), b),
  key: (name: string, key: string) => call<{ set: boolean }>('PUT', `/keys/${name}`, { key }),
  block: (at: string, why: string | null) => call<{ slots: Slot[] }>('POST', '/slots/block', { at, why }),
};
export const stillUrl = (id: string, part: number, shot: number, v: string) => `/api/social/episodes/${encodeURIComponent(id)}/still?part=${part}&shot=${shot}&v=${encodeURIComponent(v)}`;
export const epFileUrl = (id: string, path: string, download = false) => `/api/social/episodes/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
export const seriesFileUrl = (path: string) => `/api/social/series/file?path=${encodeURIComponent(path)}`;
export const usd = (n: number) => `$${n.toFixed(2)}`;

export const STAGE_INFO: Record<StageId, { name: string; what: string; gate?: string }> = {
  story: { name: 'Story', what: 'Four ideas with their hooks, or your own', gate: 'You pick' },
  script: { name: 'Script', what: 'Lines, shots, keywords, screens, checked against the series rules', gate: 'You approve, with a spending limit' },
  cast: { name: 'Cast', what: 'New characters’ pictures and voices', gate: 'You approve' },
  screens: { name: 'Screens', what: 'Phone and laptop screens, before any render' },
  storyboard: { name: 'Storyboard', what: 'The two prompts and the price', gate: 'You approve the render' },
  render: { name: 'Render', what: 'Two 30-second parts on TopView (kie.ai as fallback)' },
  review: { name: 'Review', what: 'Lines, voices, cuts and picture checked', gate: 'You approve, or retake' },
  edit: { name: 'Edit', what: 'Screens, captions, clock, theme, sounds, loudness', gate: 'You approve the cut' },
  cover: { name: 'Cover', what: 'Frames from the finished video', gate: 'You pick' },
  package: { name: 'Captions', what: 'Captions, tags, comments and the slot', gate: 'You approve' },
  schedule: { name: 'Schedule', what: 'Zubi schedules it, or you do', gate: 'You confirm' },
};

/** A line said clearly higher or lower than the character's own sample (a shout may be higher). Mirrors server/src/reels/checks.ts. */
export function voiceDrift(l: { pitch?: number; refPitch?: number } | undefined, x?: { delivery?: string; line?: string }): number | null {
  if (!l?.pitch || !l.refPitch) return null;
  const off = l.pitch / l.refPitch - 1, loud = /shout|yell|scream|frantic|pant|alarm|loud|panic|excite|desperat|exasperat|thrilled/i.test(x?.delivery ?? '') || (x?.line ?? '').includes('!');
  return (loud ? off < -0.12 : off < -0.12 || off > 0.25) ? Math.round(off * 100) : null;
}
/**
 * Corrections for the session (from the video, a shot, the editor, a comment). Kept until the session has sent them: with its
 * window closed, the agent busy, or the page loaded again, none is lost.
 */
const saidKey = (id: string) => `socialSaid-${id}`;
export function waitingSaid(id: string): string[] { try { const l = JSON.parse(lsGet(saidKey(id)) || '[]'); return Array.isArray(l) ? l.filter((x) => typeof x === 'string') : []; } catch { return []; } }
export function say(id: string, text: string) { lsSet(saidKey(id), JSON.stringify([...waitingSaid(id), text].slice(-30))); window.dispatchEvent(new CustomEvent('social:say', { detail: { id } })); }
/** The first n were sent. */
export function saidDone(id: string, n: number) { lsSet(saidKey(id), JSON.stringify(waitingSaid(id).slice(n))); }
