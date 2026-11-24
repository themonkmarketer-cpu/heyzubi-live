import { useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { useStore } from '../store';
import { voiceApi, type ClaudeSpend, type VoiceOptions, type XaiUsage } from '../voice/api';
import { endCall, isCallActive, previewVoice, startCall, useVoice } from '../voice/call';
import { Icon } from './Icon';

const FALLBACK: VoiceOptions = {
  voices: ['ara', 'eve', 'leo', 'luna', 'rex', 'sal'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
  languages: [{ code: 'auto', name: 'Auto-detect' }, { code: 'en', name: 'English' }],
  speeds: [0.7, 0.85, 1, 1.15, 1.3, 1.5],
};

const speedLabel = (s: number) => `${Number(s.toFixed(2))}x`;

function NativeSelect<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const current = options.find((o) => o.value === value)?.label ?? String(value);
  return (
    <span className="mini-select mini-select--native">
      <span>{current}</span>
      <Icon name="chev_down" size={10} opacity={0.66} />
      <select
        aria-label={label}
        value={String(value)}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value);
          if (o) onChange(o.value);
        }}
      >
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    </span>
  );
}

/** "Voice chat" section of the details panel: voice, speed, language (saved per bot), preview, start a call. */
export function VoiceSettings({ bot }: { bot: Bot }) {
  const [opts, setOpts] = useState<VoiceOptions>(FALLBACK);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);

  // Reloaded after each call: Gemini's "left today" changes as calls are logged.
  const callStatus = useVoice((s) => s.status);
  useEffect(() => { if (callStatus === 'idle') voiceApi.options().then(setOpts).catch(() => {}); }, [callStatus]);
  useEffect(() => setError(null), [bot.id]);

  const save = async (patch: Partial<Pick<Bot, 'voice' | 'voiceSpeed' | 'voiceLanguage' | 'voiceEngine' | 'geminiVoice' | 'voiceMsgEngine' | 'sarvamVoice'>>) => {
    const prev = useStore.getState().bots.find((b) => b.id === bot.id);
    // Optimistic; the server's `bot` event confirms.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, ...patch } : b)) }));
    setError(null);
    try {
      const res = await fetch(`/api/bots/${bot.id}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      if (prev) useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, voice: prev.voice, voiceSpeed: prev.voiceSpeed, voiceLanguage: prev.voiceLanguage, voiceEngine: prev.voiceEngine, geminiVoice: prev.geminiVoice, voiceMsgEngine: prev.voiceMsgEngine, sarvamVoice: prev.sarvamVoice } : b)) }));
      setError('Couldn’t save that setting.');
    }
  };

  const previewHindi = async () => {
    if (previewing) return;
    setPreviewing(true); setError(null);
    try {
      const blob = await voiceApi.previewSarvam(bot.id, bot.sarvamVoice ?? 'simran_enhi_companion');
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      await new Promise<void>((done) => { a.onended = () => done(); a.onerror = () => done(); void a.play().catch(() => done()); });
      URL.revokeObjectURL(url);
    } catch (e) { setError((e as Error).message || 'Preview unavailable'); }
    finally { setPreviewing(false); }
  };

  const preview = async () => {
    if (previewing) return;
    setPreviewing(true); setError(null);
    try { await previewVoice({ botId: bot.id, voice: bot.voice, speed: bot.voiceSpeed, language: bot.voiceLanguage }); }
    catch (e) { setError((e as Error).message || 'Preview unavailable'); }
    finally { setPreviewing(false); }
  };

  const gemini = (bot.voiceEngine ?? 'xai') === 'gemini';
  const geminiReady = opts.gemini?.ready !== false;
  const voices = opts.voices.some((v) => v.id === bot.voice) ? opts.voices : [{ id: bot.voice, name: bot.voice }, ...opts.voices];
  const gVoices = opts.geminiVoices ?? [{ id: bot.geminiVoice ?? 'Kore', name: bot.geminiVoice ?? 'Kore' }];
  const speeds = opts.speeds.includes(bot.voiceSpeed) ? opts.speeds : [...opts.speeds, bot.voiceSpeed].sort((a, b) => a - b);
  const left = opts.gemini ? Math.max(0, opts.gemini.left) : null;
  const sarvam = (bot.voiceMsgEngine ?? 'xai') === 'sarvam';
  const sarvamReady = opts.sarvam?.ready !== false;
  const sVoices = opts.sarvamVoices ?? [{ id: bot.sarvamVoice ?? 'simran_enhi_companion', name: bot.sarvamVoice ?? 'simran_enhi_companion' }];
  const sLeft = opts.sarvam ? Math.max(0, opts.sarvam.leftInr) : null;

  return (
    <div className="panel-card">
      <div className="panel-row panel-row--setting">
        <span>Live calls</span>
        <NativeSelect
          label="Live call engine"
          value={gemini ? 'gemini' : 'xai'}
          options={[
            { value: 'xai', label: 'xAI Grok voice · $0.08/min' },
            { value: 'gemini', label: geminiReady ? 'Gemini 3.8 Live · per token' : 'Gemini 3.8 Live (no key on hermes-box)' },
          ]}
          onChange={(voiceEngine) => { if (voiceEngine === 'gemini' && !geminiReady) { setError('Gemini needs a Gemini API key on hermes-box.'); return; } void save({ voiceEngine: voiceEngine as 'xai' | 'gemini' }); }}
        />
      </div>
      {gemini ? (
        <div className="panel-row panel-row--setting">
          <span>Voice</span>
          <NativeSelect label="Gemini voice" value={bot.geminiVoice ?? 'Kore'} options={gVoices.map((v) => ({ value: v.id, label: v.name }))} onChange={(geminiVoice) => save({ geminiVoice })} />
        </div>
      ) : (
        <>
          <div className="panel-row panel-row--setting">
            <span>Voice</span>
            <span className="voice-setting__right">
              <button type="button" className="voice-preview" onClick={preview} disabled={previewing} title={`Hear ${bot.name}'s voice`}>{previewing ? 'Playing…' : 'Preview'}</button>
              <NativeSelect label="Voice" value={bot.voice} options={voices.map((v) => ({ value: v.id, label: v.name }))} onChange={(voice) => save({ voice })} />
            </span>
          </div>
          <div className="panel-row panel-row--setting">
            <span>Speed</span>
            <NativeSelect label="Speed" value={bot.voiceSpeed} options={speeds.map((s) => ({ value: s, label: speedLabel(s) }))} onChange={(voiceSpeed) => save({ voiceSpeed })} />
          </div>
        </>
      )}
      <div className="panel-row panel-row--setting">
        <span>Language</span>
        <NativeSelect label="Language" value={bot.voiceLanguage} options={opts.languages.map((l) => ({ value: l.code, label: l.name }))} onChange={(voiceLanguage) => save({ voiceLanguage })} />
      </div>
      <button type="button" className={`panel-row panel-row--action panel-row--call${inCall ? ' is-active' : ''}`} onClick={() => (inCall ? endCall() : startCall(bot.id))}
        title={gemini
          ? 'Gemini bills per token: only while someone is talking, plus the call so far on each turn. It stops for the day at the daily cap. Voice messages (the mic in the message box) cost less still.'
          : 'A live call is billed for every minute it is open, silences included. The mic button in the message box (voice message) costs far less.'}>
        <Icon name="voice_a" size={14} opacity={inCall ? 1 : 0.56} />{' '}
        {inCall ? 'End live call' : gemini ? `Start live call · Gemini${left !== null ? ` · $${left.toFixed(2)} left today` : ''}` : 'Start live call · $0.08/min'}
      </button>
      {gemini && <div className="voice-note">Gemini picks the speaking language itself; the setting above guides it.</div>}
      <div className="panel-row panel-row--setting">
        <span>Voice messages</span>
        <NativeSelect
          label="Voice messages engine"
          value={sarvam ? 'sarvam' : 'xai'}
          options={[
            { value: 'xai', label: 'xAI' },
            { value: 'sarvam', label: sarvamReady ? 'Hindi · Sarvam' : 'Hindi · Sarvam (no key on hermes-box)' },
          ]}
          onChange={(v) => { if (v === 'sarvam' && !sarvamReady) { setError('Sarvam needs its key on hermes-box.'); return; } void save({ voiceMsgEngine: v as 'xai' | 'sarvam' }); }}
        />
      </div>
      {sarvam && (
        <div className="panel-row panel-row--setting">
          <span>Hindi voice</span>
          <span className="voice-setting__right">
            <button type="button" className="voice-preview" onClick={previewHindi} disabled={previewing} title="Hear this Hindi voice">{previewing ? 'Playing…' : 'Preview'}</button>
            <NativeSelect label="Hindi voice" value={bot.sarvamVoice ?? 'simran_enhi_companion'} options={sVoices.map((v) => ({ value: v.id, label: v.name }))} onChange={(sarvamVoice) => save({ sarvamVoice })} />
          </span>
        </div>
      )}
      {sarvam && <div className="voice-note">Your voice messages are written in Hinglish as you speak them, and replies are read aloud in this Hindi voice{sLeft !== null ? ` · ₹${sLeft.toFixed(2)} of ₹${opts.sarvam?.capInr ?? 20} left today` : ''}. Messages over 30 s, and anything past the daily cap, use xAI.</div>}
      <DictionaryPrefs />
      <UsageToday />
      <ClaudeToday bot={bot} />
      {error && <div className="voice-error">{error}</div>}
    </div>
  );
}

