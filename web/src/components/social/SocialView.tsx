import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Archive, ArrowLeft, Check as CheckIcon, Clapperboard, Download, KeyRound, Loader2, Plus, X } from 'lucide-react';
import { epFileUrl, socialApi, STAGE_INFO, STAGES, usd, type Brief, type Home, type StageId, type StageStatus } from '../../lib/socialApi';
import { lsGet, lsSet } from '../../lib/storage';
import { useStore } from '../../store';
import { Modal } from '../modals/Modal';
import { Icon } from '../Icon';
import { HomeTabs } from './HomeTabs';
import { FactoryPage } from './Factory';
import { WORD } from './Workspace';
import '../../styles/social.css';

/**
 * Reels Factory: the cartoon reel workflow as a pipeline. Each episode goes through eight steps; what can run by
 * itself does, and it stops in the Zubi window wherever the owner decides. Everything lives on the server, so a
 * stage carries on when this page is closed.
 */
const stateOf = (b: Brief): { s: StageStatus; stage: StageId } => {
  const find = (x: StageStatus) => STAGES.find((k) => b.stages[k] === x);
  for (const x of ['running', 'needs_you', 'failed', 'stale', 'ready'] as StageStatus[]) { const k = find(x); if (k) return { s: x, stage: k }; }
  return { s: 'done', stage: 'schedule' };
};

