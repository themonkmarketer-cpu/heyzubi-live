// The in-browser voice agent: a small agent on the xAI realtime API that speaks as the bot and hands real
// work to the bot's own text agent (hand_off). Results come back through the normal transcript stream and
// are passed into the call as [result] notes.
import { create } from 'zustand';
import type { Row } from '@shared/types';
import { sortedRows, useStore } from '../store';
import { voiceApi, type GeminiTokens, type VoiceSession } from './api';
import { MicCapture, PcmPlayer, base64ToPcm, createAudioContext, micErrorMessage, openMic, pcmToBase64 } from './audio';

export interface Caption { id: string; role: 'user' | 'assistant'; text: string; final: boolean }

export type CallStatus = 'idle' | 'connecting' | 'live' | 'ending' | 'error';

interface VoiceState {
  status: CallStatus;
  botId: string | null;
  callId: string | null;
  muted: boolean;
  /** Bot audio is playing. */
  speaking: boolean;
  /** Server VAD hears the user. */
  listening: boolean;
  /** A response is being generated but no audio yet. */
  thinking: boolean;
  /** hand_off requests still running in the text agent. */
  working: { seq: number; request: string }[];
  captions: Caption[];
  error: string | null;
  startedAt: number | null;
  /** The noise guard paused the mic, and why (resume with resumeMic). */
  paused: string | null;
  /** Which engine runs this call, and (Gemini) its running cost from the token counts Gemini reports. */
  engine: 'xai' | 'gemini';
  costUsd: number;
}

export const useVoice = create<VoiceState>(() => ({
  status: 'idle', botId: null, callId: null, muted: false, speaking: false, listening: false, thinking: false,
  working: [], captions: [], error: null, startedAt: null, paused: null, engine: 'xai', costUsd: 0,
}));

/**
 * Noise guard (Zubi HQ's "smart mic"): the call can't tell who is speaking, but it can tell how the sound behaves.
 * It pauses the mic only on signs of a messy room, never on a guess about the speaker:
 * - speech that never pauses for 20 s, or sound filling over 92% of the last 15 s: background talk, a video or music;
 * - 3 interruptions of the bot within 12 s: more than one voice, or noise, cutting in;
 * - one turn of over 600 characters of transcript: not a short request.
 */
function makeNoiseGate() {
  const g = { cont: 0, quiet: 0, win: [] as { ms: number; v: boolean }[], winMs: 0, voicedMs: 0, floor: 0.004, ints: [] as number[] };
  return {
    frame(rms: number, ms: number): string | null {
      const thr = Math.max(0.012, g.floor * 3);
      const v = rms > thr;
      if (!v) g.floor = g.floor * 0.995 + rms * 0.005;
      if (v) { g.cont += ms; g.quiet = 0; } else { g.quiet += ms; if (g.quiet >= 700) g.cont = 0; }
      g.win.push({ ms, v }); g.winMs += ms; if (v) g.voicedMs += ms;
      while (g.winMs > 15000 && g.win.length) { const o = g.win.shift()!; g.winMs -= o.ms; if (o.v) g.voicedMs -= o.ms; }
      if (g.cont >= 20000) return 'Speech that never pauses for 20 seconds sounds like background conversation, a video or music.';
      if (g.winMs >= 14500 && g.voicedMs / g.winMs > 0.92) return 'Sound that never stops for 15 seconds sounds like a noisy room.';
      return null;
    },
    interrupt(now: number): string | null {
      g.ints = g.ints.filter((t) => now - t < 12000); g.ints.push(now);
      return g.ints.length >= 3 ? 'Several interruptions in a row: more than one voice, or noise, is cutting in.' : null;
    },
    turnText: (n: number) => (n > 600 ? 'That was a long stretch of speech, not a short request.' : null),
    reset() { g.cont = g.quiet = g.winMs = g.voicedMs = 0; g.win = []; g.ints = []; },
  };
}

const setV = (p: Partial<VoiceState>) => useVoice.setState(p);

let current: VoiceCall | null = null;

/** Start a call with a bot. Must be called from a user gesture (click) so audio can start. */
export function startCall(botId: string) {
  if (current && !current.ended) {
    if (current.botId === botId) return;
    current.end();
  }
  current = new VoiceCall(botId);
  void current.start();
}

