import type { VoiceOption } from '@shared/types';

export interface GeminiRates { textInPerM: number; audioInPerM: number; audioOutPerM: number; textOutPerM: number }

/** What /api/voice/session returns: an xAI realtime session, or a Gemini Live connection (single-use key in the URL). */
export interface VoiceSession {
  engine: 'xai' | 'gemini';
  callId: string;
  model: string;
  websocketUrl: string;
  sampleRate: number;
  voice: string;
  language: string;
  // xAI only
  clientSecret?: string;
  expiresAt?: number;
  instructions?: string;
  speed?: number;
  tools?: unknown[];
  session?: Record<string, unknown>;
  // Gemini only: what's left of today's cap, and the prices used for the running cost
  capLeft?: number;
  rates?: GeminiRates;
}

export interface GeminiTokens { textIn: number; audioIn: number; audioOut: number; textOut: number }

export interface ClaudeSpend {
  available: boolean;
  day: string;
  since: number;
  total: number;
  byBot: Record<string, number>;
  bySource: { key: string; label: string; usd: number }[];
  note: string;
}

export interface VoiceOptions {
  voices: VoiceOption[];
  languages: { code: string; name: string }[];
  speeds: number[];
  geminiVoices?: VoiceOption[];
  gemini?: { ready: boolean; model: string; cap: number; left: number; rates: GeminiRates };
  sarvamVoices?: VoiceOption[];
  sarvam?: { ready: boolean; capInr: number; leftInr: number };
}

export interface XaiUsage {
  day: string;
  total: number;
  note: string;
  by: Record<'live_call' | 'transcription' | 'spoken_reply' | 'grok' | 'image' | 'gemini_call' | 'sarvam_stt' | 'sarvam_tts', { usd: number; qty: number; unit: string; uses: number }>;
  sarvamInr?: number;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/voice${path}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

let optionsPromise: Promise<VoiceOptions> | null = null;

export const voiceApi = {
  options: () => (optionsPromise ??= fetch('/api/voice/options', { credentials: 'include' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<VoiceOptions>;
  }).catch((e) => { optionsPromise = null; throw e; })),
  session: (botId: string) => post<VoiceSession>('/session', { botId }),
  tool: (botId: string, callId: string, name: string, args: unknown) => post<{ output: string; taskSeq?: number }>('/tool', { botId, callId, name, args }),
  end: (botId: string, callId: string, transcript: { role: 'user' | 'assistant'; text: string }[], error?: string, tokens?: GeminiTokens) => post<{ ok: true }>('/end', { botId, callId, transcript, error, tokens }),
  /** Best-effort end on tab close. */
  endBeacon: (botId: string, callId: string, transcript: { role: 'user' | 'assistant'; text: string }[], tokens?: GeminiTokens) => {
    try { navigator.sendBeacon('/api/voice/end', new Blob([JSON.stringify({ botId, callId, transcript, tokens })], { type: 'application/json' })); } catch { /* ignore */ }
  },
  /** A fresh single-use Gemini key that resumes the call's session (Gemini drops a connection after ~10 min). */
  geminiResume: (botId: string, callId: string, handle: string) => post<{ websocketUrl: string }>('/gemini/resume', { botId, callId, handle }),
  /** Forget the cached options (the Gemini cap headroom changes during the day). */
  refreshOptions: () => { optionsPromise = null; },
  async preview(p: { botId: string; voice?: string; speed?: number; language?: string; text?: string }): Promise<Int16Array> {
    const res = await fetch('/api/voice/preview', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...p, codec: 'pcm' }) });
    if (!res.ok) throw new Error('Preview unavailable');
    const buf = await res.arrayBuffer();
    return new Int16Array(buf, 0, buf.byteLength >> 1);
  },
  /** One of the bot's replies, read aloud (mp3). */
  async speak(botId: string, text: string): Promise<Blob> {
    const res = await fetch('/api/voice/speak', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, text }) });
    if (!res.ok) {
      let msg = 'Could not read it aloud';
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
      throw new Error(msg);
    }
    return res.blob();
  },
  /** The owner's dictionary and dictation tidy-up setting. */
  prefs: () => fetch('/api/prefs', { credentials: 'include' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<{ dictionary: string[]; tidyDictation: boolean }>;
  }),
  savePrefs: (p: { dictionary?: string[] | string; tidyDictation?: boolean }) => fetch('/api/prefs', { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<{ dictionary: string[]; tidyDictation: boolean }>;
  }),
  /** Today's Claude spend (Hermes's own estimates): by bot, and the agent's other channels. */
  claudeSpend: () => fetch('/api/voice/claude-spend', { credentials: 'include' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<ClaudeSpend>;
  }),
  /** Today's xAI spend by service (estimates). */
  usage: () => fetch('/api/voice/usage', { credentials: 'include' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<XaiUsage>;
  }),
  /** A short sample of a Sarvam (Hindi) voice, as mp3. */
  async previewSarvam(botId: string, voice: string): Promise<Blob> {
    const res = await fetch('/api/voice/preview', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, voice, engine: 'sarvam' }) });
    if (!res.ok) {
      let msg = 'Preview unavailable';
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
      throw new Error(msg);
    }
    return res.blob();
  },
  async transcribe(blob: Blob, language?: string, meta?: { ms?: number; what?: string; botId?: string }): Promise<string> {
    const fd = new FormData();
    if (meta?.botId) fd.append('botId', meta.botId);
    if (language) fd.append('language', language);
    if (meta?.ms) fd.append('ms', String(Math.round(meta.ms)));
    if (meta?.what) fd.append('what', meta.what);
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    fd.append('file', blob, `dictation.${ext}`);
    const res = await fetch('/api/voice/stt', { method: 'POST', credentials: 'include', body: fd });
    if (!res.ok) {
      let msg = 'Transcription failed';
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
      throw new Error(msg);
    }
    return ((await res.json()) as { text: string }).text;
  },
};
