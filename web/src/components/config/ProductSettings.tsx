import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../../store';
import { useConfigUI } from '../../configStore';
import { CHORDS, chordLabel, usePrefs, useAppPrefs, type PrefsPatch } from '../../lib/appPrefs';
import { useDictation } from '../../voice/dictation';
import { voiceApi } from '../../voice/api';
import { relativeShort } from '../../lib/time';
import { Segmented, Switch } from './ui';

/**
 * Settings › Products, Pointer Assistant and Dictation (after Theo's). The Windows app reads these from the server
 * (GET /api/desktop/me, every minute), so nothing is set on the PC itself.
 */

interface Device { id: string; name: string; lastUsedAt: number | null; version: string | null; mics: string[]; voices: string[] }

function useDevices(): Device[] {
  const [devices, setDevices] = useState<Device[]>([]);
  useEffect(() => {
    fetch('/api/desktop-devices', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.devices) setDevices(j.devices); }).catch(() => {});
  }, []);
  return devices;
}

function useSave() {
  const save = useAppPrefs((s) => s.save);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const run = async (patch: PrefsPatch) => {
    setError(null);
    const e = await save(patch);
    if (e) setError(e);
    else { setSaved(true); window.setTimeout(() => setSaved(false), 1500); }
  };
  return { run, error, saved };
}

function Head({ title, sub, saved }: { title: string; sub: string; saved?: boolean }) {
  return (
    <div className="app-settings__head">
      <h1>{title}{saved && <span className="prod-saved" role="status">Saved</span>}</h1>
      <p>{sub}</p>
    </div>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <select className="pa-select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="pa-row">
      <div className="pa-row__text"><div className="pa-row__title">{title}</div>{hint && <div className="pa-row__hint">{hint}</div>}</div>
      <div className="pa-row__control">{children}</div>
    </div>
  );
}

/** A note on the Windows app: which version these settings need, and whether a PC is paired. */
function AppNote({ devices }: { devices: Device[] }) {
  const open = useConfigUI((s) => s.openAppSettings);
  const latest = devices.slice().sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0];
  const old = latest && (!latest.version || latest.version < '0.3.0');
  return (
    <div className="cfg-field__hint">
      {!latest ? <>No Windows PC is paired yet. </> : <>Your PC “{latest.name}” {latest.lastUsedAt ? `was last seen ${relativeShort(latest.lastUsedAt)}` : 'hasn’t checked in yet'}{latest.version ? `, app ${latest.version}` : ''}. </>}
      {old && <>It needs the new app (0.3.0) for these settings. </>}
      The app picks up changes within a minute. <button type="button" className="prod-link" onClick={() => open('desktop')}>Windows app settings</button>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ProductsSection() {
  const p = usePrefs();
  const { run, error, saved } = useSave();
  const open = useConfigUI((s) => s.openAppSettings);
  const devices = useDevices();
  if (!p) return <Head title="Products" sub="Loading…" />;
  const cards = [
    { key: 'team', title: 'Team', on: true, locked: true, body: 'Your AI team: chats, tasks, routines, the board and the screens. Always on.', settings: null },
    { key: 'pointer', title: 'Pointer Assistant', on: p.products.pointer, locked: false, body: `Hold ${chordLabel(p.pointer.chord)} in any app on Windows, ask out loud, and get an answer with a pointer on the screen. Also the Ask button on team members’ screens here.`, settings: 'pointer' as const },
    { key: 'dictation', title: 'Dictation', on: p.products.dictation === true, locked: false, body: `Hold ${chordLabel(p.dictation.chord)} in any app on Windows and talk: your words are typed where the cursor is. Switching it off on purpose also hides the mic in the chat.`, settings: 'dictation' as const },
  ];
  return (
    <>
      <Head title="Products" sub="What HeyZubi does beyond the chat. Switch a product off and its shortcut stops in the Windows app, and its buttons go from HeyZubi." saved={saved} />
      <section className="cfg-section">
        <div className="prod-cards">
          {cards.map((c) => (
            <div key={c.key} className={`prod-card${c.on ? ' is-on' : ''}`}>
              <div className="prod-card__top">
                <span className="prod-card__title">{c.title}</span>
                <Switch on={c.on} disabled={c.locked} label={`${c.title} ${c.on ? 'on' : 'off'}`} onChange={(v) => void run({ products: { [c.key]: v } })} />
              </div>
              <p className="prod-card__body">{c.body}</p>
              {c.settings && <button type="button" className="prod-link" onClick={() => open(c.settings!)}>Settings</button>}
              {c.locked && <span className="prod-card__tag">Always on</span>}
            </div>
          ))}
        </div>
        {error && <div className="st-result is-bad" role="alert">{error}</div>}
        <AppNote devices={devices} />
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

interface TryAnswer { botName: string; text: string; point: { screen: number; x: number; y: number; label?: string } | null; marks: { kind: string; step?: number; x: number; y: number; label?: string }[]; audio: string | null }

/** One frame of a screen or window the person picks (the browser asks), as a JPEG, at most 2560 px wide. */
async function grabScreen(): Promise<{ blob: Blob; url: string; w: number; h: number }> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 300)); // the first frame can be blank
    const scale = Math.min(1, 2560 / (video.videoWidth || 1));
    const w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d')!.drawImage(video, 0, 0, w, h);
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('No picture.'))), 'image/jpeg', 0.85));
    return { blob, url: URL.createObjectURL(blob), w, h };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/** Speaks with a Windows voice through the browser (Windows voices show up in Edge and Chrome under the same names). */
