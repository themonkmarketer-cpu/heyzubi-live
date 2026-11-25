// The pipeline: what each stage does, what it waits for, what the owner decides, and what becomes out of date when
// something before it changes. Nothing that costs money or leaves the app happens without the owner's own click.
import fs from 'node:fs';
import path from 'node:path';
import { now } from '../db.js';
import { musts, packChecks, promptChecks, scriptChecks, spoken } from './checks.js';
import { applyCut, buildStudioEdit, currentSig, studioReady } from './studio.js';
import { buildEdit, coverScan, coverStills, partFile, reviewPart, shotStarts } from './edit.js';
import { ffmpeg, probe, py } from './media.js';
import { download, kieSubmit, kieWait, MODEL_IMAGE, MODEL_VIDEO, ProviderError, speak, tvQuote, tvSubmit, tvUpload, tvWait } from './providers.js';
import { buildPrompt, imageBody, leadKey, named, refsFor, retakeBody, videoBody, videoKey, type PartRefs } from './prompts.js';
import { buildScreens } from './screens.js';
import { allEpisodes, ensureDir, epDir, epFile, formula, getEpisode, getKey, listEpisodes, log, ownerOf, patch, ReelError, series, seriesDir, seriesText, slots, spent } from './store.js';
import { STAGES, type CastMember, type Episode, type PartReview, type RenderVersion, type Script, type StageId, type StoryOption } from './types.js';
import { askJson, autocomplete } from './writer.js';

const running = new Map<string, { stage: StageId; ctrl: AbortController }>();
/** Told when a step starts, waits for the owner or stops (flow.ts puts it in the Zubi window). */
export const flow: { on: (id: string, stage: StageId, what: 'started' | 'needs' | 'failed') => void } = { on: () => {} };
const tell = (id: string, stage: StageId, what: 'started' | 'needs' | 'failed') => { try { flow.on(id, stage, what); } catch (e) { console.warn('[reels] thread:', (e as Error).message); } };
export const isRunning = (id: string) => running.get(id)?.stage ?? null;
const idx = (s: StageId) => STAGES.indexOf(s);
const say = (id: string, stage: StageId, t: string) => patch(id, (e) => { e.stages[stage].progress = t; });

/** Everything after a stage that had finished is out of date now; the next one can run. */
function cascade(e: Episode, from: StageId) {
  for (const s of STAGES.slice(idx(from) + 1)) { const st = e.stages[s]; if (['done', 'needs_you', 'failed'].includes(st.status)) { st.status = 'stale'; delete st.approvedAt; delete st.approval; } }
}
function openNext(e: Episode, after: StageId) {
  const n = STAGES[idx(after) + 1];
  if (n && (e.stages[n].status === 'idle')) e.stages[n].status = 'ready';
}
export function finish(id: string, stage: StageId, approval?: string) {
  patch(id, (e) => { const st = e.stages[stage]; st.status = 'done'; st.endedAt = now(); delete st.progress; delete st.error; if (approval) { st.approvedAt = now(); st.approval = approval.slice(0, 300); } openNext(e, stage); });
  if (approval) log(id, stage, 'approve', approval);
  const e = getEpisode(id)!;
  const n = STAGES[idx(stage) + 1];
  if (n && ['ready', 'stale'].includes(e.stages[n].status) && n !== 'schedule') void start(id, n).catch(() => {});
  if (n === 'schedule') { patch(id, (x) => { if (['ready', 'idle', 'stale'].includes(x.stages.schedule.status)) x.stages.schedule.status = 'needs_you'; }); tell(id, 'schedule', 'needs'); }
}
const needYou = (id: string, stage: StageId) => { patch(id, (e) => { e.stages[stage].status = 'needs_you'; e.stages[stage].endedAt = now(); delete e.stages[stage].progress; delete e.stages[stage].error; }); tell(id, stage, 'needs'); };

/** Why a stage can't start now, or ''. */
export function blocked(e: Episode, stage: StageId): string {
  if (running.has(e.id)) return `The ${running.get(e.id)!.stage} stage is working.`;
  const prev = STAGES[idx(stage) - 1];
  if (!prev) return '';
  if (stage === 'review' && e.render.parts.every((p) => p.picked !== null)) return '';
  if (e.stages[prev].status !== 'done') return `Finish the ${prev} stage first.`;
  return '';
}

export async function start(id: string, stage: StageId, opts: Record<string, any> = {}): Promise<void> {
  const e = getEpisode(id);
  if (!e) throw new ReelError('That episode is gone.');
  const why = blocked(e, stage);
  if (why) throw new ReelError(why);
  const run = RUN[stage];
  if (!run) throw new ReelError('That stage has nothing to run.');
  const ctrl = new AbortController();
  running.set(id, { stage, ctrl });
  patch(id, (x) => { cascade(x, stage); const st = x.stages[stage]; st.status = 'running'; st.startedAt = now(); st.progress = 'Starting'; delete st.error; delete st.endedAt; delete st.approvedAt; delete st.approval; });
  log(id, stage, 'run', 'Started');
  tell(id, stage, 'started');
  void (async () => {
    let done = false;
    try { done = await run(id, ctrl.signal, opts); }
    catch (err) {
      const m = err instanceof ReelError || err instanceof ProviderError ? err.message : `Something went wrong (${String((err as Error)?.message ?? err).slice(0, 160)}).`;
      if (!(err instanceof ReelError || err instanceof ProviderError)) console.warn('[reels]', stage, err);
      try { patch(id, (x) => { const st = x.stages[stage]; st.status = 'failed'; st.error = m; st.endedAt = now(); delete st.progress; }); log(id, stage, 'error', m); tell(id, stage, 'failed'); } catch { /* the episode was deleted */ }
      return;
    } finally { running.delete(id); }
    try { if (done) finish(id, stage); else needYou(id, stage); } catch { /* deleted */ }
  })();
}
/** Work that isn't a step's own run (scheduling) holds the episode the same way: nothing else changes it meanwhile. */
export function hold(id: string, stage: StageId): AbortSignal {
  if (running.has(id)) throw new ReelError(`The ${running.get(id)!.stage} stage is working.`);
  const ctrl = new AbortController();
  running.set(id, { stage, ctrl });
  return ctrl.signal;
}
export const release = (id: string) => { running.delete(id); };
export function stop(id: string): boolean { const r = running.get(id); if (!r) return false; r.ctrl.abort(); return true; }

// ---------- writing ----------
const RULES = () => ['foundation.md', 'characters.md', 'rules.md'].map((f) => seriesText(f)).filter(Boolean).join('\n\n---\n\n');
const pastList = () => series().history.map((h) => `Ep ${h.num} “${h.title}”: ${h.trade}; AI Employee ${h.aiEmployee}; cast ${h.cast.join(', ')}; hook: ${h.hook.join(' / ')}`).join('\n');
const HEAD = () => `You are the head writer of the cartoon reel series “${series().name}” (${series().handle}). You write for US small-business owners. The series bible below is binding; where it disagrees with your instinct, the bible wins. Never invent abilities for an AI Employee: it only does what a texting or Telegram assistant really can (text the shop's own customers, read a list the owner gave it, answer from it, remind, sort, report), and the owner approves anything risky. Original characters only, no real people, no brands.\n\n# SERIES BIBLE\n${RULES()}`;

async function runStory(id: string, signal: AbortSignal): Promise<boolean> {
  const e = getEpisode(id)!, F = formula();
  say(id, 'story', 'Thinking up four stories');
  const mine = listEpisodes(ownerOf(id)!).filter((x) => x.id !== id && x.script).map((x) => `Ep ${x.num} “${x.title}”: ${x.script!.trade}; AI Employee ${x.script!.aiEmployee.name}`).join('\n');
  const r = await askJson<{ options: StoryOption[] }>({
    instructions: HEAD(), signal, onTry: (n) => n > 1 && say(id, 'story', 'Improving the stories'),
    prompt: `Propose FOUR different stories for Episode ${e.num}. Different trades, different AI Employees. Prefer a new trade and an AI Employee the series has not shown; a returning owner is fine for one option.\nEarlier episodes (never repeat a trade+AI Employee pair, a hook or a joke):\n${pastList()}\n${mine}\n\nHook style wanted: ${e.story.hookStyle || 'any that fits; vary from the last two episodes'}.\n${e.story.brief ? `The owner's own idea, which at least the first option must follow: ${e.story.brief}\n` : ''}Today is ${new Date().toISOString().slice(0, 10)}; use the season or a US holiday when it helps.\n\n${F.storyEach}\nJSON: {"options":[{"title","who","trade","aiEmployee","problem","hookSpeaker","hookLine","secondSpeaker","secondLine","unexpected","why"} x4]}`,
    check: (v) => { const o = v?.options; const p: string[] = []; if (!Array.isArray(o) || o.length !== 4) return ['options must be exactly four']; o.forEach((x, i) => { const n = String(x.hookLine ?? '').split(/\s+/).length; if (n < 5 || n > 10) p.push(`option ${i + 1}: hookLine has ${n} words, needs 5 to 10`); if (/\d/.test(`${x.hookLine}${x.secondLine}`)) p.push(`option ${i + 1}: spell numbers out`); if (!x.title || !x.who || !x.aiEmployee || !x.unexpected) p.push(`option ${i + 1}: every field is needed`); }); return p; },
  });
  patch(id, (x) => { x.story.options = r.options; x.story.picked = null; });
  return false;
}

