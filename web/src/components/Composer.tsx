import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePrefs } from '../lib/appPrefs';
import type { Bot, MessageBody } from '@shared/types';
import { api } from '../lib/api';
import { displayName, useStore } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { useDictation } from '../voice/dictation';
import { speakReply, stopSpeaking, useSpeak } from '../voice/speak';
import { AudioLines, Camera, PhoneOff, Speech } from 'lucide-react';
import { toggleCamera, useCamera } from './CameraBubble';

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

  // Pictures dropped or pasted into the box: saved into Generations (refs/) so the team member can use them
  // (look at one, put it on WhatsApp…). The message names each file so the agent knows where it is.
  const [pics, setPics] = useState<{ rel: string; name: string; url: string }[]>([]);
  const picRef = useRef<HTMLInputElement>(null);
  const [picBusy, setPicBusy] = useState(0);
  const [dropping, setDropping] = useState(false);
  useEffect(() => { setPics([]); }, [bot.id]);
  const addPictures = async (files: File[]) => {
    const imgs = files.filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
    if (!imgs.length) { if (files.length) setError('Only PNG, JPG, WebP or GIF pictures can be attached.'); return; }
    for (const f of imgs.slice(0, 6)) {
      if (f.size > 15 * 1024 * 1024) { setError(`${f.name}: pictures up to 15 MB.`); continue; }
      setPicBusy((n) => n + 1);
      try {
        const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
        const name = f.name && f.name !== 'image.png' ? f.name : `pasted-${Date.now().toString(36)}.${f.type.split('/')[1].replace('jpeg', 'jpg')}`;
        const r = await fetch('/api/generations/refs', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, data }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Upload failed');
        setPics((p) => [...p, { rel: j.rel, name: String(j.rel).split('/').pop() ?? name, url: data }]);
      } catch (e) { setError((e as Error).message); }
      finally { setPicBusy((n) => n - 1); }
    }
  };

  const send = async () => {
    const typed = text.trim();
    if ((!typed && !pics.length) || sending || picBusy) return;
    const note = pics.map((p) => `[Attached picture: ${p.rel} — in Generations, ~/.hermes/generations/${p.rel}. To send it on WhatsApp use whatsapp_draft image="${p.rel}".]`).join('\n');
    const t = [typed || (pics.length ? 'Here is a picture.' : ''), note].filter(Boolean).join('\n\n');
    setSending(true); setError(null);
    try {
      await api.send(bot.id, t);
      setText(''); setPics([]);
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
  const dictation = useDictation(insertText, setError, bot.voiceLanguage, 'dictation', bot.id);
  const dictationOn = usePrefs()?.products.dictation !== false;
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);
  const camOn = useCamera((s) => s.on);

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
  const voiceMsg = useDictation((t) => void sendVoice(t), setError, bot.voiceLanguage, 'voice-message', bot.id);
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

  const hasText = text.trim().length > 0 || pics.length > 0;
  const multiline = text.includes('\n') || (ref.current?.scrollHeight ?? 0) > 30;

  return (
    <div
      className={`composer-area${dropping ? ' is-dropping' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDropping(false); void addPictures(Array.from(e.dataTransfer.files)); }}
    >
      {dropping && <div className="composer__drop">Drop pictures for {bot.name}</div>}
      <input ref={picRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { if (e.target.files) void addPictures(Array.from(e.target.files)); e.target.value = ''; }} />
      {(pics.length > 0 || picBusy > 0) && (
        <div className="composer__pics" aria-label="Attached pictures">
          {pics.map((p) => (
            <span key={p.rel} className="composer__pic" title={`${p.name} (saved in Generations)`}>
              <img src={p.url} alt={p.name} />
              <button type="button" onClick={() => setPics((l) => l.filter((x) => x.rel !== p.rel))} aria-label={`Remove ${p.name}`}>×</button>
            </span>
          ))}
          {picBusy > 0 && <span className="composer__pic is-busy">Uploading…</span>}
        </div>
      )}
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
      {!error && vmNote && <div className="composer__note" role="status">{vmNote}</div>}
      {!error && !vmNote && voiceMsg.state !== 'idle' && <div className="composer__note" role="status">{voiceMsg.state === 'recording'
          ? 'Recording a voice message… click the red button to send (Esc cancels)'
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
                  { label: 'Attach a picture', onSelect: () => picRef.current?.click() },
                  { label: 'New conversation', onSelect: fresh },
                  { label: 'Connect apps', onSelect: () => setModal('apps') },
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
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files ?? []).filter((f) => f.type.startsWith('image/'));
              if (files.length) { e.preventDefault(); void addPictures(files); }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
            aria-label={`Message ${bot.name}`}
          />
        </div>
        <div className="composer__right">
          <button
            type="button"
            className={`composer__btn${camOn ? ' is-cam-on' : ''}`}
            onClick={toggleCamera}
            aria-pressed={camOn}
            aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
            title={camOn ? 'Turn camera off' : 'Camera: a preview just for you (nothing is recorded or sent)'}
          >
            <Camera size={18} strokeWidth={1.8} style={{ opacity: camOn ? 1 : 0.56 }} aria-hidden />
          </button>
          {dictationOn && <button
            type="button"
            className={`composer__btn${dictation.state === 'recording' ? ' is-recording' : dictation.state === 'transcribing' ? ' is-transcribing' : ''}`}
            aria-label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
            aria-pressed={dictation.state === 'recording'}
            title={dictation.state === 'recording' ? 'Release or click to stop · Esc cancels' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Dictate: your words are typed into the box (nothing is sent). Hold to talk, or click to start and click to stop.'}
            disabled={dictation.state === 'transcribing'}
            onPointerDown={dictation.onPointerDown}
            onPointerUp={dictation.onPointerUp}
            onKeyDown={dictation.onKeyDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Speech size={18} strokeWidth={1.8} style={{ opacity: dictation.state === 'idle' ? 0.56 : 1 }} aria-hidden />
          </button>}
          {/* Voice message: click to start, click again to send (Esc cancels). Zubi's reply is read aloud. */}
          <button
            type="button"
            className={`composer__btn composer__vmbtn${voiceMsg.state === 'recording' ? ' is-recording' : voiceMsg.state === 'transcribing' ? ' is-transcribing' : ''}`}
            disabled={voiceMsg.state === 'transcribing' || inCall}
            onClick={() => (voiceMsg.state === 'recording' ? voiceMsg.stop() : voiceMsg.startTap())}
            aria-pressed={voiceMsg.state === 'recording'}
            aria-label={voiceMsg.state === 'recording' ? 'Send the voice message' : `Send ${bot.name} a voice message`}
            title={voiceMsg.state === 'recording'
              ? 'Click to send · Esc cancels'
              : voiceMsg.state === 'transcribing' ? 'Sending…'
              : `Voice message${bot.voiceMsgEngine === 'sarvam' ? ' (Hindi)' : ''}: click, talk, click again to send. ${bot.name} answers and the reply is read aloud.`}
          >
            {voiceMsg.state === 'recording' ? <Icon name="stop" size={14} /> : <Icon name="mic" opacity={voiceMsg.state === 'idle' ? 0.56 : 1} />}
          </button>
          {inCall && !hasText ? (
            // During a live call the purple button hangs up (saying "hang up" works too).
            <button type="button" className="composer__cta is-in-call" onClick={endCall} aria-label="Hang up the live call" title="Hang up">
              <PhoneOff size={16} strokeWidth={2} aria-hidden />
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
            // One press starts a live call (hands-free); press again or say "hang up" to end it.
            <button
              type="button"
              className="composer__cta composer__call"
              onClick={() => startCall(bot.id)}
              aria-label={`Start a live call with ${bot.name}`}
              title={`Live call with ${bot.name}: press to start, then just talk. Press again or say “hang up” to end. ${bot.voiceEngine === 'gemini' ? 'Gemini · billed per token.' : 'xAI · $0.08 per minute.'} A cheaper voice message is in the + menu.`}
            >
              <AudioLines size={17} strokeWidth={2.2} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