function speakWindows(text: string, name: string) {
  const synth = window.speechSynthesis;
  if (!synth) return;
  const v = synth.getVoices().find((x) => x.name === name) ?? synth.getVoices().find((x) => !!name && (x.name.includes(name) || name.includes(x.name)));
  const u = new SpeechSynthesisUtterance(text);
  if (v) u.voice = v;
  synth.cancel();
  synth.speak(u);
}

function PointerTry({ voice, windowsVoice }: { voice: string; windowsVoice: string }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<{ url: string; w: number; h: number } | null>(null);
  const [ans, setAns] = useState<TryAnswer | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { audio.current?.pause(); window.speechSynthesis?.cancel(); }, []);
  const stop = () => { audio.current?.pause(); window.speechSynthesis?.cancel(); };
  const ask = async () => {
    if (!q.trim()) { setErr('Type a question first.'); return; }
    setErr(null); setAns(null); stop();
    let frame: Awaited<ReturnType<typeof grabScreen>>;
    try { frame = await grabScreen(); }
    catch { setErr('No screen was shared, so there was nothing to look at.'); return; }
    setShot((old) => { if (old) URL.revokeObjectURL(old.url); return frame; });
    setBusy(true);
    try {
      const form = new FormData();
      form.append('question', q.trim());
      form.append('meta', JSON.stringify({ screens: [{ w: frame.w, h: frame.h, primary: true, cursor: null }] }));
      form.append('screen0', frame.blob, 'screen0.jpg');
      const r = await fetch('/api/desktop-devices/try', { method: 'POST', credentials: 'include', body: form });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) { setErr(j?.error ?? `Couldn’t get an answer (HTTP ${r.status}).`); return; }
      setAns(j);
      if (j.audio) { audio.current = new Audio(`data:audio/mpeg;base64,${j.audio}`); void audio.current.play().catch(() => {}); }
      else if (voice === 'windows') speakWindows(j.text, windowsVoice);
    } catch { setErr('Couldn’t reach HeyZubi. Try again.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="pa-try">
      <div className="pa-try__ask">
        <input className="pa-input" value={q} maxLength={500} placeholder="Ask about a screen, e.g. where do I change the font?" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void ask(); } if (e.key === 'Escape') stop(); }} aria-label="Question to try" />
        <button type="button" className="cfg-btn" onClick={() => void ask()} disabled={busy}>{busy ? 'Looking…' : 'Pick a screen and ask'}</button>
      </div>
      <div className="cfg-field__hint">Your browser asks which screen or window to share; one picture of it is sent with the question (not kept), the way the Windows app does with your monitors. Esc stops the voice.</div>
      {err && <div className="st-result is-bad" role="alert">{err}</div>}
      {shot && (
        <div className="pa-try__stage">
          <img src={shot.url} alt="The screen you shared" />
          {ans?.marks.map((m, i) => <span key={i} className="pa-try__mark" style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}>{m.step ?? ''}</span>)}
          {ans?.point && <span className="pa-try__spark" style={{ left: `${ans.point.x * 100}%`, top: `${ans.point.y * 100}%` }} title={ans.point.label} />}
          {ans && <div className="pa-try__bubble"><b>{ans.botName}</b> {ans.text}</div>}
        </div>
      )}
    </div>
  );
}

