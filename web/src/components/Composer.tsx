import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Bot, MessageBody } from '@shared/types';
import { api } from '../lib/api';
import { displayName, useStore } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { useDictation } from '../voice/dictation';
import { speakReply, stopSpeaking, useSpeak } from '../voice/speak';

const MAX_H = 200;
/** Replies up to this long are read aloud after a voice message; longer ones get a Listen button instead. */
const AUTO_SPEAK_MAX = 600;
const drafts = new Map<string, string>();

/** Put a starter request in a bot's message box (the orb's capability icons use it), ready to finish and send. */
export function prefillComposer(botId: string, text: string) {
  drafts.set(botId, text);
  window.dispatchEvent(new CustomEvent('heyzubi:compose', { detail: { botId, text } }));
}

export function Composer({ bot, running }: { bot: Bot; running: boolean }) {
  const [text, setText] = useState(() => drafts.get(bot.id) ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const setModal = useStore((s) => s.setModal);

  // Per-bot drafts.
  useEffect(() => { setText(drafts.get(bot.id) ?? ''); setError(null); ref.current?.focus(); }, [bot.id]);
  useEffect(() => { drafts.set(bot.id, text); }, [bot.id, text]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ botId: string; text: string }>).detail;
      if (d?.botId !== bot.id) return;
      setText(d.text);
      setTimeout(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 0);
    };
    window.addEventListener('heyzubi:compose', on);
    return () => window.removeEventListener('heyzubi:compose', on);
  }, [bot.id]);

  // Auto-grow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden';
  }, [text]);

  // ⌘I focuses the prompt.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true); setError(null);
    try {
      await api.send(bot.id, t);
      setText('');
      drafts.delete(bot.id);
    } catch (e) {
      setError((e as Error).message || 'Message failed to send');
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const stop = () => api.interrupt(bot.id).catch((e) => setError(e.message));
  const fresh = () => api.fresh(bot.id).catch((e) => setError(e.message));

  // Dictation: insert the transcript at the cursor.
  const insertText = (t: string) => {
    const el = ref.current;
    setText((cur) => {
      const start = el && document.activeElement === el ? el.selectionStart : cur.length;
      const end = el && document.activeElement === el ? el.selectionEnd : cur.length;
      const before = cur.slice(0, start);
      const after = cur.slice(end);
      const pre = before && !/\s$/.test(before) ? ' ' : '';
      const post = after && !/^\s/.test(after) ? ' ' : '';
      requestAnimationFrame(() => { if (el) { const pos = before.length + pre.length + t.length; el.focus(); el.setSelectionRange(pos, pos); } });
      return before + pre + t + post + after;
    });
  };
  const dictation = useDictation(insertText, setError, bot.voiceLanguage, 'dictation');
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);

  // Voice message (the cheap default): hold the main button, talk, let go. It is transcribed and sent to the bot's
  // usual (text) agent; a short reply is then read aloud. No live call is opened, so silences cost nothing.
  const awaitSpeak = useRef<number | null>(null); // the voice message whose reply gets read aloud
  const [vmNote, setVmNote] = useState<string | null>(null);
  const sendVoice = async (t: string) => {
    const said = t.trim();
    if (!said) return;
    setError(null); setVmNote(null); stopSpeaking();
    try { const { row } = await api.send(bot.id, said, true); awaitSpeak.current = row.seq; }
    catch (e) { setError((e as Error).message || 'Voice message failed to send'); }
  };
  const voiceMsg = useDictation((t) => void sendVoice(t), setError, bot.voiceLanguage, 'voice-message');
  const liveState = useStore((s) => s.live[bot.id]);
  const rowsBySeq = useStore((s) => s.transcripts[bot.id]?.bySeq);
  useEffect(() => {
    const after = awaitSpeak.current;
    if (after === null || !rowsBySeq || liveState?.isRunning) return;
    const replies = Object.values(rowsBySeq)
      .filter((r) => r.seq > after && r.body.type === 'message' && r.body.role === 'assistant' && !r.body.streaming && !!r.body.text?.trim())
      .sort((a, b) => a.seq - b.seq);
    if (!replies.length) return;
    awaitSpeak.current = null;
    const said = replies.map((r) => (r.body as MessageBody).text).join('\n\n');
    const last = replies[replies.length - 1];
    if (said.length <= AUTO_SPEAK_MAX) void speakReply(bot.id, said, `${bot.id}:${last.seq}`);
    else setVmNote(`${displayName(bot)}’s reply is long, so it wasn’t read aloud. Press the speaker next to it to listen.`);
  }, [rowsBySeq, liveState?.isRunning, bot]);
  useEffect(() => { awaitSpeak.current = null; setVmNote(null); }, [bot.id]);
  const speakError = useSpeak((s) => s.error);
  useEffect(() => { if (speakError) { setError(speakError); useSpeak.setState({ error: null }); } }, [speakError]);
  useEffect(() => { if (!vmNote) return; const t = setTimeout(() => setVmNote(null), 9000); return () => clearTimeout(t); }, [vmNote]);

  const hasText = text.trim().length > 0;
  const multiline = text.includes('\n') || (ref.current?.scrollHeight ?? 0) > 30;

  return (
    <div className="composer-area">
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
      {!error && vmNote && <div className="composer__note" role="status">{vmNote}</div>}
      {!error && !vmNote && voiceMsg.state !== 'idle' && <div className="composer__note" role="status">{voiceMsg.state === 'recording'
          ? voiceMsg.tap ? 'Listening… tap the red button again to send (Esc cancels)' : 'Listening… let go to send (Esc cancels)'
          : 'Transcribing and sending your voice message…'}</div>}
      <div className={`composer${multiline ? ' is-multiline' : ''}`}>
        <div className="composer__left">
          <span className="composer__plus-anchor">
            <button type="button" className="composer__btn" onClick={() => setMenu(!menu)} aria-label="More actions" aria-expanded={menu}>
              <Icon name="composer_plus" opacity={0.56} />
            </button>
            {menu && (
              <Menu
                placement="above"
                onClose={() => setMenu(false)}
                items={[
                  { label: 'New conversation', onSelect: fresh },
                  { label: 'Connect apps', onSelect: () => setModal('apps') },
                  { label: inCall ? 'End live call' : 'Start a live call · $0.08/min', onSelect: () => (inCall ? endCall() : startCall(bot.id)) },
                ]}
              />
            )}
          </span>
          <textarea
            ref={ref}
            className="composer__input"
            rows={1}
            value={text}
            placeholder={`Message ${displayName(bot)}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
            aria-label={`Message ${bot.name}`}
          />
        </div>
        <div className="composer__right">
          <button
            type="button"
            className={`composer__btn${dictation.state === 'recording' ? ' is-recording' : dictation.state === 'transcribing' ? ' is-transcribing' : ''}`}
            aria-label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
            aria-pressed={dictation.state === 'recording'}
            title={dictation.state === 'recording' ? 'Release or click to stop · Esc cancels' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Hold to dictate, or click to start'}
            disabled={dictation.state === 'transcribing'}
            onPointerDown={dictation.onPointerDown}
            onPointerUp={dictation.onPointerUp}
            onKeyDown={dictation.onKeyDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Icon name="mic" opacity={0.56} />
          </button>
          {inCall && !hasText ? (
            <button type="button" className="composer__cta is-in-call" onClick={endCall} aria-label="End voice call" title="End voice call">
              <Icon name="voice_a" size={16} />
            </button>
          ) : running && !hasText ? (
            <button type="button" className="composer__cta" onClick={stop} aria-label="Stop" title="Stop">
              <Icon name="stop" size={14} />
            </button>
          ) : hasText ? (
            <button type="button" className="composer__cta" onClick={send} disabled={sending} aria-label="Send" title="Send (Enter)">
              <Icon name="arrow_up" size={16} />
            </button>
          ) : (
            <button
              type="button"
              className={`composer__cta composer__vm${voiceMsg.state === 'recording' ? ' is-recording' : voiceMsg.state === 'transcribing' ? ' is-transcribing' : ''}`}
              disabled={voiceMsg.state === 'transcribing'}
              onPointerDown={voiceMsg.onPointerDown}
              onPointerUp={voiceMsg.onPointerUp}
              onKeyDown={voiceMsg.onKeyDown}
              onContextMenu={(e) => e.preventDefault()}
              aria-pressed={voiceMsg.state === 'recording'}
              aria-label={voiceMsg.state === 'recording' ? 'Release to send the voice message' : `Hold to send ${bot.name} a voice message`}
              title={voiceMsg.state === 'recording' ? 'Let go (or click) to send · Esc cancels' : voiceMsg.state === 'transcribing' ? 'Sending…' : `Voice message: hold to talk, let go to send (or tap to start, tap to stop). A live call is in the + menu.`}
            >
              <Icon name={voiceMsg.state === 'recording' ? 'stop' : 'mic'} size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
