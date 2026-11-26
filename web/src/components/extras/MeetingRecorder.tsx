import { useCallback, useEffect, useRef, useState } from 'react';
import { Circle, MonitorUp } from 'lucide-react';
import type { Bot } from '@shared/types';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { voiceApi } from '../../voice/api';
import { micErrorMessage, openMic } from '../../voice/audio';
import { canShareScreen } from './pendingPictures';

/**
 * Record a meeting: the microphone (and, if asked, this tab's sound) is recorded in one-minute pieces, each one
 * transcribed as it ends. Stop & send gives the team member the whole transcript with a request to summarize it
 * and save both to its Library. Cancel throws the recording away. Nothing is kept in the browser.
 */

const CHUNK_MS = 60_000;

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return undefined;
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function MeetingRecorder({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  // The meeting goes to the team member it was started for, even if another chat is opened meanwhile.
  const botId = useRef(bot.id).current;
  const botName = useRef(bot.name).current;
  const [phase, setPhase] = useState<'starting' | 'recording' | 'finishing' | 'failed'>('starting');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [tab, setTab] = useState(false);
  const [unsent, setUnsent] = useState<string | null>(null);

  const ctx = useRef<AudioContext | null>(null);
  const dest = useRef<MediaStreamAudioDestinationNode | null>(null);
  const streams = useRef<MediaStream[]>([]);
  const rec = useRef<{ mr: MediaRecorder; done: Promise<void> } | null>(null);
  const texts = useRef<string[]>([]);
  const jobs = useRef<Promise<void>[]>([]);
  const dones = useRef<Promise<void>[]>([]);
  const count = useRef(0);
  const startAt = useRef(0);
  const cancelled = useRef(false);
  const rotate = useRef<ReturnType<typeof setInterval>>();

  const stopAll = useCallback(() => {
    clearInterval(rotate.current);
    const cur = rec.current;
    rec.current = null;
    if (cur && cur.mr.state !== 'inactive') cur.mr.stop();
    streams.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streams.current = [];
    void ctx.current?.close().catch(() => {});
    ctx.current = null; dest.current = null;
  }, []);

  /** A new piece: recorded until the next one starts, then transcribed in its place in the order. */
  const startChunk = useCallback(() => {
    const out = dest.current;
    if (!out) return;
    const mime = pickMime();
    const mr = new MediaRecorder(out.stream, mime ? { mimeType: mime } : undefined);
    const parts: Blob[] = [];
    const idx = count.current++;
    const began = Date.now();
    const done = new Promise<void>((resolve) => {
      mr.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      mr.onstop = () => {
        if (!cancelled.current && parts.length) {
          const blob = new Blob(parts, { type: mr.mimeType || mime || 'audio/webm' });
          jobs.current.push(voiceApi.transcribe(blob, 'auto', { ms: Date.now() - began, what: 'meeting', botId })
            .then((t) => { texts.current[idx] = t.trim(); })
            .catch(() => { texts.current[idx] = `[Minute ${idx + 1} could not be transcribed]`; setWarn('One minute could not be transcribed; the rest is kept.'); }));
        }
        resolve();
      };
    });
    mr.start();
    dones.current.push(done);
    rec.current = { mr, done };
  }, [botId]);

  useEffect(() => {
    let gone = false;
    cancelled.current = false;
    (async () => {
      try {
        if (typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') throw new Error('Recording isn’t supported in this browser.');
        const mic = await openMic();
        if (gone) { mic.getTracks().forEach((t) => t.stop()); return; }
        streams.current.push(mic);
        const ac = new AudioContext();
        void ac.resume().catch(() => {});
        const out = ac.createMediaStreamDestination();
        ac.createMediaStreamSource(mic).connect(out);
        ctx.current = ac; dest.current = out;
        startAt.current = Date.now();
        startChunk();
        rotate.current = setInterval(() => { const cur = rec.current; startChunk(); if (cur && cur.mr.state !== 'inactive') cur.mr.stop(); }, CHUNK_MS);
        setPhase('recording');
      } catch (e) {
        if (!gone) { setError(micErrorMessage(e)); setPhase('failed'); }
      }
    })();
    return () => { gone = true; cancelled.current = true; stopAll(); };
  }, [startChunk, stopAll]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const t = setInterval(() => setElapsed(Date.now() - startAt.current), 1000);
    return () => clearInterval(t);
  }, [phase]);

  /** Mixes this tab's (or another tab's) sound in, for a call held in the browser. */
  const addTabSound = async () => {
    const ac = ctx.current, out = dest.current;
    if (!ac || !out || !navigator.mediaDevices?.getDisplayMedia) return;
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const audio = s.getAudioTracks();
      if (!audio.length) { s.getTracks().forEach((t) => t.stop()); setWarn('No sound was shared. Try again and turn on “Share tab audio”.'); return; }
      if (!ctx.current) { s.getTracks().forEach((t) => t.stop()); return; }
      streams.current.push(s);
      ac.createMediaStreamSource(new MediaStream(audio)).connect(out);
      setTab(true); setWarn(null);
      audio[0].addEventListener('ended', () => setTab(false));
    } catch { /* cancelled or refused */ }
  };

  const deliver = async (text: string) => {
    const running = !!useStore.getState().live[botId]?.isRunning;
    if (running) await api.control(botId, 'steer', text);
    else await api.send(botId, text);
  };

  const stopAndSend = async () => {
    if (phase !== 'recording') return;
    setPhase('finishing');
    clearInterval(rotate.current);
    const ms = Date.now() - startAt.current;
    const cur = rec.current;
    rec.current = null;
    if (cur && cur.mr.state !== 'inactive') cur.mr.stop();
    await Promise.all(dones.current);
    await Promise.all(jobs.current);
    stopAll();
    const transcript = texts.current.filter(Boolean).join('\n\n').trim();
    if (!transcript) { setError('Nothing was heard, so nothing was sent.'); setPhase('failed'); return; }
    const started = new Date(startAt.current);
    const minutes = Math.max(1, Math.round(ms / 60_000));
    const date = started.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const text = `Meeting transcript (${minutes} min, recorded ${date}):\n\n${transcript}\n\nSummarize this meeting: decisions, action items with owners and dates, open questions. Save the summary and the transcript to your Library as meeting-${ymd(started)}.md.`;
    await sendText(text);
  };

  const sendText = async (text: string) => {
    setError(null); setPhase('finishing');
    try { await deliver(text); onClose(); }
    catch (e) { setUnsent(text); setError(`The transcript wasn’t sent: ${(e as Error).message}`); setPhase('failed'); }
  };

  const cancel = () => {
    if (phase === 'recording' && elapsed > 30_000 && !window.confirm('Throw this recording away?')) return;
    cancelled.current = true;
    stopAll();
    onClose();
  };

  const copyUnsent = async () => { if (unsent) { try { await navigator.clipboard.writeText(unsent); setWarn('Transcript copied.'); } catch { /* not allowed */ } } };

  return (
    <div className={`meeting-bar${phase === 'failed' ? ' is-failed' : ''}`} role="region" aria-label="Meeting recording">
      <div className="meeting-bar__row">
        {phase === 'failed' ? (
          <span className="meeting-bar__state">{error}</span>
        ) : (
          <span className="meeting-bar__state" role="status">
            <Circle size={10} fill="currentColor" strokeWidth={0} className="meeting-bar__dot" aria-hidden />
            {phase === 'starting' ? 'Starting the microphone…' : phase === 'finishing' ? 'Finishing the transcript…' : <>Recording · {clock(elapsed)}{botName !== bot.name ? ` · for ${botName}` : ''}{tab ? ' · with tab sound' : ''}</>}
          </span>
        )}
        <span className="meeting-bar__acts">
          {phase === 'recording' && !tab && canShareScreen && (
            <button type="button" className="link-btn" onClick={() => void addTabSound()} title="For a call in a browser tab: pick the tab and turn on “Share tab audio”">
              <MonitorUp size={13} strokeWidth={1.8} aria-hidden /> Also record this tab’s sound
            </button>
          )}
          {phase === 'recording' && <button type="button" className="meeting-bar__stop" onClick={() => void stopAndSend()}>Stop &amp; send</button>}
          {phase === 'failed' && unsent && <button type="button" className="meeting-bar__stop" onClick={() => void sendText(unsent)}>Try again</button>}
          {phase === 'failed' && unsent && <button type="button" className="link-btn" onClick={() => void copyUnsent()}>Copy transcript</button>}
          {phase !== 'finishing' && <button type="button" className="link-btn" onClick={cancel}>{phase === 'failed' ? 'Close' : 'Cancel'}</button>}
        </span>
      </div>
      {phase !== 'failed' && <div className="meeting-bar__note">Tell everyone on the call that it is being recorded.</div>}
      {warn && <div className="meeting-bar__note">{warn}</div>}
    </div>
  );
}
