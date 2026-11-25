// The flow in words: every step tells its result and asks its question in the Zubi window, and the owner's reply there is
// the decision. A plain reply ("2", "approve", "yes to all") is understood here, by rule; anything longer goes to Zubi, and
// even then a decision only counts when the owner's own message says it (agreed), after the question and its price were shown.
import fs from 'node:fs';
import path from 'node:path';
import { enqueue } from '../agent/loop.js';
import { giveToHermes, primaryBotId } from '../engine.js';
import { env } from '../env.js';
import { db, now } from '../db.js';
import { appendRow, getBotRow } from '../store.js';
import { musts } from './checks.js';
import { approve, flow, isRunning, left, start } from './stages.js';
import { epFile, getEpisode, istToMs, log, ownerOf, patch, ReelError, series, slotLabel, spent } from './store.js';
import { STAGES, type Episode, type StageId } from './types.js';

export type GateKind = 'story' | 'script' | 'cast' | 'storyboard' | 'cut' | 'cover' | 'captions' | 'schedule' | 'again';
export const GATES: GateKind[] = ['story', 'script', 'cast', 'storyboard', 'cut', 'cover', 'captions', 'schedule', 'again'];
export interface Ask { label: string; why?: string; kind: string; args: Record<string, any>; usd?: number; state: 'open' | 'done' | 'no' | 'old' }
type Post = (id: string, text: string, data?: { proposals?: Ask[]; step?: boolean; error?: boolean; images?: string[]; /** Not said again when it is already in the thread. */ once?: boolean }) => void;
let post: Post = () => {};
export const setPost = (p: Post) => { post = p; };
let conversing: (id: string) => boolean = () => false;
/** While Zubi is still carrying out a message, the cut waits: it is made once, at the end. */
export const setConversing = (f: (id: string) => boolean) => { conversing = f; };
const usd = (n: number) => `$${n.toFixed(2)}`;
const gate = (kind: GateKind, label: string, args: Record<string, any> = {}, cost?: number): Ask => ({ kind, label, args, ...(cost !== undefined ? { usd: cost } : {}), state: 'open' });
const bad = (l: { ok: boolean; label: string; detail?: string }[]) => l.filter((c) => !c.ok);
const CAP = 9;
const NAME: Record<StageId, string> = { story: 'Story', script: 'Script', cast: 'Cast', screens: 'Screens', storyboard: 'Storyboard', render: 'Render', review: 'The check of the parts', edit: 'The cut', cover: 'Cover', package: 'Captions', schedule: 'Schedule' };
const STARTED: Partial<Record<StageId, string>> = { story: 'Thinking up four stories', script: 'Building the script', cast: 'Building the cast', screens: 'Drawing the screens', storyboard: 'Building the storyboard and asking TopView for the price (free)', render: 'Rendering: Part 2 first, then Part 1', review: 'Checking both parts', edit: 'Making the cut', cover: 'Pulling cover frames from the cut', package: 'Writing the captions' };

