// Generation: the TopView Platform API first, kie.ai as the fallback, ElevenLabs voices through Zubi's Composio.
// The spend rules are the series' own: a free quote before every paid job, the worst case checked against what the owner
// approved, and every job written to a log before it is sent, so a dropped connection never loses or repeats a payment.
import fs from 'node:fs';
import path from 'node:path';
import { TokenExpired, zubiComposio } from '../panels.js';
import { withoutVideo } from './prompts.js';
import { wakeApps } from './writer.js';
import { ensureDir, getKey, ReelError, socialDir } from './store.js';

const BASE = (process.env.TOPVIEW_API_BASE || 'https://platform-backend.topview.ai').replace(/\/+$/, '');
export const MODEL_VIDEO = 'bytedance/seedance-2.5/omni-reference-to-video';
export const MODEL_IMAGE = 'google/nano-banana-2/edit';

export class ProviderError extends Error { constructor(m: string, public status = 0, public transient = false) { super(m); } }

const logFile = () => path.join(socialDir(), 'generation-log.jsonl');
function logLine(o: object) { try { ensureDir(logFile()); fs.appendFileSync(logFile(), JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n', { mode: 0o600 }); } catch (e) { console.warn('[reels] log not written:', (e as Error).message); } }
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); rej(new ReelError('Stopped by you.')); }, { once: true }); });

async function tv(method: string, p: string, o: { json?: unknown; form?: FormData; headers?: Record<string, string>; tries?: number } = {}): Promise<any> {
  const key = getKey('topview');
  if (!key) throw new ReelError('TopView needs its key: add it in Reels Factory › Connections.');
  const tries = o.tries ?? 5;
  for (let i = 1, wait = 2000; ; i++, wait = Math.min(wait * 2, 30_000)) {
    let err: ProviderError;
    try {
      const r = await fetch(BASE + p, { method, signal: AbortSignal.timeout(90_000), headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(o.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...o.headers }, body: o.form ?? (o.json !== undefined ? JSON.stringify(o.json) : undefined) });
      const text = await r.text();
      let j: any = {}; try { j = JSON.parse(text); } catch { /* not JSON */ }
      if (r.ok && (j.code === 200 || j.code === undefined || j.code === null)) return j.data ?? j;
      const msg = [j.code, j.error, j.message].filter(Boolean).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' · ') || text.slice(0, 200);
      err = new ProviderError(r.status === 401 || r.status === 403 ? `TopView refused the key (${msg}).` : `TopView: ${msg}`, r.status, r.status === 429 || r.status >= 500);
      const ra = Number(r.headers.get('retry-after')); if (ra > 0) wait = Math.min(ra * 1000, 60_000);
    } catch (e) { err = new ProviderError(`TopView couldn’t be reached (${(e as Error).name}).`, 0, true); }
    if (!err.transient || i >= tries) throw err;
    await sleep(wait);
  }
}
const modelPath = (m: string) => '/api/v1/models/' + m.split('/').map(encodeURIComponent).join('/') + '/predictions';

export const tvCheck = async (): Promise<number> => Number((await tv('GET', '/api/v1/media/files', { tries: 2 })).total ?? 0);

