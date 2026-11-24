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

export type Service = 'live_call' | 'transcription' | 'spoken_reply' | 'grok' | 'image' | 'gemini_call' | 'sarvam_stt' | 'sarvam_tts';

const FILE = path.join(path.dirname(env.dbPath), 'xai-usage.jsonl');
const pad = (n: number) => String(n).padStart(2, '0');
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function log(userId: string, service: Service, qty: number, unit: string, usd: number, what: string, extra?: Record<string, unknown>) {
  const line = JSON.stringify({ ts: Date.now(), day: today(), userId, service, what, qty: Math.round(qty * 1000) / 1000, unit, usd: Math.round(usd * 1e5) / 1e5, ...extra });
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
  /** A Gemini Live call: priced from the token counts Gemini reported during the call (see voice-gemini.ts). */
  geminiCall(userId: string, ms: number, usd: number, tokens: Record<string, number>) {
    log(userId, 'gemini_call', Math.max(0, ms) / 60000, 'min', Math.max(0, usd), 'Gemini live call', { tokens });
  },
  /** Sarvam bills in rupees: the line keeps the rupee amount; usd is an estimate for the shared total. */
  sarvamStt(userId: string, ms: number, inr: number, inrPerUsd: number, what = 'Voice message') {
    log(userId, 'sarvam_stt', Math.max(0, ms) / 1000, 's', inr / inrPerUsd, what, { inr: Math.round(inr * 1e4) / 1e4 });
  },
  sarvamTts(userId: string, chars: number, inr: number, inrPerUsd: number, what = 'Spoken reply') {
    log(userId, 'sarvam_tts', chars, 'chars', inr / inrPerUsd, what, { inr: Math.round(inr * 1e4) / 1e4 });
  },
  /** `u` is the `usage` object of an xAI responses call. */
  grok(userId: string, u: any, what: string) {
    const inTok = Number(u?.input_tokens ?? u?.prompt_tokens ?? 0);
    const outTok = Number(u?.output_tokens ?? u?.completion_tokens ?? 0);
    log(userId, 'grok', inTok + outTok, 'tokens', (inTok / 1e6) * RATES.grokInPerM + (outTok / 1e6) * RATES.grokOutPerM, what);
  },
};

/** Today's totals for one owner, by service. */
export function usageToday(userId: string) { return usageFrom(userId, today()); }

/** Totals for one owner from a day (YYYY-MM-DD, local) to now, by service. */
export function usageFrom(userId: string, day: string) {
  const by: Record<Service, { usd: number; qty: number; unit: string; uses: number }> = {
    live_call: { usd: 0, qty: 0, unit: 'min', uses: 0 },
    transcription: { usd: 0, qty: 0, unit: 's', uses: 0 },
    spoken_reply: { usd: 0, qty: 0, unit: 'chars', uses: 0 },
    grok: { usd: 0, qty: 0, unit: 'tokens', uses: 0 },
    image: { usd: 0, qty: 0, unit: 'images', uses: 0 },
    gemini_call: { usd: 0, qty: 0, unit: 'min', uses: 0 },
    sarvam_stt: { usd: 0, qty: 0, unit: 's', uses: 0 },
    sarvam_tts: { usd: 0, qty: 0, unit: 'chars', uses: 0 },
  };
  let sarvamInr = 0;
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { /* nothing logged yet */ }
  for (const line of text.split('\n')) {
    if (!line.includes(userId)) continue;
    try {
      const e = JSON.parse(line);
      if (e.userId !== userId || !(e.service in by) || !(String(e.day) >= day)) continue;
      const s = by[e.service as Service];
      s.usd += Number(e.usd) || 0; s.qty += Number(e.qty) || 0; s.uses += 1;
      if (e.service === 'sarvam_stt' || e.service === 'sarvam_tts') sarvamInr += Number(e.inr) || 0;
    } catch { /* skip a torn line */ }
  }
  const total = Object.values(by).reduce((a, s) => a + s.usd, 0);
  return { day, by, total, sarvamInr, note: 'Estimates from xAI’s, Google’s and Sarvam’s published prices (Sarvam converted from rupees); the exact bills are at console.x.ai, aistudio.google.com and indus.sarvam.ai. Claude is billed separately by Anthropic.' };
}

/** Today's logged Gemini call spend for one owner (for the daily cap). */
export const geminiSpendToday = (userId: string) => usageToday(userId).by.gemini_call.usd;
/** Today's logged Sarvam spend in rupees (for its daily cap). */
export const sarvamInrToday = (userId: string) => usageToday(userId).sarvamInr;