/** What a step says when it starts, waits or stops. */
function announce(id: string, stage: StageId, what: 'started' | 'needs' | 'failed') {
  const e = getEpisode(id);
  if (!e) return;
  if (what === 'started') { if (STARTED[stage]) setTimeout(() => { try { if (getEpisode(id)) post(id, STARTED[stage]!, { step: true }); } catch { /* deleted */ } }, 40); return; } // after the answer that started it
  if (what === 'failed') {
    post(id, `**${NAME[stage]} stopped.** ${e.stages[stage].error ?? ''}\n\nReply **again** to go on from here, or tell me what to do.`, { error: true, proposals: [gate('again', `${NAME[stage]} again`, { stage })] });
    return;
  }
  const s = e.script, m = money(e);
  switch (stage) {
    case 'story':
      post(id, `**Four stories are ready.** They are on the Story tab.\n\n${e.story.options.map((o, i) => `${i + 1}. **${o.title}** (${o.trade}): “${o.hookLine}”`).join('\n')}\n\nReply with a **number** and I build the script, or tell me your own story.`, { proposals: [gate('story', 'Pick a story')] });
      return;
    case 'script': {
      const no = bad(e.checks), hard = musts(e.checks);
      post(id, `**The script is ready:** “${s!.title}”, ${s!.parts.reduce((a, p) => a + p.shots.length, 0)} shots. Search phrase: **${s!.keywords.primary}**. ${no.length ? `Rules not met: ${no.map((c) => c.label).join('; ')}.` : `All ${e.checks.length} series rules are met.`}\n\nReply **approve** and I build the cast (about $0.04 for each new picture; the episode’s limit is ${usd(e.capUsd || CAP)}, and I ask before every render), or tell me what to change. Add **AI yes** if one of your AI Employees really does what the ${s!.aiEmployee.name} AI Employee does here.`, { proposals: [gate('script', hard.length ? 'Approve the script anyway' : 'Approve the script')] });
      return;
    }
    case 'cast':
      post(id, `**The cast is ready:** ${e.cast.map((c) => c.name).join(', ')}. Pictures and voices are on the Cast tab.\n\nReply **approve** and I draw the screens and build the storyboard with its price (free), or tell me who to change.`, { proposals: [gate('cast', 'Approve the cast')] });
      return;
    case 'storyboard': {
      const q = e.storyboard?.quoteUsd ?? null, no = musts(e.storyboard?.checks ?? []);
      if (no.length) { post(id, `**The storyboard needs a change first:** ${no.map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}. Tell me to fix it.`); return; }
      if (q === null) { post(id, '**The storyboard is ready, without a price:** TopView has no key here yet. Add it in Connections, then reply **again**.', { proposals: [gate('again', 'Storyboard again', { stage: 'storyboard' })] }); return; }
      if (q > left(e) + 0.005) { post(id, `**The storyboard is ready, but rendering costs up to ${usd(q)}** and ${m}. Tell me a higher limit for this episode, for example “limit $12”.`); return; }
      post(id, `**The storyboard and the screens are ready.** Rendering both parts costs **up to ${usd(q)}**${e.storyboard?.usualUsd ? ` (usually about ${usd(e.storyboard.usualUsd)})` : ''}; ${m}.\n\nReply **approve** to render, or tell me what to change.`, { proposals: [gate('storyboard', `Render both parts, up to ${usd(q)}`, {}, q)] });
      return;
    }
    case 'review': {
      const notes = e.review.flatMap((r, i) => (r?.notes ?? []).filter((n) => !n.startsWith('[')).map((n) => `Part ${i + 1}, ${n.charAt(0).toLowerCase()}${n.slice(1)}`));
      // after a first cut only a change comes through here, and the new cut says so itself
      if (!e.edit.version || e.stages.review.error) post(id, `**Both parts are checked.** ${notes.length ? `Worth a look:\n${notes.slice(0, 10).map((n) => `- ${n}`).join('\n')}` : 'Nothing odd was noticed.'}${e.stages.review.error ? `\n\n${e.stages.review.error}` : ''}`, { step: !notes.length && !e.stages.review.error });
      // No separate approval here: the owner decides on the final cut.
      setTimeout(() => { try { if (!conversing(id) && !isRunning(id) && getEpisode(id)?.stages.review.status === 'needs_you') approve(id, 'review', { words: 'Checked by itself; decided on the final cut' }); } catch { /* something else started */ } }, 400);
      return;
    }
    case 'edit': {
      const no = bad(e.edit.checks);
      post(id, `**The final cut is ready:** version ${e.edit.version}, ${e.edit.seconds?.toFixed(1)} s, ${e.edit.lufs} LUFS. ${no.length ? `Not met: ${no.map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}.` : 'Every check is met.'}\n\nWatch it on the Render tab. Reply **approve** and I pull the covers, or tell me any edit: a shot, a line or a time like 0:41.`, { proposals: [gate('cut', musts(e.edit.checks).length ? `Approve cut v${e.edit.version} anyway` : `Approve cut v${e.edit.version}`, { version: e.edit.version })] });
      return;
    }
    case 'cover':
      post(id, `**${e.cover.candidates.length} cover frames are ready** on the Cover tab, numbered 1 to ${e.cover.candidates.length}.\n\nReply with a **number** and I write the captions, or give a time in the cut for another frame.`, { proposals: [gate('cover', 'Pick a cover')] });
      return;
    case 'package': {
      const p = e.pack, no = bad(p?.checks ?? []), sl = p?.slot ? slotLabel(p.slot) : null;
      post(id, `**The captions are ready** on the Cover tab${sl ? `, for ${sl.label} (${sl.us})` : ''}, on ${(p?.platforms ?? []).join(', ') || 'no platform yet'}. ${no.length ? `Not met: ${no.map((c) => c.label).join('; ')}.` : 'Every check is met.'}\n\nReply **approve**, or tell me what to change (wording, slot or platforms).`, { proposals: [gate('captions', `Approve the captions${sl ? ` for ${sl.label}` : ''}`)] });
      return;
    }
    case 'schedule': {
      const p = e.pack, sl = p?.slot ? slotLabel(p.slot) : null;
      if (!p || !sl) return;
      const tell = post;
      setTimeout(() => tell(id, `**Everything is approved.** Nothing is scheduled yet.\n\nReply **schedule** and I schedule it for ${sl.label} on ${p.platforms.filter((k) => k !== 'whatsapp').join(', ')} (nothing is published now).${p.platforms.includes('whatsapp') ? ' WhatsApp Status stays with you; its video and caption are in the pack.' : ''} Reply **I’ll do it** to schedule it yourself.`, { proposals: [gate('schedule', `Schedule for ${sl.label}`)] }), 60);
      return;
    }
    default: return;
  }
}
flow.on = announce;
/** An episode from before this thread, or one whose question was lost: its step asks (again). */
export function ensureAsk(id: string) {
  const e = getEpisode(id);
  if (!e || isRunning(id) || (e.stages.schedule.status === 'needs_you' && e.schedule.method)) return;
  const s = STAGES.find((k) => ['needs_you', 'failed'].includes(e.stages[k].status));
  if (!s) return;
  const p = post;
  post = (i, t, d = {}) => p(i, t, { ...d, once: true });
  try { announce(id, s, e.stages[s].status === 'failed' ? 'failed' : 'needs'); } finally { post = p; }
}
const money = (e: Episode) => `${usd(spent(e))} of ${usd(e.capUsd)} is spent`;