export function endCall() { current?.end(); }
export function toggleMute() {
  if (useVoice.getState().paused) { current?.resumeMic(); return; }
  current?.setMuted(!useVoice.getState().muted);
}
/** Turn the mic back on after the noise guard paused it. */
export function resumeMic() { current?.resumeMic(); }
export function callLevels(): { out: number; mic: number } {
  return current && !current.ended ? { out: current.player.level(), mic: current.micLevel() } : { out: 0, mic: 0 };
}
export const isCallActive = (s: VoiceState = useVoice.getState()) => s.status === 'connecting' || s.status === 'live';

type Json = Record<string, any>;

interface PendingTask { seq: number; request: string; since: number; startedBusy: boolean; sawRunning: boolean; awaitingNoted: boolean; doneSince: number | null }

const IDLE_MS = 2 * 60_000;

class VoiceCall {
  ended = false;
  readonly ctx: AudioContext;
  readonly player: PcmPlayer;
  private mic: MicCapture | null = null;
  private ws: WebSocket | null = null;
  private sess: VoiceSession | null = null;
  private ready = false;
  private responseActive = false;
  private responseSpoke = false;
  private responseId: string | null = null;
  /** Response the user talked over; its late audio deltas are dropped. */
  private interruptedId: string | null = null;
  private userSpeaking = false;
  private inflight = new Map<string, { name: string; promise: Promise<string> }>();
  private handledCalls = new Set<string>();
  private tasks: PendingTask[] = [];
  private notes: string[] = [];
  private flushWaiting = false;
  private unsubStore: (() => void) | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** A live call is billed for every open minute: after IDLE_MS with nobody talking and nothing running, hang up. */
  private lastActive = Date.now();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private gate = makeNoiseGate();
  private engine: 'xai' | 'gemini' = 'xai';
  // ---- Gemini Live only ----
  /** Latest session-resumption handle: Gemini closes a connection after ~10 min and the call carries on over a new one. */
  private gHandle: string | null = null;
  private gReconnecting = false;
  private gResumeAfterTurn = false;
  private gResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private gTokens: GeminiTokens = { textIn: 0, audioIn: 0, audioOut: 0, textOut: 0 };
  private gCaption = 0;
  private gUserId: string | null = null;
  private gBotId: string | null = null;
  /** Speech-only sending: Gemini bills every second of audio it is sent, so silence stays on this side. */
  private gStreamOpen = false;
  private gSendUntil = 0;
  private gFloor = 0.004;
  private gPreroll: Int16Array[] = [];
  private onUnload = () => { if (this.sess && !this.ended) voiceApi.endBeacon(this.botId, this.sess.callId, this.transcript(), this.engine === 'gemini' ? this.gTokens : undefined); };

  constructor(readonly botId: string) {
    // Created synchronously inside the click so autoplay policy lets it run.
    this.ctx = createAudioContext();
    this.player = new PcmPlayer(this.ctx);
    this.player.onStart = () => setV({ speaking: true, thinking: false });
    this.player.onIdle = () => setV({ speaking: false });
  }

  micLevel() { return useVoice.getState().muted ? 0 : this.mic?.level ?? 0; }

  async start() {
    setV({ status: 'connecting', botId: this.botId, callId: null, muted: false, speaking: false, listening: false, thinking: false, working: [], captions: [], error: null, startedAt: null, paused: null, engine: 'xai', costUsd: 0 });
    window.addEventListener('pagehide', this.onUnload);
    let stream: MediaStream;
    try {
      stream = await openMic();
    } catch (e) {
      this.end(micErrorMessage(e));
      return;
    }
    if (this.ended) { stream.getTracks().forEach((t) => t.stop()); return; }
    try {
      this.mic = new MicCapture(this.ctx, stream, (pcm) => this.sendAudio(pcm));
      await this.mic.start();
      this.sess = await voiceApi.session(this.botId);
      if (this.ended) { void voiceApi.end(this.botId, this.sess.callId, [], 'Cancelled'); return; }
      this.engine = this.sess.engine === 'gemini' ? 'gemini' : 'xai';
      setV({ callId: this.sess.callId, engine: this.engine });
      if (this.engine === 'gemini') this.connectGemini(this.sess.websocketUrl, false);
      else this.connect(this.sess);
    } catch (e) {
      this.end((e as Error).message || 'Could not start the call');
    }
  }