export function PointerSection() {
  const p = usePrefs();
  const { run, error, saved } = useSave();
  const devices = useDevices();
  const primary = useStore((s) => s.bots.find((b) => b.isPrimary));
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [hearing, setHearing] = useState(false);
  if (!p) return <Head title="Pointer Assistant" sub="Loading…" />;
  const q = p.pointer;
  const name = primary?.name ?? 'Your team member';
  const voices = [...new Set(devices.flatMap((d) => d.voices))];
  const hear = async () => {
    const sample = `Hi, this is how ${name} sounds when answering about your screen.`;
    if (q.voice === 'windows') { speakWindows(sample, q.windowsVoice); return; }
    if (!primary) return;
    setHearing(true);
    try {
      const r = await fetch('/api/voice/speak', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: primary.id, text: sample }) });
      if (r.ok) { const a = new Audio(URL.createObjectURL(await r.blob())); await a.play().catch(() => {}); }
    } finally { setHearing(false); }
  };
  return (
    <>
      <Head title="Pointer Assistant" sub="Hold the keys in any app on your Windows PC, ask out loud, let go. Your team member looks at your screens, answers and points at the thing to click. It only looks and points: nothing is clicked for you, and screenshots aren’t kept." saved={saved} />
      {!p.products.pointer && (
        <div className="prod-off">The Pointer Assistant is switched off. <button type="button" className="cfg-btn" onClick={() => void run({ products: { pointer: true } })}>Switch it on</button></div>
      )}
      {error && <div className="st-result is-bad" role="alert">{error}</div>}
      <section className="cfg-section pa-rows">
        <Row title="Shortcut" hint="Hold to talk, let go to ask. Pressing any other key while holding cancels, so Windows shortcuts keep working. Esc stops an answer.">
          <Select label="Shortcut" value={q.chord} options={CHORDS.map((c) => ({ value: c.id, label: c.label }))} onChange={(chord) => void run({ pointer: { chord } })} />
        </Row>
        <Row title="Spark" hint={q.spark === 'always' ? 'A small spark rides next to your cursor all the time.' : q.spark === 'listening' ? 'The spark shows while it listens, thinks and answers.' : 'No spark by the cursor; answers still show in a bubble and it still points.'}>
          <Segmented label="Spark" value={q.spark} onChange={(spark) => void run({ pointer: { spark } })} options={[{ value: 'always', label: 'Always' }, { value: 'listening', label: 'While listening' }, { value: 'never', label: 'Never' }]} />
        </Row>
        <Row title="Brain" hint={q.brain === 'grok' ? 'xAI’s Grok vision: quick, a few cents a question.' : `${name}’s own Claude, through its engine: slower, and uses ${name}’s Claude sign-in.`}>
          <Segmented label="Brain" value={q.brain} onChange={(brain) => void run({ pointer: { brain } })} options={[{ value: 'grok', label: 'Grok vision' }, { value: 'claude', label: `${name}’s Claude` }]} />
        </Row>
        <Row title="Model" hint="Leave empty for the brain’s usual model.">
          <input className="pa-input pa-input--short" value={modelDraft ?? q.model} placeholder={q.brain === 'grok' ? 'Grok’s default' : `${name}’s model`} maxLength={80}
            onChange={(e) => setModelDraft(e.target.value)}
            onBlur={() => { if (modelDraft !== null && modelDraft !== q.model) void run({ pointer: { model: modelDraft.trim() } }); setModelDraft(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} aria-label="Model" />
        </Row>
        <Row title="Voice" hint={q.voice === 'bot' ? `Answers are spoken in ${name}’s own voice (Voice chat settings).` : q.voice === 'windows' ? 'A voice installed on your PC speaks the answer: free, and nothing extra is sent.' : 'Answers are only shown, not spoken.'}>
          <Segmented label="Voice" value={q.voice} onChange={(voice) => void run({ pointer: { voice } })} options={[{ value: 'bot', label: `${name}’s voice` }, { value: 'windows', label: 'Windows voice' }, { value: 'off', label: 'No voice' }]} />
        </Row>
        {q.voice === 'windows' && (
          <Row title="Windows voice" hint={voices.length ? 'The voices installed on your paired PC.' : 'Your PC lists its voices once the new Windows app (0.3.0) is running. Until then it uses the default one.'}>
            <Select label="Windows voice" value={q.windowsVoice} options={[{ value: '', label: 'Windows’ default voice' }, ...voices.map((v) => ({ value: v, label: v }))]} onChange={(windowsVoice) => void run({ pointer: { windowsVoice } })} />
          </Row>
        )}
        {q.voice !== 'off' && (
          <Row title="Hear it" hint={q.voice === 'windows' ? 'Played by your browser with the Windows voice of the same name.' : 'One short sentence (a fraction of a cent).'}>
            <button type="button" className="cfg-btn" onClick={() => void hear()} disabled={hearing}>{hearing ? 'Playing…' : 'Hear it'}</button>
          </Row>
        )}
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Try it</div>
        <PointerTry voice={q.voice} windowsVoice={q.windowsVoice} />
      </section>
      <section className="cfg-section"><AppNote devices={devices} /></section>
    </>
  );
}

// ---------------------------------------------------------------------------

function DictionaryEditor({ words, onSave }: { words: string[]; onSave: (v: string) => Promise<void> }) {
  const [draft, setDraft] = useState(words.join(', '));
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(words.join(', ')), [words]);
  const changed = draft.trim() !== words.join(', ');
  return (
    <div className="pa-dict">
      <textarea className="pa-input" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} placeholder="Zubi, HeyZubi, Murtaza, Hermes…" aria-label="Your words, separated by commas" />
      <div className="pa-dict__actions">
        <span className="cfg-field__hint">Commas or new lines between words · up to 100</span>
        <button type="button" className="cfg-btn" disabled={busy || !changed} onClick={async () => { setBusy(true); await onSave(draft); setBusy(false); }}>{busy ? 'Saving…' : 'Save words'}</button>
      </div>
    </div>
  );
}

