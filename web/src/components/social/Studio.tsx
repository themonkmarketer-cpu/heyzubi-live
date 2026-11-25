import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check as CheckIcon, Ellipsis, Loader2, Maximize2, Mic, MonitorSmartphone, Minimize2, RefreshCw, Send, SlidersHorizontal, Sun, X } from 'lucide-react';
import { epFileUrl, say, socialApi, voiceDrift, type Episode, type StudioOpen } from '../../lib/socialApi';
import { shotLabel } from './Boards';
import { Retake } from './StagePanels';
import type { Act } from './Workspace';

/**
 * The editor: HyperFrames itself, opened on this episode's cut, in a frame of its own. Every edit is saved as it is made;
 * "Make the cut" renders it. The bar above knows which shot is picked in there.
 */
const isDark = () => document.documentElement.dataset.theme === 'dark';
const sayTo = say;
const takeOf = (ep: Episode, part: number, n: number) => ep.render.parts[part - 1].versions.filter((q) => q.kind === 'shot' && q.shot === n && q.state === 'completed' && q.file && !(q.note ?? '').startsWith('[off]')).pop();

export function StudioEditor({ ep, act, busy, reload, more, fallback }: { ep: Episode; act: Act; busy: boolean; reload: () => void; more: ReactNode; fallback: ReactNode }) {
  const [open, setOpen] = useState<StudioOpen | null>(null);
  const [sel, setSel] = useState<string>('');
  const [at, setAt] = useState(0);
  const [pop, setPop] = useState<'retake' | 'fix' | 'gone' | 'menu' | 'voice' | 'screen' | null>(null);
  const [fix, setFix] = useState('');
  const [sheet, setSheet] = useState(false), [sure, setSure] = useState(false), [wide, setWide] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const can = !!ep.script && ep.review.every(Boolean) && ep.render.parts.every((q) => q.picked !== null);
  // What the shots are made of: when it changes (a new take, a screen), it is put under the cut.
  const made = JSON.stringify([ep.render.parts.map((p) => [p.picked, p.versions.filter((v) => v.kind === 'shot' && v.state === 'completed').map((v) => [v.v, (v.note ?? '').startsWith('[off]')])]), ep.edit.options.brighten, ep.edit.options.screens, ep.edit.options.screenOn, ep.edit.options.captionFixes, ep.review.map((r) => r?.shotStarts?.length ?? 0), ep.screens.map((s) => s.png)]);
  const ask = useCallback((again: boolean, fresh = false) => socialApi.editor(ep.id, { again, fresh }).then(setOpen, (e) => setOpen({ state: 'failed', note: (e as Error).message })), [ep.id]);
  useEffect(() => { if (can) void ask(true); }, [can, made, ask]);
  const working = open?.state === 'working';
  useEffect(() => { if (!working) return; const t = setInterval(() => void ask(false), 2500); return () => clearInterval(t); }, [working, ask]);

  // The frame's address is kept while it is open, so nothing done here makes it start again.
  const [src, setSrc] = useState<string | null>(null);
  const url = open?.state === 'open' ? open.url : undefined;
  // Its address is asked first: while it doesn't answer, the simple editor stays.
  const [far, setFar] = useState(false);
  useEffect(() => {
    if (!url || src) return;
    let on = true;
    const look = () => fetch(`${new URL(url).origin}/favicon.svg`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' }).then(() => { if (on) { setFar(false); open_(); } }, () => { if (on) setFar(true); });
    const open_ = () => setSrc(`${url}&theme=${isDark() ? 'dark' : 'light'}#project/${new URL(url).searchParams.get('ep')}`);
    void look();
    const t = setInterval(look, 8000);
    return () => { on = false; clearInterval(t); };
  }, [url, src]);
  useEffect(() => {
    if (!src) return;
    const origin = new URL(src).origin;
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow || !e.data?.heyzubiEditor) return;
      if (typeof e.data.sel === 'string') { setSel((x) => { if (x !== e.data.sel) setPop((p) => (p === 'gone' || p === 'menu' ? p : null)); return e.data.sel; }); setAt(Number(e.data.t) || 0); }
      if (e.data.saved) { if (t) clearTimeout(t); t = setTimeout(reload, 900); }
    };
    window.addEventListener('message', on);
    return () => { window.removeEventListener('message', on); if (t) clearTimeout(t); };
  }, [src, reload]);
  useEffect(() => { if (!wide) return; const on = (e: KeyboardEvent) => { if (e.key === 'Escape') setWide(false); }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [wide]);

  const S = ep.studio, st = ep.stages.edit;
  const pick = useMemo(() => {
    const c = S?.clips?.find((x) => x.id === sel) ?? null;
    if (!c || !ep.script) return null;
    const x = ep.script.parts[c.part - 1].shots.find((q) => q.n === c.shot);
    return x ? { ...c, x, who: x.line ? ep.cast.find((m) => m.key === x.speaker?.toLowerCase())?.name ?? x.speaker ?? '' : x.screen ? 'Screen' : 'Silent' } : null;
  }, [S, sel, ep]);
  const other = !pick && sel ? (sel === 'captions' ? 'Captions' : sel === 'clock' ? 'Clock' : sel === 'music' ? 'Theme' : sel.startsWith('snd') ? 'Sound' : '') : '';
  if (!can) return <div className="wk__pad"><div className="social__empty"><b>The editor opens once both parts are rendered and reviewed</b><span>{ep.render.parts.some((q) => q.picked === null) ? 'A part is still missing.' : 'The review hasn’t run yet.'}</span></div></div>;

  if (far) return <><div className="social__note is-warn hfe__far"><AlertTriangle size={15} aria-hidden /><span>The HyperFrames editor doesn’t answer at {url ? new URL(url).host : 'its address'}. It opens here by itself when it does; until then this is the simple editor.</span></div>{fallback}</>;
  const dirty = !ep.edit.final || !S?.made || S.sig !== ep.edit.studioSig, running = ep.running === 'edit', wait = ep.blocked.edit;
  const ready = ['needs_you', 'ready', 'failed', 'stale'].includes(st.status) && !wait;
  const lift = ep.edit.options.brighten ?? [], lit = !!pick && lift.some((d) => d.part === pick.part && d.shot === pick.shot);
  const line = pick ? ep.review[pick.part - 1]?.lines.find((l) => l.shot === pick.shot) : undefined, retaken = !!pick && !!takeOf(ep, pick.part, pick.shot), drift = pick && !retaken ? voiceDrift(line, pick.x) : null;
  const shotKey = pick ? `${pick.part}-${pick.shot}` : '', onNow = pick ? ep.edit.options.screenOn?.[shotKey] ?? pick.x.screen ?? '' : '';
  const setScreen = (v: string) => { if (!pick) return; const all = { ...(ep.edit.options.screenOn ?? {}) }; if (v === (pick.x.screen ?? '')) delete all[shotKey]; else all[shotKey] = v; setPop(null); void act(() => socialApi.edit(ep.id, { screenOn: all }), false); };
  const make = () => void act(() => socialApi.run(ep.id, 'edit'), false);
  const reopen = () => void act(() => socialApi.reopen(ep.id, 'edit'), false);
  const where = pick ? shotLabel(pick.part, pick.shot) : `The cut at ${at.toFixed(1)} s`;
  const gone = S?.gone ?? [];
  const note = running ? st.progress ?? 'Making the cut' : wait && st.status !== 'done' ? wait : st.status === 'done' ? (dirty ? 'Changed since it was approved' : 'Approved') : st.status === 'failed' ? `Stopped: ${st.error ?? ''}` : dirty ? (!ep.edit.final ? 'Not made yet' : !ep.edit.studioSig ? `Cut v${ep.edit.version} was made before this editor` : 'Changes not in the cut yet') : `Cut v${ep.edit.version} is up to date`;
  return (
    <div className={`hfe${wide ? ' is-wide' : ''}`}>
      <div className="hfe__bar">
        <b>{(S?.seconds ?? 0).toFixed(1)} s</b>
        {pick ? (
          <span className="hfe__pick">
            <em>{shotLabel(pick.part, pick.shot)}{pick.who ? ` · ${pick.who}` : ''}</em>
            <button type="button" className="btn btn--secondary btn--sm" aria-expanded={pop === 'retake'} onClick={() => setPop(pop === 'retake' ? null : 'retake')}><RefreshCw size={12} aria-hidden /> Retake</button>
            {pick.x.line && <button type="button" className={`btn btn--secondary btn--sm${drift !== null ? ' is-drift' : ''}`} aria-expanded={pop === 'voice'} title={drift !== null ? `The voice is ${Math.abs(drift)}% ${drift > 0 ? 'higher' : 'lower'} than the sample` : 'Say the line again in the character’s own voice'} onClick={() => setPop(pop === 'voice' ? null : 'voice')}><Mic size={12} aria-hidden /> Voice{drift !== null ? ` ${drift > 0 ? '+' : ''}${drift}%` : ''}</button>}
            <button type="button" className="btn btn--secondary btn--sm" aria-expanded={pop === 'screen'} title="The screen on this shot’s device" onClick={() => setPop(pop === 'screen' ? null : 'screen')}><MonitorSmartphone size={12} aria-hidden /> Screen</button>
            <button type="button" className="btn btn--secondary btn--sm" aria-pressed={lit} disabled={busy} title="Lift a dark shot a little" onClick={() => void act(() => socialApi.edit(ep.id, { brighten: lit ? lift.filter((d) => !(d.part === pick.part && d.shot === pick.shot)) : [...lift, { part: pick.part, shot: pick.shot }] }), false)}><Sun size={12} aria-hidden /> {lit ? 'Brightened' : 'Brighten'}</button>
            <button type="button" className="btn btn--secondary btn--sm" aria-expanded={pop === 'fix'} onClick={() => setPop(pop === 'fix' ? null : 'fix')}><Send size={12} aria-hidden /> Ask for a fix</button>
          </span>
        ) : <span className="hfe__pick">{other ? <em>{other}</em> : <small>Click a shot to change it. Edits save by themselves.</small>}<button type="button" className="btn btn--secondary btn--sm" aria-expanded={pop === 'fix'} onClick={() => setPop(pop === 'fix' ? null : 'fix')}><Send size={12} aria-hidden /> Ask for a fix</button></span>}
        {gone.length > 0 && <button type="button" className="btn btn--secondary btn--sm" aria-expanded={pop === 'gone'} onClick={() => setPop(pop === 'gone' ? null : 'gone')}>{gone.length} left out</button>}
        <span className="wk__sp" />
        <span className={`hfe__state${dirty || st.status === 'failed' ? ' is-on' : ''}`} role="status">{running || working ? <Loader2 size={12} className="spin" aria-hidden /> : st.status === 'failed' ? <AlertTriangle size={12} aria-hidden /> : !dirty ? <CheckIcon size={12} aria-hidden /> : null}<span>{working && open?.state === 'working' ? open.note : note}</span></span>
        <button type="button" className="btn btn--secondary btn--sm" aria-expanded={sheet} title="Sound, captions, screens, checks and approval" onClick={() => setSheet(!sheet)}><SlidersHorizontal size={13} aria-hidden /> {st.status === 'needs_you' && !dirty && !wait ? 'Check and approve' : 'Settings'}</button>
        {st.status === 'done' && dirty ? <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={reopen}>Open the cut again</button> : <button type="button" className={`btn btn--sm ${dirty ? 'btn--primary' : 'btn--secondary'}`} disabled={busy || !ready || working} title={wait || (st.status === 'done' ? 'This cut is approved and up to date.' : undefined)} onClick={make}>{ep.edit.final ? 'Make the cut again' : 'Make the cut'}</button>}
        <button type="button" className="sicon" title={wide ? 'Back to the page' : 'Fill the window'} aria-label={wide ? 'Back to the page' : 'Fill the window'} aria-pressed={wide} onClick={() => setWide(!wide)}>{wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
        <span className="wk__menu"><button type="button" className="sicon" aria-label="More" title="More" aria-expanded={pop === 'menu'} onClick={() => { setPop(pop === 'menu' ? null : 'menu'); setSure(false); }}><Ellipsis size={15} /></button>
          {pop === 'menu' && <div className="wk__pop"><button type="button" onClick={() => { setPop(null); if (frame.current && src) frame.current.src = src; }}><RefreshCw size={14} aria-hidden /> Load the editor again</button><button type="button" className="is-danger" disabled={busy || working} onClick={() => { if (!sure) { setSure(true); return; } setPop(null); setSure(false); void ask(true, true); }}>{sure ? 'Drop my edits and start over?' : 'Start over from the automatic cut'}</button></div>}
        </span>
      </div>
      {pop === 'retake' && pick && <div className="hfe__pop"><header><b>Retake {shotLabel(pick.part, pick.shot)}</b><button type="button" className="sicon" aria-label="Close" onClick={() => setPop(null)}><X size={14} /></button></header><Retake ep={ep} part={pick.part} busy={busy} act={act} only={pick.shot} />{takeOf(ep, pick.part, pick.shot) && <small>This shot already has a new take in use.</small>}</div>}
      {pop === 'voice' && pick && <div className="hfe__pop"><header><b>{pick.who}: “{pick.x.line}”</b><button type="button" className="sicon" aria-label="Close" onClick={() => setPop(null)}><X size={14} /></button></header>
        <p className="social__fine">{retaken ? 'This shot is a retake with its own sound.' : line?.pitch && line.refPitch ? `Heard at ${line.pitch} Hz; the sample is ${line.refPitch} Hz.${drift !== null ? ' That is a clear drift.' : ''}` : 'The voice hasn’t been measured.'} Saying it again uses the character’s own ElevenLabs voice over the same picture: no money, about {pick.x.line!.length} of your ElevenLabs characters. It can’t change the mouth, and Review waits for you again.</p>
        <div><small /><button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => { setPop(null); void act(() => socialApi.revoice(ep.id, pick.part, pick.shot), false); }}>Say it again</button></div></div>}
      {pop === 'screen' && pick && <div className="hfe__pop"><header><b>Screen on {shotLabel(pick.part, pick.shot)}</b><button type="button" className="sicon" aria-label="Close" onClick={() => setPop(null)}><X size={14} /></button></header>
        <div className="hfe__screens">{ep.screens.map((q) => <button key={q.id} type="button" aria-pressed={onNow === q.id} disabled={busy} title={q.title} onClick={() => setScreen(q.id)}><img src={epFileUrl(ep.id, q.png)} alt="" loading="lazy" /><span>{q.title}</span></button>)}<button type="button" aria-pressed={onNow === ''} disabled={busy} onClick={() => setScreen('')}><i>None</i><span>As rendered</span></button></div>
        <small>It is laid on the white screen of the device in this shot; that takes a minute, then the picture here changes.</small></div>}
      {pop === 'fix' && <form className="hfe__pop" onSubmit={(e) => { e.preventDefault(); if (!fix.trim()) return; sayTo(ep.id, `${where}${pick ? ` (${pick.start.toFixed(1)} s in the cut)` : ''}: ${fix.trim()}`); setFix(''); setPop(null); }}><header><b>{where}</b><button type="button" className="sicon" aria-label="Close" onClick={() => setPop(null)}><X size={14} /></button></header><textarea className="text-input" rows={3} autoFocus value={fix} maxLength={1000} placeholder="What should be different here?" aria-label={`Fix for ${where}`} onChange={(e) => setFix(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.form?.requestSubmit(); if (e.key === 'Escape') setPop(null); }} /><div><small>Goes to the session. Anything that costs money comes back with its price.</small><button type="submit" className="btn btn--primary btn--sm" disabled={!fix.trim()}>Fix it</button></div></form>}
      {pop === 'gone' && <div className="hfe__pop"><header><b>Left out</b><button type="button" className="sicon" aria-label="Close" onClick={() => setPop(null)}><X size={14} /></button></header><ul className="hfe__gone">{gone.map((g) => { const x = ep.script!.parts[g.part - 1].shots.find((q) => q.n === g.shot); return <li key={`${g.part}-${g.shot}`}><span><b>{shotLabel(g.part, g.shot)}</b> {x?.line ?? x?.picture}</span><button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void act(() => socialApi.putBack(ep.id, g.part, g.shot), false)}>Put back</button></li>; })}</ul></div>}
      <div className="hfe__in">
        {src ? <iframe ref={frame} src={src} title="HyperFrames editor" allow="clipboard-read; clipboard-write; fullscreen" /> : open?.state === 'failed' ? <div className="social__empty"><b>The editor didn’t open</b><span>{open.note}</span><button type="button" className="btn btn--secondary btn--sm" onClick={() => { setOpen(null); void ask(true); }}>Try again</button></div> : <div className="social__empty"><Loader2 size={18} className="spin" aria-hidden /><b>{open?.note ?? 'Opening the editor'}</b>{working && <span>The first time, the shots and their screens are prepared. That takes a few minutes; you can leave this page.</span>}</div>}
        {sheet && <aside className="hfe__sheet" aria-label="Settings of the cut"><header><b>Sound, captions, screens and approval</b><button type="button" className="sicon" aria-label="Close" onClick={() => setSheet(false)}><X size={15} /></button></header><div>{more}</div></aside>}
      </div>
    </div>
  );
}
