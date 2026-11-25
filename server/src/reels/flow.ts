// The flow in words: every step tells its result and asks its question in the Zubi window, and the owner's reply there is
// the decision. A plain reply ("2", "approve", "yes to all") is understood here, by rule; anything longer goes to Zubi, and
// even then a decision only counts when the owner's own message says it (agreed), after the question and its price were shown.
import { db, now } from '../db.js';
import { musts } from './checks.js';
import { openForSignIn, PLATFORMS, postAll, postingBusy, signedIn, TITLE, type Platform } from './poster.js';
import { approve, flow, hold, isRunning, left, release, start } from './stages.js';
import { allEpisodes, getEpisode, istToMs, log, patch, ReelError, slotLabel, spent } from './store.js';
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
      const tell = post, off = Object.entries(e.schedule.results).filter(([, r]) => r.status === 'failed').map(([k]) => k), on = signedIn();
      if (off.length) {
        const need = PLATFORMS.filter((k) => off.includes(k) && !on[k]).map((k) => TITLE[k]);
        setTimeout(() => tell(id, `**Not scheduled yet: ${off.join(', ')}.**${need.length ? ` First: the posting browser on Hermes isn’t signed in to ${need.join(', ')}. Say **sign in** and it opens on my screen; you sign in there yourself.` : ''}\n\nReply **schedule** and I try again for ${sl.label}, or **test schedule** to fill everything in without pressing Schedule.`, { proposals: [gate('schedule', `Schedule ${off.join(', ')} for ${sl.label}`)] }), 60);
        return;
      }
      setTimeout(() => tell(id, `**Everything is approved.** Nothing is scheduled yet.\n\nReply **schedule** and I schedule it for ${sl.label} on ${p.platforms.filter((k) => k !== 'whatsapp').join(', ')} (nothing is published now)${p.platforms.includes('whatsapp') ? ', and I post the WhatsApp Status myself at that time' : ''}. Reply **I’ll do it** to schedule it yourself.`, { proposals: [gate('schedule', `Schedule for ${sl.label}`)] }), 60);
      return;
    }
    default: return;
  }
}
flow.on = announce;
/** An episode from before this thread, or one whose question was lost: its step asks (again). */
export function ensureAsk(id: string) {
  const e = getEpisode(id);
  if (!e || isRunning(id) || (e.stages.schedule.status === 'needs_you' && e.schedule.method && (e.schedule.method === 'self' || !Object.values(e.schedule.results).some((r) => r.status === 'failed')))) return;
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

/** The owner said to schedule the approved pack: HeyZubi does it on the box, in its own Chrome (poster.ts). Nothing is published now. */
export function askSchedule(id: string, words: string, dry = false): string {
  const e = getEpisode(id)!, p = e.pack;
  if (!p?.slot || !p.folder || e.stages.package.status !== 'done') throw new ReelError('Approve the captions first.');
  // WhatsApp Status is the owner's own phone: it is prepared here, never sent from here.
  const on = signedIn();
  let ask = PLATFORMS.filter((k) => p.platforms.includes(k) && !['scheduled', 'live'].includes(e.schedule.results[k]?.status ?? ''));
  if (!ask.length) throw new ReelError('There is nothing left to schedule.');
  if (istToMs(p.slot) < Date.now() + 45 * 60_000) throw new ReelError('That slot is too close or past. Tell me another one.');
  const off = ask.filter((k) => !on[k]).map((k) => TITLE[k]);
  const wa = ask.includes('whatsapp') && on.whatsapp;
  if (dry && off.length < ask.length) ask = ask.filter((k) => on[k]); // what is signed in is tried
  else if (off.length) throw new ReelError(`The posting browser on Hermes isn’t signed in to ${off.join(', ')} yet, so nothing was started. Say “sign in”: it opens on my screen and you sign in there yourself. Then say “schedule” again.`);
  if (!dry) ask = ask.filter((k) => k !== 'whatsapp'); // posted at its time, not now
  const signal = hold(id, 'schedule'), l = slotLabel(p.slot);
  const state = (fn: (x: Episode) => void) => patch(id, (x) => { x.stages.schedule.status = 'running'; fn(x); });
  state((x) => { x.stages.schedule.progress = 'Starting'; if (dry) return; x.schedule.method = 'heyzubi'; x.schedule.askedAt = now(); for (const k of ask) x.schedule.results[k] = { status: 'asked', at: now() }; if (wa) x.schedule.results.whatsapp = { status: 'scheduled', due: p.slot!, at: now(), note: `HeyZubi posts it to My Status at ${slotLabel(p.slot!).label}.` }; });
  log(id, 'schedule', dry ? 'run' : 'approve', `${dry ? 'Trying out' : 'Scheduling'} ${ask.join(', ')} for ${l.label}${words ? `. “${words.slice(0, 120)}”` : ''}`);
  void (async () => {
    const told = new Set<string>();
    try {
      await postAll(getEpisode(id)!, ask, {
        signal, dry, say: (t) => state((x) => { x.stages.schedule.progress = t; }),
        done: (k: Platform, r) => {
          told.add(k);
          if (dry) post(id, 'error' in r ? `**${TITLE[k]}: the try stopped.** ${r.error}` : `**${TITLE[k]}: ready.** ${r.note}`, { ...('error' in r ? { error: true } : {}), images: r.shot ? [r.shot] : [] });
          else if ('error' in r) markSchedule(id, k, 'failed', '', r.error, 'HeyZubi', r.shot ? [r.shot] : []);
          else markSchedule(id, k, 'scheduled', r.link ?? '', r.note, 'HeyZubi');
          state(() => {});
        },
      });
    } catch (err) {
      const m = err instanceof ReelError ? err.message : 'Something went wrong.';
      if (!(err instanceof ReelError)) console.warn('[reels] schedule:', err);
      if (dry) post(id, m, { error: true }); else for (const k of ask) if (!told.has(k)) markSchedule(id, k, 'failed', '', m, 'HeyZubi');
    } finally {
      if (!dry && wa) post(id, `**WhatsApp Status: waiting for its time.** I post it to My Status at ${l.label}, after one more check.`);
      release(id);
      try {
        patch(id, (x) => {
          delete x.stages.schedule.progress;
          if (!dry) for (const k of ask) if (x.schedule.results[k]?.status === 'asked') x.schedule.results[k] = { status: 'failed', note: 'Stopped before its turn.', at: now() };
          x.stages.schedule.status = x.pack!.platforms.every((k) => ['scheduled', 'live'].includes(x.schedule.results[k]?.status ?? '')) ? 'done' : 'needs_you';
        });
        if (!dry && Object.values(getEpisode(id)!.schedule.results).some((r) => r.status === 'failed')) announce(id, 'schedule', 'needs');
      } catch { /* the episode was deleted */ }
    }
  })();
  if (!ask.length) return `WhatsApp Status: I post it to My Status at ${l.label}.`;
  return dry ? `Trying it out on ${ask.join(', ')}: everything is filled in and checked, and Schedule is not pressed.` : `Scheduling ${ask.join(', ')} for ${l.label}, one after the other. I report each one here.`;
}
/** Opens the posting browser on the team member's screen, at the first account that still needs a sign-in. */
/** WhatsApp has no scheduler: HeyZubi posts each waiting Status when its time comes (from 2 minutes before to an hour after). */
export function initStatusPosts() {
  const tick = () => {
    if (postingBusy()) return;
    for (const e of allEpisodes()) {
      const r = e.schedule.results.whatsapp;
      if (!r || r.status !== 'scheduled' || !r.due || isRunning(e.id)) continue;
      if (r.sending) { patch(e.id, (x) => { x.schedule.results.whatsapp = { status: 'failed', at: now(), note: 'HeyZubi stopped while this was being sent. It is not sent again: look at My status on your phone.' }; }); continue; }
      const late = (Date.now() - istToMs(r.due)) / 60_000;
      if (late < -2) continue;
      if (late > 60) { markSchedule(e.id, 'whatsapp', 'failed', '', `Its time (${slotLabel(r.due).label}) passed more than an hour ago while HeyZubi couldn’t post it. Nothing was sent.`, 'HeyZubi'); continue; }
      let signal: AbortSignal;
      try { signal = hold(e.id, 'schedule'); } catch { continue; }
      void postAll(e, ['whatsapp'], {
        signal, say: () => {}, sending: () => patch(e.id, (x) => { if (x.schedule.results.whatsapp) x.schedule.results.whatsapp.sending = true; }),
        done: (_k, res) => { if ('error' in res) markSchedule(e.id, 'whatsapp', 'failed', '', res.error, 'HeyZubi'); else markSchedule(e.id, 'whatsapp', 'live', '', res.note, 'HeyZubi', res.shot ? [res.shot] : []); },
      }).catch((err) => markSchedule(e.id, 'whatsapp', 'failed', '', (err as Error).message, 'HeyZubi')).finally(() => release(e.id));
      return; // one at a time
    }
  };
  setInterval(() => { try { tick(); } catch (err) { console.warn('[reels] status:', (err as Error).message); } }, 30_000).unref();
}
export async function askSignIn(want?: Platform): Promise<string> {
  const on = signedIn(), p = want ?? PLATFORMS.find((k) => !on[k]);
  if (!p) return 'Instagram, Facebook, YouTube and WhatsApp are all signed in on the posting browser. Say “schedule” when you want.';
  await openForSignIn(p);
  return `The posting browser is open on my screen at ${TITLE[p]}. Open my screen, take control and ${p === 'whatsapp' ? 'scan the code with WhatsApp on your phone (Settings › Linked devices › Link a device)' : 'sign in yourself (I never type passwords or codes)'}. ${PLATFORMS.filter((k) => !on[k]).length > 1 ? 'Say “sign in” again for the next one. ' : ''}It takes about half a minute until I can see a sign-in.`;
}

export function markSchedule(id: string, platform: string, status: string, link: string, note: string, by: string, images: string[] = []) {
  const e = getEpisode(id);
  if (!e?.pack?.platforms.includes(platform)) throw new ReelError('That platform isn’t part of this episode.');
  if (!['scheduled', 'live', 'failed', 'asked'].includes(status)) throw new ReelError('Status is scheduled, live or failed.');
  const url = /^https:\/\/[^\s<>"]+$/.test(link) ? link : undefined;
  patch(id, (x) => {
    x.schedule.results[platform] = { status: status as any, ...(url ? { link: url } : {}), ...(note ? { note } : {}), at: now() };
    if (platform === 'whatsapp') delete x.schedule.results.whatsapp?.sending;
    const all = x.pack!.platforms.every((k) => ['scheduled', 'live'].includes(x.schedule.results[k]?.status ?? ''));
    x.stages.schedule.status = all ? 'done' : 'needs_you';
    if (all) { x.stages.schedule.endedAt = now(); x.stages.schedule.approvedAt = now(); x.stages.schedule.approval = 'Scheduled everywhere'; }
  });
  log(id, 'schedule', status === 'failed' ? 'error' : 'info', `${platform}: ${status} (${by})${url ? ` ${url}` : ''}${note ? `. ${note}` : ''}`);
  if (by !== 'you') post(id, status === 'failed' ? `**${platform}: not scheduled.** ${note}` : `**${platform}: ${status}.**${url ? ` ${url}` : ''}${note ? ` ${note}` : ''}`, status === 'failed' ? { error: true, images } : {});
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
