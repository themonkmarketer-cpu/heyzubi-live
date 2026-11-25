import { useEffect, useState } from 'react';
import type { CardBody, EngineInfo, Row } from '@shared/types';
import { api, openWhenReady } from '../../lib/api';
import { configApi } from '../../lib/configApi';
import { useStore } from '../../store';
import { useConfigUI } from '../../configStore';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { Icon } from '../Icon';

type Body = Extract<CardBody, { card: 'teammate' }>;

/**
 * A team member Zubi just added, set up from Zubi's chat: it is in HeyZubi and Hermes, its engine starts, and the
 * owner signs it in to Claude right here (Claude's page opens in a new tab for Authorize; the code comes back here).
 * When the sign-in goes through, the server marks this card done and Zubi carries on (says hello to the new member).
 */
export function TeammateCard({ row, body }: { row: Row; body: Body }) {
  const bot = useStore((s) => s.bots.find((b) => b.id === body.teammateId));
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'start' | 'finish' | 'later' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = body.status === 'pending';

  // Follow the engine until it is up and signed in (it starts on its own in about a minute).
  useEffect(() => {
    if (!pending || !bot) return;
    let alive = true;
    const load = () => configApi.engine(body.teammateId).then((r) => { if (alive) setEngine(r.engine); }).catch(() => {});
    void load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [pending, bot?.id, body.teammateId]); // eslint-disable-line react-hooks/exhaustive-deps

  const claude = engine?.providers?.find((p) => p.id === 'anthropic');
  const ready = engine?.status === 'ready';
  const signedIn = body.status === 'ready' || !!claude?.connected;
  const open = () => { useStore.getState().selectBot(body.teammateId); useConfigUI.getState().setView('chat'); };

  const start = async () => {
    setBusy('start'); setError(null); setCode('');
    // The tab is opened before the request, so the browser doesn't treat it as a pop-up.
    const tab = openWhenReady();
    try {
      const r = await configApi.claudeSignInStart(body.teammateId);
      setLink(r.url);
      tab.go(r.url);
    } catch (e) { tab.close(); setError((e as Error).message || 'The sign-in could not start.'); }
    finally { setBusy(null); }
  };
  const finish = async () => {
    if (!code.trim() || busy) return;
    setBusy('finish'); setError(null);
    try { await configApi.claudeSignInFinish(body.teammateId, code.trim()); setLink(null); setCode(''); }
    catch (e) { setError((e as Error).message || 'The sign-in didn’t go through. Start it again and paste the newest code.'); }
    finally { setBusy(null); }
  };
  const later = async () => {
    setBusy('later'); setError(null);
    try { await configApi.claudeSignInCancel(body.teammateId).catch(() => {}); await api.dismiss(row.botId, row.seq); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  if (!bot) {
    return <div className="card teammate-card is-resolved"><div className="card__outcome"><Icon name="close" size={12} opacity={0.7} />{body.name} is no longer on the team.</div></div>;
  }

  const step = (done: boolean, now: boolean, text: string, sub?: string) => (
    <li className={`teammate-step${done ? ' is-done' : now ? ' is-now' : ''}`}>
      <span className="teammate-step__dot" aria-hidden>{done ? <Icon name="check" size={10} /> : null}</span>
      <span className="teammate-step__text">{text}{sub && <small>{sub}</small>}</span>
    </li>
  );

  return (
    <div className={`card teammate-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <BotAvatarFor bot={bot} size={44} />
        <div className="card__titles">
          <div className="card__title">{bot.name} · {bot.label || body.role}</div>
          <div className="card__sub">{signedIn ? 'Ready to work' : body.status === 'skipped' ? 'Sign in to Claude later, from its settings' : 'New team member: a minute to set up'}</div>
        </div>
      </div>

      <ol className="teammate-steps">
        {step(true, false, 'Added to HeyZubi and Hermes', engine?.profile ? `Hermes profile “${engine.profile}”, same name and mascot in both` : undefined)}
        {step(ready || body.status === 'ready', pending && !ready, ready || body.status === 'ready' ? 'Engine running' : 'Starting its engine…')}
        {step(signedIn, pending && ready && !signedIn, signedIn ? 'Signed in to Claude with its own sign-in' : 'Sign in to Claude', !signedIn && pending ? 'Its own Claude subscription, so it never shares Zubi’s' : undefined)}
      </ol>

      {pending && ready && !signedIn && (
        link ? (
          <div className="teammate-signin">
            <div className="teammate-signin__how">In the Claude tab that opened, click <b>Authorize</b>, copy the code it shows, and paste it here. <a href={link} target="_blank" rel="noreferrer">Open it again</a></div>
            <div className="teammate-signin__row">
              <input className="text-input" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void finish(); }}
                placeholder="Paste the code" autoComplete="off" spellCheck={false} aria-label={`Claude sign-in code for ${bot.name}`} autoFocus />
              <button type="button" className="btn btn--primary" onClick={() => void finish()} disabled={!code.trim() || !!busy}>{busy === 'finish' ? 'Signing in…' : 'Finish'}</button>
            </div>
          </div>
        ) : (
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => void later()}>Later</button>
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => void start()}>{busy === 'start' ? 'Opening…' : `Sign in ${bot.name} to Claude`}</button>
          </div>
        )
      )}
      {pending && !ready && <div className="card__outcome">{engine?.status === 'error' ? `Its engine hit a problem: ${engine.error ?? 'unknown'}. Ask Zubi to check it.` : 'This takes about a minute. You can keep chatting.'}</div>}
      {(!pending || signedIn) && (
        <div className="card__actions">
          <button type="button" className="btn btn--primary" onClick={open}>Open {bot.name}</button>
        </div>
      )}
      {error && <div className="card__error">{error}</div>}
    </div>
  );
}