export function SocialView() {
  const [home, setHome] = useState<Home | null>(null);
  const [id, setId] = useState<string | null>(() => lsGet('socialEpisode') || null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'new' | 'keys' | null>(null);
  const [view, setView] = useState<{ src: string; name: string } | null>(null);
  // An episode gets the room: the app's sidebar folds while one is open, and comes back as it was.
  useEffect(() => {
    if (!id) return;
    const st = useStore.getState(), before = lsGet('socialSidebar') || (st.sidebarCollapsed ? '1' : '0');
    lsSet('socialSidebar', before);
    st.set({ sidebarCollapsed: true });
    return () => { lsSet('socialSidebar', ''); if (before === '0' && useStore.getState().sidebarCollapsed) useStore.getState().set({ sidebarCollapsed: false }); };
  }, [id]);
  const unview = useCallback(() => setView(null), []);
  const load = useCallback(() => { socialApi.home().then((h) => { setHome(h); setError(null); }).catch((e) => setError((e as Error).message)); }, []);
  const open = useCallback((x: string | null) => { setId(x); lsSet('socialEpisode', x ?? ''); if (!x) load(); }, [load]);
  useEffect(() => {
    load();
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = (e: Event) => { if ((e as CustomEvent<{ type: string }>).detail?.type === 'social' && !t) t = setTimeout(() => { t = null; load(); }, 900); };
    window.addEventListener('heyzubi:event', on);
    return () => { window.removeEventListener('heyzubi:event', on); if (t) clearTimeout(t); };
  }, [load]);

  return (
    <main className="chat social" aria-label="Reels Factory" onClickCapture={(e) => {
      // Our own pictures open over the app, with a way back: in the Windows app a new tab would replace it.
      const a = (e.target as HTMLElement).closest?.('a[href^="/api/social/"]') as HTMLAnchorElement | null;
      if (!a || a.getAttribute('href')!.includes('download=1') || e.ctrlKey || e.metaKey || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      setView({ src: a.getAttribute('href')!, name: a.querySelector('img')?.alt || 'Picture' });
    }}>
      {id ? <FactoryPage key={id} id={id} onBack={() => open(null)} onKeys={() => setDialog('keys')} />
        : !home ? <div className="social__state">{error ?? 'Loading…'}</div>
        : <HomePage home={home} onOpen={open} onNew={() => setDialog('new')} onKeys={() => setDialog('keys')} reload={load} />}
      {view && <Viewer {...view} onClose={unview} />}
      {dialog === 'new' && home && <NewEpisode home={home} onClose={() => setDialog(null)} onMade={(x) => { setDialog(null); open(x); }} />}
      {dialog === 'keys' && home && <Keys home={home} onClose={() => setDialog(null)} onSaved={load} />}
    </main>
  );
}

/** A picture over the whole app. Back, the close button, Escape or a click beside it return to where you were. */
function Viewer({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const [big, setBig] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    back.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => { window.removeEventListener('keydown', k, true); prev?.focus?.(); };
  }, [onClose]);
  return createPortal(
    <div className="sview" role="dialog" aria-modal="true" aria-label={name}>
      <div className="sview__bar">
        <button ref={back} type="button" className="is-back" onClick={onClose}><ArrowLeft size={15} aria-hidden /> Back</button>
        <b>{name}</b>
        <button type="button" onClick={() => setBig(!big)}>{big ? 'Fit' : 'Full size'}</button>
        <a href={`${src}${src.includes('?') ? '&' : '?'}download=1`} download><Download size={14} aria-hidden /> Save</a>
        <button type="button" aria-label="Close" onClick={onClose}><X size={15} aria-hidden /></button>
      </div>
      <div className={`sview__pic${big ? ' is-big' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}><img src={src} alt={name} onClick={() => setBig(!big)} /></div>
    </div>, document.body);
}

// ---------- home ----------
function HomePage({ home, onOpen, onNew, onKeys, reload }: { home: Home; onOpen: (id: string) => void; onNew: () => void; onKeys: () => void; reload: () => void }) {
  const live = home.episodes.filter((e) => !e.archived);
  const waiting = live.filter((e) => ['needs_you', 'failed'].includes(stateOf(e).s)), working = live.filter((e) => stateOf(e).s === 'running');
  const nextFree = home.slots.find((s) => !s.taken);
  return (
    <div className="social__scroll">
      <header className="social__head">
        <div><h1>Reels Factory</h1><p>{home.series ? <>{home.series.name} · {home.series.handle}</> : 'Cartoon reels'}</p></div>
        <div className="social__acts">
          <button type="button" className="btn btn--secondary btn--sm" onClick={onKeys}><KeyRound size={14} aria-hidden /> Connections{!home.keys.topview && <i className="social__dot" aria-label="TopView key missing" />}</button>
          <button type="button" className="btn btn--primary btn--sm" disabled={!home.ready} onClick={onNew}><Plus size={14} aria-hidden /> New episode</button>
        </div>
      </header>
      {!home.ready && <div className="social__note is-warn"><AlertTriangle size={16} aria-hidden /> The series isn’t on the server yet, so nothing can be made.</div>}
      {home.ready && !home.keys.topview && <div className="social__note is-warn"><AlertTriangle size={16} aria-hidden /><span>TopView has no key here yet. Stories and scripts work; pictures, voices’ upload and renders need it.</span><button type="button" className="link-btn" onClick={onKeys}>Add it</button></div>}
      <section className="social__cards">
        <div className="scard"><b>{waiting.length}</b><span>waiting for you</span></div>
        <div className="scard"><b>{working.length}</b><span>working now</span></div>
        <div className="scard"><b>{live.length + home.history.length}</b><span>episodes so far</span></div>
        <div className="scard is-wide"><b>{nextFree ? nextFree.label : 'None'}</b><span>next free slot{nextFree ? ` · ${nextFree.us}` : ''}</span></div>
      </section>

      <h2 className="social__h2">Episodes</h2>
      {live.length === 0 ? <div className="social__empty"><Clapperboard size={26} aria-hidden /><b>No episode is being made here yet</b><span>Start Episode {home.next}: you get four stories to pick from in about a minute.</span><button type="button" className="btn btn--primary btn--sm" disabled={!home.ready} onClick={onNew}>New episode</button></div>
        : (
          <ul className="social__list">
            {live.map((e) => {
              const st = stateOf(e);
              return (
                <li key={e.id}>
                  <button type="button" className={`sep is-${st.s}`} onClick={() => onOpen(e.id)}>
                    <span className="sep__pic">{e.cover ? <img src={epFileUrl(e.id, e.cover)} alt="" /> : <Clapperboard size={20} aria-hidden />}</span>
                    <span className="sep__main">
                      <b>Episode {e.num}: {e.title}</b>
                      <small className={`spill is-${st.s}`}>{st.s === 'running' ? <Loader2 size={11} className="spin" aria-hidden /> : null}{STAGE_INFO[st.stage].name}: {st.s === 'done' ? 'all done' : WORD[st.s].toLowerCase()}{e.progress ? ` · ${e.progress}` : ''}</small>
                      <span className="sep__bar" aria-hidden>{STAGES.map((k) => <i key={k} className={`is-${e.stages[k]}`} />)}</span>
                    </span>
                    <span className="sep__side"><span>{usd(e.spent)}{e.cap ? <small> of {usd(e.cap)}</small> : null}</span>{e.slot && <small>{e.slot.replace('T', ' ')} IST</small>}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

      <HomeTabs home={home} onOpen={onOpen} reload={reload} />
      {home.episodes.some((e) => e.archived) && <><h2 className="social__h2">Put away</h2><ul className="social__list">{home.episodes.filter((e) => e.archived).map((e) => <li key={e.id}><button type="button" className="sep is-idle" onClick={() => onOpen(e.id)}><span className="sep__pic"><Archive size={18} aria-hidden /></span><span className="sep__main"><b>Episode {e.num}: {e.title}</b></span></button></li>)}</ul></>}
    </div>
  );
}

function NewEpisode({ home, onClose, onMade }: { home: Home; onClose: () => void; onMade: (id: string) => void }) {
  const [brief, setBrief] = useState('');
  const [hook, setHook] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const close = useCallback(() => onClose(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const go = async () => { setBusy(true); setErr(null); try { const r = await socialApi.create({ brief, hookStyle: hook }); onMade(r.episode.id); } catch (e) { setErr((e as Error).message); setBusy(false); } };
  return (
    <Modal onClose={close} className="social-modal" label="New episode">
      <form onSubmit={(e) => { e.preventDefault(); if (!busy) void go(); }}>
        <div className="modal__header"><div className="modal__title">Episode {home.next}</div><button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button></div>
        <div className="social-modal__body">
          <label className="sfield"><span>Your idea (optional)</span><textarea className="text-input" rows={4} maxLength={1500} value={brief} placeholder="e.g. A florist the week before Valentine’s Day. Leave empty for four fresh ideas." onChange={(e) => setBrief(e.target.value)} /></label>
          <label className="sfield"><span>Hook style</span><select className="text-input" value={hook} onChange={(e) => setHook(e.target.value)}><option value="">Any that fits</option>{home.series?.hookTypes.map((h) => <option key={h}>{h}</option>)}</select></label>
          <p className="social__fine">Writing the four stories costs nothing. Nothing is generated or paid for until you approve it.</p>
          {err && <div className="card__error">{err}</div>}
        </div>
        <div className="modal__footer"><button type="button" className="btn btn--secondary btn--sm" onClick={close}>Cancel</button><button type="submit" className="btn btn--primary btn--sm" disabled={busy}>{busy ? 'Starting…' : 'Get four stories'}</button></div>
      </form>
    </Modal>
  );
}

function Keys({ home, onClose, onSaved }: { home: Home; onClose: () => void; onSaved: () => void }) {
  const close = useCallback(() => onClose(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal onClose={close} className="social-modal" label="Connections">
      <div className="modal__header"><div className="modal__title">Connections</div><button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button></div>
      <div className="social-modal__body">
        <KeyRow name="topview" title="TopView" set={home.keys.topview} about="Pictures and renders (first choice). Make a key at platform.topview.ai with models:generate and requests:read. It is checked with a free call before it is saved." onSaved={onSaved} />
        <KeyRow name="kie" title="kie.ai" set={home.keys.kie} about="The fallback for renders, used only when you choose it on the Render stage. About $4.20 a part, from the credits you have there. It is checked with a free call before it is saved." onSaved={onSaved} />
        <div className="skey"><div><b>ElevenLabs</b><small>Voices, through Zubi’s Composio. Nothing to add here.</small></div></div>
        <div className="skey"><div><b>Writing and checking</b><small>Zubi’s own Claude subscription.</small></div></div>
        <p className="social__fine">Keys stay on the server, readable only by HeyZubi, and are never shown again.</p>
      </div>
    </Modal>
  );
}
function KeyRow({ name, title, set, about, onSaved }: { name: string; title: string; set: boolean; about: string; onSaved: () => void }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const save = async (key: string) => { setBusy(true); setMsg(null); try { await socialApi.key(name, key); setV(''); setMsg({ ok: true, t: key ? 'Saved' : 'Removed' }); onSaved(); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } setBusy(false); };
  return (
    <form className="skey" onSubmit={(e) => { e.preventDefault(); if (v.trim()) void save(v.trim()); }}>
      <div><b>{title} {set && <span className="spill is-done"><CheckIcon size={11} aria-hidden /> Added</span>}</b><small>{about}</small></div>
      <div className="skey__row"><input className="text-input" type="password" autoComplete="off" value={v} placeholder={set ? 'Paste a new key to replace it' : 'Paste the key'} aria-label={`${title} key`} onChange={(e) => setV(e.target.value)} /><button type="submit" className="btn btn--primary btn--sm" disabled={busy || !v.trim()}>{busy ? 'Checking…' : 'Save'}</button>{set && <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void save('')}>Remove</button>}</div>
      {msg && <div className={msg.ok ? 'social__fine' : 'card__error'}>{msg.t}</div>}
    </form>
  );
}