const SCRIPT_SHAPE = () => `{
 "title","slug" (kebab-case),"trade","logline",
 "aiEmployee":{"name" (one word),"icon" (one emoji),"color" ("#rrggbb", bright),"does":[3 rows of at most 48 characters],"howItWorks" (2 to 4 sentences, exactly what it does and what it does not)},
 "honesty" (why every claim is something a real assistant can do; which numbers are story beats),"tip" (one sentence, said by the owner in Part 2),"forward" ("Send this to the <trade> who ..."),"unexpected","runningGag","tradePhysics" (one sentence on how the trade really works, so nothing on screen is wrong),
 "keywords":{"primary" (2 to 5 words people really type),"ownerSide","secondary":[2 to 3],"evidence":[copied from the suggestions given],"facebookTags":[8],"youtubeTitle" (under 60 characters, starts with the primary phrase)},
 "location" (one paragraph describing the place, ending "No signs, logos, brand names or printed labels anywhere."),
 "cast":[ ${formula().castShape}
   {"key" (lower case first name),"name","kind":"sheet" (the owner) | "ref" (one other person who matters) | "described" (an extra),"castLine" (who they are, age, build),"lock" ("X always has ..." hair, face, clothes, phone case colour),"imagePrompt" (for sheet/ref: the full look; for ref also the place and a medium close-up with the expression),"voice":{"voiceId","voiceName","stability" 0.35 to 0.45,"similarity" 0.75,"sample" (9 to 13 words in character, about 4 seconds)},"parts":[1,2]} ],
 "parts":[ {"light","audio" (diegetic sounds only),"props" (one sentence),"time" (which shots are morning/night and what that looks like),"shots":[ 12 x {"n","start","end","camera" ("Medium close-up, 50mm, eye-level, static"),"picture" (what is seen, using @Name; a speaker's mouth is free; one action),"speaker" (cast key or ""),"delivery" (one or two words),"line" (as spoken: numbers and abbreviations spelled out),"caption" (only if its spelling on screen differs),"offscreen" (true only for a voice over a screen insert),"screen" ("s1".."s5" or ""),"clock" (${formula().clockShape}),"sound" (for a silent insert)} ]}, the same for Part 2 ],
 "screens":{"s1":{"time":"8:42","date":"Saturday, November 28","items":[2 x {"icon","from","when","text" (at most 24 characters)}],"more" (the big line under them, at most 30 characters: "90 abandoned carts, 0 orders")},"s2":{"status","rows":[3 short rows]},"s3":{"title","url" ("<Shop> · <Name> AI Employee"),"pills":[3],"rows":[3 x {"a","b" (or ""),"c" (or ""),"d"}],"last" (or null):{"a":"+9 more","b","c","d"}},"s4":{"time","day","sent":{"bold","text","at"},"result":{"bold","big","text","at"},"stats":[3 x {"label","value"}],"statsAt"},"s5":{"kind":"text"|"email" (how this AI Employee really talks to customers),"time","from","when","subject" (email only, at most 40 characters),"messages":[2 or 3 x {"side":"in"|"out","text"}] (that phone is small: at most 16 characters each, one may be a single number, with "big":true)}},
 "caption":{"line1" (the primary phrase as a question),"story" (2 to 3 sentences; names the fix as "one AI Employee (AI Agent)")},"question" (asks viewers something at the end of the comment),"altText" (one plain sentence with the primary phrase)
}`;

async function runScript(id: string, signal: AbortSignal, opts: Record<string, any>): Promise<boolean> {
  const e = getEpisode(id)!, sr = series(), F = formula(), p = e.story.picked!;
  if (!p) throw new ReelError('Pick a story first.');
  say(id, 'script', 'Checking what people search for');
  const seeds = [`${p.trade} ${p.problem.split(/\s+/).slice(0, 3).join(' ')}`, p.trade, `${p.trade} marketing`, `${p.aiEmployee} ${p.trade}`, p.problem.split(/\s+/).slice(0, 4).join(' ')].map((x) => x.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim());
  const sug: string[] = [];
  for (const q of [...new Set(seeds)].filter(Boolean)) for (const yt of [false, true]) { const l = await autocomplete(q, yt); if (l.length) sug.push(`${yt ? 'YouTube' : 'Google'} “${q}”: ${l.join(' | ')}`); }
  const prior = e.script && opts.note ? e.script : null;
  const voices = sr.voices.map((v) => `${v.id}: ${v.name} (${v.note})`).join('\n');
  const seriesCast = sr.cast.map((c) => `${c.key}: ${c.name}, ${c.about}`).join('\n');
  say(id, 'script', prior ? 'Rewriting with your notes' : 'Writing the script');
  const history = [...sr.history, ...allEpisodes().filter((x) => x.id !== id && x.script).map((x) => ({ num: x.num, title: x.title, trade: x.script!.trade, aiEmployee: x.script!.aiEmployee.name, lines: spoken(x.script!).map((l) => l.line!), slot: null, usd: null, status: '', cast: [], hook: [] }))];
  const fix = (s: Script): Script => {
    for (const part of s.parts ?? []) (part.shots ?? []).forEach((x, i) => { x.n = i + 1; x.start = Number(x.start); x.end = Number(x.end); x.speaker = String(x.speaker ?? '').toLowerCase().trim(); if (!x.line) { delete x.line; } });
    for (const c of s.cast ?? []) { c.key = String(c.key).toLowerCase(); c.parts = (c.parts ?? [1, 2]).map(Number); }
    return s;
  };
  const s = await askJson<Script>({
    instructions: HEAD(), signal, minutes: 15, tries: 4, lenient: true,
    onTry: (n, pr) => n > 1 && say(id, 'script', `Fixing ${pr.length} rule${pr.length === 1 ? '' : 's'} (try ${n})`),
    prompt: `Write the whole script for Episode ${e.num} as JSON in exactly this shape:\n${SCRIPT_SHAPE()}\n\nSTORY (chosen by the owner):\n${JSON.stringify(p)}\n\n${F.beats}\n\nSERIES CAST you may use (never redesign them):\n${seriesCast}\n\nVOICES for new people (pick by age and energy; use the exact id; ${F.voiceNote}):\n${voices}\n\nWHAT PEOPLE TYPE (autocomplete, US, today). The primary phrase must come from here if anything fits; copy the evidence:\n${sug.join('\n') || '(could not be reached: choose the plainest phrase an owner or customer would type and leave evidence empty)'}\n\nEARLIER EPISODES: no line, joke or handoff may repeat.\n${pastList()}\n\nAN EARLIER SHOT LIST IN THIS STYLE (for the level of detail, not the content):\n${seriesText('example-prompts.md').slice(0, 7000)}${prior ? `\n\nTHE CURRENT SCRIPT, and what the owner wants changed: “${String(opts.note).slice(0, 2000)}”. Change only what that needs.\n${JSON.stringify(prior)}` : ''}${e.notes?.length ? `\n\nTHE OWNER'S STANDING NOTES: ${e.notes.join(' / ')}` : ''}`,
    check: (v) => {
      try { fix(v); } catch { return ['the shape is wrong']; }
      if (!Array.isArray(v.parts) || v.parts.length !== 2 || !v.screens || !Array.isArray(v.cast)) return ['parts (two), cast and screens are all needed'];
      const keys = new Set(v.cast.map((c) => c.key));
      const bad = [...new Set(v.parts.flatMap((x) => x.shots.map((q) => q.speaker).filter((k) => k && !keys.has(k!))))];
      // how long the two prompts will be, with every reference in place
      const all = v.cast.map((c) => { const k = sr.cast.find((q) => q.key === c.key); return { ...c, ...(k ? { name: k.name, castLine: k.castLine, lock: c.lock?.length > k.lock.length ? c.lock : k.lock } : {}), imageAsset: c.kind === 'described' ? undefined : 'x', voiceAsset: 'x', voiceSeconds: k?.voiceSeconds ?? 4.8 } as CastMember; });
      const long = [1, 2].map((p) => buildPrompt(v, all, p, refsFor(v, all, p, 'x'), sr).length).map((n, i) => (n > 7400 ? `Part ${i + 1}'s prompt would be ${n} characters and the limit is 7,400: cut about ${n - 7300} by shortening pictures, locks, location, props and time (not the lines)` : '')).filter(Boolean);
      return [...long, ...(bad.length ? [`speakers without a cast entry: ${bad.join(', ')}`] : []), ...v.cast.filter((c) => c.kind !== 'series' && !c.voice?.voiceId && v.parts.some((x) => x.shots.some((q) => q.speaker === c.key))).map((c) => `${c.name} speaks and needs a voice`), ...musts(scriptChecks(v, history)).map((c) => `${c.label}${c.detail ? ` (now: ${c.detail})` : ''}`)];
    },
  });
  fix(s);
  const cast: CastMember[] = s.cast.map((c) => {
    const k = sr.cast.find((q) => q.key === c.key);
    if (k) return { ...c, kind: 'series', name: k.name, castLine: k.castLine, lock: c.lock?.length > k.lock.length ? c.lock : k.lock, image: k.image, imageAsset: k.imageAsset, voiceFile: k.voice, voiceAsset: k.voiceAsset, voiceSeconds: k.voiceSeconds, approved: true };
    const kept = e.cast.find((q) => q.key === c.key && q.imagePrompt === c.imagePrompt);
    return kept ? { ...c, image: kept.image, imageAsset: kept.imageAsset, imageUsd: kept.imageUsd, ...(kept.voice?.voiceId === c.voice?.voiceId && kept.voice?.sample === c.voice?.sample ? { voiceFile: kept.voiceFile, voiceAsset: kept.voiceAsset, voiceSeconds: kept.voiceSeconds } : {}) } : c;
  });
  patch(id, (x) => { x.script = s; x.title = s.title; x.cast = cast; x.checks = scriptChecks(s, history); x.scriptNote = opts.note ? String(opts.note).slice(0, 500) : undefined; });
  return false;
}
/** After the owner edits a line or a screen by hand. */
export function recheck(e: Episode) {
  const sr = series();
  if (e.script) e.checks = scriptChecks(e.script, [...sr.history, ...allEpisodes().filter((x) => x.id !== e.id && x.script).map((x) => ({ num: x.num, title: x.title, trade: '', aiEmployee: '', lines: spoken(x.script!).map((l) => l.line!), slot: null, usd: null, status: '', cast: [], hook: [] }))]);
}