export async function tvUpload(file: string, kind: 'image' | 'audio' | 'video'): Promise<string> {
  const buf = fs.readFileSync(file);
  if (!buf.length || buf.length > 20 * 1024 * 1024) throw new ReelError(`${path.basename(file)} is empty or over TopView’s 20 MB limit.`);
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp3: 'audio/mpeg', mp4: 'video/mp4' } as Record<string, string>)[ext] ?? 'application/octet-stream';
  const form = new FormData();
  form.set('kind', kind); form.set('file', new Blob([buf], { type }), path.basename(file));
  const d = await tv('POST', '/api/v1/media/files', { form });
  const id = String(d.id ?? d.asset_id ?? d.assetId ?? '');
  if (!id) throw new ReelError('TopView took the file but gave no id for it.');
  return id;
}
async function assetUrl(id: string): Promise<string> {
  for (let i = 0; i < 12; i++) {
    const a = await tv('GET', `/api/v1/media/files/${encodeURIComponent(id)}`);
    if (a.status === 'READY' && a.download_url) return String(a.download_url);
    if (a.status && !/PEND|PROC|UPLOAD|CREAT/i.test(String(a.status))) throw new ReelError(`TopView file ${id} is ${a.status}; it has to be uploaded again.`);
    await sleep(2500);
  }
  throw new ReelError(`TopView file ${id} isn’t ready yet.`);
}
/** Swaps every "tvasset:<id>" for a fresh link (they last an hour). */
export async function withLinks(body: any): Promise<any> {
  const fresh = new Map<string, string>();
  const url = async (v: string) => { const id = v.slice(8); if (!fresh.has(id)) fresh.set(id, await assetUrl(id)); return fresh.get(id)!; };
  const b = structuredClone(body);
  for (const item of b.content ?? []) for (const f of ['image_url', 'video_url', 'audio_url']) if (typeof item[f]?.url === 'string' && item[f].url.startsWith('tvasset:')) item[f].url = await url(item[f].url);
  for (const k of Object.keys(b)) if (Array.isArray(b[k])) b[k] = await Promise.all(b[k].map((v: any) => (typeof v === 'string' && v.startsWith('tvasset:') ? url(v) : v)));
  return b;
}

/** The worst case of a free quote. */
export async function tvQuote(model: string, body: any): Promise<{ estimate: number; worst: number }> {
  const q = await tv('POST', '/api/v1/predictions/quote', { json: { modelKey: model, input: await withLinks(body) } });
  const nums = [q.reserveUsd, q.maxChargeUsd, q.estimatedUsd].map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  if (!nums.length) throw new ReelError('TopView’s quote had no price in it, so nothing was started.');
  return { estimate: Number(q.estimatedUsd) || Math.max(...nums), worst: Math.max(...nums) };
}
/** Starts a paid job. `idem` makes a repeat safe: the same key and body never pay twice. */
export async function tvSubmit(model: string, body: any, idem: string, maxUsd: number): Promise<{ task: string; estimate: number }> {
  const linked = await withLinks(body);
  const q = await tvQuote(model, body);
  if (q.worst > maxUsd + 1e-6) throw new ReelError(`Not started: it could cost up to $${q.worst.toFixed(2)}, above the $${maxUsd.toFixed(2)} left of what you approved.`);
  logLine({ event: 'submit', provider: 'topview', model, idem, estimate: q.estimate, body: { ...body, content: undefined, prompt: undefined } });
  const d = await tv('POST', modelPath(model), { json: linked, headers: { 'Idempotency-Key': idem } });
  logLine({ event: 'submitted', provider: 'topview', model, idem, task: d.id, status: d.status });
  if (!d.id) throw new ReelError('TopView accepted the job but gave no id. Nothing else was started; check TopView before trying again.');
  return { task: String(d.id), estimate: q.estimate };
}
export interface TaskResult { outputs: string[]; usd: number }
export async function tvWait(task: string, onStatus: (s: string) => void, signal?: AbortSignal): Promise<TaskResult> {
  let gap = 4000, fails = 0, last = '';
  for (const until = Date.now() + 40 * 60_000; Date.now() < until; ) {
    let d: any;
    try { d = await tv('GET', `/api/v1/predictions/${encodeURIComponent(task)}`, { tries: 1 }); fails = 0; }
    catch (e) { if (!(e instanceof ProviderError) || !e.transient || ++fails > 10) throw e; await sleep(gap, signal); continue; }
    if (d.status !== last) { last = d.status; onStatus(String(d.status)); }
    if (d.status === 'completed') { logLine({ event: 'completed', task, charged_usd: d.charged_usd }); return { outputs: (d.outputs ?? []).map(String), usd: Number(d.charged_usd) || 0 }; }
    if (d.status === 'failed') { logLine({ event: 'failed', task, error: d.error }); throw new ReelError(`The job failed at TopView: ${String(d.error || 'no reason given').slice(0, 240)}`); }
    if (d.status === 'payment_required') { logLine({ event: 'payment_required', task }); throw new ReelError(`TopView needs a top-up (short by $${Number(d.shortfall_usd || 0).toFixed(2)}). Top up the same workspace, then press Continue: the job is kept and is not sent again.`); }
    await sleep(gap, signal); gap = Math.min(gap * 1.2, 15_000);
  }
  throw new ReelError('Still running after 40 minutes. That isn’t a failure: press Continue to keep waiting for the same job.');
}
export async function download(url: string, dest: string) {
  if (!/^https:\/\//.test(url)) throw new ReelError('The result came without a link to download.');
  const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!r.ok || !r.body) throw new ReelError(`The result couldn’t be downloaded (HTTP ${r.status}).`);
  ensureDir(dest);
  fs.writeFileSync(`${dest}.part`, Buffer.from(await r.arrayBuffer()));
  fs.renameSync(`${dest}.part`, dest);
}