// ---------- the owner's reply ----------
const YES = new Set('yes y yep yeah yup ok okay sure approve approved approving go build make render start schedule continue proceed do confirm confirmed good perfect great haan han ji next again retry retake'.split(' '));
const NO = new Set('no nope nah skip cancel later'.split(' '));
const FILL = new Set('please the it and then now ahead script cast cut final story stories option number cover frame pick choose use take with for me captions caption to all both parts part storyboard looks look fine that this them of is a i ll lets let s screens theek hai sab thanks thank you zubi anyway'.split(' '));
const WORDS: Record<string, string> = { first: '1', second: '2', third: '3', fourth: '4', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8' };
export interface Reply { yes: number[]; no: number[]; pick?: number; ai?: 'yes' | 'later'; self?: boolean; unclear?: string }
/** A short reply that can only mean one thing; null = it needs reading. */
export function readReply(text: string, asks: Ask[]): Reply | null {
  let t = text.trim().toLowerCase().replace(/[’']/g, '').replace(/[“”"*_]/g, ' ');
  if (!asks.length || t.length > 120 || t.includes('?')) return null;
  let ai: Reply['ai'];
  t = t.replace(/\bai(?: employees?)?\s*[:=,]?\s*(yes|confirmed|real|no|later|not yet)\b/g, (_m, x) => { ai = /yes|confirmed|real/.test(x) ? 'yes' : 'later'; return ' '; });
  if (/\b(ill|i will) do it( myself)?\b|\bmyself\b/.test(t) && asks.some((a) => a.kind === 'schedule')) return { yes: [], no: [], self: true };
  const tok = t.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).map((w) => WORDS[w] ?? w), nums = tok.filter((w) => /^\d{1,2}$/.test(w)).map(Number), rest = tok.filter((w) => !/^\d{1,2}$/.test(w));
  if (rest.length && rest.every((w) => NO.has(w) || w === 'thanks' || w === 'now' || w === 'not' || w === 'yet')) return nums.length ? null : { yes: [], no: asks.map((_, i) => i) };
  if (rest.some((w) => !YES.has(w) && !FILL.has(w))) return null;
  const agreed = rest.some((w) => YES.has(w)), one = asks.length === 1 ? asks[0] : null;
  if (one && (one.kind === 'story' || one.kind === 'cover')) return nums.length === 1 ? { yes: [0], no: [], pick: nums[0], ai } : agreed ? { yes: [], no: [], unclear: one.kind === 'story' ? 'Which story? Reply with its number, 1 to 4.' : 'Which cover? Reply with its number.' } : null;
  if (nums.length && asks.length > 1) return nums.every((n) => n >= 1 && n <= asks.length) ? { yes: [...new Set(nums)].map((n) => n - 1), no: [], ai } : null;
  if (nums.length) return null;
  if (one) return agreed || ai === 'yes' ? (agreed ? { yes: [0], no: [], ai } : null) : null;
  if (!agreed && !rest.includes('all')) return null;
  if (rest.includes('all') || rest.includes('both') || asks.every((a) => !a.usd)) return { yes: asks.map((_, i) => i), no: [], ai };
  return { yes: [], no: [], unclear: `Which ones? Reply with the numbers, or **all** (${usd(asks.reduce((a, x) => a + (x.usd ?? 0), 0))} at most).` };
}
/** Does the owner's own message say yes? A question, or a message without any yes in it, never approves anything. */
export function agreed(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[’']/g, '');
  if (t.endsWith('?') || /\b(should i|shall i|can i|could you|dont|do not|not yet|wait|hold|stop|dont approve|before i)\b/.test(t)) return false;
  return /\b(yes|yep|yeah|ok|okay|sure|approve[ds]?|go ahead|go|do it|build|make|render|start|schedule|continue|proceed|confirm(ed)?|pick|choose|use|take|story \d|option \d|cover \d|again|retry|haan)\b/.test(t);
}

/** Carries one decision out. Anything priced is priced again first and refused when it went up. */
export async function carryOut(id: string, a: Ask, x: { pick?: number; custom?: string; ai?: 'yes' | 'later'; words?: string } = {}): Promise<string> {
  const e = getEpisode(id)!, words = x.words ? `“${x.words.slice(0, 120)}” (Zubi window)` : '';
  if (isRunning(id)) throw new ReelError(`${NAME[isRunning(id)!]} is still working. I’ll take your answer when it is done.`);
  switch (a.kind as GateKind) {
    case 'story': {
      if (x.custom) { approve(id, 'story', { custom: x.custom, words }); return 'Your own story.'; }
      const o = e.story.options[(x.pick ?? 0) - 1];
      if (!o) throw new ReelError('Which story? Reply with its number, 1 to 4.');
      approve(id, 'story', { pick: (x.pick ?? 0) - 1, words: `Story ${x.pick}: ${o.title}${words ? `. ${words}` : ''}` });
      return `Story ${x.pick}: “${o.title}”.`;
    }
    case 'script': approve(id, 'script', { capUsd: e.capUsd || CAP, aiEmployee: x.ai ?? e.aiConfirmed ?? 'later', anyway: true, words: `Script approved, limit ${usd(e.capUsd || CAP)}${words ? `. ${words}` : ''}` }); return `The script is approved${x.ai === 'yes' ? ', and your AI Employee is confirmed' : ''}.`;
    case 'cast': approve(id, 'cast', { words: `Cast approved${words ? `. ${words}` : ''}` }); return 'The cast is approved.';
    case 'storyboard': approve(id, 'storyboard', { confirmUsd: (a.usd ?? 0) + 0.005, words: `Render both parts, up to ${usd(a.usd ?? 0)}${words ? `. ${words}` : ''}` }); return `Approved: up to ${usd(a.usd ?? 0)}.`;
    case 'cut': {
      if (e.stages.edit.status !== 'needs_you') throw new ReelError('The cut is being made again with your change. I ask when it is ready to watch.');
      if (e.edit.version !== a.args.version) throw new ReelError(`The cut is version ${e.edit.version} now. Watch it, then reply again.`);
      approve(id, 'edit', { anyway: true, words: `Cut v${e.edit.version} approved${words ? `. ${words}` : ''}` });
      return `Cut version ${e.edit.version} is approved.`;
    }
    case 'cover': {
      const c = e.cover.candidates[(x.pick ?? 0) - 1];
      if (!c) throw new ReelError(`Which cover? Reply with a number from 1 to ${e.cover.candidates.length}.`);
      approve(id, 'cover', { file: c.file, words: `Cover ${x.pick} (${c.t.toFixed(1)} s)${words ? `. ${words}` : ''}` });
      return `Cover ${x.pick} it is.`;
    }
    case 'captions': approve(id, 'package', { words: `Captions approved for ${String(e.pack?.slot ?? '').replace('T', ' ')} IST${words ? `. ${words}` : ''}` }); return 'The captions are approved and the publish pack is made.';
    case 'schedule': return askSchedule(id, x.words ?? '');
    case 'again': await start(id, a.args.stage as StageId); return '';
    default: throw new ReelError('That isn’t here any more.');
  }
}

/** The owner asks Zubi to schedule the approved pack. It is a message to Zubi with the files; nothing is published now. */
export function askSchedule(id: string, words: string): string {
  const e = getEpisode(id)!, p = e.pack;
  if (!p?.slot || !p.folder || e.stages.package.status !== 'done') throw new ReelError('Approve the captions first.');
  // WhatsApp Status is the owner's own phone: it is prepared here, never sent from here.
  const ask = p.platforms.filter((k) => k !== 'whatsapp' && !['scheduled', 'live'].includes(e.schedule.results[k]?.status ?? ''));
  if (!ask.length) throw new ReelError('There is nothing left for Zubi to schedule.');
  if (istToMs(p.slot) < Date.now() + 25 * 60_000) throw new ReelError('That slot is too close or past. Tell me another one.');
  const zubi = primaryBotId();
  if (!zubi) throw new ReelError('The main team member isn’t set up.');
  // A copy Zubi's own computer can open.
  const name = path.basename(p.folder), dest = path.join(env.hermesHome, 'social', name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(epFile(e, p.folder), dest, { recursive: true });
  giveToHermes(path.dirname(dest));
  const l = slotLabel(p.slot);
  appendRow(zubi, 'message', { type: 'message', role: 'user', text: `Schedule Episode ${e.num}, “${e.title}”, for ${l.label} on ${ask.join(', ')}.` });
  enqueue(zubi, {
    type: 'user',
    text: `[Approved in Reels Factory by ${ownerName(id)}] Schedule Episode ${e.num} “${e.title}” for ${l.label} (${l.us}) on: ${ask.join(', ')}. Schedule only; publish nothing now, and nothing else. First look at the Instagram calendar: if that slot already has a post, stop and say so. Files: ${dest} (reel-v1.mp4, cover.jpg, caption-us-ig.txt, caption-us-fb.txt, youtube.txt, alt-text.txt, keywords.json). Use the files' text exactly.\n- Instagram (Meta Business Suite or instagram.com in your browser): crop Original, the cover as cover.jpg, AI label ON, auto captions off, “Share to” empty. Read the caption back before pressing Schedule, and afterwards check the calendar shows it exactly once.\n- Facebook Page only: the same time, caption-us-fb.txt, thumbnail cover.jpg, the tags in keywords.json in the Tags field when creating it. Check the copyright check passed and the Scheduled list shows it once.\n- YouTube Shorts (Studio): title, description and tags from youtube.txt, thumbnail cover.jpg, AI use Yes, not made for kids, category Education,${series().youtubePlaylist ? ` playlist “${series().youtubePlaylist}”,` : ''} scheduled to go public at the same time (India time). Open the saved page and check the title, description, tags and AI use. Do not post any comment.\nBefore pressing Schedule, check the account is ${series().handle}. If you are not signed in somewhere, stop and tell the owner to sign in on your screen: never enter a password or code. After each one is confirmed on screen, call reel_schedule_report for it. If something blocks one, report it as failed with the reason and do the others.`,
  });
  patch(id, (x) => { x.schedule.method = 'zubi'; x.schedule.askedAt = now(); x.stages.schedule.status = 'needs_you'; for (const k of ask) x.schedule.results[k] = { status: 'asked', at: now() }; });
  log(id, 'schedule', 'approve', `Asked ${getBotRow(zubi)?.name ?? 'Zubi'} to schedule ${ask.join(', ')} for ${l.label}${words ? `. “${words.slice(0, 120)}”` : ''}`);
  return `Asked for ${ask.join(', ')}, ${l.label}. I report each platform here when it is done.`;
}
const ownerName = (id: string) => String((db.prepare('SELECT name FROM users WHERE id=?').get(ownerOf(id) ?? '') as any)?.name ?? 'the owner');

export function markSchedule(id: string, platform: string, status: string, link: string, note: string, by: string) {
  const e = getEpisode(id);
  if (!e?.pack?.platforms.includes(platform)) throw new ReelError('That platform isn’t part of this episode.');
  if (!['scheduled', 'live', 'failed', 'asked'].includes(status)) throw new ReelError('Status is scheduled, live or failed.');
  const url = /^https:\/\/[^\s<>"]+$/.test(link) ? link : undefined;
  patch(id, (x) => {
    x.schedule.results[platform] = { status: status as any, ...(url ? { link: url } : {}), ...(note ? { note } : {}), at: now() };
    const all = x.pack!.platforms.every((k) => ['scheduled', 'live'].includes(x.schedule.results[k]?.status ?? ''));
    x.stages.schedule.status = all ? 'done' : 'needs_you';
    if (all) { x.stages.schedule.endedAt = now(); x.stages.schedule.approvedAt = now(); x.stages.schedule.approval = 'Scheduled everywhere'; }
  });
  log(id, 'schedule', status === 'failed' ? 'error' : 'info', `${platform}: ${status} (${by})${url ? ` ${url}` : ''}${note ? `. ${note}` : ''}`);
  if (by !== 'you') post(id, status === 'failed' ? `**${platform}: not scheduled.** ${note}` : `**${platform}: ${status}.**${url ? ` ${url}` : ''}${note ? ` ${note}` : ''}`, status === 'failed' ? { error: true } : {});
}

/** After a free change: whatever is out of date and can be made again for free is made again by itself. */
export function settle(id: string) {
  const e = getEpisode(id);
  if (!e || isRunning(id) || e.render.parts.some((p) => p.picked === null)) return;
  const go = (s: StageId) => void start(id, s).catch(() => {});
  if (e.stages.review.status === 'needs_you') { try { approve(id, 'review', { words: 'Checked by itself; decided on the final cut' }); } catch { /* busy */ } }
  else if (['stale', 'ready'].includes(e.stages.review.status)) go('review');
  else if (e.stages.review.status === 'done' && ['stale', 'ready'].includes(e.stages.edit.status)) go('edit');
}
