import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Bot } from '@shared/types';
import { voiceApi } from '../voice/api';
import { createAudioContext, PcmPlayer } from '../voice/audio';
import { useDictation } from '../voice/dictation';
import { BotAvatarFor } from '../avatar/BotAvatar';
import '../styles/clicky.css';

/**
 * Clicky on a screen: hold Ctrl+Alt (or the Ask button), say what you need, let go. The team member looks
 * at the screen, answers out loud, and a spark flies to the thing to click and circles it. It only points:
 * nothing on the screen is clicked or typed for you, and the questions are not saved in the chat.
 */

interface Mark { kind: 'circle' | 'arrow' | 'step'; step?: number; x: number; y: number; label?: string }
interface Answer { text: string; point: { x: number; y: number; label?: string } | null; marks: Mark[] }
export type ClickyPhase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

const HOLD_MS = 250;
const LINGER_MS = 9000;

async function askScreen(botId: string, question: string, history: { q: string; a: string }[]): Promise<Answer> {
  const res = await fetch('/api/clicky/ask', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId, question, history }),
  });
  if (!res.ok) {
    let msg = 'Couldn’t get an answer just now.';
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json() as Promise<Answer>;
}

export function useClicky(bot: Bot, active: boolean) {
  const [phase, setPhase] = useState<ClickyPhase>('idle');
  const [answer, setAnswer] = useState<(Answer & { id: number }) | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const history = useRef<{ q: string; a: string }[]>([]);
  const audio = useRef<{ ctx: AudioContext; player: PcmPlayer } | null>(null);
  const turn = useRef(0);
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hush = useCallback(() => { audio.current?.player.clear(); }, []);
  const clear = useCallback(() => {
    hush();
    if (linger.current) clearTimeout(linger.current);
    setAnswer(null); setQuestion(null); setError(null);
  }, [hush]);

  const speak = useCallback(async (text: string, id: number) => {
    try {
      const pcm = await voiceApi.preview({ botId: bot.id, text: text.slice(0, 400) });
      if (turn.current !== id) return;
      if (!audio.current) { const ctx = createAudioContext(); audio.current = { ctx, player: new PcmPlayer(ctx) }; }
      const { player } = audio.current;
      for (let i = 0; i < pcm.length; i += 2400) player.push(pcm.subarray(i, i + 2400));
      await player.whenIdle(45_000);
    } catch { /* the words are on screen anyway */ }
  }, [bot.id]);

  const ask = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text) { setPhase('idle'); return; }
    const id = ++turn.current;
    if (linger.current) clearTimeout(linger.current);
    setQuestion(text); setError(null); setPhase('thinking');
    try {
      const a = await askScreen(bot.id, text, history.current);
      if (turn.current !== id) return;
      history.current = [...history.current, { q: text, a: a.text }].slice(-4);
      setAnswer({ ...a, id });
      setPhase('speaking');
      await speak(a.text, id);
    } catch (e) {
      if (turn.current === id) setError((e as Error).message);
    } finally {
      if (turn.current === id) {
        setPhase('idle');
        linger.current = setTimeout(() => { if (turn.current === id) { setAnswer(null); setQuestion(null); setError(null); } }, LINGER_MS);
      }
    }
  }, [bot.id, speak]);

  const dict = useDictation((t) => void ask(t), (m) => { setError(m); setPhase('idle'); }, bot.voiceLanguage);
  useEffect(() => {
    if (dict.state === 'recording') setPhase('listening');
    else if (dict.state === 'transcribing') setPhase('transcribing');
    else {
      // Back to idle without a question (nothing heard, or too short): say so instead of hanging.
      setPhase((p) => {
        if (p !== 'transcribing') return p === 'listening' ? 'idle' : p;
        setError('I didn’t catch that. Hold the key, talk, then let go.');
        return 'idle';
      });
    }
  }, [dict.state]);

  // Hold Ctrl+Alt to talk (the same shortcut Clicky uses on Windows). Any other key with them cancels,
  // so shortcuts like Ctrl+Alt+T still reach the screen untouched.
  const dictRef = useRef(dict);
  dictRef.current = dict;
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let holding = false;
    const reset = (cancel: boolean) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (holding) { holding = false; if (cancel) dictRef.current.cancel(); else dictRef.current.stop(); }
    };
    const down = (e: KeyboardEvent) => {
      const mod = e.key === 'Control' || e.key === 'Alt';
      if (mod && e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey) {
        if (!timer && !holding) timer = setTimeout(() => { timer = null; holding = true; hush(); clear(); dictRef.current.start(); }, HOLD_MS);
      } else if (timer || holding) {
        reset(true);
      }
    };
    const up = (e: KeyboardEvent) => { if (e.key === 'Control' || e.key === 'Alt') reset(false); };
    const blur = () => reset(true);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      reset(true);
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
    };
  }, [active, hush, clear]);

  useEffect(() => () => {
    turn.current++;
    if (linger.current) clearTimeout(linger.current);
    audio.current?.player.dispose();
    void audio.current?.ctx.close().catch(() => {});
    audio.current = null;
  }, []);
  useEffect(() => { if (!active) { turn.current++; clear(); setPhase('idle'); } }, [active, clear]);

  /** Ask button: hold to talk, or tap to start and tap again to stop. */
  const button = {
    onPointerDown: (e: React.PointerEvent) => { hush(); clear(); dict.onPointerDown(e); },
    onPointerUp: dict.onPointerUp,
    onKeyDown: dict.onKeyDown,
  };
  /** A typed question (for a quiet room or a call): same answer, voice and pointing. */
  const askTyped = useCallback((t: string) => { if (!t.trim()) return; hush(); clear(); void ask(t); }, [hush, clear, ask]);
  return { phase, answer, question, error, button, ask: askTyped, dismiss: clear };
}

