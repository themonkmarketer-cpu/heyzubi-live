import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, EngineInfo, EngineProvider } from '@shared/types';
import { configApi } from '../lib/configApi';
import { useStore } from '../store';
import { Icon } from './Icon';

const KIND: Record<EngineProvider['kind'], string> = { subscription: 'Subscription', api_key: 'API key' };
const STATUS: Record<EngineInfo['status'], string> = { ready: 'ready', starting: 'starting', stopped: 'stopped', error: 'error' };
/** Value of the "Other model…" choice in the model list. */
const OTHER = '__other__';
const EFFORTS: { value: Bot['effort']; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Max' },
];

/** Connected providers first; otherwise the server's order. */
function sortProviders(list: EngineProvider[]): EngineProvider[] {
  return [...list].sort((a, b) => Number(b.connected) - Number(a.connected));
}

/**
 * "Engine" section of the details panel: which provider and model run this bot's agent, signing in to
 * a subscription, and the agent's status. Every call fails soft: if the engine endpoints are missing or
 * down, the section says so and the rest of the panel is unaffected.
 */
export function EngineSettings({ bot }: { bot: Bot }) {
  const viewerOpen = useStore((s) => s.viewerOpen);
  const set = useStore((s) => s.set);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<'save' | 'effort' | 'signin' | 'restart' | 'screen' | null>(null);
  const [effort, setEffort] = useState<Bot['effort']>(bot.effort ?? 'medium');
  const [custom, setCustom] = useState(false);
  useEffect(() => { setEffort(bot.effort ?? 'medium'); }, [bot.effort]);
  const [note, setNote] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  // Claude sign-in in the owner's own browser (team members): the link, then the code pasted back here.
  const [claude, setClaude] = useState<{ url: string } | null>(null);
  const [code, setCode] = useState('');
  const [claudeBusy, setClaudeBusy] = useState(false);
  const dirty = useRef(false);
  const botId = bot.id;

  const apply = useCallback((e: EngineInfo, keepDraft = false) => {
    setEngine(e); setPhase('ok');
    if (!keepDraft || !dirty.current) { dirty.current = false; setProvider(e.provider ?? ''); setModel(e.model ?? ''); }
    // Keep the bot's model label in step without waiting for the server's `bot` event.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === e.botId && (b.model !== e.model || b.provider !== e.provider) ? { ...b, model: e.model, provider: e.provider } : b)) }));
  }, []);

  /** Quiet refreshes keep what is on screen if the call fails. */
  const load = useCallback((quiet = false) => {
    let alive = true;
    if (!quiet) setPhase('loading');
    configApi.engine(botId)
      .then((r) => { if (alive && r?.engine) apply(r.engine, quiet); else if (alive && !quiet) setPhase('unavailable'); })
      .catch(() => { if (alive && !quiet) setPhase('unavailable'); });
    return () => { alive = false; };
  }, [botId, apply]);

  useEffect(() => { dirty.current = false; setEngine(null); setNote(null); setSigningIn(false); return load(); }, [load]);

  // The agent takes a moment to come up after a change or a restart.
  const starting = engine?.status === 'starting';
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(() => load(true), 3000);
    return () => clearInterval(t);
  }, [starting, load]);

  // Signing in happens on the bot's computer. Check while that view is open, and once more when it closes.
  useEffect(() => {
    if (!signingIn) return;
    if (!viewerOpen) { setSigningIn(false); load(true); return; }
    const t = setInterval(() => load(true), 5000);
    return () => clearInterval(t);
  }, [signingIn, viewerOpen, load]);

  if (phase !== 'ok' || !engine) {
    return (
      <div className="panel-card">
        <div className="panel-empty engine__empty">
          {phase === 'loading' ? 'Checking…' : (
            <>
              <span>Engine unavailable</span>
              <button type="button" className="link-btn link-btn--small" onClick={() => load()}>Try again</button>
            </>
          )}
        </div>
      </div>
    );
  }

  const providers = sortProviders(engine.providers ?? []);
  const selected = providers.find((p) => p.id === provider) ?? null;
  const suggestions = selected?.models ?? [];
  const current = engine.model ?? '';
  // The models offered: the provider's list, plus whatever the bot uses now if it is not on that list.
  const modelOptions = current && !suggestions.includes(current) ? [current, ...suggestions] : suggestions;
  const wantModel = model.trim() && model.trim() !== current ? model.trim() : undefined;
  const openSubscriptions = providers.filter((p) => p.kind === 'subscription' && !p.connected);
  const signInTo = selected && selected.kind === 'subscription' && !selected.connected ? selected : null;
  const listId = `engine-models-${botId}`;

  /** Provider and model apply as soon as they are picked, as in the HeyZubi dashboard. */
  const saveEngine = async (p: { provider?: string; model?: string }) => {
    if (busy) return;
    setBusy('save'); setNote(null);
    try { const r = await configApi.setEngine(botId, p); dirty.current = false; setCustom(false); apply(r.engine); }
    catch (e) { setNote(`Couldn’t save: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const pickProvider = (id: string) => {
    dirty.current = true; setNote(null); setProvider(id);
    const next = providers.find((p) => p.id === id);
    // A model from another provider will not work there, so start from that provider's first model.
    const m = next?.models.length && !next.models.includes(model.trim()) ? next.models[0] : model.trim();
    setModel(m);
    void saveEngine({ provider: id, ...(m && m !== current ? { model: m } : {}) });
  };

  const pickModel = (v: string) => {
    setNote(null);
    if (v === OTHER) { dirty.current = true; setCustom(true); setModel(''); return; }
    setCustom(false); setModel(v);
    if (v !== current) void saveEngine({ model: v });
  };

  const saveCustom = () => { if (wantModel) void saveEngine({ model: wantModel }); };

  const pickEffort = async (v: Bot['effort']) => {
    if (v === effort || busy) return;
    const before = effort;
    setEffort(v); setBusy('effort'); setNote(null);
    try {
      const { bot: next } = await configApi.updateBot(botId, { effort: v });
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? { ...b, effort: next.effort } : b)) }));
    } catch (e) { setEffort(before); setNote(`Couldn’t save: ${(e as Error).message || 'the app did not answer'}`); }
    finally { setBusy(null); }
  };

  // A team member signs in to Claude in your own browser: HeyZubi gets the link from Hermes, you paste the code back.
  const browserClaude = signInTo?.id === 'anthropic' && engine.profile !== 'default';

  const startClaude = async () => {
    setBusy('signin'); setNote(null); setCode('');
    try { const r = await configApi.claudeSignInStart(botId); setClaude({ url: r.url }); }
    catch (e) { setNote(`Couldn’t start sign-in: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const finishClaude = async () => {
    if (!code.trim() || claudeBusy) return;
    setClaudeBusy(true); setNote(null);
    try {
      const r = await configApi.claudeSignInFinish(botId, code.trim());
      setClaude(null); setCode('');
      if (r.engine) apply(r.engine);
      setNote(`${bot.name} is signed in to Claude. Send it a message to check.`);
      setTimeout(() => load(true), 4000);
    } catch (e) { setNote((e as Error).message || 'The sign-in didn’t go through.'); }
    finally { setClaudeBusy(false); }
  };

  const cancelClaude = () => { setClaude(null); setCode(''); void configApi.claudeSignInCancel(botId).catch(() => {}); };

  const signIn = async () => {
    if (busy) return;
    if (browserClaude) { await startClaude(); return; }
    setBusy('signin'); setNote(null);
    try {
      await configApi.engineLogin(botId, signInTo?.id);
      // The sign-in runs in a terminal on the bot's screen, so take the person there with the mouse and keyboard.
      set({ viewerOpen: true, viewerMode: 'control', viewerHint: `Finish signing in on ${bot.name}’s computer, then hand back.` });
      setSigningIn(true);
    } catch (e) { setNote(`Couldn’t start sign-in: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const restart = async () => {
    if (busy) return;
    setBusy('restart'); setNote(null);
    try { const r = await configApi.restartEngine(botId); apply(r.engine, true); }
    catch (e) { setNote(`Couldn’t restart: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const useThisScreen = async () => {
    if (busy) return;
    setBusy('screen'); setNote(null);
    try { const r = await configApi.stopOwnScreen(botId); apply(r.engine, true); }
    catch (e) { setNote(`Couldn’t switch screens: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  return (
    <div className="panel-card engine">
      <div className="panel-row panel-row--setting">
        <span>Provider</span>
        <span className="mini-select mini-select--native engine__select">
          <span>{selected?.name ?? (provider || 'Default')}</span>
          <Icon name="chev_down" size={10} opacity={0.66} />
          <select aria-label="Provider" value={provider} onChange={(e) => pickProvider(e.target.value)}>
            {!selected && <option value={provider}>{provider || 'Default'}</option>}
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {KIND[p.kind]} · {p.connected ? 'Connected' : 'Not connected'}</option>)}
          </select>
        </span>
      </div>
      {selected && (
        <div className={`engine__conn${selected.connected ? ' is-on' : ''}`}>
          <i aria-hidden />
          <span>{selected.connected ? 'Connected' : 'Not connected'} · {KIND[selected.kind]}</span>
        </div>
      )}
      <div className="panel-row panel-row--setting">
        <span>Model</span>
        <span className="mini-select mini-select--native engine__select">
          <span>{custom ? 'Other model…' : (current || 'Agent default')}</span>
          <Icon name="chev_down" size={10} opacity={0.66} />
          <select aria-label="Model" value={custom ? OTHER : current} onChange={(e) => pickModel(e.target.value)} disabled={busy === 'save'}>
            {!current && <option value="">Agent default</option>}
            {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            <option value={OTHER}>Other model…</option>
          </select>
        </span>
      </div>
      {custom && (
        <div className="panel-row panel-row--setting">
          <label htmlFor={`${listId}-input`}>Model id</label>
          <input
            id={`${listId}-input`} name={`${listId}-id`} className="engine__model" value={model} spellCheck={false}
            autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"
            placeholder={suggestions[0] ?? 'e.g. claude-sonnet-5-5'} autoFocus
            onChange={(e) => { dirty.current = true; setNote(null); setModel(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') saveCustom(); if (e.key === 'Escape') { setCustom(false); setModel(current); } }}
          />
        </div>
      )}
      {custom && (
        <div className="engine__actions">
          <button type="button" className="btn btn--sm btn--bot" onClick={saveCustom} disabled={!wantModel || busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Use this model'}</button>
          <button type="button" className="link-btn link-btn--small" onClick={() => { dirty.current = false; setCustom(false); setModel(current); }}>Cancel</button>
        </div>
      )}
      <div className="panel-row panel-row--setting">
        <span>Reasoning effort</span>
        <span className="mini-select mini-select--native engine__select">
          <span>{EFFORTS.find((x) => x.value === effort)?.label ?? 'Medium'}</span>
          <Icon name="chev_down" size={10} opacity={0.66} />
          <select aria-label="Reasoning effort" value={effort} onChange={(e) => pickEffort(e.target.value as Bot['effort'])} disabled={busy === 'effort'}>
            {EFFORTS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </span>
      </div>
      {busy === 'save' && <div className="engine__saving">Saving…</div>}
      {(signInTo || openSubscriptions.length > 0) && (
        <button type="button" className="panel-row panel-row--action engine__signin" onClick={signIn} disabled={busy === 'signin'}>
          <Icon name="monitor" size={14} opacity={0.56} />
          {busy === 'signin' ? 'Opening sign-in…' : signInTo ? `Sign in to ${signInTo.name}…` : 'Sign in to a subscription…'}
        </button>
      )}
      {claude && (
        <div className="engine__notice" style={{ display: 'block' }}>
          <ol style={{ margin: '0 0 8px', paddingLeft: 18, lineHeight: 1.5 }}>
            <li><a href={claude.url} target="_blank" rel="noreferrer"><b>Open Claude’s sign-in page</b></a> (it opens in your own browser) and click <b>Authorize</b>.</li>
            <li>Claude shows a code. Copy it, paste it here and press <b>Finish</b>.</li>
          </ol>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="text-input" style={{ flex: 1, minWidth: 0 }} value={code} onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void finishClaude(); }} placeholder="Paste the code" autoComplete="off" spellCheck={false} aria-label="Claude sign-in code" />
            <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => void finishClaude()} disabled={!code.trim() || claudeBusy}>{claudeBusy ? 'Signing in…' : 'Finish'}</button>
          </div>
          <button type="button" className="link-btn link-btn--small" style={{ marginTop: 6 }} onClick={cancelClaude}>Cancel</button>
        </div>
      )}
      {engine.ownScreen && (
        <div className="engine__notice">
          <span>{bot.name} also has a private screen of its own switched on. Desktop work it does there (clicking around apps) will not show on the screen here.</span>
          <button type="button" className="link-btn link-btn--small" onClick={useThisScreen} disabled={busy === 'screen'}>{busy === 'screen' ? 'Switching…' : 'Use this screen'}</button>
        </div>
      )}
      {note && <div className="voice-error" role="alert">{note}</div>}
      <div className="engine__meta">
        <span className={`engine__state is-${engine.status}`} title={engine.version ? `Hermes ${engine.version}` : undefined}>
          <i aria-hidden />
          Hermes · profile {engine.profile} · {STATUS[engine.status] ?? engine.status}
        </span>
        {(engine.status === 'error' || engine.status === 'stopped') && (
          <button type="button" className="link-btn link-btn--small" onClick={restart} disabled={busy === 'restart'}>{busy === 'restart' ? 'Restarting…' : 'Restart agent'}</button>
        )}
      </div>
      {engine.status === 'error' && engine.error && <div className="engine__error">{engine.error}</div>}
    </div>
  );
}
