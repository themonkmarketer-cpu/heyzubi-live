import { useCallback, useEffect, useRef, useState } from 'react';
import { Check as CheckIcon, History, Loader2, Plus, Square, X } from 'lucide-react';
import { epFileUrl, saidDone, socialApi, waitingSaid, type ChatState } from '../../lib/socialApi';
import { lsGet, lsSet } from '../../lib/storage';
import { Markdown } from '../Markdown';
import { FloatWin, type Rect } from './Workspace';
import '../../styles/social-chat.css';

/**
 * The session window: free instructions to the owner's agent, with a tick for every step. It floats, or is attached to the
 * right side. Free changes happen at once; anything that spends or approves comes back as a button with its price.
 * Corrections written elsewhere (on the video, a shot, a comment) arrive here as messages.
 */
const when = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function AgentChat({ id, stage, mode, onMode, onClose, onRect }: { id: string; stage: string; mode: 'float' | 'dock'; onMode: (m: 'float' | 'dock') => void; onClose: () => void; onRect: (id: string, r: Rect | null) => void }) {
  const [talk, setTalk] = useState<number | null>(null);
  const [chat, setChat] = useState<ChatState | null>(null);
  const [past, setPast] = useState(false);
  const [text, setText] = useState(() => lsGet(`socialDraft-${id}`) ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(() => { socialApi.chat(id, talk).then(setChat).catch((e) => setErr((e as Error).message)); }, [id, talk]);
  useEffect(() => {
    load();
    const on = (e: Event) => { const d = (e as CustomEvent<{ type: string; episodeId: string }>).detail; if (d?.type === 'social' && d.episodeId === id) load(); };
    window.addEventListener('heyzubi:event', on);
    const t = setInterval(load, 8000);
    return () => { window.removeEventListener('heyzubi:event', on); clearInterval(t); };
  }, [id, load]);
  useEffect(() => { lsSet(`socialDraft-${id}`, text); }, [id, text]);
  const last = chat?.messages[chat.messages.length - 1]?.id, working = chat?.busy, steps = chat?.did.length ?? 0;
  useEffect(() => { if (!past) end.current?.scrollIntoView({ block: 'nearest' }); }, [last, working, steps, past, talk]);

  const post = async (t: string, typed: boolean) => {
    setErr(null); setPast(false);
    if (typed) setText('');
    try { const c = await socialApi.say(id, t, talk ?? chat?.talk ?? null); setChat(c); setTalk(c.talk); }
    catch (e) { setErr((e as Error).message); setText((x) => (x.trim() ? `${x.trim()}\n${t}` : t)); }
  };
  const send = () => { const t = text.trim(); if (t && !working) void post(t, true); };
  const name = chat?.agent ?? 'Zubi';
  // Corrections from the video, a shot, the editor or a comment: sent when the agent is free, kept until they are.
  const [queue, setQueue] = useState<string[]>(() => waitingSaid(id));
  const sending = useRef(false);
  useEffect(() => { const on = (e: Event) => { if ((e as CustomEvent<{ id: string }>).detail?.id === id) setQueue(waitingSaid(id)); }; window.addEventListener('social:say', on); setQueue(waitingSaid(id)); return () => window.removeEventListener('social:say', on); }, [id]);
  const ready = !!chat && !working && !err;
  useEffect(() => {
    if (!ready || !queue.length || sending.current) return;
    sending.current = true; setPast(false);
    void socialApi.say(id, queue.join('\n'), talk ?? chat?.talk ?? null).then((c) => { saidDone(id, queue.length); setChat(c); setTalk(c.talk); }, (e) => setErr((e as Error).message)).finally(() => { sending.current = false; setQueue(waitingSaid(id)); });
  }, [ready, queue, id, talk, chat?.talk]);
  const decide = async (msg: number, i: number, yes: boolean) => {
    setErr(null); setBusy(`${msg}-${i}`);
    try { setChat(await socialApi.decide(id, msg, i, yes)); } catch (e) { setErr((e as Error).message); }
    setBusy(null);
  };
  const fresh = chat ? Math.max(0, ...chat.talks.map((t) => t.talk)) + 1 : 1;
  const ask = ['What needs me now?', ...(stage === 'render' || stage === 'review' ? ['Check the lips in every shot'] : []), 'Is anything wrong with what is made so far?'];
  return (
    <FloatWin id="session" mode={mode} onMode={onMode} onClose={onClose} onRect={onRect} className="is-session"
      init={() => { const v = Math.max(380, Math.min(600, window.innerHeight * 0.58)); return { x: window.innerWidth - 356, y: 66 + v + 10, w: 340, h: Math.max(220, window.innerHeight - 66 - v - 24) }; }}
      title={<><i className={`fwin__dot${chat?.online ? ' is-on' : ''}`} aria-hidden /> {name} <small>{working ? 'working' : chat && !chat.online ? 'not answering' : ''}</small></>}
      actions={<>
        <button type="button" className="sicon" aria-pressed={past} title="Past conversations" aria-label="Past conversations" onClick={() => setPast(!past)}><History size={14} /></button>
        <button type="button" className="sicon" title="New conversation" aria-label="New conversation" disabled={!!working || !chat?.messages.length} onClick={() => { setTalk(fresh); setPast(false); }}><Plus size={15} /></button>
      </>}>
      {past ? (
        <div className="agd__list">
          {!chat?.talks.length && <p className="agd__hi">No conversations yet.</p>}
          <ul className="agd__past">{chat?.talks.map((t) => <li key={t.talk}><button type="button" className={t.talk === chat.talk ? 'is-on' : ''} onClick={() => { setTalk(t.talk); setPast(false); }}><b>{t.title}</b><small>{when(t.at)} · {t.n} message{t.n === 1 ? '' : 's'}</small></button></li>)}</ul>
        </div>
      ) : (
        <div className="agd__list" role="log" aria-live="polite">
          {chat && chat.messages.length === 0 && !working && <div className="agd__hi"><b>Tell {name} what to do, in your own words.</b><span>Free changes happen at once; anything that costs money or approves something comes back as a button.</span><div className="agd__chips">{ask.map((a) => <button key={a} type="button" onClick={() => setText(a)}>{a}</button>)}</div></div>}
          {chat?.messages.map((m) => (
            <article key={m.id} className={`agd__m is-${m.role}${m.data.error ? ' is-bad' : ''}`}>
              <small className="agd__who">{m.role === 'you' ? 'You' : name} · {when(m.at)}</small>
              {m.role === 'you' ? <p>{m.text}</p> : <Markdown text={m.text} />}
              <Steps did={m.data.did} no={m.data.no} />
              {!!m.data.images?.length && <div className="agd__pics">{m.data.images.map((p) => <a key={p} href={epFileUrl(id, p)} target="_blank" rel="noreferrer" title="Look closer"><img src={epFileUrl(id, p)} alt="What was looked at" loading="lazy" /></a>)}</div>}
              {m.data.proposals?.map((p, i) => (
                <div key={i} className={`agd__ask is-${p.state}`}>
                  {p.state === 'open' ? <><button type="button" className="btn btn--primary btn--sm" disabled={!!busy} onClick={() => void decide(m.id, i, true)}>{busy === `${m.id}-${i}` ? <Loader2 size={12} className="spin" aria-hidden /> : null} {p.label}</button><button type="button" className="sicon" aria-label={`No: ${p.label}`} title="No" disabled={!!busy} onClick={() => void decide(m.id, i, false)}><X size={14} /></button></> : <em>{p.state === 'done' ? <CheckIcon size={12} aria-hidden /> : <X size={12} aria-hidden />} {p.label}</em>}
                  {p.why && <small>{p.why}</small>}
                </div>
              ))}
              {!!m.data.tokens && <small className="agd__tok">{m.data.tokens.toLocaleString()} tokens</small>}
            </article>
          ))}
          {working && <article className="agd__m is-agent"><Steps did={chat!.did} /><p className="agd__busy"><Loader2 size={13} className="spin" aria-hidden /> {working}…<button type="button" className="btn btn--secondary btn--sm" onClick={() => void socialApi.chatStop(id).then(load)}><Square size={11} aria-hidden /> Stop</button></p></article>}
          <div ref={end} />
        </div>
      )}
      {queue.length > 0 && <div className="agd__wait"><b>{queue.length === 1 ? 'One correction waits' : `${queue.length} corrections wait`}{working ? ` until ${name} is done` : ''}</b><ul>{queue.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
      {err && <div className="card__error agd__err">{err} <button type="button" className="link-btn" onClick={() => setErr(null)}>{queue.length ? 'Try again' : 'Dismiss'}</button></div>}
      <form className="agd__form" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea className="text-input" rows={2} value={text} maxLength={4000} placeholder="What should change? (Ctrl+Enter to send)" aria-label={`Instructions for ${name}`} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
        <button type="submit" className="btn btn--primary" disabled={!text.trim() || !!working}>Send</button>
      </form>
    </FloatWin>
  );
}
function Steps({ did, no }: { did?: string[]; no?: string[] }) {
  if (!did?.length && !no?.length) return null;
  return <ul className="agd__did">{did?.map((d, i) => <li key={`d${i}`}><CheckIcon size={13} aria-hidden /> {d}</li>)}{no?.map((d, i) => <li key={`n${i}`} className="is-no"><X size={13} aria-hidden /> {d}</li>)}</ul>;
}
