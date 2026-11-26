// /api/social: the Reels Factory. Every route is the signed-in owner's; an episode belongs to one person.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Hono, type Context } from 'hono';
import type { AuthVars } from '../lib/auth.js';
import { now } from '../db.js';
import { primaryBotId } from '../engine.js';
import { appendRow, getBotRow } from '../store.js';
import { enqueue } from '../agent/loop.js';
import { giveToHermes } from '../engine.js';
import { env } from '../env.js';
import { packChecks } from './checks.js';
import { accounts, browserOpen, closeBrowser, openForSignIn, PLATFORMS, postingBusy, signedIn, type Platform } from './poster.js';
import { kieCheck, tvCheck, ProviderError } from './providers.js';
import { chat, decide, editShot, send, stopChat, tidyLooks } from './agent.js';
import { partFile } from './edit.js';
import { grab } from './media.js';
import { askSchedule, markSchedule } from './flow.js';
import { openStudio, putBack, studioReady, studioState } from './studio.js';
import { addCover, approve, blocked, changeCut, importPart, isRunning, left, pickVersion, quoteRender, quoteRetake, recheck, retake, revoice, shotTime, start, stop } from './stages.js';
import { blockSlot, deleteEpisode, epDir, epFile, events, formula, getEpisode, getKey, istToMs, listEpisodes, log, newEpisode, nextNum, ownerOf, patch, ReelError, series, seriesDir, seriesReady, setKey, slotLabel, slots, spent, type KeyName } from './store.js';
import { STAGES, type Episode, type StageId } from './types.js';

export const socialApi = new Hono<AuthVars>();
socialApi.onError((e, c) => {
  if (e instanceof ReelError || e instanceof ProviderError) return c.json({ error: e.message }, 400);
  console.warn('[reels] request failed:', e);
  return c.json({ error: 'That didn’t work just now.' }, 500);
});
const body = async (c: Context): Promise<any> => (await c.req.json().catch(() => null)) ?? {};
function mine(c: Context<AuthVars>): Episode {
  const id = c.req.param('id')!;
  const e = ownerOf(id) === c.get('user').id ? getEpisode(id) : null;
  if (!e) throw new ReelError('That episode isn’t here.');
  return e;
}
const stageOf = (c: Context): StageId => { const s = c.req.param('stage') as StageId; if (!STAGES.includes(s)) throw new ReelError('No such stage.'); return s; };
const regulars = (): string[] => (seriesReady() ? Object.values(formula().names) : []);
const brief = (e: Episode) => ({ id: e.id, num: e.num, title: e.title, updatedAt: e.updatedAt, createdAt: e.createdAt, archived: !!e.archived, stages: Object.fromEntries(STAGES.map((s) => [s, e.stages[s].status])), progress: STAGES.map((s) => (e.stages[s].status === 'running' ? e.stages[s].progress : null)).find(Boolean) ?? null, spent: spent(e), cap: e.capUsd, cover: e.cover.picked, slot: e.pack?.slot ?? null, trade: e.script?.trade ?? e.story.picked?.trade ?? '', aiEmployee: e.script?.aiEmployee.name ?? '', keyword: e.script?.keywords.primary ?? '', cast: (e.script?.cast ?? []).map((c) => c.name).filter((n) => !regulars().includes(n)), platforms: e.pack?.platforms ?? [], links: Object.fromEntries(Object.entries(e.schedule.results).filter(([, r]) => r.link).map(([k, r]) => [k, r.link!])), scheduled: e.stages.schedule.status === 'done' });
const full = (e: Episode) => ({ ...e, spent: spent(e), running: isRunning(e.id), blocked: Object.fromEntries(STAGES.map((s) => [s, blocked(e, s)])), events: events(e.id), studio: studioReady() ? studioState(e) : null });