// ---------- making ----------
export const left = (e: Episode) => Math.max(0, e.capUsd - spent(e));
async function makeImage(id: string, key: string, signal: AbortSignal) {
  let e = getEpisode(id)!;
  const sr = series(), c = e.cast.find((x) => x.key === key)!;
  const n = e.ledger.filter((l) => l.what.startsWith(`${c.name} image`)).length + 1;
  const prompt = c.kind === 'sheet'
    ? `${sr.sheetStyle} ${c.imagePrompt}`
    : `Use the reference sheet ONLY for its rendering style and lighting; this is a completely different new person. A vertical 9:16 still in Pixar-style 3D feature animation: ${c.imagePrompt} Warm light, soft global illumination, shallow depth of field, feature-film polish. No text, no signs, no logos, no brand names, no watermark.`;
  const body = imageBody(prompt, sr.styleRefAsset, c.kind === 'sheet');
  let task = c.task;
  if (!task) {
    say(id, 'cast', `Drawing ${c.name}`);
    const sub = await tvSubmit(MODEL_IMAGE, body, `${id}-${key}-img${n}`, left(e));
    task = sub.task;
    patch(id, (x) => { x.cast.find((q) => q.key === key)!.task = task; x.ledger.push({ at: now(), what: `${c.name} image ${n}`, provider: 'topview', model: MODEL_IMAGE, task, usd: 0, estimate: sub.estimate, state: 'submitted' }); });
    log(id, 'cast', 'spend', `${c.name} image: TopView job started, about $${sub.estimate.toFixed(2)}`);
  }
  let res;
  try { res = await tvWait(task, () => {}, signal); }
  catch (err) { if (err instanceof ReelError && /failed at TopView/.test(err.message)) patch(id, (x) => { delete x.cast.find((q) => q.key === key)!.task; const l = x.ledger.find((q) => q.task === task); if (l) l.state = 'failed'; }); throw err; }
  const png = epFile(e, `cast/${key}-${n}.png`), jpg = `cast/${key}-${n}.jpg`;
  await download(res.outputs[0], png);
  await ffmpeg(['-i', png, '-q:v', '2', epFile(e, jpg)], { signal });
  const asset = await tvUpload(epFile(e, jpg), 'image');
  patch(id, (x) => { const m = x.cast.find((q) => q.key === key)!; m.image = jpg; m.imageAsset = asset; m.imageUsd = (m.imageUsd ?? 0) + res.usd; delete m.task; const l = x.ledger.find((q) => q.task === task); if (l) { l.usd = res.usd; l.state = 'completed'; } });
  e = getEpisode(id)!;
}
async function makeVoice(id: string, key: string, signal: AbortSignal) {
  const e = getEpisode(id)!, c = e.cast.find((x) => x.key === key)!;
  if (!c.voice) return;
  say(id, 'cast', `Recording ${c.name}’s voice`);
  const raw = ensureDir(epFile(e, `cast/${key}-voice-raw.mp3`)), out = `cast/${key}-voice.mp3`;
  await speak(c.voice.voiceId, c.voice.sample, c.voice.stability, c.voice.similarity, raw, signal);
  // trimmed and levelled; a sample is kept under five seconds so a part's voices fit in 30 seconds together
  await ffmpeg(['-i', raw, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,loudnorm=I=-18:TP=-2,aresample=44100,atrim=0:5', '-ac', '1', '-b:a', '128k', epFile(e, out)], { signal });
  const sec = (await probe(epFile(e, out))).seconds;
  const asset = await tvUpload(epFile(e, out), 'audio');
  patch(id, (x) => { const m = x.cast.find((q) => q.key === key)!; m.voiceFile = out; m.voiceAsset = asset; m.voiceSeconds = sec; });
  log(id, 'cast', 'info', `${c.name}: voice sample ${sec.toFixed(1)} s (${c.voice.voiceName})`);
}
async function runCast(id: string, signal: AbortSignal, opts: Record<string, any>): Promise<boolean> {
  const only = opts.key as string | undefined;
  for (const c of getEpisode(id)!.cast.filter((x) => x.kind !== 'series' && (!only || x.key === only))) {
    if (['sheet', 'ref'].includes(c.kind) && (!c.imageAsset || opts.what === 'image')) await makeImage(id, c.key, signal);
    if (c.voice && spoken(getEpisode(id)!.script!).some((l) => l.speaker === c.key) && (!c.voiceAsset || opts.what === 'voice')) await makeVoice(id, c.key, signal);
  }
  return getEpisode(id)!.cast.every((c) => c.kind === 'series');
}

async function runScreens(id: string): Promise<boolean> {
  const list = await buildScreens(getEpisode(id)!, (t) => say(id, 'screens', t));
  patch(id, (x) => { x.screens = list; });
  return true; // shown, and approved, on the storyboard
}

async function runStoryboard(id: string): Promise<boolean> {
  const e = getEpisode(id)!, s = e.script!, sr = series();
  let screenAsset: string | null = null;
  const s2 = e.screens.find((x) => x.id === 's2');
  say(id, 'storyboard', 'Putting the prompts together');
  if (s2 && getKey('topview')) screenAsset = await tvUpload(epFile(e, s2.png), 'image');
  const refs = [1, 2].map((p) => refsFor(s, e.cast, p, screenAsset));
  const prompts = [1, 2].map((p) => buildPrompt(s, e.cast, p, refs[p - 1], sr));
  const checks = promptChecks(prompts, s, refs.map((r) => r.audio.reduce((a, x) => a + x.seconds, 0)), refs.map((r) => r.images.length));
  let quote: number | null = null, usual = 0;
  if (getKey('topview')) {
    say(id, 'storyboard', 'Asking TopView for the price (free)');
    quote = 0;
    for (const p of [0, 1]) { const q = await tvQuote(MODEL_VIDEO, videoBody(prompts[p], refs[p], sr.refVideoAsset)); quote += q.worst; usual += q.estimate; }
  }
  patch(id, (x) => {
    x.storyboard = { prompts, chars: prompts.map((q) => q.length), checks, quoteUsd: quote, usualUsd: usual || undefined, quotedAt: now(), refs: refs.map((r, n) => ({ images: r.images.map((i) => i.name), audio: r.audio.map((a) => a.name), video: n === 0 ? `${e.cast.find((c) => c.key === leadKey(s))?.name ?? 'the lead'}, cut from Part 2` : `${formula().names.closer} (this part renders first)` })) };
    x.storyboard.refData = refs.map((r) => ({ images: r.images, audio: r.audio }));
  });
  return false;
}
export const partRefs = (e: Episode, part: number): PartRefs => { const d = e.storyboard?.refData?.[part - 1]; const r = refsFor(e.script!, e.cast, part, null); return d ? { ...r, images: d.images, audio: d.audio } : r; };

/** The asset behind a part's (or a shot's) reference video, when it is there already; the price is the same with the closer's. */
const videoNow = (e: Episode, part: number, shot?: number) => (videoKey(e.script!, e.cast, part, shot) !== formula().roles.closer && e.render.lead?.v === e.render.parts[1].picked && e.render.lead ? e.render.lead.asset : series().refVideoAsset);
/** The lead's clip, cut from the finished Part 2: shots where the lead speaks, alone if possible, two to four seconds. */
async function leadClip(id: string, stage: StageId, signal: AbortSignal): Promise<string> {
  const e = getEpisode(id)!, s = e.script!, v = e.render.parts[1].picked, ver = e.render.parts[1].versions.find((x) => x.v === v);
  if (v === null || !ver?.file) throw new ReelError('Part 2 comes first: the reference video for Part 1 is cut from it.');
  if (e.render.lead?.v === v) return e.render.lead.asset;
  const key = leadKey(s), who = e.cast.find((c) => c.key === key), name = who?.name ?? 'the lead';
  say(id, stage, `Cutting ${name}’s clip from Part 2`);
  const file = epFile(e, ver.file), shots = s.parts[1].shots, rel = `renders/lead-p2v${v}.mp4`;
  const c = await py<{ cuts: number[]; frames: number; fps: number }>('cuts', { file }, { signal });
  const st = shotStarts(shots, c.cuts, c.fps), span = (i: number) => [(st[i] + 2) / c.fps, ((st[i + 1] ?? c.frames) - 2) / c.fps] as const;
  const others = e.cast.filter((q) => q.key !== key);
  const mine = shots.map((x, i) => ({ x, i, len: span(i)[1] - span(i)[0], alone: !others.some((o) => named(o, x.picture)) })).filter((q) => q.x.line && !q.x.offscreen && q.x.speaker?.toLowerCase() === key && q.len > 0.6);
  const pool = mine.sort((a, b) => Number(b.alone) - Number(a.alone) || b.len - a.len);
  if (!pool.length) throw new ReelError(`${name} doesn’t speak on screen in Part 2, so there is no clip of them for Part 1.`);
  const take: (readonly [number, number])[] = [];
  let sec = 0;
  for (const q of pool) { if (sec >= 2.4 || take.length === 3) break; const [a, b] = span(q.i), end = Math.min(b, a + 4 - sec); take.push([a, end]); sec += end - a; }
  for (let i = 0; sec < 2.4; i++) { take.push(take[i]); sec += take[i][1] - take[i][0]; }
  await ffmpeg(['-i', file, '-filter_complex', `${take.map(([a, b], i) => `[0:v]trim=${a.toFixed(3)}:${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`).join(';')};${take.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${take.length}:v=1:a=1[v][a]`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', epFile(e, rel)], { signal });
  // Whoever is in this clip plays the lead in Part 1, so it is looked at before Part 1 is paid for.
  let doubt = '';
  const pic = who?.image ? (who.kind === 'series' ? path.join(seriesDir(), who.image) : epFile(e, who.image)) : '';
  if (who && pic && fs.existsSync(pic)) {
    try {
      const still = epFile(e, `renders/lead-p2v${v}.jpg`);
      await ffmpeg(['-ss', ((take[0][1] - take[0][0]) / 2).toFixed(2), '-i', epFile(e, rel), '-frames:v', '1', '-q:v', '2', still], { signal });
      say(id, stage, `Checking that it is ${name}`);
      const r = await askJson<{ same: boolean; seen: string }>({
        instructions: 'You check that the right cartoon character is on screen, not a different person. Compare only the face, hair, facial hair, age, skin and build. What is out of the frame, the pose, crossed arms, props, the light, the expression, the mouth and small drawing differences never count. Answer same=false only when it is plainly someone else.',
        images: [{ label: `${name}’s own picture.`, file: pic }, { label: 'A frame from the render.', file: still }], signal, minutes: 4, tries: 2,
        prompt: `Is the main person in the frame ${name}? How they must look: ${who.lock}\nJSON: {"same": true or false, "seen": "who it looks like, in under 15 words"}`,
        check: (j) => (typeof j?.same === 'boolean' ? [] : ['same must be true or false']),
      });
      if (!r.same) doubt = String(r.seen ?? '').replace(/\.$/, '').slice(0, 160) || 'someone else is on screen';
    } catch (err) { if (signal.aborted) throw err; log(id, stage, 'info', `${name}’s clip wasn’t checked (${(err as Error).message}). Look at Part 2 yourself.`); }
  }
  say(id, stage, 'Sending the clip to TopView');
  const asset = await tvUpload(epFile(e, rel), 'video');
  patch(id, (x) => { x.render.lead = { v, key, file: rel, asset, ...(doubt ? { doubt } : {}) }; });
  log(id, stage, 'info', `${name}’s clip for Part 1: ${sec.toFixed(1)} s from Part 2`);
  if (doubt) throw new ReelError(`Part 1 hasn’t been started: in Part 2, ${name} may be someone else (${doubt}). Compare the two pictures below and decide.`);
  return asset;
}

async function renderOne(id: string, part: number, kind: 'part' | 'shot', o: { shot?: number; note?: string; signal: AbortSignal; stage: StageId }) {
  let e = getEpisode(id)!;
  const pr = e.render.parts[part - 1];
  let v = pr.versions.find((x) => x.task && ['submitted', 'payment_required'].includes(x.state) && x.kind === kind && x.shot === o.shot);
  if (!v) {
    const n = Math.max(0, ...pr.versions.map((x) => x.v)) + 1, idem = `${id}-p${part}-v${n}`;
    const refs = partRefs(e, part);
    const prompt = e.storyboard!.prompts[part - 1];
    if (kind === 'part' && prompt.length + (o.note ?? '').length > 7500) throw new ReelError(`Part ${part}’s prompt is ${prompt.length.toLocaleString()} characters and the limit is 7,500. Nothing was sent. Shorten a few pictures or props (the Session can do it), then try again.`);
    const video = e.render.provider !== 'kie' && videoKey(e.script!, e.cast, part, o.shot) !== formula().roles.closer ? await leadClip(id, o.stage, o.signal) : series().refVideoAsset;
    const body = kind === 'shot' ? retakeBody(e, part, o.shot!, o.note ?? '', refs, video).body : videoBody(o.note ? `${prompt}\n\nMake sure: ${o.note}` : prompt, refs, video);
    v = { v: n, kind, provider: e.render.provider, state: 'quoted', at: now(), key: idem, ...(o.shot ? { shot: o.shot } : {}), ...(o.note ? { note: o.note } : {}) } as RenderVersion;
    patch(id, (x) => { x.render.parts[part - 1].versions.push(v!); });
    say(id, o.stage, kind === 'shot' ? `Part ${part}, shot ${o.shot}: sending` : `Part ${part}: sending`);
    let sub: { task: string; estimate: number };
    try { sub = e.render.provider === 'kie' ? await kieSubmit(body, left(e), idem) : await tvSubmit(MODEL_VIDEO, body, idem, left(e)); }
    catch (err) { patch(id, (x) => { const q = x.render.parts[part - 1].versions.find((z) => z.v === n)!; q.state = 'failed'; q.error = (err as Error).message; }); throw err; }
    v = patch(id, (x) => { const q = x.render.parts[part - 1].versions.find((z) => z.v === n)!; q.state = 'submitted'; q.task = sub.task; q.estimate = sub.estimate; x.ledger.push({ at: now(), what: kind === 'shot' ? `Part ${part} shot ${o.shot} retake` : `Part ${part} v${n}`, provider: x.render.provider, model: 'Seedance 2.5, 480p', task: sub.task, usd: 0, estimate: sub.estimate, state: 'submitted' }); }).render.parts[part - 1].versions.find((z) => z.v === n)!;
    log(id, o.stage, 'spend', `${kind === 'shot' ? `Part ${part} shot ${o.shot}` : `Part ${part}`}: ${e.render.provider === 'kie' ? 'kie.ai' : 'TopView'} job started, about $${sub.estimate.toFixed(2)}`);
  }
  const vn = v.v, task = v.task!;
  const status = (t: string) => say(id, o.stage, `${kind === 'shot' ? `Part ${part}, shot ${o.shot}` : `Part ${part}`}: ${t === 'created' ? 'waiting to start' : t}`);
  const setV = (fn: (q: RenderVersion) => void, usd?: number, state?: string) => patch(id, (x) => { const q = x.render.parts[part - 1].versions.find((z) => z.v === vn)!; fn(q); const l = x.ledger.find((z) => z.task === task); if (l) { if (usd !== undefined) l.usd = usd; if (state) l.state = state; } });
  let res;
  try { res = v.provider === 'kie' ? await kieWait(task, v.estimate ?? 0, status, o.signal) : await tvWait(task, status, o.signal); }
  catch (err) {
    const m = (err as Error).message;
    if (/failed at/.test(m)) setV((q) => { q.state = 'failed'; q.error = m; }, 0, 'failed');
    else if (/top-up/.test(m)) setV((q) => { q.state = 'payment_required'; q.error = m; });
    throw err;
  }
  e = getEpisode(id)!;
  const rel = kind === 'shot' ? `renders/p${part}s${o.shot}-v${vn}.mp4` : `renders/part${part}-v${vn}.mp4`;
  await download(res.outputs[0], epFile(e, rel));
  setV((q) => { q.state = 'completed'; q.file = rel; q.usd = res.usd; delete q.error; }, res.usd, 'completed');
  if (kind === 'part') patch(id, (x) => { x.render.parts[part - 1].picked = vn; x.review[part - 1] = null; x.render.parts[part - 1].versions.forEach((q) => { if (q.kind === 'shot') q.note = `[off] ${q.note ?? ''}`; }); });
  log(id, o.stage, 'info', `${kind === 'shot' ? `Part ${part} shot ${o.shot}` : `Part ${part}`} is ready ($${res.usd.toFixed(2)})`);
}
async function runRender(id: string, signal: AbortSignal, opts: Record<string, any>): Promise<boolean> {
  const e = getEpisode(id)!;
  // Part 2 first, then Part 1 with the lead's clip from it. One at a time also keeps each price check against what is really left.
  const want: number[] = opts.part ? [Number(opts.part)] : [2, 1].filter((p) => e.render.parts[p - 1].picked === null);
  for (const p of want) {
    await renderOne(id, p, 'part', { signal, note: opts.note, stage: 'render' });
    if (p === 2 && want.includes(1)) {
      const rv = await reviewPart(getEpisode(id)!, 2, { signal, say: (t) => say(id, 'render', t) });
      patch(id, (x) => { x.review[1] = { ...rv, notes: ['[again]'] }; });
      try { await mouthCheck(id, 2, signal, (t) => say(id, 'render', t)); } catch (err) { if (signal.aborted) throw err; }
      const lost = rv.lines.filter((l) => l.score < 0.5);
      if (lost.length > 2) throw new ReelError(`Part 1 hasn’t been started: ${lost.length} of Part 2’s ${rv.lines.length} lines weren’t heard as written. Watch Part 2. Run again to go on anyway, or put your own clip in its place.`);
    }
  }
  return true;
}

/** Spoken lines whose speaker is on screen but doesn't move the mouth: seen in frames taken while the line is heard. */
export async function mouthCheck(id: string, part: number, signal?: AbortSignal, say_: (t: string) => void = () => {}): Promise<number[]> {
  const e = getEpisode(id)!, v = partFile(e, part);
  if (!v?.file) throw new ReelError(`Part ${part} isn’t rendered yet.`);
  const rv = e.review[part - 1] ?? await reviewPart(e, part, { signal, say: say_ });
  if (!e.review[part - 1]) patch(id, (x) => { x.review[part - 1] = { ...rv, notes: ['[again]'] }; });
  const shots = e.script!.parts[part - 1].shots, retaken = (n: number) => e.render.parts[part - 1].versions.some((q) => q.kind === 'shot' && q.shot === n && q.state === 'completed' && !(q.note ?? '').startsWith('[off]'));
  const rows = rv.lines.filter((l) => l.score > 0.25 && l.end - l.start > 0.4 && !shots.find((x) => x.n === l.shot)?.offscreen && !retaken(l.shot)), bad: number[] = [];
  for (let i = 0; i < rows.length; i += 4) {
    const set = rows.slice(i, i + 4), rel = `review/lips-p${part}-${i}.jpg`;
    say_(`Part ${part}: watching the lips (${Math.min(rows.length, i + 4)} of ${rows.length})`);
    const frames = set.flatMap((l) => { const k = shots.findIndex((x) => x.n === l.shot), s0 = rv.shotStarts[k] + 1, s1 = (rv.shotStarts[k + 1] ?? rv.frames) - 2; return Array.from({ length: 6 }, (_, j) => Math.round(Math.max(s0, Math.min(s1, (l.start + 0.08 + ((l.end - l.start - 0.16) * j) / 5) * rv.fps)))); });
    await py('sheet', { file: epFile(e, v.file), out: epFile(e, rel), frames, cols: 6 }, { signal, minutes: 5 });
    const r = await askJson<{ frozen: number[] }>({
      instructions: 'You check cartoon lip movement. Each row is six frames taken while one character is heard speaking. Look at that character’s mouth only. Talking: the mouth is open in some frames or clearly changes shape. Frozen: in all six frames the mouth stays closed, or keeps the very same smile.',
      images: [{ label: `Rows from top to bottom: ${set.map((l, n) => `row ${n + 1} = shot ${l.shot}, ${e.cast.find((c) => c.key === l.speaker.toLowerCase())?.name ?? l.speaker} says “${l.text}”`).join('; ')}`, file: epFile(e, rel) }], signal, minutes: 4, tries: 2,
      prompt: 'Which rows are frozen? JSON: {"frozen":[shot numbers]} (empty when all talk)',
      check: (x) => (Array.isArray(x?.frozen) && x.frozen.every((n) => set.some((l) => l.shot === Number(n))) ? [] : ['frozen must be a list of the shot numbers above']),
    });
    bad.push(...r.frozen.map(Number));
  }
  patch(id, (x) => {
    const q = x.review[part - 1]; if (!q) return;
    for (const l of q.lines) if (rows.some((z) => z.shot === l.shot)) l.lips = !bad.includes(l.shot);
    q.notes = [...q.notes.filter((n) => !/mouth doesn’t move/.test(n)), ...bad.map((n) => `Shot ${n}: ${x.cast.find((c) => c.key === q.lines.find((l) => l.shot === n)?.speaker.toLowerCase())?.name ?? 'The speaker'}’s mouth doesn’t move while the line is heard. Retake that shot.`)];
  });
  if (bad.length) log(id, 'review', 'info', `Part ${part}: the mouth doesn’t move in shot ${bad.join(', ')}`);
  return bad;
}
/** After a change to the plan: the prompts follow it, so a retake or a missing part is made from what is written now. */
export function rebuildPrompts(id: string) {
  patch(id, (x) => {
    if (!x.storyboard || !x.script) return;
    const refs = [1, 2].map((p) => partRefs(x, p)), sr = series();
    x.storyboard.prompts = [1, 2].map((p) => buildPrompt(x.script!, x.cast, p, refs[p - 1], sr));
    x.storyboard.chars = x.storyboard.prompts.map((q) => q.length);
    x.storyboard.checks = promptChecks(x.storyboard.prompts, x.script, refs.map((r) => r.audio.reduce((a, q) => a + q.seconds, 0)), refs.map((r) => r.images.length));
  });
}
/** Before anything is rendered: the edge between two shots moves (whole half seconds; each keeps at least one). */
export function shotTime(id: string, part: number, n: number, end: number) {
  if (running.has(id)) throw new ReelError('Wait for the running stage to finish.');
  patch(id, (x) => {
    const s = x.script?.parts[part - 1].shots ?? [], i = s.findIndex((q) => q.n === n);
    if (i < 0 || i === s.length - 1) throw new ReelError('That edge can’t be moved.');
    if (x.render.parts[part - 1].picked !== null) throw new ReelError('That part is rendered; trim it in the Editor instead.');
    const e = Math.round(Math.max(s[i].start + 1, Math.min(s[i + 1].end - 1, end)) * 2) / 2;
    s[i].end = e; s[i + 1].start = e;
    recheck(x);
  });
  rebuildPrompts(id);
  log(id, 'script', 'change', `Part ${part} shot ${n}: its time changed`);
}
/** What the missing parts cost at most. */
export async function quoteRender(id: string, parts: number[]): Promise<number> {
  const e = getEpisode(id)!;
  if (!e.storyboard) throw new ReelError('Build the storyboard first.');
  let n = 0;
  for (const p of parts) n += (await tvQuote(MODEL_VIDEO, videoBody(e.storyboard.prompts[p - 1], partRefs(e, p), videoNow(e, p)))).worst;
  return n;
}
/** The cut's options, cleaned. */
export function changeCut(id: string, b: Record<string, any>) {
  if (running.has(id)) throw new ReelError('Wait for the running stage to finish.');
  const STR = (v: unknown, n: number) => String(v ?? '').slice(0, n);
  const was = JSON.parse(JSON.stringify(getEpisode(id)!.edit.options)) as Episode['edit']['options'];
  const now = patch(id, (x) => {
    const o = x.edit.options, num = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
    if (b.musicDb !== undefined) o.musicDb = num(b.musicDb, -40, 0, -11);
    if (b.trimStart !== undefined) o.trimStart = num(b.trimStart, 0, 3, 0);
    if (b.trimEnd !== undefined) o.trimEnd = num(b.trimEnd, 0, 6, 0);
    if (Array.isArray(b.dropShots)) o.dropShots = b.dropShots.map((d: any) => ({ part: Number(d.part) === 2 ? 2 : 1, shot: Number(d.shot) })).slice(0, 12);
    if (Array.isArray(b.brighten)) o.brighten = b.brighten.map((d: any) => ({ part: Number(d.part) === 2 ? 2 : 1, shot: Number(d.shot) })).slice(0, 24);
    if (Array.isArray(b.trims)) o.trims = b.trims.map((d: any) => ({ part: Number(d.part) === 2 ? 2 : 1, shot: Number(d.shot), in: num(d.in, 0, 6, 0), out: num(d.out, 0, 6, 0) })).filter((d: any) => d.shot > 0 && (d.in > 0.01 || d.out > 0.01)).slice(0, 24);
    if (Array.isArray(b.captionFixes)) o.captionFixes = b.captionFixes.filter((f: any) => Array.isArray(f) && f[0]).map((f: any) => [STR(f[0], 40), STR(f[1], 40)] as [string, string]).slice(0, 60);
    if (b.screenOn && typeof b.screenOn === 'object') o.screenOn = Object.fromEntries(Object.entries<any>(b.screenOn).filter(([k, v]) => /^[12]-\d{1,2}$/.test(k) && /^(s[1-5])?$/.test(String(v))).slice(0, 24).map(([k, v]) => [k, String(v)]));
    if (b.screens && typeof b.screens === 'object') for (const [k, v] of Object.entries<any>(b.screens)) if (/^s[1-5]$/.test(k)) o.screens[k] = { on: v.on !== false, ...(v.f0 !== undefined && v.f0 !== '' ? { f0: Math.max(0, Math.round(Number(v.f0))) } : {}), ...(v.f1 !== undefined && v.f1 !== '' ? { f1: Math.max(1, Math.round(Number(v.f1))) } : {}), ...(v.motion === 'static' || v.motion === 'track' ? { motion: v.motion } : {}) };
  });
  if (JSON.stringify(now.edit.options) !== JSON.stringify(was) && now.edit.final) patch(id, (x) => { if (['done', 'needs_you'].includes(x.stages.edit.status)) { x.stages.edit.status = 'stale'; delete x.stages.edit.approvedAt; delete x.stages.edit.approval; } cascade(x, 'edit'); });
  applyCut(now, was);
}

async function runReview(id: string, signal: AbortSignal): Promise<boolean> {
  for (const part of [1, 2]) {
    const e = getEpisode(id)!;
    const had = e.review[part - 1];
    if (had && !had.notes.includes('[again]')) continue;
    const rv: PartReview = had ? { ...had, notes: had.notes.filter((n) => n !== '[again]') } : await reviewPart(e, part, { signal, say: (t) => say(id, 'review', t) });
    patch(id, (x) => { x.review[part - 1] = rv; });
    if (rv.lines.every((l) => l.lips === undefined)) { try { await mouthCheck(id, part, signal, (t) => say(id, 'review', t)); } catch (err) { if (signal.aborted) throw err; } }
    say(id, 'review', `Part ${part}: looking at the picture`);
    try {
      const s = e.script!.parts[part - 1];
      const r = await askJson<{ notes: string[] }>({
        instructions: 'You check cartoon renders for AI slop before a human editor sees them. Be specific and only report what you can see. Rules: faces and outfits match from shot to shot; the right person is on screen for each line; nobody eats, drinks or has a straw at the mouth while speaking; tools touch what they work on; phone and laptop screens that should be plain white are plain white; no readable signs or wrong text; no extra or missing people, fingers or props; when a line says how many, that many are seen; faces in night shots are light enough to read; laughs have a reason; trade physics is right. Small logo artefacts are fine.',
        images: [{ label: `Contact sheet of Part ${part}: for each shot in order, its first frame and its middle frame, numbered.`, file: epFile(e, rv.sheet) }], signal, minutes: 5, tries: 2, lenient: true,
        prompt: `The shots this part should show:\n${s.shots.map((x) => `${x.n} (${x.start}-${x.end}s): ${x.camera}. ${x.picture}${x.line ? ` ${x.speaker}: "${x.line}"` : ' (silent)'}`).join('\n')}\n\nHow everyone must look: ${e.cast.map((c) => c.lock).filter(Boolean).join(' ')}\nTrade: ${e.script!.tradePhysics}\n\nList only what an ordinary viewer would notice in a fast cartoon: at most 5, worst first, each starting "Shot N:" in under 25 words. Ignore small differences of pose, angle, wardrobe detail or background from the plan. If it looks right, return an empty list. JSON: {"notes":["..."]}`,
        check: (v) => (Array.isArray(v?.notes) ? [] : ['notes must be a list']),
      });
      patch(id, (x) => { x.review[part - 1]!.notes = [...x.review[part - 1]!.notes, ...r.notes.map((n) => String(n).slice(0, 240)).slice(0, 5)]; });
    } catch (err) { if (signal.aborted) throw err; log(id, 'review', 'info', `Part ${part}: the picture check didn’t run (${(err as Error).message}). Look at the contact sheet yourself.`); }
  }
  return false;
}

async function runEdit(id: string, signal: AbortSignal): Promise<boolean> {
  const e = getEpisode(id)!;
  const r = await (studioReady() ? buildStudioEdit : buildEdit)(e, { signal, say: (t) => say(id, 'edit', t) });
  patch(id, (x) => { Object.assign(x.edit, r); x.cover = { candidates: [], picked: null }; });
  return false;
}

async function runCover(id: string, signal: AbortSignal): Promise<boolean> {
  const e = getEpisode(id)!;
  say(id, 'cover', 'Looking through the cut');
  const scan = await coverScan(e, { signal });
  let picks: number[] = [];
  try {
    const r = await askJson<{ picks: { n: number; why: string }[] }>({
      instructions: 'You choose cover frames for cartoon reels. The best covers show one face at its most extreme (fury, shock, horror, outrage), mouth open, eyes wide, sharp and unblurred, close, nobody half out of frame. Screens, backs of heads and calm faces are useless.',
      images: [{ label: 'Frames from the finished video, numbered top left.', file: epFile(e, scan.sheet) }], signal, minutes: 4, tries: 2,
      prompt: `Pick the 8 strongest, best first, from different moments. JSON: {"picks":[{"n":<frame number>,"why":"..."}]}`,
      check: (v) => (Array.isArray(v?.picks) && v.picks.length >= 4 && v.picks.every((p) => p.n >= 1 && p.n <= scan.times.length) ? [] : [`picks must be 4 to 8 frame numbers between 1 and ${scan.times.length}`]),
    });
    picks = [...new Set(r.picks.map((p) => scan.times[Math.round(p.n) - 1]))].slice(0, 8);
  } catch (err) { if (signal.aborted) throw err; }
  if (picks.length < 4) picks = [0.5, 1.6, 2.6, 3.8, 4.4, 14.8, 22.6, 28.6].map((t) => Math.min(t, scan.times[scan.times.length - 1]));
  say(id, 'cover', 'Saving clean frames');
  const st = await coverStills(e, picks, { signal });
  patch(id, (x) => { x.cover.candidates = st; });
  return false;
}
export async function addCover(id: string, t: number) {
  const e = getEpisode(id)!;
  if (!(t >= 0 && t < (e.edit.seconds ?? 0))) throw new ReelError('Give a time inside the video.');
  const st = await coverStills(e, [t], {});
  patch(id, (x) => { for (const c of st) if (!x.cover.candidates.some((q) => q.file === c.file)) x.cover.candidates.push(c); });
}

async function runPackage(id: string, signal: AbortSignal): Promise<boolean> {
  const e = getEpisode(id)!, s = e.script!, sr = series(), F = formula();
  say(id, 'package', 'Writing the captions');
  const kw = s.keywords, base = `${s.caption.line1.trim()} ${s.caption.story.trim()}\n\n${/^(his|her|their|the) tip/i.test(s.tip) ? s.tip : `The tip: ${s.tip.trim().replace(new RegExp(`^${kw.primary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'i'), '')}`}\n\n${s.forward.trim()}\n\n${F.captionEnd}`;
  const tags = [...new Set([...kw.facebookTags, 'AI for small business', 'AI employee', 'AI agent', 'small business'].map((x) => x.trim()).filter(Boolean))].slice(0, 8);
  const clean = (t: string) => t.replace(/\s*—\s*/g, ', ').trim();
  const lines = spoken(s);
  const places = [kw.primary, kw.ownerSide, ...kw.secondary].filter(Boolean).map((k) => { const n = k.toLowerCase(); const w: string[] = []; const sp = lines.filter((l) => l.line!.toLowerCase().replace(/-/g, ' ').includes(n)); if (sp.length) w.push(`spoken ${sp.length}×`); if (JSON.stringify(s.screens).toLowerCase().includes(n)) w.push('on a screen'); if (base.toLowerCase().includes(n)) w.push('caption'); if (tags.some((t) => t.toLowerCase() === n)) w.push('Facebook tag'); if (kw.youtubeTitle.toLowerCase().includes(n)) w.push('YouTube title'); w.push('YouTube description and tags'); return `${k}: ${w.join(', ')}`; });
  const free = slots(ownerOf(id)!, 14, id).find((x) => !x.taken);
  const list = (x: string[]) => { const u = [...new Set(x.filter(Boolean))]; return u.length > 1 ? `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}` : u[0] ?? s.trade; };
  const told = s.caption.story.match(/[^.!?]+[.!?]+/g) ?? [s.caption.story], i = told.findIndex((x) => new RegExp(F.turn).test(x)), before = told.slice(0, i < 0 ? 1 : i).map((x) => x.trim());
  const pack: Episode['pack'] = {
    instagram: clean(`${base}${sr.courseLine} ${sr.hashtags}`), facebook: clean(`${base}${sr.courseLineFacebook} ${sr.hashtags}`),
    commentInstagram: clean(`${sr.commentBase} ${s.question}`), commentFacebook: clean(`${sr.commentBaseFacebook} ${s.question}`), altText: clean(s.altText),
    keywords: [kw.primary, kw.ownerSide, ...kw.secondary, 'AI Employee (AI Agent)', 'AI for small business'].filter(Boolean), facebookTags: tags, youtubeTitle: clean(kw.youtubeTitle),
    youtubeDescription: clean(`${s.caption.line1} ${s.caption.story}\n\n${s.tip}\n\nThis episode covers ${list([kw.primary, kw.ownerSide, ...kw.secondary])}.\n\n${sr.name}, Episode ${e.num}. ${F.youtube[0]}\n\n${F.youtube[1]} ${sr.courseLine.replace(/is in my bio/i, 'is linked on my channel')}\n${sr.youtubeLink}\n\n${F.youtube[2]}\n\n${F.youtube[3]} #${s.trade.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)}`),
    youtubeTags: [...new Set([kw.primary, kw.ownerSide, ...kw.secondary, 'AI Employee', 'AI agent', 'AI for small business', sr.name, s.trade])].filter(Boolean), keywordPlaces: places,
    slot: e.pack?.slot ?? free?.at ?? null, platforms: e.pack?.platforms ?? ['instagram', 'facebook', 'youtube', 'whatsapp'], checks: [], folder: null,
    whatsapp: clean(`${s.caption.line1.trim()} ${before.join(' ')} ${F.whatsappEnd}`.replace(/\s+/g, ' ')),
    youtubeComment: clean(`${sr.commentBase.replace(/is in my bio/i, 'is linked on my channel')} ${s.question}`),
  };
  patch(id, (x) => { x.pack = pack; x.pack!.checks = packChecks(x, sr); });
  // WhatsApp takes 10 MB at most: a 720p copy of the reel, made here so it is ready when the captions are approved.
  say(id, 'package', 'Making the WhatsApp copy');
  const src = epFile(e, e.edit.final!), small = ensureDir(epFile(e, 'whatsapp/status.mp4')), sec = (await probe(src)).seconds, kb = Math.floor((8_800_000 * 8 / sec - 112_000) / 1000);
  const two = path.join(path.dirname(small), 'pass');
  const common = ['-i', src, '-c:v', 'libx264', '-b:v', `${kb}k`, '-preset', 'slow', '-passlogfile', two, '-vf', 'scale=720:1280:flags=lanczos', '-pix_fmt', 'yuv420p'];
  await ffmpeg([...common, '-pass', '1', '-an', '-f', 'null', '-'], { signal, minutes: 15 });
  await ffmpeg([...common, '-pass', '2', '-c:a', 'aac', '-b:a', '112k', '-movflags', '+faststart', small], { signal, minutes: 15 });
  if (fs.statSync(small).size > 9_900_000) log(id, 'package', 'error', 'The WhatsApp copy came out over 9.9 MB.');
  return false;
}
/** The publish pack as files: the reel, the cover and every text, named as the series names them. */
export function writePack(e: Episode): string {
  const p = e.pack!, name = `${formula().packPrefix}${String(e.num).padStart(2, '0')}-${(e.script!.slug || 'episode').replace(/[^a-z0-9-]/gi, '').slice(0, 50)}`, dir = path.join(epDir(e.num), 'publish-pack', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(epFile(e, e.edit.final!), path.join(dir, 'reel-v1.mp4'));
  if (e.cover.picked) fs.copyFileSync(epFile(e, e.cover.picked), path.join(dir, 'cover.jpg'));
  const put = (f: string, t: string) => fs.writeFileSync(path.join(dir, f), t);
  put('caption-us-ig.txt', p.instagram); put('caption-us-fb.txt', p.facebook); put('comment-ig.txt', p.commentInstagram); put('comment-fb.txt', p.commentFacebook); put('alt-text.txt', p.altText);
  if (p.youtubeComment) put('comment-youtube.txt', p.youtubeComment);
  if (p.whatsapp && p.platforms.includes('whatsapp')) { put('caption-whatsapp.txt', p.whatsapp); const w = epFile(e, 'whatsapp/status.mp4'); if (fs.existsSync(w)) fs.copyFileSync(w, path.join(dir, 'whatsapp-status.mp4')); }
  put('youtube.txt', `${p.youtubeTitle}\n\n${p.youtubeDescription}\n\nTags: ${p.youtubeTags.join(', ')}`);
  put('keywords.json', JSON.stringify({ keywords: p.keywords, facebook_tags: p.facebookTags, youtube_title: p.youtubeTitle }, null, 1));
  return `publish-pack/${name}`;
}

const RUN: Partial<Record<StageId, (id: string, signal: AbortSignal, opts: Record<string, any>) => Promise<boolean>>> = {
  story: runStory, script: runScript, cast: runCast, screens: (id) => runScreens(id), storyboard: (id) => runStoryboard(id), render: runRender, review: runReview, edit: runEdit, cover: runCover, package: (id, signal) => runPackage(id, signal),
};

// ---------- the owner's decisions ----------
export function approve(id: string, stage: StageId, b: Record<string, any>) {
  const e = getEpisode(id);
  if (!e) throw new ReelError('That episode is gone.');
  if (running.has(id)) throw new ReelError('Wait for the running stage to finish.');
  const st = e.stages[stage];
  if (st.status !== 'needs_you') throw new ReelError('There is nothing to approve in that stage right now.');
  const words = String(b.words ?? '').trim().slice(0, 200);
  switch (stage) {
    case 'story': {
      const own = String(b.custom ?? '').trim();
      const pick: StoryOption | undefined = own ? { title: own.slice(0, 60), who: '', trade: '', aiEmployee: '', problem: own.slice(0, 1200), hookSpeaker: '', hookLine: '', secondSpeaker: '', secondLine: '', unexpected: '', why: 'The owner’s own story' } : e.story.options[Number(b.pick)];
      if (!pick) throw new ReelError('Pick one of the stories, or write your own.');
      patch(id, (x) => { x.story.picked = pick; x.title = pick.title; cascade(x, 'story'); });
      return finish(id, 'story', words || `Story: ${pick.title}`);
    }
    case 'script': {
      const bad = musts(e.checks);
      if (bad.length && !b.anyway) throw new ReelError(`${bad.length} rule${bad.length === 1 ? ' is' : 's are'} not met: ${bad.map((c) => c.label).slice(0, 3).join('; ')}. Fix them, or approve anyway.`);
      const cap = Number(b.capUsd);
      if (!(cap > 0 && cap <= 60)) throw new ReelError('Set the most this episode may cost, in dollars.');
      const ai = b.aiEmployee === 'yes' ? 'yes' : b.aiEmployee === 'later' ? 'later' : null;
      if (!ai) throw new ReelError('Say whether one of your AI Employees really does this.');
      patch(id, (x) => { x.capUsd = cap; x.aiConfirmed = ai; });
      return finish(id, 'script', words || `Script approved, up to $${cap.toFixed(2)}; AI Employee ${ai === 'yes' ? 'confirmed' : 'not confirmed yet'}${bad.length ? ` (with ${bad.length} rules not met)` : ''}`);
    }
    case 'cast': {
      if (e.cast.some((c) => c.kind !== 'series' && c.kind !== 'described' && !c.imageAsset)) throw new ReelError('Someone still has no picture.');
      patch(id, (x) => { x.cast.forEach((c) => { c.approved = true; }); });
      return finish(id, 'cast', words || 'Characters and voices approved');
    }
    case 'storyboard': {
      const bad = musts(e.storyboard?.checks ?? []);
      if (bad.length) throw new ReelError(bad.map((c) => `${c.label} (${c.detail})`).join('; '));
      if (e.storyboard?.quoteUsd === null) throw new ReelError('There is no price yet: add the TopView key in Connections, then run this stage again. (Or import your own clips in Render.)');
      const ok = Number(b.confirmUsd), q = e.storyboard!.quoteUsd!;
      if (!(ok >= q - 0.005)) throw new ReelError(`The two parts are quoted at up to $${q.toFixed(2)}. Approve that amount to start.`);
      if (q > left(e) + 0.005) throw new ReelError(`That is above what’s left of this episode’s limit ($${left(e).toFixed(2)}). Raise the limit first.`);
      return finish(id, 'storyboard', words || `Storyboard approved; render both parts for up to $${q.toFixed(2)}`);
    }
    case 'review': return finish(id, 'review', words || 'Both parts approved');
    case 'edit': {
      const bad = musts(e.edit.checks);
      if (e.edit.studioSig && studioReady() && currentSig(e) !== e.edit.studioSig && !b.anyway) throw new ReelError('The editor has changes that aren’t in this cut yet. Make the cut again first.');
      if (bad.length && !b.anyway) throw new ReelError(`${bad.map((c) => `${c.label}: ${c.detail}`).join('; ')}. Fix it, or approve anyway.`);
      return finish(id, 'edit', words || `Cut v${e.edit.version} approved`);
    }
    case 'cover': {
      const f = String(b.file ?? '');
      if (!e.cover.candidates.some((c) => c.file === f)) throw new ReelError('Pick a cover first.');
      patch(id, (x) => { x.cover.picked = f; });
      return finish(id, 'cover', words || 'Cover approved');
    }
    case 'package': {
      const bad = musts(e.pack?.checks ?? []);
      if (bad.length) throw new ReelError(bad.map((c) => c.label).join('; '));
      if (!e.pack?.slot || !e.pack.platforms.length) throw new ReelError('Choose a slot and at least one platform.');
      const folder = writePack(e);
      patch(id, (x) => { x.pack!.folder = folder; x.schedule = { method: null, results: {} }; });
      return finish(id, 'package', words || `Captions approved for ${e.pack.slot.replace('T', ' ')} IST`);
    }
    default: throw new ReelError('That stage isn’t approved here.');
  }
}

/** A part or one shot again. `confirmUsd` is the owner's OK for the price shown. */
export async function quoteRetake(id: string, part: number, shot?: number, note = ''): Promise<{ usd: number; left: number }> {
  const e = getEpisode(id)!;
  if (!e.storyboard) throw new ReelError('Build the storyboard first.');
  const refs = partRefs(e, part);
  const body = shot ? retakeBody(e, part, shot, note, refs, videoNow(e, part, shot)).body : videoBody(note ? `${e.storyboard.prompts[part - 1]}\n\nMake sure: ${note}` : e.storyboard.prompts[part - 1], refs, videoNow(e, part));
  return { usd: (await tvQuote(MODEL_VIDEO, body)).worst, left: left(e) };
}
export async function retake(id: string, o: { part: number; shot?: number; note: string; confirmUsd: number }) {
  const e = getEpisode(id)!;
  if (running.has(id)) throw new ReelError('Wait for the running stage to finish.');
  const q = await quoteRetake(id, o.part, o.shot, o.note);
  if (!(o.confirmUsd >= q.usd - 0.005)) throw new ReelError(`That retake is now quoted at up to $${q.usd.toFixed(2)}. Approve that amount to start.`);
  if (q.usd > left(e) + 0.005) throw new ReelError(`That is above what’s left of this episode’s limit ($${left(e).toFixed(2)}).`);
  if (!e.stages.storyboard.approvedAt && e.render.parts.some((p) => p.picked === null)) throw new ReelError('Approve the storyboard first.');
  const at: StageId = e.render.parts.some((p) => p.picked === null) ? 'render' : 'review';
  log(id, at, 'approve', `Retake approved: part ${o.part}${o.shot ? `, shot ${o.shot}` : ''}, up to $${q.usd.toFixed(2)}${o.note ? `. “${o.note}”` : ''}`);
  const ctrl = new AbortController();
  running.set(id, { stage: at, ctrl });
  patch(id, (x) => { cascade(x, at); x.stages[at].status = 'running'; x.stages[at].progress = 'Retaking'; delete x.stages[at].error; });
  void (async () => {
    try {
      await renderOne(id, o.part, o.shot ? 'shot' : 'part', { shot: o.shot, note: o.note, signal: ctrl.signal, stage: at });
      if (at === 'render') {
        // a part is still missing: the stage waits for it, with the owner's own click
        if (!o.shot) { const rv = await reviewPart(getEpisode(id)!, o.part, { signal: ctrl.signal, say: (t) => say(id, at, t) }); patch(id, (x) => { x.review[o.part - 1] = { ...rv, notes: ['[again]'] }; }); await mouthCheck(id, o.part, ctrl.signal, (t) => say(id, at, t)).catch(() => {}); }
        patch(id, (x) => { x.stages.render.status = x.render.parts.every((p) => p.picked !== null) ? 'done' : 'ready'; x.stages.render.endedAt = now(); delete x.stages.render.progress; if (x.stages.render.status === 'done' && x.stages.review.status === 'idle') x.stages.review.status = 'ready'; });
        const q = getEpisode(id)!;
        if (q.stages.render.status === 'done') setTimeout(() => void start(id, 'review').catch(() => {}), 400); else tell(id, 'render', 'needs');
        return;
      }
      if (!o.shot) await runReview(id, ctrl.signal);
      needYou(id, 'review');
    } catch (err) { const m = (err as Error).message; patch(id, (x) => { x.stages[at].status = at === 'review' ? 'needs_you' : 'failed'; x.stages[at].error = m; delete x.stages[at].progress; }); log(id, at, 'error', m); tell(id, at, at === 'review' ? 'needs' : 'failed'); }
    finally { running.delete(id); }
  })();
}
/**
 * One line spoken again in the character's own voice and laid over the render (the picture is copied): for a word that
 * came out wrong or a voice that drifted. Pauses tightened, only sped up if it must be, loudness matched, no pitch shift.
 */
const own0 = (e: Episode, part: number, shot: number) => e.render.parts[part - 1].versions.some((q) => q.kind === 'shot' && q.shot === shot && q.state === 'completed' && q.file && !(q.note ?? '').startsWith('[off]'));
export async function revoice(id: string, part: number, shot: number) {
  const e = getEpisode(id)!;
  if (running.has(id)) throw new ReelError('Wait for the running stage to finish.');
  const rv = e.review[part - 1], s = e.script!.parts[part - 1], i = s.shots.findIndex((x) => x.n === shot), x = s.shots[i];
  const line = rv?.lines.find((l) => l.shot === shot);
  if (!rv || !x?.line || !line) throw new ReelError('That shot has no line to say again.');
  if (!own0(e, part, shot) && !(line.end > line.start)) throw new ReelError('That line wasn’t found in the sound, so there is no place to put it. Retake the shot instead.');
  // A retaken shot is its own clip with its own sound: the line is said again on that clip.
  const own = e.render.parts[part - 1].versions.filter((q) => q.kind === 'shot' && q.shot === shot && q.state === 'completed' && q.file && !(q.note ?? '').startsWith('[off]')).pop();
  const key = x.speaker!.toLowerCase(), c = e.cast.find((q) => q.key === key), k = series().cast.find((q) => q.key === key);
  const voice = c?.voice?.voiceId ? c.voice : k?.voiceId ? { voiceId: k.voiceId, stability: k.stability ?? 0.4, similarity: k.similarity ?? 0.75 } : null;
  if (!voice) throw new ReelError('That character’s ElevenLabs voice isn’t known here.');
  const ctrl = new AbortController(), base = e.render.parts[part - 1].picked, ver = e.render.parts[part - 1].versions.find((q) => q.v === base);
  if (!ver?.file) throw new ReelError('That part has no finished render.');
  running.set(id, { stage: 'review', ctrl });
  patch(id, (q) => { cascade(q, 'review'); q.stages.review.status = 'running'; q.stages.review.progress = `Part ${part}, shot ${shot}: saying it again`; delete q.stages.review.error; });
  log(id, 'review', 'approve', `Part ${part}, shot ${shot}: say it again in ${c?.name ?? key}’s own voice`);
  void (async () => {
    try {
      const n = Math.max(0, ...e.render.parts[part - 1].versions.map((q) => q.v)) + 1, take = ensureDir(epFile(e, `voice/p${part}s${shot}-v${n}.mp3`)), rel = own ? `renders/p${part}s${shot}-v${n}.mp4` : `renders/part${part}-v${n}.mp4`;
      await speak(voice.voiceId, x.line!, voice.stability, voice.similarity, take, ctrl.signal);
      if (own) {
        const clip = epFile(e, own.file!);
        say(id, 'review', `Part ${part}, shot ${shot}: finding the line in the retake`);
        const heard = (await py<{ words: [number, number, string][] }>('words', { file: clip }, { signal: ctrl.signal, minutes: 5 })).words;
        if (!heard.length) throw new ReelError('No line was heard in that retake, so there is no place to put the new one.');
        const r = await py<{ natural: number; tempo: number }>('voiceline', { file: clip, take, out: epFile(e, rel), a: heard[0][0], end: heard[heard.length - 1][1], limit: (await probe(clip)).seconds - 0.02, earliest: 0 }, { signal: ctrl.signal });
        patch(id, (q) => { q.render.parts[part - 1].versions.push({ v: n, kind: 'shot', provider: 'elevenlabs', state: 'completed', file: rel, usd: 0, shot, at: now(), note: `Said again by ${c?.name ?? key}, ${r.natural.toFixed(2)} s${r.tempo > 1.005 ? `, ${Math.round((r.tempo - 1) * 100)}% faster` : ''}` }); });
        needYou(id, 'review');
        return;
      }
      const next = Math.min(...rv.lines.filter((l) => l.start > line.start + 0.01).map((l) => l.start - 0.08), (rv.shotStarts[i + 1] ?? rv.frames) / rv.fps);
      say(id, 'review', `Part ${part}, shot ${shot}: laying it in`);
      const r = await py<{ natural: number; tempo: number }>('voiceline', { file: epFile(e, ver.file!), take, out: epFile(e, rel), a: line.start, end: line.end, limit: next, earliest: Math.max(rv.shotStarts[i] / rv.fps, ...rv.lines.filter((l) => l.end < line.start + 0.01 && l !== line).map((l) => l.end + 0.08)) }, { signal: ctrl.signal });
      patch(id, (q) => {
        const p = q.render.parts[part - 1];
        p.versions.push({ v: n, kind: 'voice', provider: 'elevenlabs', state: 'completed', file: rel, usd: 0, shot, at: now(), note: `Shot ${shot}: ${c?.name ?? key} again, ${r.natural.toFixed(2)} s${r.tempo > 1.005 ? `, ${Math.round((r.tempo - 1) * 100)}% faster` : ''}` });
        p.picked = n;
        if (part === 2 && q.render.lead?.v === base) q.render.lead.v = n; // the picture is the same
      });
      const again = await reviewPart(getEpisode(id)!, part, { signal: ctrl.signal, say: (t) => say(id, 'review', t) });
      patch(id, (q) => { q.review[part - 1] = { ...again, notes: rv.notes }; });
      needYou(id, 'review');
    } catch (err) { const m = (err as Error).message; patch(id, (q) => { q.stages.review.status = 'needs_you'; q.stages.review.error = m; delete q.stages.review.progress; }); log(id, 'review', 'error', m); tell(id, 'review', 'needs'); }
    finally { running.delete(id); }
  })();
}
/** The owner's own clip as a part (made somewhere else): no cost here. */
export async function importPart(id: string, part: number, tmp: string) {
  const e = getEpisode(id)!;
  if (running.has(id)) throw new ReelError('Wait for the running stage to finish.');
  const pr = await probe(tmp);
  if (!pr.width || pr.height <= pr.width || pr.seconds < 20 || pr.seconds > 40) throw new ReelError('A part is a vertical video of about 30 seconds.');
  const n = Math.max(0, ...e.render.parts[part - 1].versions.map((x) => x.v)) + 1, rel = `renders/part${part}-v${n}.mp4`;
  ensureDir(epFile(e, rel));
  fs.copyFileSync(tmp, epFile(e, rel));
  patch(id, (x) => {
    x.render.parts[part - 1].versions.push({ v: n, kind: 'import', provider: 'import', state: 'completed', file: rel, usd: 0, at: now(), note: 'Your own clip' });
    x.render.parts[part - 1].picked = n; x.review[part - 1] = null; cascade(x, 'render');
    if (x.render.parts.every((p) => p.picked !== null)) { x.stages.render.status = 'done'; x.stages.render.endedAt = now(); delete x.stages.render.error; if (x.stages.review.status === 'idle') x.stages.review.status = 'ready'; }
  });
  log(id, 'render', 'change', `Part ${part}: your own clip was added`);
}
export function pickVersion(id: string, part: number, v: number) {
  patch(id, (x) => { const q = x.render.parts[part - 1].versions.find((z) => z.v === v && z.state === 'completed'); if (!q) throw new ReelError('That version isn’t finished.'); if (q.kind === 'shot') { q.note = (q.note ?? '').startsWith('[off]') ? (q.note ?? '').replace(/^\[off\]\s*/, '') : `[off] ${q.note ?? ''}`; cascade(x, 'review'); } else { x.render.parts[part - 1].picked = v; x.review[part - 1] = null; cascade(x, 'render'); if (['done', 'needs_you', 'stale'].includes(x.stages.review.status)) x.stages.review.status = 'ready'; } });
}

/** After a restart: paid jobs are waited for again; anything else that was mid-way says so. */
export function resumeReels() {
  for (const e of allEpisodes()) {
    const s = STAGES.find((x) => e.stages[x].status === 'running');
    if (!s) continue;
    if (s === 'schedule') {
      patch(e.id, (x) => { x.stages.schedule.status = 'needs_you'; delete x.stages.schedule.progress; for (const [k, r] of Object.entries(x.schedule.results)) if (r.status === 'asked') x.schedule.results[k] = { status: 'failed', at: now(), note: 'HeyZubi restarted while this was being scheduled. Say “schedule” again: what is scheduled already is found and not done twice.' }; });
      continue;
    }
    const paid = e.render.parts.some((p) => p.versions.some((v) => v.state === 'submitted' && v.task)) || e.cast.some((c) => c.task);
    patch(e.id, (x) => { x.stages[s].status = paid && s === 'review' ? 'needs_you' : 'failed'; x.stages[s].error = 'HeyZubi restarted while this was working. Press Run again: paid jobs are picked up where they were, not paid twice.'; delete x.stages[s].progress; });
    if (paid && (s === 'render' || s === 'cast')) { patch(e.id, (x) => { x.stages[s].status = 'ready'; delete x.stages[s].error; }); void start(e.id, s).catch((err) => console.warn('[reels] resume:', (err as Error).message)); }
  }
}