// ---------- kie.ai (fallback) ----------
const KIE = 'https://api.kie.ai';
/** Credits for a fresh Seedance 2.5 second at 480p / 720p, and what a credit is worth, as the series recorded them. */
export const KIE_CREDITS = { '480p': 28, '720p': 63 } as Record<string, number>, KIE_USD = 0.005;
async function kie(method: string, p: string, json?: unknown): Promise<any> {
  const key = getKey('kie');
  if (!key) throw new ReelError('kie.ai needs its key: add it in Reels Factory › Connections.');
  let r: Response;
  try { r = await fetch(KIE + p, { method, signal: AbortSignal.timeout(90_000), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: json ? JSON.stringify(json) : undefined }); }
  catch (e) { throw new ProviderError(`kie.ai couldn’t be reached (${(e as Error).name}).`, 0, true); }
  const j: any = await r.json().catch(() => ({}));
  // Its errors come with HTTP 200 and their own code.
  const code = Number(j.code ?? r.status);
  if (!r.ok || code !== 200) throw new ProviderError(code === 401 ? 'kie.ai refused the key.' : `kie.ai: ${String(j.msg ?? j.message ?? code).slice(0, 200)}`, code, code === 429 || code >= 500);
  return j.data ?? j;
}
/** The credits left on the account (free). */
export async function kieCheck(): Promise<number> {
  const n = Number(await kie('GET', '/api/v1/chat/credit'));
  if (!Number.isFinite(n)) throw new ReelError('kie.ai didn’t say how many credits are left.');
  return n;
}
/** The same request as TopView's, in kie's shape. Its links come from TopView's own store. */
export async function kieSubmit(body: any, maxUsd: number, idem: string): Promise<{ task: string; estimate: number }> {
  const credits = (KIE_CREDITS[body.resolution] ?? 28) * body.duration, estimate = credits * KIE_USD;
  if (estimate > maxUsd + 1e-6) throw new ReelError(`Not started: kie.ai would cost about $${estimate.toFixed(2)}, above the $${maxUsd.toFixed(2)} left of what you approved.`);
  const have = await kieCheck();
  if (have < credits) throw new ReelError(`Not started: kie.ai has ${have} credits and this needs about ${credits} ($${estimate.toFixed(2)}). Top up there, or render on TopView.`);
  const l = await withLinks({ ...body, content: (body.content as any[]).filter((c) => c.type !== 'video_url') });
  const pick = (t: string) => (l.content as any[]).filter((c) => c.type === t).map((c) => c[t].url);
  logLine({ event: 'submit', provider: 'kie', idem, estimate });
  // kie.ai has no repeat-safe key: when its answer is lost the job may be running, so it is never sent again by itself.
  const d = await kie('POST', '/api/v1/jobs/createTask', { model: 'bytedance/seedance-2-5', input: { prompt: withoutVideo((l.content as any[]).find((c) => c.type === 'text')?.text ?? ''), omni_reference_task_type: 'reference', reference_image_urls: pick('image_url'), reference_audio_urls: pick('audio_url'), duration: body.duration, aspect_ratio: body.ratio, resolution: body.resolution, generate_audio: true } }).catch((e: ProviderError) => {
    logLine({ event: 'submit_error', provider: 'kie', idem, error: e.message });
    if (e.transient && (e.status === 0 || e.status >= 500)) throw new ReelError('kie.ai’s answer was lost, so the job may be running. Look at kie.ai’s logs before trying again, so it isn’t paid twice.');
    throw e;
  });
  logLine({ event: 'submitted', provider: 'kie', idem, task: d.taskId });
  if (!d.taskId) throw new ReelError('kie.ai gave no job id. Check kie.ai before trying again.');
  return { task: String(d.taskId), estimate };
}
export async function kieWait(task: string, estimate: number, onStatus: (s: string) => void, signal?: AbortSignal): Promise<TaskResult> {
  let last = '', fails = 0;
  for (const until = Date.now() + 40 * 60_000; Date.now() < until; await sleep(20_000, signal)) {
    let d: any;
    try { d = await kie('GET', `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(task)}`); fails = 0; }
    catch (e) { if (!(e instanceof ProviderError) || !e.transient || ++fails > 10) throw e; continue; }
    if (d.state !== last) { last = d.state; onStatus(String(d.state)); }
    if (d.state === 'success') { const res = typeof d.resultJson === 'string' ? JSON.parse(d.resultJson) : d.resultJson ?? {}; const used = Number(d.creditsConsumed); logLine({ event: 'completed', provider: 'kie', task, credits: used }); return { outputs: (res.resultUrls ?? []).map(String), usd: used > 0 ? used * KIE_USD : estimate }; }
    if (d.state === 'fail') logLine({ event: 'failed', provider: 'kie', task, error: d.failMsg });
    if (d.state === 'fail') throw new ReelError(`The job failed at kie.ai: ${String(d.failMsg ?? 'no reason given').slice(0, 200)}`);
  }
  throw new ReelError('Still running after 40 minutes. Press Continue to keep waiting for the same job.');
}