socialApi.get('/', (c) => {
  const u = c.get('user').id, ready = seriesReady();
  const sr = ready ? series() : null;
  return c.json({
    ready, series: sr && { name: sr.name, handle: sr.handle, hookTypes: sr.hookTypes, assetsExpire: sr.assetsExpire, cast: sr.cast.map((x) => ({ key: x.key, name: x.name, about: x.about, image: x.image, look: x.castLine, voice: x.voice, role: x.key === formula().roles.hero ? 'hero' : x.key === formula().roles.closer ? 'closer' : '' })), voices: sr.voices.length },
    episodes: listEpisodes(u).map(brief), history: (sr?.history ?? []).map((h) => ({ num: h.num, title: h.title, trade: h.trade, aiEmployee: h.aiEmployee, slot: h.slot, usd: h.usd, status: h.status, cast: h.cast, hook: h.hook, cover: h.cover ?? null, links: h.links ?? {}, youtubeAt: h.youtubeAt ?? null, youtubeTitle: h.youtubeTitle ?? '', keyword: h.keyword ?? '', platforms: h.platforms ?? [], page: /^https:\/\//.test(h.page ?? '') ? h.page : '', pagePreview: h.pagePreview ?? null })),
    slots: ready ? slots(u, 10) : [], next: nextNum(u), keys: { topview: !!getKey('topview'), kie: !!getKey('kie') },
  });
});
socialApi.get('/posting', (c) => c.json({ signedIn: signedIn(), open: browserOpen(), busy: postingBusy(), accounts: { instagram: accounts().instagram?.handle ?? null, facebook: accounts().facebook?.page ?? null, youtube: accounts().youtube ? 'your channel' : null } }));
socialApi.post('/posting/open', async (c) => { const p = STR((await body(c)).platform, 20); if (!PLATFORMS.includes(p as Platform)) throw new ReelError('No such platform.'); await openForSignIn(p as Platform); return c.json({ ok: true }); });
socialApi.post('/posting/close', async (c) => { if (postingBusy()) throw new ReelError('It is scheduling right now.'); await closeBrowser(); return c.json({ ok: true }); });
socialApi.put('/keys/:name', async (c) => {
  const name = c.req.param('name') as KeyName;
  if (name !== 'topview' && name !== 'kie') throw new ReelError('No such key.');
  const v = String((await body(c)).key ?? '').trim();
  if (v && (v.length < 12 || v.length > 400 || /\s/.test(v))) throw new ReelError('That doesn’t look like a key.');
  const before = getKey(name);
  setKey(name, v);
  if (v) { try { await (name === 'topview' ? tvCheck() : kieCheck()); } catch (e) { setKey(name, before); throw e; } }
  return c.json({ ok: true, set: !!v });
});
socialApi.post('/slots/block', async (c) => { const b = await body(c); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(String(b.at))) throw new ReelError('No such slot.'); blockSlot(String(b.at), b.why ? String(b.why) : null); return c.json({ slots: slots(c.get('user').id, 10) }); });

socialApi.post('/episodes', async (c) => {
  const b = await body(c), u = c.get('user').id;
  if (!seriesReady()) throw new ReelError('The series isn’t set up on the server yet.');
  const num = Number(b.num) || nextNum(u);
  if (!(num > 0 && num < 1000)) throw new ReelError('Give the episode a number.');
  if (listEpisodes(u).some((x) => x.num === num) || series().history.some((h) => h.num === num)) throw new ReelError(`Episode ${num} already exists.`);
  const e = newEpisode(u, { num, brief: String(b.brief ?? '').trim().slice(0, 1500), hookStyle: String(b.hookStyle ?? '').slice(0, 120), capUsd: 0 });
  log(e.id, null, 'info', `Episode ${num} started`);
  await start(e.id, 'story');
  return c.json({ episode: full(getEpisode(e.id)!) });
});
socialApi.get('/episodes/:id', (c) => c.json({ episode: full(mine(c)), slots: slots(c.get('user').id, 12, c.req.param('id')) }));
socialApi.delete('/episodes/:id', async (c) => {
  const e = mine(c);
  if (isRunning(e.id)) throw new ReelError('Stop the running stage first.');
  if (c.req.query('confirm') !== String(e.num)) throw new ReelError('Not confirmed.');
  deleteEpisode(e.id);
  fs.rmSync(epDir(e.num), { recursive: true, force: true });
  return c.json({ ok: true });
});
socialApi.post('/episodes/:id/archive', async (c) => { const e = mine(c); const on = !!(await body(c)).on; patch(e.id, (x) => { x.archived = on; }); return c.json({ ok: true }); });
socialApi.post('/episodes/:id/auto', async (c) => { const e = mine(c); const on = !!(await body(c)).on; patch(e.id, (x) => { x.auto = on; }); return c.json({ episode: full(getEpisode(e.id)!) }); });
socialApi.post('/episodes/:id/cap', async (c) => {
  const e = mine(c), usd = Number((await body(c)).usd);
  if (!(usd >= spent(e) && usd <= 60)) throw new ReelError('The limit has to be at least what is already spent, and at most $60.');
  patch(e.id, (x) => { x.capUsd = usd; });
  log(e.id, null, 'approve', `Spending limit set to $${usd.toFixed(2)}`);
  return c.json({ episode: full(getEpisode(e.id)!) });
});
socialApi.post('/episodes/:id/stages/:stage/run', async (c) => {
  const e = mine(c), s = stageOf(c), b = await body(c);
  // Anything that would start a paid job outside the approved plan is asked for with its price (retakes, storyboard approval).
  const opts: Record<string, any> = {};
  if (s === 'script' && b.note) opts.note = String(b.note).slice(0, 2000);
  if (s === 'cast' && b.key) {
    opts.key = String(b.key); opts.what = b.what === 'voice' ? 'voice' : 'image';
    if (typeof b.prompt === 'string' && b.prompt.trim()) patch(e.id, (x) => { const m = x.cast.find((q) => q.key === opts.key); if (m && m.kind !== 'series') m.imagePrompt = b.prompt.trim().slice(0, 2500); });
    if (b.voice?.voiceId) patch(e.id, (x) => { const m = x.cast.find((q) => q.key === opts.key); if (m?.voice) Object.assign(m.voice, { voiceId: String(b.voice.voiceId).slice(0, 60), voiceName: String(b.voice.voiceName ?? '').slice(0, 60), stability: Math.min(1, Math.max(0, Number(b.voice.stability) || 0.4)), sample: String(b.voice.sample ?? m.voice.sample).slice(0, 300) }); });
  }
  if (s === 'review') patch(e.id, (x) => { if (b.again) x.review = [null, null]; });
  if (s === 'render' && !e.stages.storyboard.approvedAt) throw new ReelError('Approve the storyboard and its price first.');
  await start(e.id, s, opts);
  return c.json({ episode: full(getEpisode(e.id)!) });
});
socialApi.post('/episodes/:id/stop', (c) => { const e = mine(c); if (!stop(e.id)) throw new ReelError('Nothing is running.'); return c.json({ ok: true }); });
socialApi.post('/episodes/:id/stages/:stage/approve', async (c) => { const e = mine(c); approve(e.id, stageOf(c), await body(c)); return c.json({ episode: full(getEpisode(e.id)!) }); });
/** Take an approval back: the stage opens again, and what came after it is out of date. */
socialApi.post('/episodes/:id/stages/:stage/reopen', async (c) => {
  const e = mine(c), s = stageOf(c);
  if (isRunning(e.id)) throw new ReelError('Wait for the running stage to finish.');
  patch(e.id, (x) => { if (x.stages[s].status !== 'done') throw new ReelError('That stage isn’t finished.'); x.stages[s].status = 'needs_you'; delete x.stages[s].approvedAt; delete x.stages[s].approval; for (const t of STAGES.slice(STAGES.indexOf(s) + 1)) if (['done', 'needs_you'].includes(x.stages[t].status)) x.stages[t].status = 'stale'; else if (x.stages[t].status === 'ready') x.stages[t].status = 'idle'; });
  log(e.id, s, 'change', 'Opened again');
  return c.json({ episode: full(getEpisode(e.id)!) });
});

const STR = (v: unknown, n: number) => String(v ?? '').slice(0, n);
socialApi.patch('/episodes/:id/script', async (c) => {
  const e = mine(c), b = await body(c);
  if (isRunning(e.id)) throw new ReelError('Wait for the running stage to finish.');
  if (!e.script || e.stages.script.status !== 'needs_you') throw new ReelError('The script is approved. Open that stage again to change it.');
  patch(e.id, (x) => {
    const s = x.script!;
    if (b.shot) { const q = s.parts[Number(b.part) - 1]?.shots.find((z) => z.n === Number(b.shot)); if (!q) throw new ReelError('No such shot.'); for (const k of ['line', 'delivery', 'picture', 'camera', 'caption'] as const) if (b[k] !== undefined) (q as any)[k] = STR(b[k], 600).trim() || undefined; if (!q.picture) q.picture = ''; if (!q.camera) q.camera = 'Medium close-up, 50mm, eye-level, static'; }
    if (b.screen && s.screens[b.screen] && b.data && typeof b.data === 'object') s.screens[b.screen] = JSON.parse(JSON.stringify(b.data).slice(0, 6000));
    for (const k of ['tip', 'forward', 'honesty', 'question', 'altText'] as const) if (b[k] !== undefined) (s as any)[k] = STR(b[k], 600);
    if (b.caption) { if (b.caption.line1 !== undefined) s.caption.line1 = STR(b.caption.line1, 300); if (b.caption.story !== undefined) s.caption.story = STR(b.caption.story, 900); }
    recheck(x);
  });
  return c.json({ episode: full(getEpisode(e.id)!) });
});
socialApi.patch('/episodes/:id/screens/:screen', async (c) => {
  const e = mine(c), b = await body(c), k = c.req.param('screen');
  if (isRunning(e.id)) throw new ReelError('Wait for the running stage to finish.');
  if (!e.script?.screens[k] || typeof b.data !== 'object') throw new ReelError('No such screen.');
  if (/\bdemo\b/i.test(JSON.stringify(b.data))) throw new ReelError('No DEMO word on a screen.');
  patch(e.id, (x) => { x.script!.screens[k] = JSON.parse(JSON.stringify(b.data).slice(0, 6000)); if (x.stages.screens.status === 'done') { x.stages.screens.status = 'ready'; for (const t of ['storyboard', 'edit', 'cover', 'package'] as StageId[]) if (['done', 'needs_you'].includes(x.stages[t].status)) x.stages[t].status = 'stale'; } });
  await start(e.id, 'screens');
  return c.json({ episode: full(getEpisode(e.id)!) });
});
// ---------- the storyboard: stills, changes to a shot, and comments ----------
socialApi.get('/episodes/:id/still', async (c) => {
  const e = mine(c), part = c.req.query('part') === '2' ? 2 : 1, n = Number(c.req.query('shot')), v = partFile(e, part), i = e.script?.parts[part - 1].shots.findIndex((x) => x.n === n) ?? -1;
  if (!v?.file || i < 0) return c.json({ error: 'not found' }, 404);
  const re = e.render.parts[part - 1].versions.filter((q) => q.kind === 'shot' && q.shot === n && q.state === 'completed' && q.file && !(q.note ?? '').startsWith('[off]')).pop();
  const rv = e.review[part - 1], s = e.script!.parts[part - 1].shots, a = rv ? rv.shotStarts[i] / rv.fps : s[i].start, b = rv ? (rv.shotStarts[i + 1] ?? rv.frames) / rv.fps : s[i].end;
  const rel = `stills/p${part}s${n}-v${re?.v ?? v.v}-${re ? 'r' : Math.round(a * 100)}.jpg`, f = epFile(e, rel);
  if (!fs.existsSync(f)) await grab(epFile(e, re ? re.file! : v.file), re ? Math.max(0.3, (b - a) / 2) : a + (b - a) * 0.45, f);
  return serve(c, epDir(e.num), rel);
});
socialApi.patch('/episodes/:id/shot', async (c) => { const e = mine(c), b = await body(c); editShot(e.id, Number(b.part) === 2 ? 2 : 1, Number(b.shot), b.set && typeof b.set === 'object' ? b.set : {}); return c.json({ episode: full(getEpisode(e.id)!) }); });
socialApi.post('/episodes/:id/shot/time', async (c) => { const e = mine(c), b = await body(c); shotTime(e.id, Number(b.part) === 2 ? 2 : 1, Number(b.shot), Number(b.end)); return c.json({ episode: full(getEpisode(e.id)!) }); });
socialApi.post('/episodes/:id/comments', async (c) => {
  const e = mine(c), b = await body(c), text = STR(b.text, 1200).trim();
  if (!text) throw new ReelError('Write the comment first.');
  if ((e.comments ?? []).length >= 200) throw new ReelError('That is a lot of comments; delete some first.');
  const unit = (v: unknown) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Math.min(1, Math.max(0, Number(v))) : undefined);
  const shot = Number(b.shot) > 0 ? Number(b.shot) : undefined, part = Number(b.part) === 2 ? 2 : 1;
  patch(e.id, (x) => { x.comments = [...(x.comments ?? []), { id: crypto.randomUUID().slice(0, 8), at: now(), text, ...(shot ? { part, shot } : {}), ...(shot && unit(b.x) !== undefined ? { x: unit(b.x), y: unit(b.y) ?? 0.5 } : {}), ...(Number(b.t) >= 0 && b.t !== undefined && b.t !== null ? { t: Number(b.t) } : {}) }]; });
  return c.json({ episode: full(getEpisode(e.id)!) });
});
socialApi.patch('/episodes/:id/comments/:cid', async (c) => { const e = mine(c), b = await body(c), cid = c.req.param('cid'); patch(e.id, (x) => { const q = x.comments?.find((z) => z.id === cid); if (!q) throw new ReelError('That comment isn’t here any more.'); if (b.done !== undefined) q.done = !!b.done; if (b.text !== undefined && STR(b.text, 1200).trim()) q.text = STR(b.text, 1200).trim(); }); return c.json({ episode: full(getEpisode(e.id)!) }); });
socialApi.delete('/episodes/:id/comments/:cid', (c) => { const e = mine(c), cid = c.req.param('cid'); patch(e.id, (x) => { x.comments = (x.comments ?? []).filter((z) => z.id !== cid); }); return c.json({ episode: full(getEpisode(e.id)!) }); });
// The session window: free instructions to the owner's agent (agent.ts).
socialApi.get('/episodes/:id/chat', async (c) => c.json(await chat(mine(c).id, Number(c.req.query('talk')) || undefined)));
socialApi.post('/episodes/:id/chat', async (c) => { const e = mine(c), b = await body(c); tidyLooks(e); const talk = await send(e.id, STR(b.text, 4000), Number(b.talk) || undefined); return c.json(await chat(e.id, talk)); });
socialApi.post('/episodes/:id/chat/stop', (c) => { const e = mine(c); stopChat(e.id); return c.json({ ok: true }); });
socialApi.post('/episodes/:id/chat/decide', async (c) => { const e = mine(c), b = await body(c); const talk = await decide(e.id, Number(b.msg), Number(b.i), b.yes === true); return c.json(await chat(e.id, talk)); });
socialApi.post('/episodes/:id/render/quote', async (c) => { const e = mine(c), want = [2, 1].filter((p) => e.render.parts[p - 1].picked === null); return c.json({ parts: want, usd: want.length ? await quoteRender(e.id, want) : 0, left: left(e) }); });
socialApi.post('/episodes/:id/retake/quote', async (c) => { const e = mine(c), b = await body(c); return c.json(await quoteRetake(e.id, Number(b.part) === 2 ? 2 : 1, b.shot ? Number(b.shot) : undefined, STR(b.note, 500))); });
socialApi.post('/episodes/:id/retake', async (c) => { const e = mine(c), b = await body(c); await retake(e.id, { part: Number(b.part) === 2 ? 2 : 1, shot: b.shot ? Number(b.shot) : undefined, note: STR(b.note, 500), confirmUsd: Number(b.confirmUsd) }); return c.json({ episode: full(getEpisode(e.id)!) }); });
socialApi.post('/episodes/:id/version', async (c) => { const e = mine(c), b = await body(c); if (isRunning(e.id)) throw new ReelError('Wait for the running stage to finish.'); pickVersion(e.id, Number(b.part) === 2 ? 2 : 1, Number(b.v)); return c.json({ episode: full(getEpisode(e.id)!) }); });
socialApi.post('/episodes/:id/provider', async (c) => { const e = mine(c), b = await body(c); patch(e.id, (x) => { x.render.provider = b.provider === 'kie' ? 'kie' : 'topview'; }); return c.json({ episode: full(getEpisode(e.id)!) }); });
const CLIP_MAX = 200 * 1024 * 1024;
socialApi.put('/episodes/:id/import/:part', async (c) => {
  const e = mine(c), part = c.req.param('part') === '2' ? 2 : 1;
  if (!e.script || !['done', 'needs_you'].includes(e.stages.script.status)) throw new ReelError('Write the script first.');
  if (Number(c.req.header('content-length') ?? 0) > CLIP_MAX || !c.req.raw.body) throw new ReelError('Choose a video of at most 200 MB.');
  const tmp = path.join(os.tmpdir(), `reel-${crypto.randomUUID()}.mp4`);
  try {
    let n = 0;
    const src = Readable.fromWeb(c.req.raw.body as any);
    src.on('data', (d: Buffer) => { n += d.length; if (n > CLIP_MAX) src.destroy(new ReelError('That clip is too big.')); });
    await pipeline(src, fs.createWriteStream(tmp, { mode: 0o600 }));
    await importPart(e.id, part, tmp);
  } finally { fs.rmSync(tmp, { force: true }); }
  return c.json({ episode: full(getEpisode(e.id)!) });
});
socialApi.post('/episodes/:id/revoice', async (c) => { const e = mine(c), b = await body(c); if (!['needs_you', 'done', 'stale'].includes(e.stages.review.status)) throw new ReelError('The review hasn’t run yet.'); await revoice(e.id, Number(b.part) === 2 ? 2 : 1, Number(b.shot)); return c.json({ episode: full(getEpisode(e.id)!) }); });
socialApi.post('/episodes/:id/ai-employee', async (c) => { const e = mine(c); if (e.aiConfirmed !== 'yes') { patch(e.id, (x) => { x.aiConfirmed = 'yes'; if (x.pack) x.pack.checks = packChecks(x, series()); }); log(e.id, null, 'approve', 'Confirmed: one of your AI Employees really does this'); } return c.json({ episode: full(getEpisode(e.id)!) }); });
socialApi.patch('/episodes/:id/edit', async (c) => {
  const e = mine(c), b = await body(c);
  changeCut(e.id, b);
  return c.json({ episode: full(getEpisode(e.id)!) });
});
/** The HyperFrames editor: gets the episode ready and gives the address to show. `again` looks for changes, `fresh` starts over. */
socialApi.post('/episodes/:id/editor', async (c) => {
  const e = mine(c), b = await body(c);
  if (b.fresh && isRunning(e.id)) throw new ReelError('Wait for the running stage to finish.');
  if (b.fresh) log(e.id, 'edit', 'change', 'The editor started over from the automatic cut');
  return c.json({ ...(await openStudio(e, b.again === true || b.fresh === true, b.fresh === true)), episode: full(getEpisode(e.id)!) });
});
socialApi.post('/episodes/:id/editor/put-back', async (c) => {
  const e = mine(c), b = await body(c), part = Number(b.part) === 2 ? 2 : 1, shot = Number(b.shot);
  if (!e.script?.parts[part - 1].shots.some((x) => x.n === shot)) throw new ReelError('No such shot.');
  const now = patch(e.id, (x) => { x.edit.options.dropShots = x.edit.options.dropShots.filter((d) => !(d.part === part && d.shot === shot)); });
  putBack(now, part, shot);
  await openStudio(now, true, false);
  return c.json({ episode: full(getEpisode(e.id)!) });
});
socialApi.post('/episodes/:id/cover', async (c) => { const e = mine(c); if (!e.edit.final) throw new ReelError('Make the cut first.'); await addCover(e.id, Number((await body(c)).t)); return c.json({ episode: full(getEpisode(e.id)!) }); });
socialApi.patch('/episodes/:id/pack', async (c) => {
  const e = mine(c), b = await body(c);
  if (!e.pack || e.stages.package.status !== 'needs_you') throw new ReelError('Open the captions stage again to change them.');
  patch(e.id, (x) => {
    const p = x.pack!;
    for (const k of ['instagram', 'facebook', 'commentInstagram', 'commentFacebook', 'whatsapp', 'youtubeComment', 'altText', 'youtubeTitle', 'youtubeDescription'] as const) if (b[k] !== undefined) (p as any)[k] = STR(b[k], 2200);
    if (Array.isArray(b.facebookTags)) p.facebookTags = b.facebookTags.map((t: unknown) => STR(t, 60).trim()).filter(Boolean).slice(0, 10);
    if (Array.isArray(b.youtubeTags)) p.youtubeTags = b.youtubeTags.map((t: unknown) => STR(t, 60).trim()).filter(Boolean).slice(0, 20);
    if (Array.isArray(b.platforms)) p.platforms = b.platforms.filter((t: unknown) => ['instagram', 'facebook', 'youtube', 'whatsapp'].includes(String(t)));
    if (b.slot !== undefined) { const s = slots(c.get('user').id, 20, x.id).find((q) => q.at === b.slot); if (!s || s.taken) throw new ReelError('That slot is taken or past.'); p.slot = String(b.slot); }
    p.checks = packChecks(x, series());
  });
  return c.json({ episode: full(getEpisode(e.id)!) });
});

/** The owner asks Zubi to schedule it, with everything that will be posted shown to them first (confirm: true). */
socialApi.post('/episodes/:id/schedule', async (c) => {
  const e = mine(c), b = await body(c), p = e.pack;
  if (!p?.slot || !p.folder || e.stages.package.status !== 'done') throw new ReelError('Approve the captions first.');
  if (b.method === 'self') { patch(e.id, (x) => { x.schedule.method = 'self'; x.stages.schedule.status = 'needs_you'; }); return c.json({ episode: full(getEpisode(e.id)!) }); }
  if (b.confirm !== true) throw new ReelError('Confirm what will be scheduled first.');
  askSchedule(e.id, '');
  return c.json({ episode: full(getEpisode(e.id)!) });
});
socialApi.post('/episodes/:id/schedule/mark', async (c) => {
  const e = mine(c), b = await body(c);
  markSchedule(e.id, STR(b.platform, 20), b.status, STR(b.link, 300), STR(b.note, 300), 'you');
  return c.json({ episode: full(getEpisode(e.id)!) });
});
/** For the team member's tool: by episode number, only while it was asked to schedule it. */
export function reportSchedule(num: number, platform: string, status: string, link: string, note: string): string {
  const zubi = primaryBotId(), owner = zubi ? getBotRow(zubi)?.user_id : null;
  const e = owner ? listEpisodes(owner).find((x) => x.num === num) : null;
  if (!e || e.schedule.method !== 'zubi' || !e.schedule.results[platform]) return 'No episode with that number is waiting to be scheduled by you on that platform.';
  try { markSchedule(e.id, platform, status, link, note, 'Zubi'); return 'Noted in Reels Factory.'; } catch (err) { return (err as Error).message; }
}

// ---------- files ----------
const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.png': 'image/png', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.ass': 'text/plain; charset=utf-8' };
function serve(c: Context, root: string, rel: string) {
  const f = path.resolve(root, rel), type = TYPES[path.extname(f).toLowerCase()];
  if (!f.startsWith(path.resolve(root) + path.sep) || !type || !fs.existsSync(f) || !fs.realpathSync(f).startsWith(fs.realpathSync(root) + path.sep)) return c.json({ error: 'not found' }, 404);
  const size = fs.statSync(f).size;
  const h: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff', ...(c.req.query('download') ? { 'Content-Disposition': `attachment; filename="${path.basename(f).replace(/[^\w.-]/g, '_')}"` } : {}) };
  const m = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
  if (m && (m[1] || m[2])) {
    const a = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])), b = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    if (a > b || a >= size) return c.body(null, 416, { 'Content-Range': `bytes */${size}` });
    return c.body(Readable.toWeb(fs.createReadStream(f, { start: a, end: b })) as any, 206, { ...h, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': String(b - a + 1) });
  }
  return c.body(Readable.toWeb(fs.createReadStream(f)) as any, 200, { ...h, 'Content-Length': String(size) });
}
socialApi.get('/episodes/:id/file', (c) => { const e = mine(c); return serve(c, epDir(e.num), c.req.query('path') ?? ''); });
socialApi.get('/series/file', (c) => { const p = c.req.query('path') ?? ''; if (!/^(cast|voices|sfx|music|covers|pages)\/[\w.-]+$/.test(p) || p.includes('..')) return c.json({ error: 'not found' }, 404); return serve(c, seriesDir(), p); });