const USAGE_ROWS: { k: keyof XaiUsage['by']; label: string; qty: (q: number) => string }[] = [
  { k: 'live_call', label: 'Live calls (xAI)', qty: (q) => `${q.toFixed(1)} min` },
  { k: 'gemini_call', label: 'Live calls (Gemini)', qty: (q) => `${q.toFixed(1)} min` },
  { k: 'transcription', label: 'Voice messages & dictation', qty: (q) => `${Math.round(q)} s` },
  { k: 'sarvam_stt', label: 'Voice messages (Sarvam)', qty: (q) => `${Math.round(q)} s` },
  { k: 'sarvam_tts', label: 'Spoken replies (Sarvam)', qty: (q) => `${Math.round(q).toLocaleString()} chars` },
  { k: 'spoken_reply', label: 'Spoken replies', qty: (q) => `${Math.round(q).toLocaleString()} chars` },
  { k: 'grok', label: 'Grok (summaries, Clicky, X search)', qty: (q) => `${Math.round(q).toLocaleString()} tokens` },
  { k: 'image', label: 'Images created', qty: (q) => `${Math.round(q)}` },
];
const usd = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

/** Today's xAI spend by service, from the app's own log (estimates; the exact bill is in xAI's console). */
function UsageToday() {
  const [u, setU] = useState<XaiUsage | null>(null);
  const callStatus = useVoice((s) => s.status);
  useEffect(() => {
    let on = true;
    const load = () => voiceApi.usage().then((r) => { if (on) setU(r); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { on = false; clearInterval(t); };
  }, [callStatus]);
  if (!u) return null;
  return (
    <div className="xai-usage" title={u.note}>
      <div className="xai-usage__head"><span>Voice &amp; AI spend today</span><b>{usd(u.total)}</b></div>
      {USAGE_ROWS.map((r) => {
        const s = u.by[r.k];
        return (
          <div key={r.k} className="xai-usage__row">
            <span>{r.label}</span>
            <span className="xai-usage__qty">{s.uses ? r.qty(s.qty) : '—'}</span>
            <span>{s.uses ? usd(s.usd) : '$0.00'}</span>
          </div>
        );
      })}
      <div className="xai-usage__note">Estimates from xAI’s and Google’s prices · exact bills at console.x.ai and aistudio.google.com · Claude is below</div>
    </div>
  );
}

/** Personal dictionary (names dictation must spell right) and the dictation tidy-up switch. */
function DictionaryPrefs() {
  const [p, setP] = useState<{ dictionary: string[]; tidyDictation: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { voiceApi.prefs().then(setP).catch(() => {}); }, []);
  if (!p) return null;
  const save = async (patch: { dictionary?: string; tidyDictation?: boolean }) => {
    setBusy(true);
    try { setP(await voiceApi.savePrefs(patch)); if (patch.dictionary !== undefined) setEditing(false); } catch { /* kept as was */ } finally { setBusy(false); }
  };
  return (
    <>
      <div className="panel-row panel-row--setting">
        <span title="Names and words dictation should always spell right, like Zubi, HeyZubi or a client's name">Dictionary</span>
        <button type="button" className="voice-preview" onClick={() => { setDraft(p.dictionary.join(', ')); setEditing(!editing); }}>
          {p.dictionary.length ? `${p.dictionary.length} word${p.dictionary.length === 1 ? '' : 's'} · Edit` : 'Add words'}
        </button>
      </div>
      {editing && (
        <div className="voice-dict">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} placeholder="Zubi, HeyZubi, Murtaza, Hermes…" aria-label="Dictionary words, separated by commas" />
          <div className="voice-dict__actions">
            <span>Commas or new lines between words · up to 100</span>
            <button type="button" className="voice-preview" disabled={busy} onClick={() => void save({ dictionary: draft })}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
      <label className="panel-row panel-row--setting voice-toggle" title="Fix punctuation and remove filler words before dictated text lands in the message box">
        <span>Tidy up dictation</span>
        <input type="checkbox" checked={p.tidyDictation} disabled={busy} onChange={(e) => void save({ tidyDictation: e.target.checked })} />
      </label>
    </>
  );
}

/** Today's Claude spend (Zubi's thinking): this bot's HeyZubi chats, and the agent's other channels. */
function ClaudeToday({ bot }: { bot: Bot }) {
  const [s, setS] = useState<ClaudeSpend | null>(null);
  const running = useStore((st) => !!st.live[bot.id]?.isRunning);
  useEffect(() => {
    let on = true;
    const load = () => voiceApi.claudeSpend().then((r) => { if (on) setS(r); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { on = false; clearInterval(t); };
  }, [running]);
  if (!s?.available) return null;
  const mine = s.byBot[bot.id] ?? 0;
  const since = new Date(s.since);
  const late = since.getHours() > 0 || since.getMinutes() > 15;
  return (
    <div className="xai-usage" title={s.note}>
      <div className="xai-usage__head"><span>Claude today{late ? ` (since ${since.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : ''}</span><b>{usd(s.total)}</b></div>
      <div className="xai-usage__row"><span>{bot.name} · chats here</span><span className="xai-usage__qty" /><span>{mine ? usd(mine) : '$0.00'}</span></div>
      {s.bySource.map((x) => (
        <div key={x.key} className="xai-usage__row"><span>{x.label}</span><span className="xai-usage__qty" /><span>{usd(x.usd)}</span></div>
      ))}
      <div className="xai-usage__note">Hermes’s own estimates at Anthropic’s API prices, cache included. Zubi signs in with a Claude subscription, so these are likely not real charges</div>
    </div>
  );
}