const PHASE_TEXT: Partial<Record<ClickyPhase, string>> = {
  listening: 'Listening… let go when you’re done',
  transcribing: 'Got it…',
  thinking: 'Looking at the screen…',
};

/** The spark, the marks and the caption, laid over the screen (coordinates are fractions of it). */
export function ClickyOverlay({ bot, clicky }: { bot: Bot; clicky: ReturnType<typeof useClicky> }) {
  const { phase, answer, question, error, dismiss } = clicky;
  const point = answer?.point ?? null;
  const status = PHASE_TEXT[phase];
  if (!answer && !status && !error) return null;
  const at = (x: number, y: number) => ({ left: `${x * 100}%`, top: `${y * 100}%` }) as CSSProperties;

  return (
    <div className="clicky" aria-live="polite">
      {answer?.marks.map((m, i) => (
        <span key={`${answer.id}-${i}`} className={`clicky__mark is-${m.kind}`} style={{ ...at(m.x, m.y), animationDelay: `${300 + i * 180}ms` }}>
          {m.kind === 'step' ? <b>{m.step}</b> : null}
          {/* The pointer already names the spot it sits on, so a mark there keeps only its number. */}
          {m.label && !(point && Math.hypot(point.x - m.x, point.y - m.y) < 0.03) && <em>{m.label}</em>}
        </span>
      ))}
      <span key={answer?.id ?? 'home'} className={`clicky__spark${point ? ' is-pointing' : ''}`} style={point ? at(point.x, point.y) : undefined} aria-hidden>
        <i className="clicky__ring" />
        <svg className="clicky__cursor" viewBox="0 0 24 24" width="22" height="22"><path d="M3 2l17 8-7 2.5L10.5 20z" /></svg>
        {point?.label && <span className="clicky__tag">{point.label}</span>}
      </span>
      <div className={`clicky__caption${error ? ' is-error' : ''}`} onClick={dismiss} role="status" title="Click to dismiss">
        <BotAvatarFor bot={bot} size={22} />
        <div className="clicky__words">
          {question && phase !== 'listening' && <span className="clicky__q">“{question}”</span>}
          <span className="clicky__a">{error ?? (answer && phase !== 'thinking' ? answer.text : status)}</span>
        </div>
        {phase === 'speaking' && <i className="clicky__wave" aria-hidden><b /><b /><b /></i>}
      </div>
    </div>
  );
}