// ---------- voices (the owner's ElevenLabs, through Zubi's Composio) ----------
/** Which of Zubi's ElevenLabs connections to use: with more than one, Composio refuses a call that doesn't say. */
export async function voiceAccount(): Promise<string> {
  const r = await zubiComposio('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: [{ name: 'elevenlabs', action: 'list' }] }, 60_000);
  const live = ((r?.data?.results?.elevenlabs?.accounts ?? []) as any[]).filter((a) => /^active$/i.test(String(a.status)));
  const a = live.find((x) => x.is_default) ?? live[0];
  if (!a) throw new ReelError('ElevenLabs isn’t connected in Zubi’s Composio. Ask Zubi to connect it, then run this again.');
  return String(a.id);
}
export async function speak(voiceId: string, text: string, stability: number, similarity: number, dest: string, signal?: AbortSignal) {
  let account: string;
  await wakeApps(signal);
  try { account = await voiceAccount(); }
  catch (e) { if (e instanceof TokenExpired) throw new ReelError(e.message); throw e; }
  const r = await zubiComposio('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'ELEVENLABS_TEXT_TO_SPEECH', account, arguments: { voice_id: voiceId, text, model_id: 'eleven_multilingual_v2', voice_settings: { stability, similarity_boost: similarity } } }], sync_response_to_workbench: false, thought: 'A short voice sample for a cartoon reel, approved by the owner in HeyZubi.' }, 90_000);
  const one = r?.data?.results?.[0] ?? {}, res = one.response ?? {};
  if (res.successful !== true) throw new ReelError(`ElevenLabs: ${String(res.error ?? one.error ?? r?.error ?? 'the voice couldn’t be made').slice(0, 200)}`);
  const found: string[] = [];
  const walk = (v: any) => { if (typeof v === 'string') { if (/^https:\/\/\S+/.test(v) && !/elevenlabs\.io\/docs/.test(v)) found.push(v); } else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(res.data);
  if (!found.length) throw new ReelError('ElevenLabs answered without an audio file.');
  await download(found[0], dest);
}
