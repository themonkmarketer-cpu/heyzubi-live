// Gemini Live as a second engine for voice calls (the owner picks xAI or Gemini under Voice chat).
// The browser talks to Gemini directly over a WebSocket, with a single-use key minted here that locks the
// call's settings (model, voice, instructions, tools, transcription, context compression): the page can't
// change what the voice agent is told or what it may call. The API key itself never leaves the server.
// Plain REST + WebSocket, no SDK. Docs: ai.google.dev/gemini-api/docs/ephemeral-tokens, /api/live.
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import type { VoiceOption } from './types.js';

export const GEMINI_MODEL = process.env.HQ_GEMINI_LIVE_MODEL ?? 'gemini-3.8-live';
const API = 'https://generativelanguage.googleapis.com';
const WS = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained`;

/** Google's published paid-tier prices for gemini-3.8-live (ai.google.dev/gemini-api/docs/pricing, checked 2026-11-23). */
export const GEMINI_RATES = { textInPerM: 0.75, audioInPerM: 3, audioOutPerM: 12, textOutPerM: 4.5 };
/** Owner-approved ceiling for Gemini calls per day (Murtaza, 2026-11-23: $1). */
export const GEMINI_DAILY_CAP = Number(process.env.HQ_GEMINI_DAILY_CAP ?? 1) || 1;

/**
 * Context kept between turns. Every turn re-bills the whole context, so the call keeps only its last few
 * minutes (the voice prompt, about 3.5k tokens, counts too); read_chat reaches further back.
 */
const COMPRESS_TRIGGER = Number(process.env.HQ_GEMINI_COMPRESS_TRIGGER ?? 10000) || 10000;
const COMPRESS_TARGET = Number(process.env.HQ_GEMINI_COMPRESS_TARGET ?? 6000) || 6000;

/** Google's 30 prebuilt voices with their published styles (ai.google.dev/gemini-api/docs/speech-generation). */
const VOICES: [string, string][] = [
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm'], ['Fenrir', 'Excitable'],
  ['Leda', 'Youthful'], ['Orus', 'Firm'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'],
  ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'], ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'],
  ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'], ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'],
  ['Alnilam', 'Firm'], ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'], ['Achird', 'Friendly'],
  ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'], ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
];
export const GEMINI_VOICES: VoiceOption[] = VOICES.map(([id, style]) => ({ id, name: `${id} · ${style}` }));
export const DEFAULT_GEMINI_VOICE = 'Kore';
export const isGeminiVoice = (v: unknown) => typeof v === 'string' && VOICES.some(([id]) => id === v);

/**
 * The Gemini API key: GEMINI_API_KEY in hq.env if set, else the one in Zubi's Hermes settings (the owner chose
 * to reuse it, 2026-11-23). Read on demand, never logged or returned.
 */
function geminiKey(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    const m = fs.readFileSync(path.join(env.hermesHome, '.env'), 'utf8').match(/^GEMINI_API_KEY=(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}
export const geminiConfigured = () => !!geminiKey();

/** OpenAI-style function tools → Gemini function declarations (OpenAPI schema, upper-case types). */
function schema(s: any): any {
  if (!s || typeof s !== 'object') return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toUpperCase();
    else if (k === 'properties' && v && typeof v === 'object') out.properties = Object.fromEntries(Object.entries(v).map(([p, d]) => [p, schema(d)]));
    else if (k === 'items') out.items = schema(v);
    else out[k] = v;
  }
  return out;
}
export function functionDeclarations(tools: { name: string; description: string; parameters?: any }[]) {
  return tools.map((t) => {
    const hasParams = t.parameters && Object.keys(t.parameters.properties ?? {}).length > 0;
    // BLOCKING: the model waits for each result, as on xAI (hand_off still returns at once).
    return { name: t.name, description: t.description, behavior: 'BLOCKING', ...(hasParams ? { parameters: schema(t.parameters) } : {}) };
  });
}

export interface GeminiSetup { voice: string; instructions: string; tools: unknown[]; language: string }

function setupMessage(s: GeminiSetup, handle?: string) {
  const lang = s.language && s.language !== 'auto' ? s.language : null;
  return {
    model: `models/${GEMINI_MODEL}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } } },
    },
    systemInstruction: { parts: [{ text: s.instructions }] },
    tools: [{ functionDeclarations: s.tools }],
    inputAudioTranscription: lang ? { languageCodes: [lang] } : {},
    outputAudioTranscription: {},
    contextWindowCompression: { triggerTokens: COMPRESS_TRIGGER, slidingWindow: { targetTokens: COMPRESS_TARGET } },
    sessionResumption: handle ? { handle } : {},
  };
}

/** A single-use key for one connection (1 minute to connect, 30 to use), with the setup locked in. */
export async function mintGeminiToken(s: GeminiSetup, handle?: string): Promise<{ websocketUrl: string } | { error: string; status: number }> {
  const key = geminiKey();
  if (!key) return { error: 'Gemini voice needs a Gemini API key on hermes-box.', status: 503 };
  const t = Date.now();
  const r = await fetch(`${API}/v1alpha/auth_tokens`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(t + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(t + 60_000).toISOString(),
      bidiGenerateContentSetup: setupMessage(s, handle),
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e?.message ?? e) }) as any);
  if (!r.ok) {
    const detail = String(await r.text().catch(() => '')).slice(0, 300);
    console.warn('[voice] gemini token mint failed', r.status, detail);
    const billing = /billing|quota|exceeded|RESOURCE_EXHAUSTED/i.test(detail);
    return { error: billing ? 'Gemini voice is paused: the Google account is out of quota or billing isn’t set up. Switch to xAI under Voice chat.' : 'Could not start a Gemini voice session', status: 502 };
  }
  const j = (await r.json()) as { name?: string };
  if (!j.name) return { error: 'Could not start a Gemini voice session', status: 502 };
  return { websocketUrl: `${WS}?access_token=${encodeURIComponent(j.name)}` };
}

export interface GeminiTokens { textIn: number; audioIn: number; audioOut: number; textOut: number }
export const geminiCost = (u: GeminiTokens) =>
  (u.textIn * GEMINI_RATES.textInPerM + u.audioIn * GEMINI_RATES.audioInPerM + u.audioOut * GEMINI_RATES.audioOutPerM + u.textOut * GEMINI_RATES.textOutPerM) / 1e6;
