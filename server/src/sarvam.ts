// Sarvam (docs.sarvam.ai) for Hindi / Hinglish voice messages: Saaras v4 turns a voice message into text (codemix
// mode writes Hinglish the way it is spoken) and Bulbul v4 Flash reads the bot's replies aloud in a Hindi voice.
// Picked per bot under Voice chat; xAI stays the default and the fallback. The key stays on the server.

export const SARVAM_API = 'https://api.sarvam.ai';
const key = () => String(process.env.SARVAM_API_KEY ?? '').trim();
export const sarvamConfigured = () => !!key();

/** Sarvam's pay-as-you-go prices in rupees (docs.sarvam.ai/api/getting-started/pricing, checked 2026-11-23). */
export const SARVAM_RATES = { sttPerMinInr: 0.49, ttsPer1kCharsInr: 2 };
/** Rupees per dollar, only to show Sarvam beside the other services in the spend panel (an estimate). */
export const INR_PER_USD = Number(process.env.HQ_INR_PER_USD ?? 85) || 85;
/** Owner-approved ceiling per day (Murtaza, 2026-11-23: ₹20). Past it, that day uses xAI. */
export const SARVAM_DAILY_CAP_INR = Number(process.env.HQ_SARVAM_DAILY_CAP_INR ?? 20) || 20;
/** Saaras REST takes clips up to 30 s; longer voice messages go to xAI. */
export const SARVAM_STT_MAX_MS = 29_000;

/** Everyday Hindi and Hinglish (enhi) Bulbul v4 Flash personas (docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/voices). */
const VOICE_IDS = [
  'simran_enhi_companion', 'ishita_enhi_companion', 'shubh_enhi_companion', 'shalini_enhi_companion', 'sanchita_enhi_companion',
  'simran_enhi_customer', 'ishita_enhi_customer', 'shalini_enhi_customer', 'sunny_enhi_customer',
  'kavya_hi_conversational', 'shreya_hi_conversational', 'roopa_hi_conversational', 'ritu_hi_conversation', 'sarika_hi_conversation', 'simran_hi_conversation',
  'roopa_hi_companion', 'shalini_hi_companion', 'suman_hi_companion',
  'aarti_hi_customer', 'aparna_hi_customer', 'chaitra_hi_customer', 'ritu_hi_customer',
  'aayan_hi_conversational', 'aditya_hi_conversational', 'amit_hi_conversational', 'ashutosh_hi_conversational', 'kabir_hi_conversational',
  'manan_hi_conversational', 'mani_hi_conversational', 'mohit_hi_conversational', 'rahul_hi_conversational', 'sumit_hi_conversational', 'tarun_hi_conversational',
  'shubh_hi_customer',
];
const STYLE: Record<string, string> = { companion: 'companion', customer: 'helpful', conversational: 'conversational', conversation: 'conversational' };
export const SARVAM_VOICES = VOICE_IDS.map((id) => {
  const [name, lang, style] = id.split('_');
  return { id, name: `${name[0].toUpperCase()}${name.slice(1)} · ${lang === 'enhi' ? 'Hinglish' : 'Hindi'} · ${STYLE[style] ?? style}` };
});
export const DEFAULT_SARVAM_VOICE = 'simran_enhi_companion';
export const isSarvamVoice = (v: unknown) => typeof v === 'string' && VOICE_IDS.includes(v);

export const sttCostInr = (ms: number) => (Math.max(0, ms) / 60_000) * SARVAM_RATES.sttPerMinInr;
export const ttsCostInr = (chars: number) => (Math.max(0, chars) / 1000) * SARVAM_RATES.ttsPer1kCharsInr;

const why = (status: number, detail: string) => (/credit|balance|quota|insufficient|402/i.test(detail) || status === 402
  ? 'the Sarvam account is out of credits'
  : status === 401 || status === 403 ? 'the Sarvam key was refused' : `Sarvam answered ${status || 'nothing'}`);

/** A voice message (≤30 s) to text, Hinglish as spoken. */
export async function sarvamTranscribe(file: Blob, name: string, language: string, keyterms: string[] = []): Promise<{ text: string; language?: string } | { error: string }> {
  const fd = new FormData();
  fd.append('model', 'saaras:v4');
  fd.append('mode', 'codemix');
  // The owner's dictionary: names and words to recognise (Saaras v4 takes up to 50, 64 characters each).
  if (keyterms.length) fd.append('keyterms', JSON.stringify(keyterms.slice(0, 50).map((t) => t.slice(0, 64))));
  fd.append('language_code', language && language !== 'auto' ? (language.includes('-') ? language : `${language}-IN`) : 'unknown');
  fd.append('file', file, name);
  const r = await fetch(`${SARVAM_API}/speech-to-text`, { method: 'POST', headers: { 'api-subscription-key': key() }, body: fd, signal: AbortSignal.timeout(45_000) }).catch(() => null);
  if (!r?.ok) {
    const detail = String(await r?.text().catch(() => '') ?? '').slice(0, 300);
    console.warn('[voice] sarvam stt failed', r?.status, detail);
    return { error: why(r?.status ?? 0, detail) };
  }
  const j = (await r.json()) as { transcript?: string; language_code?: string | null };
  return { text: String(j.transcript ?? '').trim(), language: j.language_code ?? undefined };
}

/** Text (≤3,500 chars) to MP3 in a Bulbul v4 Flash Hindi voice. */
export async function sarvamSpeak(text: string, speaker: string, pace = 1): Promise<{ mp3: Buffer } | { error: string }> {
  const r = await fetch(`${SARVAM_API}/text-to-speech/stream`, {
    method: 'POST',
    headers: { 'api-subscription-key': key(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 3500), language_code: 'hi-IN', model: 'bulbul:v4-flash', speaker, pace: Math.min(2, Math.max(0.5, pace)), output_audio_codec: 'mp3' }),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);
  if (!r?.ok) {
    const detail = String(await r?.text().catch(() => '') ?? '').slice(0, 300);
    console.warn('[voice] sarvam tts failed', r?.status, detail);
    return { error: why(r?.status ?? 0, detail) };
  }
  return { mp3: Buffer.from(await r.arrayBuffer()) };
}