function DictationTry() {
  const primary = useStore((s) => s.bots.find((b) => b.isPrimary));
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const d = useDictation((t) => { setErr(null); setText(t || '(Nothing heard.)'); }, (m) => setErr(m), undefined, 'dictation', primary?.id);
  return (
    <div className="pa-try">
      <div className="pa-try__ask">
        <button type="button" className={`cfg-btn pa-rec${d.state === 'recording' ? ' is-on' : ''}`} disabled={d.state === 'transcribing'}
          onPointerDown={d.onPointerDown} onPointerUp={d.onPointerUp} onKeyDown={d.onKeyDown} onContextMenu={(e) => e.preventDefault()}>
          {d.state === 'recording' ? 'Listening… let go to finish' : d.state === 'transcribing' ? 'Writing it down…' : 'Hold to talk'}
        </button>
        <span className="cfg-field__hint">Or click to start and click again to stop. Uses the automatic recognizer and the tidy-up, as set here.</span>
      </div>
      {err && <div className="st-result is-bad" role="alert">{err}</div>}
      {text && <div className="pa-try__text">{text}</div>}
    </div>
  );
}

export function DictationSection() {
  const p = usePrefs();
  const { run, error, saved } = useSave();
  const devices = useDevices();
  const [langs, setLangs] = useState<{ code: string; name: string }[]>([{ code: 'auto', name: 'Auto-detect' }]);
  useEffect(() => { voiceApi.options().then((o) => setLangs(o.languages)).catch(() => {}); }, []);
  if (!p) return <Head title="Dictation" sub="Loading…" />;
  const d = p.dictation;
  const mics = [...new Set(devices.flatMap((x) => x.mics))];
  return (
    <>
      <Head title="Dictation" sub="Hold the keys in any app on your Windows PC and talk; let go and your words are typed where the cursor is. The same settings tidy up the mic in the chat." saved={saved} />
      {p.products.dictation !== true && (
        <div className="prod-off">Dictate-anywhere is off on your PC. <button type="button" className="cfg-btn" onClick={() => void run({ products: { dictation: true } })}>Switch it on</button></div>
      )}
      {error && <div className="st-result is-bad" role="alert">{error}</div>}
      <section className="cfg-section pa-rows">
        <Row title="Shortcut" hint={`Hold to talk, let go to type. It can’t be the Pointer Assistant’s keys (${chordLabel(p.pointer.chord)}).`}>
          <Select label="Shortcut" value={d.chord} options={CHORDS.map((c) => ({ value: c.id, label: c.label }))} onChange={(chord) => void run({ dictation: { chord } })} />
        </Row>
        <Row title="Microphone" hint={mics.length ? 'The microphones on your paired PC.' : 'Your PC lists its microphones once the new Windows app (0.3.0) is running.'}>
          <Select label="Microphone" value={d.mic} options={[{ value: '', label: 'Windows’ default microphone' }, ...mics.map((m) => ({ value: m, label: m }))]} onChange={(mic) => void run({ dictation: { mic } })} />
        </Row>
        <Row title="Recognizer" hint={d.recognizer === 'auto' ? 'HeyZubi’s speech to text: Sarvam for Hindi and Hinglish, xAI otherwise. Best quality.' : 'Windows’ own offline recognizer on your PC: free and the recording never leaves the PC, but English only and less accurate. The tidy-up still runs when it’s on.'}>
          <Segmented label="Recognizer" value={d.recognizer} onChange={(recognizer) => void run({ dictation: { recognizer } })} options={[{ value: 'auto', label: 'Automatic' }, { value: 'windows', label: 'Windows offline' }]} />
        </Row>
        <Row title="Language" hint="Auto-detect suits mixed Hindi and English.">
          <Select label="Language" value={d.language} options={langs.map((l) => ({ value: l.code, label: l.name }))} onChange={(language) => void run({ dictation: { language } })} />
        </Row>
        <Row title="Tidy up" hint="Fixes punctuation and capitals and drops filler words (um, uh) before the words are typed. Your words and language stay as said.">
          <Switch on={p.tidyDictation} label="Tidy up dictation" onChange={(tidyDictation) => void run({ tidyDictation })} />
        </Row>
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Your words</div>
        <div className="cfg-field__hint">Names and words dictation should always spell right, like Zubi, HeyZubi or a client’s name.</div>
        <DictionaryEditor words={p.dictionary} onSave={async (v) => { await run({ dictionary: v }); }} />
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Try it</div>
        <DictationTry />
      </section>
      <section className="cfg-section"><AppNote devices={devices} /></section>
    </>
  );
}
