// The session window beside an episode: the owner writes freely, and the main team member looks at the work and changes it
// with the same functions the page's buttons use. It never spends, approves or undoes an approval by itself: for those it
// makes a proposal with its price, which only the owner's click carries out.
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from '../db.js';
import { engineFor, primaryBotId } from '../engine.js';
import { hub } from '../lib/hub.js';
import { getBotRow } from '../store.js';
import { packChecks } from './checks.js';
import { partFile } from './edit.js';
import { voiceDrift } from './checks.js';
import { probe, py } from './media.js';
import { buildScreens } from './screens.js';
import { addCover, approve, blocked, changeCut, isRunning, left, mouthCheck, pickVersion, quoteRender, quoteRetake, rebuildPrompts, recheck, retake, revoice, start, stop } from './stages.js';
import { ensureDir, epFile, events, getEpisode, log, ownerOf, patch, ReelError, series, seriesDir, slots, spent } from './store.js';
import { STAGES, type Episode, type StageId } from './types.js';
import { studioReady, studioState } from './studio.js';
import { askJson } from './writer.js';

db.exec(`CREATE TABLE IF NOT EXISTS reel_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id TEXT NOT NULL REFERENCES reel_episodes(id) ON DELETE CASCADE, at INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS reel_chat_ep ON reel_chat(episode_id, id);`);
if (!(db.prepare('PRAGMA table_info(reel_chat)').all() as any[]).some((c) => c.name === 'talk')) db.exec('ALTER TABLE reel_chat ADD COLUMN talk INTEGER NOT NULL DEFAULT 1');

import { agreed, carryOut, ensureAsk, GATES, markSchedule, readReply, setConversing, setPost, settle, type Ask } from './flow.js';
/** Something the owner can say yes or no to, in this window. */
export type Proposal = Ask;
interface Data { /** A step that started by itself: one quiet line. */ step?: boolean; did?: string[]; /** What was tried and could not be done. */ no?: string[]; tokens?: number; images?: string[]; proposals?: Proposal[]; error?: boolean }
export interface ChatRow { id: number; at: number; role: 'you' | 'agent'; text: string; data: Data }
const rows = (id: string, talk: number, n = 120): ChatRow[] => (db.prepare('SELECT id, at, role, text, data FROM reel_chat WHERE episode_id=? AND talk=? ORDER BY id DESC LIMIT ?').all(id, talk, n) as any[]).reverse().map((r) => ({ ...r, data: JSON.parse(r.data || '{}') }));
const add = (id: string, talk: number, role: 'you' | 'agent', text: string, data: Data = {}) => { db.prepare('INSERT INTO reel_chat(episode_id,at,role,text,data,talk) VALUES (?,?,?,?,?,?)').run(id, now(), role, text.slice(0, 6000), JSON.stringify(data), talk); tell(id); };
/** The conversations held about an episode, newest first. */
const talks = (id: string) => (db.prepare("SELECT talk, MAX(at) AS at, COUNT(*) AS n, (SELECT text FROM reel_chat q WHERE q.episode_id=r.episode_id AND q.talk=r.talk AND q.role='you' ORDER BY q.id LIMIT 1) AS title FROM reel_chat r WHERE episode_id=? GROUP BY talk ORDER BY at DESC").all(id) as any[]).map((t) => ({ talk: Number(t.talk), at: Number(t.at), n: Number(t.n), title: String(t.title ?? 'Conversation').slice(0, 120) }));
/** One thread per episode: the flow and the conversation together. */
const thread = (id: string) => talks(id)[0]?.talk ?? 1;
/** A message from the flow itself. A new question takes the place of the flow's older ones. */
setPost((id, text, { once, ...data } = {}) => {
  if (once) {
    const had = [...rows(id, thread(id), 60)].reverse().find((r) => r.text === text);
    if (had) { let any = false; for (const p of had.data.proposals ?? []) if (p.state === 'old' || p.state === 'no') { p.state = 'open'; any = true; } if (any) db.prepare('UPDATE reel_chat SET data=? WHERE id=?').run(JSON.stringify(had.data), had.id); return; }
  }
  // Once a later step asks, the retakes nobody answered are over too.
  if (data.proposals?.length) retire(id, data.proposals.some((p) => ['cover', 'captions', 'schedule'].includes(p.kind)));
  add(id, thread(id), 'agent', text, data);
});
setConversing((id) => working.has(id));
function retire(id: string, all = false) {
  for (const r of rows(id, thread(id), 60)) {
    if (!r.data.proposals?.some((p) => p.state === 'open' && (all || GATES.includes(p.kind as any)))) continue;
    for (const p of r.data.proposals) if (p.state === 'open' && (all || GATES.includes(p.kind as any))) p.state = 'old';
    db.prepare('UPDATE reel_chat SET data=? WHERE id=?').run(JSON.stringify(r.data), r.id);
  }
}
/** What can be answered now, newest question first; the first group is what a short reply refers to. */
function openAsks(id: string): { msg: number; i: number; ask: Proposal }[][] {
  return rows(id, thread(id), 60).reverse().map((r) => (r.data.proposals ?? []).map((ask, i) => ({ msg: r.id, i, ask })).filter((x) => x.ask.state === 'open')).filter((g) => g.length);
}
const tell = (id: string) => { const u = ownerOf(id); if (u) hub.emit(u, { type: 'social', episodeId: id }); };