  private connect(sess: VoiceSession) {
    const ws = new WebSocket(sess.websocketUrl, [`xai-client-secret.${sess.clientSecret}`]);
    this.ws = ws;
    this.connectTimer = setTimeout(() => { if (!this.ready) this.end('Couldn’t connect the call'); }, 15000);
    ws.onopen = () => this.send({ type: 'session.update', session: sess.session });
    ws.onmessage = (m) => {
      if (typeof m.data !== 'string') return;
      try { this.handle(JSON.parse(m.data)); } catch (e) { console.warn('[voice] bad event', e); }
    };
    ws.onclose = (e) => {
      if (this.ended) return;
      this.end(this.ready ? 'Call dropped' : `Couldn’t connect the call${e.reason ? ` (${e.reason})` : ''}`);
    };
  }

  private send(ev: Json) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(ev));
  }

  private sendAudio(pcm: Int16Array) {
    if (!this.ready || this.ended || useVoice.getState().muted) return;
    // The noise guard listens only while the bot is quiet and nothing is running, like Zubi HQ.
    if (!this.player.playing && !this.responseActive && !this.inflight.size && pcm.length) {
      let q = 0;
      for (let i = 0; i < pcm.length; i++) { const s = pcm[i] / 32768; q += s * s; }
      const why = this.gate.frame(Math.sqrt(q / pcm.length), (pcm.length / (this.sess?.sampleRate || 24000)) * 1000);
      if (why) { this.pauseForNoise(why); return; }
    }
    if (this.engine === 'gemini') this.pushGeminiAudio(pcm);
    else this.send({ type: 'input_audio_buffer.append', audio: pcmToBase64(pcm) });
  }

  setMuted(m: boolean) {
    if (this.mic) this.mic.muted = m;
    if (m && this.ready) {
      if (this.engine === 'gemini') this.closeGeminiStream();
      else this.send({ type: 'input_audio_buffer.clear' });
    }
    setV({ muted: m, listening: m ? false : useVoice.getState().listening });
  }

  private pauseForNoise(why: string) {
    if (useVoice.getState().paused) return;
    this.setMuted(true);
    this.gate.reset();
    setV({ paused: why });
  }

  resumeMic() {
    this.gate.reset();
    setV({ paused: null });
    this.setMuted(false);
  }

  /** The call is connected: start the clock, the idle hang-up and the hand-off watcher. */
  private goLive() {
    this.ready = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    setV({ status: 'live', startedAt: Date.now() });
    this.lastActive = Date.now();
    this.idleTimer = setInterval(() => {
      const busy = this.userSpeaking || this.gStreamOpen || this.player.playing || this.responseActive || this.inflight.size > 0;
      if (busy) { this.lastActive = Date.now(); return; }
      if (Date.now() - this.lastActive > IDLE_MS) this.end('Hung up after 2 minutes of silence, to save cost. Any work you handed off still finishes in the chat.');
    }, 5000);
    this.watchTranscript();
  }

  // ---------- Gemini Live ----------

  private connectGemini(url: string, resuming: boolean) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer'; // Gemini sends JSON in binary frames; decode in order, synchronously
    this.ws = ws;
    if (!resuming) this.connectTimer = setTimeout(() => { if (!this.ready) this.end('Couldn’t connect the call'); }, 15000);
    const dec = new TextDecoder();
    ws.onopen = () => ws.send(JSON.stringify({ setup: { model: `models/${this.sess?.model}` } }));
    ws.onmessage = (m) => {
      if (ws !== this.ws) return;
      try { this.handleGemini(JSON.parse(typeof m.data === 'string' ? m.data : dec.decode(m.data as ArrayBuffer))); } catch (e) { console.warn('[voice] bad gemini event', e); }
    };
    ws.onclose = (e) => {
      if (this.ended || ws !== this.ws) return;
      // Gemini ends every connection after ~10 minutes: carry the same session over a new one.
      if (this.ready && this.gHandle) { void this.resumeGemini(); return; }
      this.end(this.ready ? 'Call dropped' : `Couldn’t connect the call${e.reason ? ` (${e.reason})` : ''}`);
    };
  }

  private async resumeGemini() {
    if (this.gReconnecting || this.ended || !this.sess || !this.gHandle) return;
    this.gReconnecting = true;
    this.gResumeAfterTurn = false;
    if (this.gResumeTimer) { clearTimeout(this.gResumeTimer); this.gResumeTimer = null; }
    const old = this.ws;
    this.ws = null;
    try { old?.close(1000, 'resuming'); } catch { /* ignore */ }
    this.gStreamOpen = false;
    try {
      const r = await voiceApi.geminiResume(this.botId, this.sess.callId, this.gHandle);
      if (!this.ended) this.connectGemini(r.websocketUrl, true);
    } catch (e) {
      this.end(`Call dropped while reconnecting${(e as Error).message ? ` (${(e as Error).message})` : ''}`);
    } finally {
      this.gReconnecting = false;
    }
  }

  private gSend(msg: Json) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Audio goes to Gemini only while someone is talking (plus a short tail); a short pre-roll keeps the first word. */
  private pushGeminiAudio(pcm: Int16Array) {
    let q = 0;
    for (let i = 0; i < pcm.length; i++) { const s = pcm[i] / 32768; q += s * s; }
    const rms = Math.sqrt(q / Math.max(1, pcm.length));
    const voiced = rms > Math.max(0.012, this.gFloor * 3);
    if (!voiced) this.gFloor = this.gFloor * 0.995 + rms * 0.005;
    const now = Date.now();
    const send = (p: Int16Array) => this.gSend({ realtimeInput: { audio: { data: pcmToBase64(p), mimeType: `audio/pcm;rate=${this.sess?.sampleRate || 24000}` } } });
    if (voiced) {
      if (!this.gStreamOpen) {
        this.gStreamOpen = true;
        for (const p of this.gPreroll) send(p);
        this.gPreroll = [];
        setV({ listening: true });
      }
      this.gSendUntil = now + 1200;
      this.lastActive = now;
      send(pcm);
      return;
    }
    if (this.gStreamOpen) {
      if (now < this.gSendUntil) { send(pcm); return; }
      this.closeGeminiStream();
      if (!this.player.playing) setV({ thinking: true });
      return;
    }
    this.gPreroll.push(pcm);
    let ms = 0;
    for (let i = this.gPreroll.length - 1; i >= 0; i--) {
      ms += (this.gPreroll[i].length / (this.sess?.sampleRate || 24000)) * 1000;
      if (ms > 350) { this.gPreroll = this.gPreroll.slice(i); break; }
    }
  }

  /** Tell Gemini the user's audio stopped, so it answers now instead of waiting for more. */
  private closeGeminiStream() {
    if (!this.gStreamOpen) return;
    this.gStreamOpen = false;
    this.gSend({ realtimeInput: { audioStreamEnd: true } });
    setV({ listening: false });
  }

  /** A text turn from "the user" side: the greeting cue and [result] notes (Gemini answers it right away). */
  private geminiText(text: string) {
    this.gSend({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
  }

  private addGeminiUsage(u: Json) {
    const sum = (arr: unknown, mod: string) => (Array.isArray(arr) ? arr : []).filter((x: Json) => x?.modality === mod).reduce((a: number, x: Json) => a + (Number(x.tokenCount) || 0), 0);
    const t = this.gTokens;
    t.textIn += sum(u.promptTokensDetails, 'TEXT') + (Number(u.toolUsePromptTokenCount) || 0);
    t.audioIn += sum(u.promptTokensDetails, 'AUDIO');
    t.audioOut += sum(u.responseTokensDetails, 'AUDIO');
    t.textOut += sum(u.responseTokensDetails, 'TEXT') + (Number(u.thoughtsTokenCount) || 0);
    const r = this.sess?.rates;
    if (!r) return;
    const cost = (t.textIn * r.textInPerM + t.audioIn * r.audioInPerM + t.audioOut * r.audioOutPerM + t.textOut * r.textOutPerM) / 1e6;
    setV({ costUsd: cost });
    if (cost >= (this.sess?.capLeft ?? Infinity)) this.end('Hung up: Gemini calls reached today’s spending cap. Switch to xAI under Voice chat, or call again tomorrow.');
  }

  private finishUserCaption() {
    if (!this.gUserId) return;
    const cap = useVoice.getState().captions.find((c) => c.id === this.gUserId);
    this.caption(this.gUserId, 'user', '', true, 'append');
    this.gUserId = null;
    const why = this.gate.turnText(cap?.text.length ?? 0);
    if (why) this.pauseForNoise(why);
  }

  private handleGemini(ev: Json) {
    if (ev.setupComplete) {
      if (!this.ready) {
        this.goLive();
        this.geminiText(`(Automatic note: the call just connected. Say a short, friendly hello to ${this.firstName()} by name and let them lead.)`);
      }
      return;
    }
    if (ev.sessionResumptionUpdate) {
      if (ev.sessionResumptionUpdate.resumable && ev.sessionResumptionUpdate.newHandle) this.gHandle = String(ev.sessionResumptionUpdate.newHandle);
      return;
    }
    if (ev.goAway) {
      // Switch connections between turns, before Gemini closes this one.
      const left = parseFloat(String(ev.goAway.timeLeft ?? '5')) * 1000 || 5000;
      if (this.responseActive || this.player.playing || this.inflight.size) {
        this.gResumeAfterTurn = true;
        this.gResumeTimer = setTimeout(() => void this.resumeGemini(), Math.max(500, left - 1500));
      } else void this.resumeGemini();
      return;
    }
    if (ev.usageMetadata) this.addGeminiUsage(ev.usageMetadata);
    if (ev.toolCall) {
      for (const fc of (ev.toolCall.functionCalls ?? []) as Json[]) this.startTool(fc.id, fc.name, JSON.stringify(fc.args ?? {}));
      if (this.inflight.size) void this.finishTools(this.responseSpoke);
      return;
    }
    if (ev.toolCallCancellation) {
      for (const id of (ev.toolCallCancellation.ids ?? []) as string[]) this.inflight.delete(id);
      return;
    }
    const sc = ev.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) {
      if (!this.gUserId) this.gUserId = `gu${++this.gCaption}`;
      this.caption(this.gUserId, 'user', String(sc.inputTranscription.text), false, 'append');
    }
    if (sc.interrupted) {
      // The user talked over the bot: stop playing. Three in quick succession sound like a noisy room.
      this.player.clear();
      this.responseActive = false;
      if (this.gBotId) { this.caption(this.gBotId, 'assistant', '', true, 'append'); this.gBotId = null; }
      setV({ thinking: false });
      const why = this.gate.interrupt(Date.now());
      if (why) this.pauseForNoise(why);
    }
    const parts = (sc.modelTurn?.parts ?? []) as Json[];
    if (parts.length || sc.outputTranscription?.text) {
      if (!this.responseActive) {
        this.responseActive = true;
        this.responseSpoke = false;
        this.finishUserCaption();
      }
      setV({ thinking: false });
    }
    for (const p of parts) {
      const d = p.inlineData;
      if (d?.data && String(d.mimeType ?? '').startsWith('audio/')) {
        this.responseSpoke = true;
        this.player.push(base64ToPcm(d.data), 24000);
      }
    }
    if (sc.outputTranscription?.text) {
      if (!this.gBotId) this.gBotId = `gb${++this.gCaption}`;
      this.responseSpoke = true;
      this.caption(this.gBotId, 'assistant', String(sc.outputTranscription.text), false, 'append');
    }
    if (sc.turnComplete) {
      this.responseActive = false;
      if (this.gBotId) { this.caption(this.gBotId, 'assistant', '', true, 'append'); this.gBotId = null; }
      this.finishUserCaption();
      setV({ thinking: false });
      if (this.gResumeAfterTurn) { void this.player.whenIdle(8000).then(() => this.resumeGemini()); return; }
      this.flushNotes();
    }
  }

  // ---------- realtime events (xAI) ----------

  private handle(ev: Json) {
    switch (ev.type) {
      case 'session.updated':
        if (!this.ready) {
          this.goLive();
          this.send({ type: 'response.create' }); // the bot greets first
        }
        return;

      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true;
        setV({ listening: true });
        // Barge-in: stop talking and listen. Three in quick succession sound like a noisy room.
        if (this.player.playing || this.responseActive) {
          const why = this.gate.interrupt(Date.now());
          if (why) { this.player.clear(); if (this.responseActive) this.send({ type: 'response.cancel' }); this.pauseForNoise(why); return; }
        }
        if (this.player.playing) this.player.clear();
        if (this.responseActive) {
          this.interruptedId = this.responseId;
          this.send({ type: 'response.cancel' });
        }
        return;
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed':
        this.userSpeaking = false;
        setV({ listening: false });
        this.flushNotes();
        return;

      case 'conversation.item.added':
      case 'conversation.item.created': {
        const item = ev.item ?? {};
        if (item.role === 'user' && Array.isArray(item.content) && item.content.some((c: Json) => c?.type === 'input_audio')) {
          const t = item.content.find((c: Json) => c?.transcript)?.transcript;
          this.caption(item.id, 'user', t ?? '', !!t, 'set');
        }
        return;
      }
      // xAI sends the cumulative transcript in `.updated`; OpenAI sends `.delta` increments.
      case 'conversation.item.input_audio_transcription.updated':
        this.caption(ev.item_id, 'user', ev.transcript ?? '', false, 'set');
        return;
      case 'conversation.item.input_audio_transcription.delta':
        this.caption(ev.item_id, 'user', ev.delta ?? '', false, 'append');
        return;
      case 'conversation.item.input_audio_transcription.completed': {
        this.caption(ev.item_id, 'user', ev.transcript ?? '', true, 'set');
        const why = this.gate.turnText(String(ev.transcript ?? '').length);
        if (why) this.pauseForNoise(why);
        return;
      }

      case 'response.created':
        this.responseActive = true;
        this.responseSpoke = false;
        this.responseId = ev.response?.id ?? null;
        setV({ thinking: true });
        return;
      case 'response.output_item.added':
        if (ev.item?.type === 'message') this.caption(ev.item.id, 'assistant', '', false, 'set');
        return;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta':
      case 'response.text.delta':
        this.responseSpoke = true;
        this.caption(ev.item_id, 'assistant', ev.delta ?? '', false, 'append');
        return;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (ev.transcript) this.caption(ev.item_id, 'assistant', ev.transcript, true, 'set');
        return;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (ev.delta && !(this.interruptedId && ev.response_id === this.interruptedId)) {
          this.responseSpoke = true;
          this.player.push(base64ToPcm(ev.delta), this.sess?.sampleRate);
        }
        return;

      case 'response.function_call_arguments.done':
        this.startTool(ev.call_id, ev.name, ev.arguments);
        return;
      case 'response.done': {
        this.responseActive = false;
        setV({ thinking: false });
        for (const o of (ev.response?.output ?? []) as Json[]) if (o?.type === 'function_call') this.startTool(o.call_id, o.name, o.arguments);
        if (this.inflight.size) void this.finishTools(this.responseSpoke);
        else this.flushNotes();
        return;
      }

      case 'error': {
        const code = ev.error?.code ?? ev.code ?? '';
        if (/cancel/i.test(String(code)) || /no active response/i.test(String(ev.error?.message ?? ''))) return;
        console.warn('[voice] realtime error', ev.error ?? ev);
        if (!this.ready) this.end(ev.error?.message ?? 'Voice service error');
        return;
      }
    }
  }

  private caption(id: string | undefined, role: Caption['role'], text: string, final: boolean, mode: 'set' | 'append') {
    if (!id) return;
    const caps = useVoice.getState().captions;
    const i = caps.findIndex((c) => c.id === id);
    if (i < 0) {
      setV({ captions: [...caps, { id, role, text, final }].slice(-200) });
      return;
    }
    const prev = caps[i];
    const next = { ...prev, text: mode === 'append' ? prev.text + text : text || prev.text, final: final || prev.final };
    const copy = caps.slice();
    copy[i] = next;
    setV({ captions: copy });
  }

  transcript() {
    return useVoice.getState().captions.filter((c) => c.text.trim()).map((c) => ({ role: c.role, text: c.text.trim() }));
  }

  // ---------- relay tools ----------

  private startTool(callId: string | undefined, name: string | undefined, rawArgs: string | undefined) {
    if (!callId || !name || this.handledCalls.has(callId)) return;
    this.handledCalls.add(callId);
    let args: Json = {};
    try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { /* model sent bad JSON */ }
    let promise: Promise<string>;
    if (name === 'hang_up') promise = Promise.resolve('Ending the call.');
    else {
      // Show "working" right away; replaced by the real task once the server answers.
      const placeholder = { seq: -1, request: String(args.request ?? '') };
      const dropOptimistic = () => setV({ working: useVoice.getState().working.filter((x) => x !== placeholder) });
      if (name === 'hand_off') setV({ working: [...useVoice.getState().working, placeholder] });
      promise = voiceApi.tool(this.botId, this.sess!.callId, name, args)
        .then((r) => {
          if (name === 'hand_off') {
            dropOptimistic();
            if (r.taskSeq) this.addTask(r.taskSeq, String(args.request ?? ''));
          }
          return r.output;
        })
        .catch((e) => {
          if (name === 'hand_off') dropOptimistic();
          return `Tool error: ${(e as Error).message}. Tell the user it didn't go through.`;
        });
    }
    this.inflight.set(callId, { name, promise });
  }

  private async finishTools(spoke: boolean) {
    const batch = [...this.inflight.entries()];
    this.inflight.clear();
    const outputs = await Promise.all(batch.map(([, b]) => b.promise));
    if (this.ended) return;
    if (this.engine === 'gemini') {
      // One toolResponse for the batch; Gemini carries on speaking by itself after it (blocking calls).
      this.gSend({ toolResponse: { functionResponses: batch.map(([callId, b], i) => ({ id: callId, name: b.name, response: { output: outputs[i] } })) } });
      if (batch.some(([, b]) => b.name === 'hang_up')) {
        await new Promise((r) => setTimeout(r, 600));
        await this.player.whenIdle(8000);
        this.end();
      }
      return;
    }
    // Every output first, then a single response.create (xAI parallel-call rule).
    batch.forEach(([callId], i) => this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: outputs[i] } }));
    if (batch.some(([, b]) => b.name === 'hang_up')) {
      await this.player.whenIdle(8000);
      this.end();
      return;
    }
    // A hand-off the bot already announced needs no follow-up turn; read tools do.
    const needsReply = !spoke || batch.some(([, b]) => b.name !== 'hand_off');
    if (needsReply) {
      await this.player.whenIdle(8000); // don't talk over the current sentence
      if (!this.ended && !this.responseActive && !this.inflight.size) this.send({ type: 'response.create' });
    } else this.flushNotes();
  }

  // ---------- results: watch the text agent finish what was asked by voice ----------

  private addTask(seq: number, request: string) {
    const live = useStore.getState().live[this.botId];
    this.tasks.push({ seq, request, since: Date.now(), startedBusy: !!live?.isRunning, sawRunning: false, awaitingNoted: false, doneSince: null });
    this.syncWorking();
    this.scheduleCheck(800);
  }

  private syncWorking() {
    const optimistic = useVoice.getState().working.filter((x) => x.seq === -1);
    setV({ working: [...this.tasks.map((t) => ({ seq: t.seq, request: t.request })), ...optimistic] });
  }

  private watchTranscript() {
    this.unsubStore = useStore.subscribe((s, prev) => {
      if (!this.tasks.length) return;
      if (s.live[this.botId] !== prev.live[this.botId] || s.transcripts[this.botId] !== prev.transcripts[this.botId]) {
        if (s.live[this.botId]?.isRunning) for (const t of this.tasks) t.sawRunning = true;
        this.scheduleCheck(400);
      }
    });
  }

  private scheduleCheck(ms: number) {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => this.checkTasks(), ms);
  }

  private checkTasks() {
    if (this.ended || !this.tasks.length) return;
    const st = useStore.getState();
    const live = st.live[this.botId];
    const rows = sortedRows(st.transcripts[this.botId]);
    const now = Date.now();
    let recheck = false;
    for (const task of [...this.tasks]) {
      if (live?.isRunning) task.sawRunning = true;
      const after = rows.filter((r) => r.seq > task.seq);
      if (live?.awaiting) {
        if (!task.awaitingNoted) {
          task.awaitingNoted = true;
          this.queueNote(`The work you handed off ("${clip(task.request, 160)}") is paused and needs ${this.firstName()}'s OK in the chat: ${live.awaiting.reason}. Tell them it's waiting for their approval on screen.`);
        }
        task.doneSince = null;
        continue;
      }
      task.awaitingNoted = false;
      const replies = after.filter((r) => r.body.type === 'message' && r.body.role === 'assistant' && !r.body.streaming);
      const streaming = after.some((r) => r.body.type === 'message' && r.body.streaming);
      const finished = !live?.isRunning && !streaming && (replies.length > 0 || (task.sawRunning && !task.startedBusy)) && now - task.since > 1500;
      if (!finished) { task.doneSince = null; continue; }
      // Stay "finished" for a moment: back-to-back queued turns briefly look idle.
      if (task.doneSince === null) { task.doneSince = now; recheck = true; continue; }
      if (now - task.doneSince < 1200) { recheck = true; continue; }
      this.tasks = this.tasks.filter((t) => t !== task);
      this.queueNote(landedNote(task.request, replies, after));
    }
    this.syncWorking();
    if (recheck) this.scheduleCheck(700);
  }

  private firstName() {
    return (useStore.getState().user?.name ?? '').split(/\s+/)[0] || 'the user';
  }

  private queueNote(text: string) {
    this.notes.push(text);
    this.flushNotes();
  }

  private flushNotes() {
    if (!this.ready || this.ended || !this.notes.length) return;
    if (this.responseActive || this.userSpeaking || this.inflight.size) return; // retried on response.done / speech_stopped
    if (this.player.playing) {
      if (!this.flushWaiting) {
        this.flushWaiting = true;
        void this.player.whenIdle().then(() => { this.flushWaiting = false; this.flushNotes(); });
      }
      return;
    }
    if (this.gStreamOpen) return; // Gemini: the user is mid-sentence; retried at the end of the turn
    const text = this.notes.splice(0).map((n) => `[result] ${n}`).join('\n\n');
    const note = `${text}\n\n(Automatic note from your text agent, not spoken by ${this.firstName()}. Tell them the outcome now, briefly.)`;
    if (this.engine === 'gemini') { this.geminiText(note); return; }
    // A user-role item: the voice model ignores system-role items mid-call (tested), but relays these.
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: note }] } });
    this.send({ type: 'response.create' });
  }

  // ---------- teardown ----------

  end(error?: string) {
    if (this.ended) return;
    this.ended = true;
    window.removeEventListener('pagehide', this.onUnload);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.checkTimer) clearTimeout(this.checkTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.gResumeTimer) clearTimeout(this.gResumeTimer);
    this.unsubStore?.();
    try { this.ws?.close(1000, 'call ended'); } catch { /* ignore */ }
    this.mic?.stop();
    this.player.dispose();
    void this.ctx.close().catch(() => {});
    const transcript = this.transcript();
    if (this.sess) void voiceApi.end(this.botId, this.sess.callId, transcript, error, this.engine === 'gemini' ? this.gTokens : undefined).catch((e) => console.warn('[voice] end failed', e));
    if (this.engine === 'gemini') voiceApi.refreshOptions(); // today's cap headroom changed
    if (current === this) current = null;
    if (error) {
      setV({ status: 'error', error, speaking: false, listening: false, thinking: false, working: [] });
      setTimeout(() => { if (useVoice.getState().status === 'error' && !current) setV({ status: 'idle', botId: null, error: null }); }, 6000);
    } else {
      setV({ status: 'idle', botId: null, callId: null, speaking: false, listening: false, thinking: false, working: [], startedAt: null, paused: null, muted: false });
    }
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function landedNote(request: string, replies: Row[], after: Row[]): string {
  const text = replies.map((r) => (r.body.type === 'message' ? r.body.text : '')).join('\n\n').trim();
  const waiting = after
    .map((r) => r.body)
    .filter((b) => b.type === 'card' && b.status === 'pending')
    .map((b) => (b.type === 'card' ? (b.card === 'approval' ? b.title : b.card === 'question' ? `a question: ${b.question}` : b.card === 'connect' ? `connecting ${b.toolkitName}` : 'a draft to review') : ''));
  return `The work you handed off just finished. Request: "${clip(request, 200)}". ${text ? `Your text agent replied:\n"""\n${clip(text, 1800)}\n"""` : 'It finished without a written reply.'}${waiting.length ? `\nStill waiting on the user in the chat: ${waiting.join('; ')}.` : ''}`;
}

/** Play a short TTS sample through the same PCM path the call uses. */
export async function previewVoice(p: { botId: string; voice?: string; speed?: number; language?: string }): Promise<void> {
  const ctx = createAudioContext();
  const player = new PcmPlayer(ctx);
  try {
    const pcm = await voiceApi.preview(p);
    // Feed it in 100 ms chunks, like realtime deltas.
    for (let i = 0; i < pcm.length; i += 2400) player.push(pcm.subarray(i, i + 2400));
    await player.whenIdle(30000);
  } finally {
    player.dispose();
    void ctx.close().catch(() => {});
  }
}
