import { useEffect, useRef, useState } from 'react';
import type { TelegramState } from '@shared/types';
import { configApi } from '../../lib/configApi';

/**
 * Give a team member its own Telegram bot without leaving HeyZubi: a short how-to video (always shown), then the
 * token from BotFather and the owner's Telegram user ID pasted into two boxes. They go straight to the server, which
 * saves them in the member's own Hermes settings and restarts it. They are kept only in this component while typed,
 * cleared once sent, and never become a chat message, so nothing of them is saved in the chat or seen by the model.
 */
export function TelegramSetup({ botId, botName, mode, onSkip, onConnected }: {
  botId: string;
  botName: string;
  mode: 'card' | 'settings';
  onSkip?: () => void;
  onConnected?: (username: string | null) => void;
}) {
  const [state, setState] = useState<TelegramState | null>(null);
  const [token, setToken] = useState('');
  const [userId, setUserId] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<'connect' | 'skip' | 'disconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [greeted, setGreeted] = useState<boolean | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  // Open the how-to video fullscreen and play it (iPhone Safari has its own fullscreen call for videos).
  const watch = async () => {
    const v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!v) return;
    try {
      if (v.requestFullscreen) await v.requestFullscreen();
      else v.webkitEnterFullscreen?.();
    } catch { /* fullscreen refused: it still plays in place */ }
    void v.play().catch(() => {});
  };

  useEffect(() => {
    let alive = true;
    configApi.telegram(botId).then((r) => { if (alive) setState(r.telegram); }).catch(() => { if (alive) setState({ available: mode === 'card', connected: false, username: null }); });
    return () => { alive = false; };
  }, [botId]);

  const cleanId = userId.replace(/\s+/g, '');
  const canSend = /^\d{5,15}:\S{30,}$/.test(token.trim()) && /^\d{4,15}$/.test(cleanId) && !busy;

  const connect = async () => {
    if (!canSend) return;
    setBusy('connect'); setError(null);
    try {
      const r = await configApi.telegramConnect(botId, token.trim(), cleanId);
      setToken(''); setUserId(''); setShow(false);
      setState(r.telegram); setGreeted(r.greeted);
      onConnected?.(r.telegram.username);
    } catch (e) { setError((e as Error).message || 'It didn’t connect. Check the token and try again.'); }
    finally { setBusy(null); }
  };
  const skip = async () => {
    setBusy('skip'); setError(null);
    try { await configApi.telegramSkip(botId); onSkip?.(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const disconnect = async () => {
    setBusy('disconnect'); setError(null);
    try { const r = await configApi.telegramDisconnect(botId); setState(r.telegram); setGreeted(null); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  // In settings it is its own section, shown only for team members with an agent of their own (not Zubi).
  const wrap = (el: JSX.Element) => mode === 'settings' ? <section><div className="section-label">Telegram</div>{el}</section> : el;
  if (!state) return mode === 'settings' ? null : <div className="tg-setup tg-setup--loading">Checking Telegram…</div>;
  if (!state.available) return null;

  if (state.connected) {
    const at = state.username ? `@${state.username}` : 'its bot';
    return wrap(
      <div className={`tg-setup tg-setup--${mode} is-connected`}>
        <div className="tg-setup__done">
          <span className="tg-setup__dot" aria-hidden />
          <span>On Telegram as {state.username ? <a href={`https://t.me/${state.username}`} target="_blank" rel="noreferrer">{at}</a> : at}</span>
        </div>
        {greeted === false && state.username && (
          <div className="tg-setup__note">Open <a href={`https://t.me/${state.username}`} target="_blank" rel="noreferrer">{at}</a> in Telegram and tap <b>Start</b>, so {botName} can message you.</div>
        )}
        {greeted && <div className="tg-setup__note">{botName} just said hello to you there.</div>}
        {mode === 'settings' && (
          <button type="button" className="link-btn link-btn--small" onClick={() => void disconnect()} disabled={!!busy}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect Telegram'}</button>
        )}
        {error && <div className="card__error">{error}</div>}
      </div>
    );
  }

  return wrap(
    <div className={`tg-setup tg-setup--${mode}`}>
      <div className="tg-setup__body">
        <video ref={video} className="tg-setup__video" src="/media/telegram-setup.mp4" poster="/media/telegram-setup.jpg" controls playsInline preload="none"
          aria-label="How to make a Telegram bot with BotFather and find your user ID" />
        <div className="tg-setup__side">
          <button type="button" className="btn btn--primary tg-setup__watch" onClick={() => void watch()}>Watch fullscreen</button>
          <div className="tg-setup__hint">The token and your ID go straight into {botName}’s own settings, not this chat.</div>
        </div>
      </div>
      <div className="tg-setup__fields">
        <label className="tg-setup__field">
          <span>Bot token</span>
          <span className="tg-setup__row">
            <input className={`text-input${show ? '' : ' tg-setup__secret'}`} type="text" name="tg-bot-key" value={token} data-bwignore="true" data-protonpass-ignore="true" onChange={(e) => setToken(e.target.value)}
              placeholder="123456789:AAH…" autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" data-form-type="other"
              aria-label={`Telegram bot token for ${botName}`} />
            <button type="button" className="link-btn link-btn--small" onClick={() => setShow((s) => !s)}>{show ? 'Hide' : 'Show'}</button>
          </span>
        </label>
        <label className="tg-setup__field">
          <span>Your user ID</span>
          <input className="text-input" type="text" name="tg-chat-number" inputMode="numeric" pattern="[0-9]*" value={userId} onChange={(e) => setUserId(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }} placeholder="123456789" autoComplete="off" spellCheck={false}
            data-1p-ignore data-lpignore="true" data-form-type="other" aria-label="Your Telegram ID number" data-bwignore="true" data-protonpass-ignore="true" />
        </label>
      </div>
      <div className="card__actions">
        {mode === 'card' && <button type="button" className="btn btn--secondary" onClick={() => void skip()} disabled={!!busy}>{busy === 'skip' ? 'Skipping…' : 'Skip'}</button>}
        <button type="button" className="btn btn--primary" onClick={() => void connect()} disabled={!canSend}>{busy === 'connect' ? `Connecting ${botName}…` : 'Connect Telegram'}</button>
      </div>
      {busy === 'connect' && <div className="tg-setup__note">Checking the token with Telegram and restarting {botName}. This takes up to a minute.</div>}
      {error && <div className="card__error">{error}</div>}
    </div>
  );
}