const working = new Map<string, { ctrl: AbortController; doing: string; talk: number; did: string[] }>();
export const agentName = () => getBotRow(primaryBotId() ?? '')?.name ?? 'Your agent';
let alive = { at: 0, ok: false };
async function online(): Promise<boolean> {
  if (Date.now() - alive.at < 20_000) return alive.ok;
  let ok = false;
  try { const e = await engineFor(primaryBotId()!); ok = (await fetch(`${e.url}/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { /* not answering */ }
  alive = { at: Date.now(), ok };
  return ok;
}
/** A conversation (the newest unless one is named; a number not used yet is a new, empty one). */
export async function chat(id: string, want?: number) {
  void want;
  const w = working.get(id), talk = thread(id), at = isRunning(id), e = getEpisode(id);
  if (!w && !at && e && !openAsks(id).some((g) => g.some((x) => GATES.includes(x.ask.kind as any)))) ensureAsk(id);
  return { agent: agentName(), online: !!w || await online(), talk, talks: [], messages: rows(id, talk, 200), busy: w ? w.doing : null, step: at ? { stage: at, text: e?.stages[at].progress ?? 'Working' } : null, did: w ? w.did : [], waiting: openAsks(id)[0]?.map((x) => x.ask.label) ?? [] };
}
export function stopChat(id: string) { working.get(id)?.ctrl.abort(); }
const doing = (id: string, t: string) => { const w = working.get(id); if (w) { w.doing = t; tell(id); } };

const S = (v: unknown, n: number) => String(v ?? '').replace(/\r/g, '').slice(0, n);
const P = (v: unknown) => (Number(v) === 2 ? 2 : 1);
const usd = (n: number) => `$${n.toFixed(2)}`;
const stageName = (v: unknown): StageId => { const s = String(v) as StageId; if (!STAGES.includes(s)) throw new ReelError(`There is no stage called “${S(v, 30)}”.`); return s; };
const free = (id: string) => { if (isRunning(id)) throw new ReelError(`The ${isRunning(id)} stage is working; wait for it or stop it.`); };

// ---------- what the agent sees ----------
/** Which picture of a shot is in use, when there is more than one. */
function shownTake(e: Episode, part: number, n: number): string {
  const all = e.render.parts[part - 1].versions.filter((q) => q.kind === 'shot' && q.shot === n && q.state === 'completed' && q.file);
  if (!all.length) return '';
  const on = all.filter((q) => !(q.note ?? '').startsWith('[off]')).pop();
  return on ? ` {SHOWN: retake v${on.v}; the part's own shot is not used}` : ` {SHOWN: the part's own shot; the owner switched the retake${all.length > 1 ? 's' : ''} v${all.map((q) => q.v).join(', v')} off}`;
}
function state(e: Episode): string {
  const s = e.script, out: string[] = [];
  out.push(`EPISODE ${e.num} “${e.title}”. Spent ${usd(spent(e))} of ${usd(e.capUsd)}; ${usd(left(e))} left. Runs by itself: ${e.auto ? 'on' : 'off'}. Renders on ${e.render.provider}. AI Employee confirmed by the owner: ${e.aiConfirmed ?? 'not asked'}.`);
  out.push(`STAGES: ${STAGES.map((k) => `${k}=${e.stages[k].status}${e.stages[k].progress ? ` (${e.stages[k].progress})` : ''}${e.stages[k].error ? ` ERROR: ${e.stages[k].error}` : ''}`).join('; ')}`);
  if (e.notes?.length) out.push(`THE OWNER'S STANDING NOTES FOR THIS EPISODE: ${e.notes.map((n) => `- ${n}`).join(' ')}`);
  if (!s) { out.push(`STORY OPTIONS: ${JSON.stringify(e.story.options.map((o) => [o.title, o.trade, o.hookLine]))}. No script yet.`); return out.join('\n'); }
  out.push(`STORY: ${s.logline || e.story.picked?.problem || ''} Trade: ${s.trade}. AI Employee: ${s.aiEmployee.name}: ${s.aiEmployee.howItWorks} Tip: ${s.tip} Place: ${s.location}`);
  out.push(`CAST: ${e.cast.map((c) => `${c.key} (${c.name}, ${c.kind}, parts ${c.parts.join('+')}${c.image || c.imageAsset ? '' : ', no picture'}): ${c.lock}`).join(' | ')}`);
  s.parts.forEach((p, i) => {
    const part = i + 1, pr = e.render.parts[i], rv = e.review[i];
    out.push(`PART ${part} SCRIPT (time: ${p.time}; props: ${p.props})`);
    for (const x of p.shots) { const l = rv?.lines.find((q) => q.shot === x.n); out.push(`  shot ${x.n} [${x.start}-${x.end}s]${x.screen ? ` screen ${x.screen}` : ''}${x.clock ? ` clock ${x.clock}` : ''}: ${x.camera} ${x.picture}${x.line ? ` LINE ${x.speaker}${x.offscreen ? ' (off screen)' : ''}, ${x.delivery ?? ''}: "${x.line}"` : ' (silent)'}${rv ? ` -> in the render from ${(rv.shotStarts[p.shots.indexOf(x)] / rv.fps).toFixed(2)} s${l ? `; heard "${l.heard || 'nothing'}" at ${l.start.toFixed(2)}-${l.end.toFixed(2)} s, match ${l.score}${l.lips === false && !x.offscreen ? ', MOUTH DOES NOT MOVE' : ''}${l.pitch && l.refPitch ? `, pitch ${Math.round((l.pitch / l.refPitch - 1) * 100)}% off the sample${voiceDrift(l, x) ? ' (VOICE DRIFT)' : ''}` : ''}` : ''}` : ''}${shownTake(e, part, x.n)}`); }
    out.push(`  RENDERS: ${pr.versions.map((v) => `v${v.v} ${v.kind}${v.shot ? ` shot ${v.shot}` : ''} ${v.state}${v.usd ? ` ${usd(v.usd)}` : ''}${pr.picked === v.v ? ' IN USE' : ''}${v.note ? ` (${v.note})` : ''}`).join('; ') || 'none yet'}`);
    const notes = (rv?.notes ?? []).filter((n) => !n.startsWith('['));
    if (notes.length) out.push(`  REVIEW NOTES: ${notes.join(' / ')}`);
  });
  const open = (e.comments ?? []).filter((c) => !c.done);
  if (open.length) out.push(`THE OWNER'S OPEN COMMENTS: ${open.map((c) => `[${c.id}] ${c.shot ? `Part ${c.part} shot ${c.shot}${c.x !== undefined ? ` at ${Math.round(c.x * 100)}% across, ${Math.round((c.y ?? 0) * 100)}% down` : ''}` : 'whole video'}: ${c.text}`).join(' | ')}`);
  if (e.render.lead) out.push(`Part 1's reference video: ${e.render.lead.key}'s clip cut from Part 2 v${e.render.lead.v}${e.render.lead.doubt ? `; a check doubted it: ${e.render.lead.doubt}` : ''}`);
  out.push(`SCREENS: ${JSON.stringify(s.screens).slice(0, 5000)}`);
  const o = e.edit.options;
  out.push(`CUT: v${e.edit.version}${e.edit.final ? `, ${e.edit.seconds?.toFixed(1)} s, ${e.edit.lufs} LUFS` : ' not made'}; options ${JSON.stringify(o)}; checks not met: ${e.edit.checks.filter((c) => !c.ok).map((c) => `${c.label} ${c.detail ?? ''}`).join('; ') || 'none'}`);
  const ed = studioReady() ? studioState(e) : null;
  if (ed?.made) out.push(`EDITOR (HyperFrames; the owner cuts there by hand, and it is what the cut is made from): ${ed.shots} clips, ${ed.seconds!.toFixed(2)} s${ed.sig !== e.edit.studioSig ? ', with changes that are not in the cut yet' : ''}: ${ed.clips!.map((c) => { const rv = e.review[c.part - 1], i = s.parts[c.part - 1].shots.findIndex((q) => q.n === c.shot), l = rv?.lines.find((q) => q.shot === c.shot), at = l && rv ? c.start + l.start - rv.shotStarts[i] / rv.fps : 0; return `P${c.part} shot ${c.shot} at ${c.start.toFixed(2)}-${(c.start + c.dur).toFixed(2)}${l?.score ? ` (${l.speaker} heard ${at.toFixed(2)}-${(at + l.end - l.start).toFixed(2)})` : ''}`; }).join('; ')}${ed.gone!.length ? `. Left out: ${ed.gone!.map((g) => `P${g.part} shot ${g.shot}`).join(', ')}` : ''}. Trims and dropped shots you set with "cut" are carried into it (only the shots you change); captions, clock and sounds follow the shots by themselves.`);
  out.push(`COVER: ${e.cover.candidates.length} frames, picked ${e.cover.picked ?? 'none'}`);
  if (e.pack) out.push(`CAPTIONS: ${JSON.stringify({ instagram: e.pack.instagram, facebook: e.pack.facebook, whatsapp: e.pack.whatsapp, youtubeTitle: e.pack.youtubeTitle, youtubeDescription: e.pack.youtubeDescription, commentInstagram: e.pack.commentInstagram, slot: e.pack.slot, platforms: e.pack.platforms }).slice(0, 5000)}`);
  const asks = openAsks(e.id).flat();
  out.push(`WAITING FOR THE OWNER'S ANSWER: ${asks.map((x, i) => `[${i + 1}] ${x.ask.label} (${x.ask.kind}${x.ask.usd ? `, up to ${usd(x.ask.usd)}` : ''})`).join('; ') || 'nothing'}`);
  if (e.stages.story.status === 'needs_you') out.push(`THE STORIES ON OFFER: ${e.story.options.map((o, i) => `${i + 1}. ${o.title}: ${o.problem}`).join(' | ')}`);
  if (e.stages.cover.status === 'needs_you') out.push(`COVERS ON OFFER: ${e.cover.candidates.map((c, i) => `${i + 1} at ${c.t.toFixed(1)} s`).join(', ')}`);
  out.push(`LATEST EVENTS: ${events(e.id).slice(0, 14).map((x) => `${x.stage ?? ''} ${x.kind}: ${x.text.slice(0, 240)}`).join(' | ')}`);
  return out.join('\n');
}

const ACTIONS = `You act by listing actions. Those marked FREE happen at once and you get the result; those marked PROPOSE become a question with its price, which the owner answers in this window.
DECISIONS
{"do":"confirm","ask":[numbers from WAITING FOR THE OWNER'S ANSWER],"pick":n (story or cover number),"ai":"yes"|"later" (the owner said whether one of their AI Employees really does it)} only when the owner's last message itself clearly says yes to it; it is refused otherwise. If they approve and also ask for a change, make the change and do not confirm. | {"do":"decline","ask":[n]}
{"do":"own_story","text":"the owner's own story, in their words"} when they tell one instead of picking | {"do":"stories"} four different stories | {"do":"script_note","note":"what to change"} writes the script again with their notes, while the script waits for approval
{"do":"limit","usd":n} the episode's spending limit, only a number the owner wrote | {"do":"mark","platform":"instagram|facebook|youtube|whatsapp","status":"scheduled|live|failed","link":"..."} when the owner says they did it
FREE
{"do":"look","part":1|2,"shot":n} eight frames across that shot of the render in use | {"do":"look","part":1|2,"from":s,"to":s} frames between two times | {"do":"look","what":"cut","from":s,"to":s} of the finished cut | {"do":"look","what":"cast","key":"hector"} | {"do":"look","what":"screen","id":"s1"} | {"do":"look","what":"sheet","part":1|2} the contact sheet
{"do":"lips","part":1|2} checks every spoken line for a mouth that doesn't move
{"do":"edit_shot","part":1|2,"shot":n,"set":{"picture","camera","line","delivery","speaker","caption","clock","sound","offscreen"}} changes the plan of a shot (and the prompt of its part); a finished render only changes with a retake, or a line with revoice
{"do":"edit_text","set":{"tip","forward","question","altText","captionLine1","captionStory","location"},"parts":[{"part":1|2,"props","time","light","audio"}]}
{"do":"edit_cast","key":"...","set":{"lock","castLine","imagePrompt"}}
{"do":"edit_screen","id":"s1".."s5","data":{the whole new data of that screen}} redraws it
{"do":"revoice","part":1|2,"shot":n} says that line again in the character's own voice over the same picture, also on a retaken shot (wrong word, wrong or drifting voice; it cannot fix a mouth; costs no money, only a few of the owner's ElevenLabs characters; the cut follows by itself)
{"do":"take","part":1|2,"shot":n,"use":true|false} switches a retake of that shot on, or off so the part's own shot is back ("restore the previous one"); afterwards make the shot's plan match what is now shown with edit_shot
{"do":"cut","set":{"musicDb" (the theme under the voices, in dB; “a little” is 2 to 3 from what it is now),"trimStart","trimEnd","dropShots":[{"part","shot"}],"brighten":[{"part","shot"}],"trims":[{"part","shot","in":s,"out":s}] (seconds off a shot's start and end),"captionFixes":[["heard","shown"]],"screens":{"s1":{"on":true,"f0":n,"f1":n}},"screenOn":{"2-7":"s5"} (a screen on another shot's device, "part-shot": screen id, or "" for none)}} changes the cut's options (lists replace the old ones); the cut is then made again by itself
{"do":"cover","t":seconds} adds a cover frame | {"do":"captions","set":{"instagram","facebook","whatsapp","youtubeComment","youtubeTitle","youtubeDescription","commentInstagram","commentFacebook","altText","facebookTags":[],"youtubeTags":[],"slot"}}
{"do":"run","stage":"screens|storyboard|review|edit|cover|package"} a stage that is ready, stopped or out of date (no cost)
{"do":"comment_done","id":"..."} ticks off one of the owner's comments once it is dealt with | {"do":"remember","text":"..."} a standing note for this episode | {"do":"auto","on":true|false} | {"do":"stop"} stops what is running
PROPOSE
{"do":"render"} the parts that are missing | {"do":"retake","part":1|2,"shot":n (leave out for the whole part),"note":"what must be right this time, for the video model"} | {"do":"cast_again","key":"...","what":"image"|"voice","prompt":"..."}
{"do":"approve","stage":"cast|review|edit|package"} | {"do":"reopen","stage":"..."} | {"do":"rewrite","note":"..."} the whole script again (undoes what came after) | {"do":"run_again","stage":"..."} a stage that is already done
Every action may carry "why" (one short sentence).`;

// ---------- doing it ----------
/** A shot's plan changed, at any time: its part's prompt follows, and what was made after the edit is out of date when words changed. */
export function editShot(id: string, part: number, n: number, set: Record<string, any>): string[] {
  free(id);
  if (!getEpisode(id)?.script?.parts[part - 1].shots.some((q) => q.n === n)) throw new ReelError(`Part ${part} has no shot ${n}.`);
  const changed: string[] = [];
  patch(id, (q) => {
    const z = q.script!.parts[part - 1].shots.find((k) => k.n === n)!;
    for (const k of ['picture', 'camera', 'line', 'delivery', 'caption', 'sound'] as const) if (set[k] !== undefined) { const v = S(set[k], 700).trim(); if (k === 'picture' || k === 'camera') { if (v) z[k] = v; } else if (v) z[k] = v; else delete z[k]; changed.push(k); }
    if (set.clock !== undefined) { if (/^\d\d:\d\d:\d\d$/.test(String(set.clock))) z.clock = String(set.clock); else delete z.clock; changed.push('clock'); }
    if (set.offscreen !== undefined) { if (set.offscreen) z.offscreen = true; else delete z.offscreen; changed.push('offscreen'); }
    if (set.speaker !== undefined) { const key = S(set.speaker, 30).toLowerCase(); if (key && !q.cast.some((c) => c.key === key)) throw new ReelError(`There is no one called ${key} in the cast.`); z.speaker = key; changed.push('speaker'); }
    if (!changed.length) throw new ReelError('Nothing to change was given.');
    recheck(q);
    if (['line', 'caption', 'clock', 'speaker'].some((k) => changed.includes(k))) for (const t of ['edit', 'cover', 'package'] as StageId[]) if (['done', 'needs_you'].includes(q.stages[t].status)) q.stages[t].status = 'stale';
  });
  rebuildPrompts(id);
  log(id, 'script', 'change', `Part ${part} shot ${n}: ${changed.join(', ')} changed`);
  return changed;
}

interface Out { text: string; image?: { label: string; file: string; rel: string }; did?: string; proposal?: Proposal }
async function frames(e: Episode, file: string, list: number[], label: string): Promise<Out> {
  const rel = `chat/look-${Date.now()}-${Math.round(Math.random() * 1e4)}.jpg`;
  await py('sheet', { file, out: ensureDir(epFile(e, rel)), frames: list, cols: Math.min(8, Math.max(1, list.length)) }, { minutes: 5 });
  return { text: `${label}: the picture is attached (frames numbered, with their times).`, image: { label, file: epFile(e, rel), rel } };
}
const spread = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => Math.round(a + ((b - a) * i) / Math.max(1, n - 1)));

const LEGACY = new Set(['approve']);
async function act(id: string, a: any): Promise<Out> {
  if (LEGACY.has(String(a?.do ?? ''))) throw new ReelError('Each step asks for its approval by itself; use confirm when the owner says yes to it.');
  const e = getEpisode(id)!, kind = String(a?.do ?? ''), why = a?.why ? S(a.why, 200) : undefined;
  const propose = (p: Omit<Proposal, 'state' | 'why'>): Out => ({ text: `Proposed to the owner: ${p.label}. It has not happened.`, proposal: { ...p, why, state: 'open' } });
  const shotOf = (part: number, n: number) => { const x = e.script?.parts[part - 1].shots.find((q) => q.n === n); if (!x) throw new ReelError(`Part ${part} has no shot ${n}.`); return x; };
  switch (kind) {
    case 'look': {
      if (a.what === 'cast') { const c = e.cast.find((x) => x.key === String(a.key).toLowerCase()); if (!c?.image) throw new ReelError('That person has no picture.'); return { text: `${c.name}'s own picture is attached.`, image: { label: c.name, file: c.kind === 'series' ? path.join(seriesDir(), c.image) : epFile(e, c.image), rel: c.kind === 'series' ? '' : c.image } }; }
      if (a.what === 'screen') { const q = e.screens.find((x) => x.id === a.id); if (!q) throw new ReelError('That screen isn’t drawn yet.'); return { text: `Screen ${q.id} is attached.`, image: { label: q.title, file: epFile(e, q.png), rel: q.png } }; }
      if (a.what === 'sheet') { const r = e.review[P(a.part) - 1]; if (!r) throw new ReelError('That part hasn’t been reviewed yet.'); return { text: 'The contact sheet is attached.', image: { label: `Part ${P(a.part)}`, file: epFile(e, r.sheet), rel: r.sheet } }; }
      if (a.what === 'cut') {
        if (!e.edit.final) throw new ReelError('There is no cut yet.');
        const f = epFile(e, e.edit.final), m = await probe(f), fps = m.fps || 24, from = Math.max(0, Number(a.from) || 0), to = Math.min(m.seconds, Number(a.to) || m.seconds);
        return frames(e, f, spread(from * fps, Math.max(from * fps + 1, to * fps - 2), 8), `The cut, ${from.toFixed(1)} to ${to.toFixed(1)} s`);
      }
      const part = P(a.part), v = partFile(e, part);
      if (!v?.file) throw new ReelError(`Part ${part} isn’t rendered yet.`);
      const base = epFile(e, v.file), rv = e.review[part - 1];
      if (a.shot) {
        const n = Number(a.shot), x = shotOf(part, n), i = e.script!.parts[part - 1].shots.indexOf(x);
        const re = e.render.parts[part - 1].versions.filter((q) => q.kind === 'shot' && q.shot === n && q.state === 'completed' && q.file && !(q.note ?? '').startsWith('[off]')).pop();
        if (re) { const m = await probe(epFile(e, re.file!)); return frames(e, epFile(e, re.file!), spread(1, Math.max(8, Math.round(m.seconds * (m.fps || 24)) - 3), 8), `Part ${part} shot ${n} (the retake)`); }
        const fps = rv?.fps ?? 24, s0 = rv ? rv.shotStarts[i] : Math.round(x.start * fps), s1 = rv ? rv.shotStarts[i + 1] ?? rv.frames : Math.round(x.end * fps);
        return frames(e, base, spread(s0 + 1, s1 - 2, 8), `Part ${part} shot ${n}${x.line ? `, while ${x.speaker} says “${x.line}”` : ''}`);
      }
      const m = await probe(base), fps = m.fps || 24, from = Math.max(0, Number(a.from) || 0), to = Math.min(m.seconds, Number(a.to) || m.seconds);
      return frames(e, base, spread(from * fps, Math.max(from * fps + 1, to * fps - 2), 12), `Part ${part}, ${from.toFixed(1)} to ${to.toFixed(1)} s`);
    }
    case 'lips': {
      const part = P(a.part), bad = await mouthCheck(id, part);
      return { text: bad.length ? `Part ${part}: the mouth doesn't move in ${bad.map((n) => `shot ${n}`).join(', ')}.` : `Part ${part}: every speaker's mouth moves.`, did: `Checked the lips in Part ${part}` };
    }
    case 'edit_shot': {
      const part = P(a.part), n = Number(a.shot), x = shotOf(part, n), changed = editShot(id, part, n, a.set ?? {});
      return { text: `Part ${part} shot ${n} changed (${changed.join(', ')}).${x.line && partFile(e, part) ? ' The render in use is unchanged until it is retaken.' : ''}${tooLong(id)}`, did: `Changed Part ${part} shot ${n}` };
    }
    case 'comment_done': { const c = e.comments?.find((q) => q.id === a.id); if (!c) throw new ReelError('No such comment.'); patch(id, (q) => { for (const z of q.comments ?? []) if (z.id === a.id) z.done = true; }); return { text: 'Ticked off.', did: `Ticked off: ${c.text.slice(0, 60)}` }; }
    case 'edit_text': {
      free(id);
      patch(id, (q) => {
        const s = q.script; if (!s) throw new ReelError('There is no script yet.');
        const t = a.set ?? {};
        for (const k of ['tip', 'forward', 'question', 'altText', 'location'] as const) if (t[k] !== undefined) (s as any)[k] = S(t[k], 900);
        if (t.captionLine1 !== undefined) s.caption.line1 = S(t.captionLine1, 300);
        if (t.captionStory !== undefined) s.caption.story = S(t.captionStory, 900);
        for (const p of Array.isArray(a.parts) ? a.parts : []) for (const k of ['props', 'time', 'light', 'audio'] as const) if (p[k] !== undefined) s.parts[P(p.part) - 1][k] = S(p[k], 700);
        recheck(q);
      });
      rebuildPrompts(id);
      log(id, 'script', 'change', 'Texts changed');
      return { text: `Changed.${tooLong(id)}`, did: 'Changed the texts' };
    }
    case 'edit_cast': {
      free(id);
      const key = String(a.key ?? '').toLowerCase();
      patch(id, (q) => { const c = q.cast.find((x) => x.key === key); if (!c) throw new ReelError('No one by that name.'); for (const k of ['lock', 'castLine', 'imagePrompt'] as const) if (a.set?.[k] !== undefined) c[k] = S(a.set[k], 2500); const sc = q.script?.cast.find((x) => x.key === key); if (sc) { sc.lock = c.lock; sc.castLine = c.castLine; } });
      rebuildPrompts(id);
      log(id, 'cast', 'change', `${key}: description changed`);
      return { text: `Changed; a picture only changes when it is made again.${tooLong(id)}`, did: `Changed ${key}'s description` };
    }
    case 'edit_screen': {
      free(id);
      const k = String(a.id ?? '');
      if (!e.script?.screens[k] || typeof a.data !== 'object' || !a.data) throw new ReelError('That needs a screen (s1 to s5) and its whole data.');
      if (/\bdemo\b/i.test(JSON.stringify(a.data))) throw new ReelError('No DEMO word on a screen.');
      patch(id, (q) => { q.script!.screens[k] = JSON.parse(JSON.stringify(a.data).slice(0, 6000)); });
      const list = await buildScreens(getEpisode(id)!, () => {});
      patch(id, (q) => { q.screens = list; for (const t of ['edit', 'cover', 'package'] as StageId[]) if (['done', 'needs_you'].includes(q.stages[t].status)) q.stages[t].status = 'stale'; });
      log(id, 'screens', 'change', `${k} changed`);
      const s = list.find((x) => x.id === k);
      return { text: 'Redrawn; attached.', did: `Redrew screen ${k.slice(1)}`, ...(s ? { image: { label: s.title, file: epFile(e, s.png), rel: s.png } } : {}) };
    }
    case 'confirm': {
      const all = openAsks(id).flat(), want = (Array.isArray(a.ask) ? a.ask : [a.ask]).map(Number).filter((n: number) => n >= 1 && n <= all.length), last = lastWords(id);
      if (!want.length) throw new ReelError('There is no such question waiting.');
      if (!agreed(last)) throw new ReelError('The owner’s message doesn’t say yes to that. Ask plainly, and wait for their answer.');
      const done: string[] = [];
      for (const n of want) { const x = all[n - 1]; done.push(await settleAsk(id, x, { pick: Number(a.pick) || undefined, ai: a.ai === 'yes' && /\bai\b|employee|really|confirm/i.test(last) ? 'yes' : undefined, words: last })); }
      return { text: `Done: ${done.filter(Boolean).join(' ') || 'it started'}`, did: done.filter(Boolean).join(' ') || all[want[0] - 1].ask.label };
    }
    case 'decline': { const all = openAsks(id).flat(); for (const n of (Array.isArray(a.ask) ? a.ask : [a.ask]).map(Number)) if (all[n - 1]) mark(id, all[n - 1], 'no'); return { text: 'Declined.' }; }
    case 'own_story': { if (e.stages.story.status !== 'needs_you') throw new ReelError('The story is already chosen; reopen it first.'); const t = S(a.text, 1200).trim(); if (t.length < 20) throw new ReelError('That is too short for a story.'); const r = await carryOut(id, { kind: 'story', label: '', args: {}, state: 'open' }, { custom: t, words: lastWords(id) }); retire(id); return { text: r, did: 'Took your own story' }; }
    case 'stories': { if (e.stages.story.status !== 'needs_you') throw new ReelError('The story is already chosen.'); await start(id, 'story'); return { text: 'Started.', did: 'Four different stories' }; }
    case 'script_note': { if (e.stages.script.status !== 'needs_you') throw new ReelError('The script is approved. Propose a rewrite (it undoes what came after).'); await start(id, 'script', { note: S(a.note, 2000) }); return { text: 'The script is being written again.', did: 'Writing the script again with your notes' }; }
    case 'limit': {
      const n = Number(a.usd);
      if (!new RegExp(`(^|[^\\d.])${String(n).replace('.', '\\.')}(?![\\d])`).test(lastWords(id))) throw new ReelError('Only a limit the owner wrote themselves counts.');
      return { text: setLimit(id, n), did: `Limit ${usd(n)}` };
    }
    case 'mark': { markSchedule(id, S(a.platform, 20), S(a.status, 20), S(a.link, 300), S(a.note, 300), 'you'); return { text: 'Noted.', did: `${a.platform}: ${a.status}` }; }
    case 'take': {
      free(id);
      const part = P(a.part), n = Number(a.shot), on = a.use !== false;
      shotOf(part, n);
      const list = e.render.parts[part - 1].versions.filter((q) => q.kind === 'shot' && q.shot === n && q.state === 'completed' && q.file), off = (q: { note?: string }) => (q.note ?? '').startsWith('[off]');
      if (!list.length) throw new ReelError('That shot was never retaken.');
      const todo = on ? list.filter(off).slice(-1) : list.filter((q) => !off(q));
      if (!todo.length) throw new ReelError(on ? 'That retake is already in use.' : 'The part’s own shot is already in use.');
      for (const q of todo) pickVersion(id, part, q.v);
      log(id, 'review', 'change', `Part ${part} shot ${n}: ${on ? `retake v${todo[0].v} in use` : 'the retake is off, the part’s own shot is back'} (session window)`);
      return { text: on ? 'The retake is in use.' : 'The part’s own shot is back.', did: `Part ${part} shot ${n}: ${on ? 'the retake is in use' : 'the shot from before is back'}` };
    }
    case 'revoice': {
      if (e.render.parts.some((p) => p.picked === null)) throw new ReelError('Both parts have to be rendered first.');
      await revoice(id, P(a.part), Number(a.shot));
      return { text: 'Started; it takes about a minute, then the cut follows by itself.', did: `Part ${P(a.part)} shot ${Number(a.shot)}: saying the line again` };
    }
    case 'cut': {
      free(id);
      const was0 = e.edit.options as Record<string, any>;
      changeCut(id, a.set ?? {});
      const is0 = getEpisode(id)!.edit.options as Record<string, any>, diff = Object.keys(is0).filter((k) => JSON.stringify(is0[k]) !== JSON.stringify(was0[k])).map((k) => `${k} was ${JSON.stringify(was0[k] ?? null).slice(0, 120)}, is now ${JSON.stringify(is0[k]).slice(0, 120)}`);
      if (!diff.length) return { text: 'Nothing changed: that is already how it is. Do not set it again.' };
      return { text: `Saved once: ${diff.join('; ')}. Do not set it again. The cut is made again by itself at the end of this message; do not start it.`, did: 'Changed the cut’s options' };
    }
    case 'cover': { if (!e.edit.final) throw new ReelError('Make the cut first.'); await addCover(id, Number(a.t)); return { text: 'Added.', did: `Added a cover frame at ${Number(a.t).toFixed(1)} s` }; }
    case 'captions': {
      if (!e.pack || e.stages.package.status !== 'needs_you') throw new ReelError('The captions can be changed while that stage waits for the owner.');
      const t = a.set ?? {};
      patch(id, (q) => {
        const p = q.pack!;
        for (const k of ['instagram', 'facebook', 'commentInstagram', 'commentFacebook', 'whatsapp', 'youtubeComment', 'altText', 'youtubeTitle', 'youtubeDescription'] as const) if (t[k] !== undefined) (p as any)[k] = S(t[k], 2200);
        for (const k of ['facebookTags', 'youtubeTags'] as const) if (Array.isArray(t[k])) p[k] = t[k].map((x: unknown) => S(x, 60).trim()).filter(Boolean).slice(0, k === 'facebookTags' ? 10 : 20);
        if (t.slot !== undefined) { const s = slots(ownerOf(id)!, 20, id).find((x) => x.at === t.slot); if (!s || s.taken) throw new ReelError('That slot is taken or past.'); p.slot = s.at; }
        p.checks = packChecks(q, series());
      });
      return { text: 'Changed.', did: 'Changed the captions' };
    }
    case 'run': {
      const s = stageName(a.stage);
      if (!['screens', 'storyboard', 'review', 'edit', 'cover', 'package'].includes(s)) throw new ReelError('That one costs or decides something: propose it instead.');
      if (!['ready', 'failed', 'stale'].includes(e.stages[s].status)) throw new ReelError(`That stage is ${e.stages[s].status}; running it again would undo it, so propose run_again.`);
      await start(id, s);
      return { text: `${s} started.`, did: `Started ${s}` };
    }
    case 'remember': { const t = S(a.text, 400).trim(); if (!t) throw new ReelError('Nothing to remember.'); patch(id, (q) => { q.notes = [...(q.notes ?? []), t].slice(-20); }); return { text: 'Noted.', did: `Noted: ${t.slice(0, 80)}` }; }
    case 'auto': { patch(id, (q) => { q.auto = !!a.on; }); return { text: 'Done.', did: `Run by itself: ${a.on ? 'on' : 'off'}` }; }
    case 'stop': { if (!stop(id)) throw new ReelError('Nothing is running.'); return { text: 'Stopping.', did: 'Stopped the running stage' }; }
    // ---- only ever proposed ----
    case 'render': {
      const want = [2, 1].filter((p) => e.render.parts[p - 1].picked === null);
      if (!want.length) throw new ReelError('Both parts are there. Propose a retake instead.');
      if (!e.stages.storyboard.approvedAt) throw new ReelError('The storyboard isn’t approved yet; the owner does that on its page.');
      const q = await quoteRender(id, want);
      return propose({ kind: 'render', label: `Render ${want.map((p) => `Part ${p}`).join(' and ')}, up to ${usd(q)}`, args: {}, usd: q });
    }
    case 'retake': {
      const part = P(a.part), shot = a.shot ? Number(a.shot) : undefined, note = S(a.note, 500);
      if (shot) shotOf(part, shot);
      if (!partFile(e, part)) throw new ReelError(`Part ${part} isn’t rendered yet; propose render.`);
      const q = await quoteRetake(id, part, shot, note);
      return propose({ kind: 'retake', label: `Retake Part ${part}${shot ? ` shot ${shot}` : ''}, up to ${usd(q.usd)}`, args: { part, ...(shot ? { shot } : {}), note }, usd: q.usd });
    }
    case 'cast_again': { const c = e.cast.find((x) => x.key === String(a.key).toLowerCase()); if (!c || c.kind === 'series') throw new ReelError('Only this episode’s own new people can be made again.'); const what = a.what === 'voice' ? 'voice' : 'image'; return propose({ kind: 'cast', label: `Make ${c.name}’s ${what === 'voice' ? 'voice' : 'picture'} again${what === 'image' ? ', about $0.04' : ''}${e.stages.cast.status === 'done' ? ' (what came after becomes out of date)' : ''}`, args: { key: c.key, what, ...(a.prompt ? { prompt: S(a.prompt, 2500) } : {}) }, ...(what === 'image' ? { usd: 0.08 } : {}) }); }
    case 'approve': { const s = stageName(a.stage); if (!['cast', 'review', 'edit', 'package'].includes(s)) throw new ReelError('That one is approved on its own page (it needs a choice or a price).'); if (e.stages[s].status !== 'needs_you') throw new ReelError('That stage isn’t waiting for approval.'); return propose({ kind: 'approve', label: `Approve the ${s === 'package' ? 'captions' : s}`, args: { stage: s } }); }
    case 'reopen': { const s = stageName(a.stage); if (e.stages[s].status !== 'done') throw new ReelError('That stage isn’t finished.'); return propose({ kind: 'reopen', label: `Open ${s} again (what came after becomes out of date)`, args: { stage: s } }); }
    case 'rewrite': return propose({ kind: 'rewrite', label: 'Write the script again with your notes (undoes what came after)', args: { note: S(a.note, 2000) } });
    case 'run_again': { const s = stageName(a.stage); if (['render', 'cast', 'schedule', 'story'].includes(s)) throw new ReelError('Use render, retake or cast_again for that.'); return propose({ kind: 'run', label: `Run ${s} again (what came after becomes out of date)`, args: { stage: s } }); }
    default: throw new ReelError(`There is no action called “${S(kind, 40)}”.`);
  }
}

/** The owner's own latest message: what a decision rests on. */
const lastWords = (id: string) => [...rows(id, thread(id), 60)].reverse().find((r) => r.role === 'you')?.text ?? '';
function setLimit(id: string, n: number): string {
  const e = getEpisode(id)!;
  if (!(n >= spent(e) && n <= 60)) throw new ReelError('The limit has to be at least what is already spent, and at most $60.');
  patch(id, (x) => { x.capUsd = n; });
  log(id, null, 'approve', `Spending limit set to ${usd(n)}. “${lastWords(id).slice(0, 120)}”`);
  retire(id); // asked again with the new limit
  return `The limit for this episode is ${usd(n)}.`;
}
const mark = (id: string, x: { msg: number; i: number }, s: Proposal['state']) => { const r = db.prepare('SELECT data FROM reel_chat WHERE id=? AND episode_id=?').get(x.msg, id) as any, d = JSON.parse(r?.data || '{}') as Data; if (d.proposals?.[x.i]) { d.proposals[x.i].state = s; db.prepare('UPDATE reel_chat SET data=? WHERE id=?').run(JSON.stringify(d), x.msg); tell(id); } };
/** Carries out one answered question: a step of the flow, or something Zubi proposed. */
async function settleAsk(id: string, x: { msg: number; i: number; ask: Proposal }, o: { pick?: number; ai?: 'yes' | 'later'; words?: string }): Promise<string> {
  if (GATES.includes(x.ask.kind as any)) { mark(id, x, 'done'); try { return await carryOut(id, x.ask, o); } catch (err) { mark(id, x, 'open'); throw err; } }
  await decide(id, x.msg, x.i, true);
  return `${x.ask.label.replace(/, up to .*/, '')}: started.`;
}
/** A reply that can only mean one thing is carried out at once, without asking the model. */
async function quick(id: string, text: string): Promise<boolean> {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
  const talk = thread(id), say = (m: string, data: Data = {}) => add(id, talk, 'agent', m, data);
  if (t === 'stop' && isRunning(id)) { stop(id); say('Stopping.'); return true; }
  const lim = /^(?:set |raise |change )?(?:the |my )?(?:limit|budget|cap)(?: to| of|:)?\s*\$?\s*(\d+(?:\.\d+)?)(?: dollars?)?$/.exec(t);
  if (lim) { try { say(setLimit(id, Number(lim[1]))); } catch (err) { say((err as Error).message, { error: true }); } return true; }
  const group = openAsks(id)[0];
  const r = group && readReply(text, group.map((x) => x.ask));
  if (!group || !r) return false;
  if (r.unclear) { say(r.unclear); return true; }
  try {
    if (r.self) { patch(id, (x) => { x.schedule.method = 'self'; }); for (const x of group) mark(id, x, 'done'); say('You schedule it yourself. The pack is ready on the Schedule tab. Tell me when a platform is scheduled and I note it.'); return true; }
    for (const i of r.no) if (!GATES.includes(group[i].ask.kind as any)) mark(id, group[i], 'no');
    if (r.no.length) { say('All right, not now. Tell me when, or what to change.'); return true; }
    const said: string[] = [];
    for (const i of r.yes) said.push(await settleAsk(id, group[i], { pick: r.pick, ai: r.ai, words: text }));
    const out = said.filter(Boolean).join(' ');
    if (out) say(out, { step: true });
  } catch (err) { if (!(err instanceof ReelError)) console.warn('[reels] reply:', err); say(err instanceof ReelError ? err.message : 'That didn’t work just now.', { error: true }); }
  return true;
}

/** After a change: does either prompt no longer fit? */
const tooLong = (id: string) => { const c = getEpisode(id)!.storyboard?.chars ?? []; const t = c.map((n, i) => (n > 7500 ? `Part ${i + 1}'s prompt is now ${n} characters, over the 7,500 limit: shorten pictures, props, place or locks (not the lines) until it fits.` : '')).filter(Boolean).join(' '); return t ? ` ${t}` : ''; };

/** Messages that were being answered when the app restarted: answered now, knowing that some of it may be done already. */
export function resumeChats() {
  for (const r of db.prepare("SELECT episode_id, talk, id, at, role FROM reel_chat WHERE id IN (SELECT MAX(id) FROM reel_chat GROUP BY episode_id)").all() as any[]) {
    if (r.role !== 'you' || now() - Number(r.at) > 2 * 3600_000 || working.has(r.episode_id) || !getEpisode(r.episode_id)) continue;
    begin(r.episode_id, Number(r.talk), true);
  }
}
/** The owner wrote something. Answers at once; the work goes on and shows up in the chat. */
export async function send(id: string, text: string, want?: number): Promise<number> {
  const t = text.trim().slice(0, 4000);
  if (!t) throw new ReelError('Write what you want done.');
  if (working.has(id)) throw new ReelError(`${agentName()} is still working on your last message. Stop it or wait.`);
  const list = talks(id), top = Math.max(0, ...list.map((x) => x.talk)), talk = want && want > 0 && want <= top + 1 ? Math.floor(want) : list[0]?.talk ?? 1;
  void talk;
  void list; void top;
  add(id, thread(id), 'you', t);
  if (!(await quick(id, t))) begin(id, thread(id), false); else settle(id);
  return thread(id);
}
function begin(id: string, talk: number, again: boolean) {
  const ctrl = new AbortController();
  working.set(id, { ctrl, doing: 'Thinking', talk, did: [] });
  tell(id);
  void converse(id, talk, ctrl.signal, again).catch((err) => {
    const m = ctrl.signal.aborted ? 'Stopped.' : err instanceof ReelError ? err.message : 'Something went wrong; try again.';
    if (!ctrl.signal.aborted && !(err instanceof ReelError)) console.warn('[reels] chat:', err);
    try { const w = working.get(id); add(id, talk, 'agent', m, { error: true, ...(w?.did.length ? { did: w.did } : {}) }); } catch { /* the episode was deleted */ }
  }).finally(() => { working.delete(id); tell(id); try { settle(id); } catch { /* deleted */ } });
}
async function converse(id: string, talk: number, signal: AbortSignal, again_: boolean) {
  const did = working.get(id)!.did, no: string[] = [], shown: string[] = [], proposals: Proposal[] = [], steps: string[] = again_ ? ['- HeyZubi restarted while you were answering this message. Some of it may be done already: read LATEST EVENTS and the state before you act, and repeat nothing that is done.'] : [];
  let images: { label: string; file: string }[] = [], reply = '', tokens = 0;
  for (let n = 1; n <= 7; n++) {
    const e = getEpisode(id);
    if (!e) return;
    const said = rows(id, talk, 18).map((r) => `${r.role === 'you' ? 'OWNER' : 'YOU'}: ${r.text}${r.data.did?.length ? ` [did: ${r.data.did.join('; ')}]` : ''}${r.data.proposals?.length ? ` [proposed: ${r.data.proposals.map((p) => `${p.label} (${p.state === 'done' ? 'the owner said yes' : p.state === 'no' ? 'declined' : p.state === 'old' ? 'no longer asked' : 'not answered yet'})`).join('; ')}]` : ''}`).join('\n');
    const r = await askJson<{ reply: string; actions?: any[] }>({
      instructions: `You are ${agentName()}, making the cartoon reel series “${series().name}” with its owner. You are in the Zubi window beside one episode, the only place the owner writes: there are no buttons. The steps are Story, Script, Cast, Screens, Storyboard, Render (with its check and the final cut), Cover (with the captions) and Schedule; each step posts its result and question here by itself. The owner gives you free instructions; you carry them out with the actions below, and answer plainly.
Rules: act rather than explain. Look at the picture before you say anything about how it looks. Say only what the results show; never say something is done that a result did not confirm. You cannot spend or approve on your own: propose it with its price, say “reply yes”, and confirm only what the owner's own message agreed to. After a free change the cut is made again by itself; say so. When the owner reports a fault, find its cause first, then fix what is free and propose the rest with a precise note for the video model (say what must be seen, not what went wrong; for speech: "the mouth opens and moves clearly with every word from the first frame"). Prefer one shot's retake over a whole part. A time the owner gives is a time in the cut: find the clip and whose line is heard there in the EDITOR list before acting. A line marked off screen needs no moving mouth. Answer every separate point of a message. Never propose again what the owner declined or switched off unless they ask for it. Never invent abilities for the AI Employee in the story. If something can't be done here, say so in one sentence and what can be done instead. Never repeat a step's question in full; it is already in the window. Replies: the owner's language, short sentences, under 110 words, no headings or tables, no internal names of actions.
${ACTIONS}`,
      prompt: `${state(e)}\n\nTHE CONVERSATION (the last message is the one to answer):\n${said}\n\n${steps.length ? `WHAT YOU HAVE DONE FOR THIS MESSAGE SO FAR:\n${steps.join('\n')}\n\n` : ''}${n === 7 ? 'This is your last step: no more actions, only the reply.\n' : ''}Answer with JSON: {"reply": "what you tell the owner (leave empty while you still need to act)", "actions": [ ... ] (empty when you are finished)}`,
      images, signal, minutes: 6, tries: 2, onUsage: (t) => { tokens += t; },
      check: (v) => (typeof v?.reply === 'string' && (v.actions === undefined || Array.isArray(v.actions)) ? (!v.reply.trim() && !(v.actions ?? []).length ? ['give a reply or actions'] : []) : ['reply must be text and actions a list']),
    });
    reply = r.reply.trim() || reply;
    const list = n === 7 ? [] : (r.actions ?? []).slice(0, 6);
    if (!list.length) break;
    images = [];
    let again = false;
    // What happens at once comes before what runs for a while, so one point of a message never blocks another.
    const late = (x: any) => (['revoice', 'run', 'stories', 'script_note', 'confirm'].includes(String(x?.do)) ? 1 : 0);
    list.sort((x: any, y: any) => late(x) - late(y));
    for (const a of list) {
      if (signal.aborted) throw new ReelError('Stopped.');
      for (let w = 0; w < 600 && isRunning(id) && !['look', 'stop', 'remember', 'comment_done', 'retake', 'render', 'decline', 'mark', 'limit'].includes(String(a?.do)); w++) { if (w === 0) doing(id, 'Waiting for the last change to finish'); if (signal.aborted) throw new ReelError('Stopped.'); await new Promise((z) => setTimeout(z, 1000)); }
      doing(id, ({ look: 'Looking', lips: 'Checking the lips', edit_shot: 'Changing a shot', edit_screen: 'Redrawing a screen', retake: 'Asking for the price', render: 'Asking for the price', cut: 'Changing the cut', captions: 'Changing the captions' } as Record<string, string>)[a?.do] ?? 'Working');
      try {
        const o = await act(id, a);
        steps.push(`- ${JSON.stringify(a).slice(0, 500)} -> ${o.text}`);
        if (o.did && !did.includes(o.did)) did.push(o.did);
        if (o.image) { images.push({ label: o.image.label, file: o.image.file }); if (o.image.rel && !shown.includes(o.image.rel)) shown.push(o.image.rel); }
        if (o.proposal && !proposals.some((p) => p.label === o.proposal!.label)) proposals.push(o.proposal);
        if (!o.proposal) again = true;
      } catch (err) {
        if (signal.aborted) throw err;
        steps.push(`- ${JSON.stringify(a).slice(0, 400)} -> NOT DONE: ${(err as Error).message}`);
        no.push(`${({ look: 'Look', lips: 'Check the lips', edit_shot: 'Change a shot', edit_screen: 'Redraw a screen', revoice: 'Say a line again', cut: 'Change the cut', captions: 'Change the captions', retake: 'Price a retake', render: 'Price the render', run: 'Run a stage' } as Record<string, string>)[a?.do] ?? 'A step'}: ${(err as Error).message}`.slice(0, 200));
        again = true;
      }
    }
    doing(id, 'Thinking');
    if (!again && reply) break;
  }
  add(id, talk, 'agent', reply || 'Done.', { did, no: no.slice(0, 5), images: shown.slice(0, 6), proposals, tokens });
}

/** The owner pressed one of the buttons, or turned it down. */
export async function decide(id: string, msg: number, i: number, yes: boolean): Promise<number> {
  const q0 = db.prepare('SELECT id, talk, data FROM reel_chat WHERE id=? AND episode_id=?').get(msg, id) as any, row = q0 ? { id: msg, talk: Number(q0.talk), data: JSON.parse(q0.data || '{}') as Data } : null, p = row?.data.proposals?.[i];
  if (!row || !p) throw new ReelError('That suggestion isn’t here any more.');
  if (p.state !== 'open') throw new ReelError('That was already decided.');
  if (GATES.includes(p.kind as any)) throw new ReelError('Answer that in the Zubi window.');
  const save = (s: Proposal['state']) => { p.state = s; db.prepare('UPDATE reel_chat SET data=? WHERE id=? AND episode_id=?').run(JSON.stringify(row.data), msg, id); tell(id); };
  if (!yes) { save('no'); return row.talk; }
  const e = getEpisode(id)!;
  free(id);
  switch (p.kind) {
    case 'render': {
      const want = [2, 1].filter((k) => e.render.parts[k - 1].picked === null);
      if (!want.length) throw new ReelError('Both parts are there already.');
      const q = await quoteRender(id, want);
      if (q > (p.usd ?? 0) + 0.02) throw new ReelError(`It is now quoted at up to ${usd(q)}. Ask again for the new price.`);
      log(id, 'render', 'approve', `${p.label} (session window)`);
      await start(id, 'render');
      break;
    }
    case 'retake': await retake(id, { part: p.args.part, shot: p.args.shot, note: p.args.note ?? '', confirmUsd: (p.usd ?? 0) + 0.005 }); break;
    case 'cast':
      if (p.args.prompt) patch(id, (x) => { const m = x.cast.find((q) => q.key === p.args.key); if (m && m.kind !== 'series') m.imagePrompt = p.args.prompt; });
      log(id, 'cast', 'approve', `${p.label} (session window)`);
      await start(id, 'cast', { key: p.args.key, what: p.args.what });
      break;
    case 'approve': approve(id, p.args.stage, { words: `${p.label} (session window)` }); break;
    case 'reopen': patch(id, (x) => { const s = p.args.stage as StageId; if (x.stages[s].status !== 'done') throw new ReelError('That stage isn’t finished.'); x.stages[s].status = 'needs_you'; delete x.stages[s].approvedAt; delete x.stages[s].approval; for (const t of STAGES.slice(STAGES.indexOf(s) + 1)) if (['done', 'needs_you'].includes(x.stages[t].status)) x.stages[t].status = 'stale'; else if (x.stages[t].status === 'ready') x.stages[t].status = 'idle'; }); log(id, p.args.stage, 'change', 'Opened again (session window)'); break;
    case 'rewrite': await start(id, 'script', { note: p.args.note }); break;
    case 'run': await start(id, p.args.stage); break;
  }
  save('done');
  return row.talk;
}
/** Old looks are only useful for a while: a chat keeps the newest forty pictures. */
export function tidyLooks(e: Episode) {
  const d = epFile(e, 'chat');
  try { const f = fs.readdirSync(d).filter((x) => /^look-\d+-\d+\.jpg$/.test(x)).sort(); for (const x of f.slice(0, Math.max(0, f.length - 40))) fs.unlinkSync(path.join(d, x)); } catch { /* none yet */ }
}
