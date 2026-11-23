import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';

/**
 * What the app spends at xAI, logged per use so the owner can see it by service. Only amounts and kinds are
 * written (never what was said). Prices are xAI's published rates (docs.x.ai/developers/pricing, checked
 * 2026-11-23); they are estimates of the bill, which xAI's console has exactly. Claude costs are not here:
 * Zubi's own model is billed by Anthropic.
 */
export const RATES = {
  liveCallPerMin: 0.08, // Speech to Speech (grok-voice), server VAD: billed for the whole time a call is open
  callTextInput: 0.004, // each text message put into a live call (hand-off results)
  sttPerHour: 0.10, // speech to text, recorded audio
  ttsPerMChars: 15, // text to speech
  grokInPerM: 2, // grok-4.7 text, under 200k tokens
  grokOutPerM: 6,
  imagePerImage: 0.04, // grok-imagine-image-2.0, 1K/2K
};

export type Service = 'live_call' | 'transcription' | 'spoken_reply' | 'grok' | 'image';

const FILE = path.join(path.dirname(env.dbPath), 'xai-usage.jsonl');
const pad = (n: number) => String(n).padStart(2, '0');
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function log(userId: string, service: Service, qty: number, unit: string, usd: number, what: string) {
  const line = JSON.stringify({ ts: Date.now(), day: today(), userId, service, what, qty: Math.round(qty * 1000) / 1000, unit, usd: Math.round(usd * 1e5) / 1e5 });
  fs.appendFile(FILE, `${line}\n`, { mode: 0o600 }, (e) => { if (e) console.warn('[usage] not logged:', e.message); });
}

export const usage = {
  liveCall(userId: string, ms: number, textInputs: number) {
    const min = Math.max(0, ms) / 60000;
    log(userId, 'live_call', min, 'min', min * RATES.liveCallPerMin + textInputs * RATES.callTextInput, 'Live call');
  },
  transcription(userId: string, ms: number, what = 'Voice message') {
    const h = Math.max(0, ms) / 3_600_000;
    log(userId, 'transcription', ms / 1000, 's', h * RATES.sttPerHour, what);
  },
  speech(userId: string, chars: number, what = 'Spoken reply') {
    log(userId, 'spoken_reply', chars, 'chars', (chars / 1e6) * RATES.ttsPerMChars, what);
  },
  image(userId: string, n: number, what = 'Created image') {
    log(userId, 'image', n, 'images', n * RATES.imagePerImage, what);
  },
  /** `u` is the `usage` object of an xAI responses call. */
  grok(userId: string, u: any, what: string) {
    const inTok = Number(u?.input_tokens ?? u?.prompt_tokens ?? 0);
    const outTok = Number(u?.output_tokens ?? u?.completion_tokens ?? 0);
    log(userId, 'grok', inTok + outTok, 'tokens', (inTok / 1e6) * RATES.grokInPerM + (outTok / 1e6) * RATES.grokOutPerM, what);
  },
};

/** Today's totals for one owner, by service. */
export function usageToday(userId: string) {
  const day = today();
  const by: Record<Service, { usd: number; qty: number; unit: string; uses: number }> = {
    live_call: { usd: 0, qty: 0, unit: 'min', uses: 0 },
    transcription: { usd: 0, qty: 0, unit: 's', uses: 0 },
    spoken_reply: { usd: 0, qty: 0, unit: 'chars', uses: 0 },
    grok: { usd: 0, qty: 0, unit: 'tokens', uses: 0 },
    image: { usd: 0, qty: 0, unit: 'images', uses: 0 },
  };
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { /* nothing logged yet */ }
  for (const line of text.split('\n')) {
    if (!line.includes(`"day":"${day}"`)) continue;
    try {
      const e = JSON.parse(line);
      if (e.userId !== userId || !(e.service in by)) continue;
      const s = by[e.service as Service];
      s.usd += Number(e.usd) || 0; s.qty += Number(e.qty) || 0; s.uses += 1;
    } catch { /* skip a torn line */ }
  }
  const total = Object.values(by).reduce((a, s) => a + s.usd, 0);
  return { day, by, total, note: 'Estimates from xAI’s published prices; the exact bill is at console.x.ai. Claude is billed separately by Anthropic.' };
}
