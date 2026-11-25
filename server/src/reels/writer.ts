// The writing and the looking: the main team member's own Claude, through its engine, in one-off conversations that are
// not kept and use no tools. Every answer is asked for as JSON and checked before it is used.
import fs from 'node:fs';
import { engineFor, primaryBotId } from '../engine.js';
import { composioFresh } from '../panels.js';
import { chatHeaders, dropOneOff, hideOneOff, noteChat } from '../engine-sessions.js';
import { getBotRow } from '../store.js';
import { ReelError } from './store.js';

async function ask(instructions: string, content: any[], minutes: number, signal?: AbortSignal, rule = 'Do not call any tools and do not ask questions. Answer with one JSON object only: no prose before or after it, no code fence.', effort = 'high', onUsage?: (tokens: number) => void, talk = false): Promise<string> {
  const botId = primaryBotId();
  if (!botId) throw new ReelError('The main team member isn’t set up, and it does the writing.');
  const bot = getBotRow(botId);
  const engine = await engineFor(botId);
  const ctrl = AbortSignal.any([AbortSignal.timeout(minutes * 60_000), ...(signal ? [signal] : [])]);
  let res: Response | null = null;
  // What the owner says goes in the team member's one session; work nobody talks in gets a hidden one that is deleted.
  const chat = talk ? chatHeaders(botId, engine) : {}, inChat = Object.keys(chat).length > 0;
  try {
    res = await fetch(`${engine.url}/v1/responses`, {
      method: 'POST', signal: ctrl,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(engine.key ? { authorization: `Bearer ${engine.key}` } : {}), ...chat },
      body: JSON.stringify({
        model: bot?.model || 'hermes-agent', ...(bot?.provider ? { provider: bot.provider } : {}),
        instructions: `${instructions}\n\n${rule}`,
        input: [{ role: 'user', content }], conversation: `hq-reel-${Date.now()}-${Math.round(Math.random() * 1e6)}`, stream: true, store: false,
        model_options: { reasoning_effort: effort },
      }),
    });
    if (inChat) noteChat(botId, engine, res); else hideOneOff(botId, engine, res);
    if (!res.ok || !res.body) throw new ReelError(`The writer didn’t answer (HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}).`);
    let text = '', done = '', buf = '';
    const dec = new TextDecoder();
    for await (const chunk of res.body as any) {
      buf += dec.decode(chunk, { stream: true });
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!ln.startsWith('data:')) continue;
        let ev: any; try { ev = JSON.parse(ln.slice(5)); } catch { continue; }
        if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') text += ev.delta;
        else if (ev.type === 'response.completed' && Number(ev.response?.usage?.total_tokens) > 0) onUsage?.(Number(ev.response.usage.total_tokens));
        if (ev.type === 'response.completed') done = (ev.response?.output ?? []).flatMap((o: any) => o?.content ?? []).map((x: any) => x?.text ?? '').join('');
        else if (ev.type === 'response.failed' || ev.type === 'error') throw new ReelError(`The writer stopped: ${String(ev.response?.error?.message ?? ev.error?.message ?? ev.message ?? 'unknown').slice(0, 200)}`);
      }
    }
    return text || done;
  } catch (e) {
    if (e instanceof ReelError) throw e;
    if (signal?.aborted) throw new ReelError('Stopped by you.');
    throw new ReelError((e as Error).name === 'TimeoutError' ? `The writer took longer than ${minutes} minutes.` : `The writer couldn’t be reached (${String((e as Error).message).slice(0, 120)}).`);
  } finally { if (!inChat) dropOneOff(engine, res); }
}

/**
 * Zubi's app sign-in lasts an hour and is renewed by Zubi alone (its renewal code works once, so nobody else may use it),
 * usually within seconds of running out. That is waited for; if it doesn't happen, Zubi is asked for one harmless look at
 * its own connections, which renews it.
 */
export async function wakeApps(signal?: AbortSignal): Promise<void> {
  const waitFor = async (seconds: number) => { for (let i = 0; i < seconds && !composioFresh(); i++) { if (signal?.aborted) throw new ReelError('Stopped by you.'); await new Promise((r) => setTimeout(r, 1000)); } return composioFresh(); };
  if (await waitFor(120)) return;
  await ask('This is an automatic check from HeyZubi, not a message from the owner.', [{ type: 'input_text', text: 'Make exactly one call to your Composio tool COMPOSIO_MANAGE_CONNECTIONS with {"toolkits":[{"name":"elevenlabs","action":"list"}]}. It only lists; change nothing and call nothing else. Then answer "done".' }], 3, signal, 'Call only that one tool. Do not save anything to memory. Do not ask questions.', 'low').catch((e) => { if (signal?.aborted) throw e; });
  if (!(await waitFor(60))) throw new ReelError('Zubi’s app sign-in has run out and didn’t renew. Ask Zubi in chat to list its connected apps, then run this again.');
}

/** The JSON object in an answer (a stray fence or sentence around it is tolerated). */
export function jsonIn(text: string): any {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON in the answer');
  const raw = text.slice(a, b + 1);
  try { return JSON.parse(raw); } catch (e) {
    try { return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u001f]+/g, ' ')); } catch { throw new Error(`the JSON was broken (${(e as Error).message})`); }
  }
}

/**
 * Asks for JSON until `check` finds nothing wrong (it returns what to fix), at most `tries` times; what was wrong goes
 * back with the next ask. With `lenient`, the last answer is used even when something is still wrong.
 */
export async function askJson<T>(o: { instructions: string; prompt: string; images?: { label: string; file: string }[]; check?: (v: T) => string[]; tries?: number; minutes?: number; lenient?: boolean; signal?: AbortSignal; onTry?: (n: number, problems: string[]) => void; onUsage?: (tokens: number) => void; talk?: boolean }): Promise<T> {
  let problems: string[] = [], last: T | null = null;
  const tries = o.tries ?? 3;
  for (let n = 1; n <= tries; n++) {
    o.onTry?.(n, problems);
    const content: any[] = [];
    for (const im of o.images ?? []) content.push({ type: 'input_text', text: im.label }, { type: 'input_image', image_url: `data:image/${im.file.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(im.file).toString('base64')}` });
    content.push({ type: 'input_text', text: o.prompt });
    if (problems.length) content.push({ type: 'input_text', text: `Your last answer${last ? ' is below' : ' could not be used'}. Return the whole corrected JSON object, fixing exactly these points and keeping everything else:\n- ${problems.join('\n- ')}${last ? `\n\nLast answer:\n${JSON.stringify(last)}` : ''}` });
    const text = await ask(o.instructions, content, o.minutes ?? 10, o.signal, undefined, undefined, o.onUsage, o.talk);
    try { last = jsonIn(text) as T; } catch (e) { problems = [(e as Error).message]; continue; }
    problems = o.check?.(last) ?? [];
    if (!problems.length) return last;
  }
  if (last && o.lenient) return last;
  throw new ReelError(`The writer’s answer didn’t pass after ${tries} tries: ${problems.slice(0, 4).join('; ')}`);
}

/** What people type: Google's and YouTube's own autocomplete (US). Returns [] when it can't be reached. */
export async function autocomplete(q: string, youtube = false): Promise<string[]> {
  try {
    const u = new URL('https://suggestqueries.google.com/complete/search');
    u.search = new URLSearchParams({ client: 'firefox', hl: 'en', gl: 'us', q, ...(youtube ? { ds: 'yt' } : {}) }).toString();
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as [string, string[]];
    return Array.isArray(j?.[1]) ? j[1].slice(0, 8).map(String) : [];
  } catch { return []; }
}
