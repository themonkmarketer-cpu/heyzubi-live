import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Archive, ArrowLeft, BadgeCheck, CalendarClock, Captions, Check as CheckIcon, Clock, Ellipsis, FileText, Film, Hand, ImageIcon, LayoutGrid, LayoutTemplate, Lightbulb, ListChecks, Loader2, MessageSquare, Minus, MonitorSmartphone, PanelRightClose, PenLine, PictureInPicture2, Pin, Play, Receipt, Scissors, Square, Trash2, Users, X } from 'lucide-react';
import { epFileUrl, say, socialApi, waitingSaid, STAGE_INFO, STAGES, usd, type Episode, type Home, type Slot, type StageId, type StageStatus, type Version } from '../../lib/socialApi';
import { lsGet, lsSet } from '../../lib/storage';
import { AgentChat } from './AgentChat';
import { blocksOf, EditorBoard, StoryboardBoard, shotLabel, type PlayAt } from './Boards';
import { EditPanel, StagePanel } from './StagePanels';
import { StudioEditor } from './Studio';
import '../../styles/social-work.css';

/**
 * One episode's workspace: the script, the storyboard and the editor as sections, the stages behind "Steps", and floating
 * windows for the video, the session with the agent, and every new render as it arrives.
 */
export const ICONS: Record<StageId, typeof Film> = { story: Lightbulb, script: PenLine, cast: Users, screens: MonitorSmartphone, storyboard: LayoutTemplate, render: Film, review: BadgeCheck, edit: Scissors, cover: ImageIcon, package: Captions, schedule: CalendarClock };
export const WORD: Record<StageStatus, string> = { idle: 'Not yet', ready: 'Ready', running: 'Working', needs_you: 'Needs you', done: 'Done', failed: 'Stopped', stale: 'Out of date' };
const when = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export type Act = (fn: () => Promise<unknown>, follow?: boolean) => Promise<void>;

// ---------- floating windows ----------
export interface Rect { x: number; y: number; w: number; h: number; min?: boolean }
let top = 60;
const fit = (r: Rect): Rect => { const W = window.innerWidth, H = window.innerHeight, w = Math.min(Math.max(240, r.w), W - 16), h = Math.min(Math.max(150, r.h), H - 16); return { ...r, w, h, x: Math.min(Math.max(8 - w + 120, r.x), W - 90), y: Math.min(Math.max(6, r.y), H - 46) }; };
export function FloatWin({ id, title, actions, init, children, onClose, mode = 'float', onMode, onRect, className = '' }: { id: string; title: ReactNode; actions?: ReactNode; init: () => Rect; children: ReactNode; onClose?: () => void; mode?: 'float' | 'dock'; onMode?: (m: 'float' | 'dock') => void; onRect?: (id: string, r: Rect | null) => void; className?: string }) {
  const [r, setR] = useState<Rect>(() => { try { const s = JSON.parse(lsGet(`win-${id}`) || 'null'); if (s && s.w) return fit(s); } catch { /* the default place */ } return fit(init()); });
  const [z, setZ] = useState(() => ++top);
  const box = useRef<HTMLElement>(null);
  const put = useCallback((n: Rect, keep = true) => { setR(n); if (keep) lsSet(`win-${id}`, JSON.stringify(n)); }, [id]);
  useEffect(() => { const on = () => setR((x) => fit(x)); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  useEffect(() => { onRect?.(id, mode === 'float' ? r : null); return () => onRect?.(id, null); }, [id, mode, r, onRect]);
  const move = (kind: 'move' | 'e' | 's' | 'se' | 'w') => (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, input, textarea, select, a') && kind === 'move') return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement, x0 = e.clientX, y0 = e.clientY, from = r;
    let last = from;
    el.setPointerCapture(e.pointerId);
    const mv = (m: PointerEvent) => {
      const dx = m.clientX - x0, dy = m.clientY - y0;
      last = fit(kind === 'move' ? { ...from, x: from.x + dx, y: from.y + dy } : kind === 'w' ? { ...from, x: from.x + dx, w: from.w - dx } : { ...from, w: kind === 's' ? from.w : from.w + dx, h: kind === 'e' ? from.h : from.h + dy });
      setR(last);
    };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); lsSet(`win-${id}`, JSON.stringify(last)); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  const nudge = (e: React.KeyboardEvent) => { const s = e.shiftKey ? 40 : 10, d = ({ ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] } as Record<string, number[]>)[e.key]; if (d && e.target === e.currentTarget) { e.preventDefault(); put(fit({ ...r, x: r.x + d[0], y: r.y + d[1] })); } };
  const dock = mode === 'dock';
  return (
    <section ref={box} className={`fwin${dock ? ' is-dock' : ''}${r.min && !dock ? ' is-min' : ''} ${className}`} role="dialog" aria-label={typeof title === 'string' ? title : id} style={dock ? undefined : { left: r.x, top: r.y, width: r.w, height: r.min ? undefined : r.h, zIndex: z }} onPointerDown={() => { if (z !== top) setZ(++top); }}>
      <header className="fwin__bar" tabIndex={dock ? undefined : 0} aria-label={dock ? undefined : 'Drag, or use the arrow keys, to move this window'} onPointerDown={dock ? undefined : move('move')} onKeyDown={dock ? undefined : nudge} onDoubleClick={() => !dock && put({ ...r, min: !r.min })}>
        <span className="fwin__t">{title}</span>
        {actions}
        {onMode && <button type="button" className="sicon" title={dock ? 'Detach: make it float' : 'Attach to the right side'} aria-label={dock ? 'Detach this window' : 'Attach this window to the right side'} onClick={() => onMode(dock ? 'float' : 'dock')}>{dock ? <PictureInPicture2 size={14} /> : <PanelRightClose size={14} />}</button>}
        {!dock && <button type="button" className="sicon" title={r.min ? 'Open' : 'Fold'} aria-label={r.min ? 'Open this window' : 'Fold this window'} onClick={() => put({ ...r, min: !r.min })}>{r.min ? <Square size={11} /> : <Minus size={14} />}</button>}
        {onClose && <button type="button" className="sicon" title="Close" aria-label="Close this window" onClick={onClose}><X size={14} /></button>}
      </header>
      {(!r.min || dock) && <div className="fwin__in">{children}</div>}
      {!dock && !r.min && <><i className="fwin__w" onPointerDown={move('w')} /><i className="fwin__e" onPointerDown={move('e')} /><i className="fwin__s" onPointerDown={move('s')} /><i className="fwin__se" onPointerDown={move('se')} /></>}
    </section>
  );
}
/** A correction, right where it was seen: to the agent, or kept as a comment. */
export function FixBox({ where, onAsk, onPin }: { where: string; onAsk: (t: string) => void; onPin?: (t: string) => void }) {
  const [t, setT] = useState('');
  const ok = !!t.trim();
  return (
    <form className="fix" onSubmit={(e) => { e.preventDefault(); if (ok) { onAsk(t.trim()); setT(''); } }}>
      <small>{where}</small>
      <textarea className="text-input" rows={2} value={t} maxLength={1000} placeholder="What should be different here?" aria-label={`Correction for ${where}`} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ok) { e.preventDefault(); onAsk(t.trim()); setT(''); } }} />
      <div>{onPin && <button type="button" className="btn btn--secondary btn--sm" disabled={!ok} title="Keep it as a comment for later" onClick={() => { onPin(t.trim()); setT(''); }}><Pin size={12} aria-hidden /> Note it</button>}<button type="submit" className="btn btn--primary btn--sm" disabled={!ok}>Fix it</button></div>
    </form>
  );
}

// ---------- the video ----------
function VideoWin({ ep, play, setPlay, req, act, mode, onMode, onClose, onRect }: { ep: Episode; play: PlayAt; setPlay: (p: PlayAt) => void; req: { n: number; src: PlayAt['src']; t: number; play: boolean }; act: Act; mode: 'float' | 'dock'; onMode: (m: 'float' | 'dock') => void; onClose: () => void; onRect: (id: string, r: Rect | null) => void }) {
  const v = useRef<HTMLVideoElement>(null);
  const [old, setOld] = useState<number | null>(null);
  const src = play.src, part = src === 'p2' ? 2 : 1, made = ep.render.parts[part - 1].versions.filter((x) => x.kind !== 'shot' && x.state === 'completed' && x.file);
  const inUse = made.find((x) => x.v === ep.render.parts[part - 1].picked), cur = src === 'cut' ? null : made.find((x) => x.v === old) ?? inUse ?? made[made.length - 1];
  const file = src === 'cut' ? ep.edit.final : cur?.file ?? null;
  const want = useRef<{ t: number; play: boolean } | null>(null);
  useEffect(() => { setOld(null); }, [src]);
  useEffect(() => { want.current = { t: req.t, play: req.play }; const e = v.current; if (e && e.readyState >= 1) { e.currentTime = Math.min(req.t, Math.max(0, (e.duration || 999) - 0.05)); if (req.play) void e.play().catch(() => {}); want.current = null; } }, [req.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = () => { const w = want.current, e = v.current; if (w && e) { e.currentTime = Math.min(w.t, Math.max(0, (e.duration || 999) - 0.05)); if (w.play) void e.play().catch(() => {}); want.current = null; } };
  const list = useMemo(() => blocksOf(ep, src === 'cut' ? 'cut' : 'board'), [ep, src]);
  const here = src === 'cut' ? list.find((b) => !b.dropped && play.t >= b.at && play.t < b.at + b.len) : list.find((b) => b.part === part && play.t >= b.s && play.t < b.e);
  const re = here && ep.render.parts[here.part - 1].versions.filter((q) => q.kind === 'shot' && q.shot === here.n && q.state === 'completed' && !(q.note ?? '').startsWith('[off]')).pop();
  const where = here ? `${shotLabel(here.part, here.n)} at ${play.t.toFixed(1)} s${src === 'cut' ? ' of the cut' : ''}` : src === 'cut' ? `The cut at ${play.t.toFixed(1)} s` : `Part ${part} at ${play.t.toFixed(1)} s`;
  const step = (d: number) => { const e = v.current; if (e) { e.pause(); e.currentTime = Math.max(0, e.currentTime + d / 24); } };
  return (
    <FloatWin id="video" title="Video" className="is-video" mode={mode} onMode={onMode} onClose={onClose} onRect={onRect} init={() => ({ x: window.innerWidth - 356, y: 66, w: 340, h: Math.max(380, Math.min(600, window.innerHeight * 0.58)) })}
      actions={<div className="seg" role="group" aria-label="Which video">{([['p1', 'Part 1'], ['p2', 'Part 2'], ['cut', 'Cut']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={src === k} disabled={k === 'cut' ? !ep.edit.final : !ep.render.parts[k === 'p2' ? 1 : 0].versions.some((x) => x.kind !== 'shot' && x.file)} onClick={() => setPlay({ src: k, t: 0 })}>{l}</button>)}</div>}>
      <div className="vid">
        {file ? <video key={file} ref={v} src={`${epFileUrl(ep.id, file)}${src === 'cut' ? `&v=${ep.edit.version}` : ''}`} controls preload="auto" playsInline onLoadedMetadata={ready} onTimeUpdate={(e) => setPlay({ src, t: e.currentTarget.currentTime })} onSeeked={(e) => setPlay({ src, t: e.currentTarget.currentTime })} /> : <div className="vid__no">{src === 'cut' ? 'No cut yet' : `Part ${part} isn’t made yet`}</div>}
      </div>
      <div className="vid__row">
        <button type="button" className="sicon" title="One frame back" aria-label="One frame back" onClick={() => step(-1)}>‹</button><button type="button" className="sicon" title="One frame on" aria-label="One frame on" onClick={() => step(1)}>›</button>
        {src !== 'cut' && made.length > 1 && <select className="text-input" aria-label="Version" value={cur?.v ?? ''} onChange={(e) => setOld(Number(e.target.value))}>{made.map((x) => <option key={x.v} value={x.v}>v{x.v}{x.kind === 'voice' ? ` (shot ${x.shot} said again)` : x.kind === 'import' ? ' (your clip)' : ''}{x.v === ep.render.parts[part - 1].picked ? ', in use' : ''}</option>)}</select>}
        {src !== 'cut' && cur && cur.v !== ep.render.parts[part - 1].picked && <button type="button" className="btn btn--secondary btn--sm" disabled={!!ep.running} onClick={() => void act(() => socialApi.version(ep.id, part, cur.v), false)}>Use this</button>}
        {src !== 'cut' && re && <small className="vid__re">Shot {here!.n} was retaken: the cut uses the new one</small>}
      </div>
      <FixBox where={where} onAsk={(t) => say(ep.id, `${where}: ${t}`)} onPin={(t) => void act(() => socialApi.comment(ep.id, { text: t, t: play.t, ...(here ? { part: here.part, shot: here.n } : {}) }), false)} />
    </FloatWin>
  );
}

/** A render that has just arrived, in its own window, beside what it replaces. */
interface Fresh { key: string; part: number; v: Version | null; cut?: number }
function FreshWin({ ep, f, n, last, act, onClose }: { ep: Episode; f: Fresh; n: number; last: boolean; act: Act; onClose: () => void }) {
  const [both, setBoth] = useState(false);
  const shot = f.v?.kind === 'shot' ? f.v.shot! : null, P = ep.render.parts[f.part - 1], now = f.v ? P.versions.find((x) => x.v === f.v!.v) ?? f.v : null;
  const off = (now?.note ?? '').startsWith('[off]'), base = f.v ? P.versions.filter((x) => x.kind !== 'shot' && x.state === 'completed' && x.file && (shot ? x.v === P.picked : x.v !== f.v!.v)).pop() : null;
  const b = shot ? blocksOf(ep, 'board').find((x) => x.part === f.part && x.n === shot) : null;
  const old = useRef<HTMLVideoElement>(null);
  const name = f.cut ? `New cut v${f.cut}` : shot ? `New: ${shotLabel(f.part, shot)}` : f.v?.kind === 'voice' ? `${shotLabel(f.part, f.v.shot ?? 0)} said again` : `New: Part ${f.part} v${f.v?.v}`;
  const file = f.cut ? ep.edit.final : f.v?.file;
  const usable = f.v && (shot ? <button type="button" className="btn btn--secondary btn--sm" disabled={!!ep.running} onClick={() => void act(() => socialApi.version(ep.id, f.part, f.v!.v), false)}>{off ? 'Use it' : 'Don’t use it'}</button> : P.picked === f.v.v ? <span className="spill is-done">In use</span> : <button type="button" className="btn btn--secondary btn--sm" disabled={!!ep.running} onClick={() => void act(() => socialApi.version(ep.id, f.part, f.v!.v), false)}>Use this</button>);
  if (!file) return null;
  return (
    <FloatWin id={`fresh-${f.key}`} title={<><i className="fwin__new" aria-hidden /> {name}</>} className="is-video is-fresh" onClose={onClose} init={() => ({ x: Math.max(110, window.innerWidth * 0.34) + n * 34, y: 96 + n * 30, w: both ? 560 : 320, h: 620 })}>
      <div className={`vid${both ? ' is-two' : ''}`}>
        {both && base?.file && <figure><video ref={old} src={`${epFileUrl(ep.id, base.file)}${b ? `#t=${b.s.toFixed(2)},${b.e.toFixed(2)}` : ''}`} controls playsInline preload="auto" /><figcaption>Before</figcaption></figure>}
        <figure><video src={`${epFileUrl(ep.id, file)}${f.cut ? `&v=${f.cut}` : ''}`} controls autoPlay={last && !both} loop={!!shot} playsInline preload="auto" />{both && <figcaption>New</figcaption>}</figure>
      </div>
      <div className="vid__row">{usable}{base?.file && <button type="button" className="btn btn--secondary btn--sm" aria-pressed={both} onClick={() => setBoth(!both)}>{both ? 'Only the new one' : 'Compare'}</button>}{now?.usd ? <small>{usd(now.usd)}</small> : null}{off && <small>Not used in the cut</small>}</div>
      <FixBox where={shot ? `The new ${shotLabel(f.part, shot)}` : name} onAsk={(t) => say(ep.id, `${shot ? `The new take of ${shotLabel(f.part, shot)}` : name}: ${t}`)} onPin={(t) => void act(() => socialApi.comment(ep.id, { text: t, ...(shot ? { part: f.part, shot } : {}) }), false)} />
    </FloatWin>
  );
}
/** What has been rendered since it was last looked at here. */
function useFresh(ep: Episode | null): [Fresh[], (key: string) => void] {
  const [list, setList] = useState<Fresh[]>([]);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!ep) return;
    const all: Fresh[] = [...ep.render.parts.flatMap((p, i) => p.versions.filter((v) => v.state === 'completed' && v.file && v.kind !== 'import').map((v) => ({ key: `p${i + 1}v${v.v}`, part: i + 1, v }))), ...(ep.edit.final && ep.edit.version ? [{ key: `cut${ep.edit.version}`, part: 0, v: null, cut: ep.edit.version }] : [])];
    const name = `seen-${ep.id}`;
    if (!seen.current) { const s = lsGet(name); seen.current = new Set(s === null ? all.map((f) => f.key) : s.split(',')); if (s === null) lsSet(name, [...seen.current].join(',')); }
    const add = all.filter((f) => !seen.current!.has(f.key));
    if (!add.length) return;
    add.forEach((f) => seen.current!.add(f.key));
    lsSet(name, [...seen.current].join(','));
    setList((l) => [...l.filter((x) => !(x.cut && add.some((a) => a.cut))), ...add].slice(-4));
  }, [ep]);
  return [list, useCallback((key: string) => setList((l) => l.filter((x) => x.key !== key)), [])];
}

// ---------- the page ----------
type View = 'script' | 'storyboard' | 'editor' | 'steps' | 'history' | 'spending';
const VIEWS: [View, string, typeof Film][] = [['editor', 'Editor', Film], ['script', 'Script', FileText], ['storyboard', 'Storyboard', LayoutGrid]], MORE: [View, string, typeof Film][] = [['steps', 'Steps', ListChecks], ['history', 'History', Clock], ['spending', 'Spending', Receipt]];
const homeView = (s: StageId): View => (s === 'script' ? 'script' : s === 'storyboard' || s === 'review' ? 'storyboard' : s === 'edit' ? 'editor' : 'steps');

export function EpisodePage({ id, keys, onBack, onKeys, hookTypes }: { id: string; keys?: Home['keys']; onBack: () => void; onKeys: () => void; hookTypes: string[] }) {
  const [ep, setEp] = useState<Episode | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [pick, setPick] = useState<StageId | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [sure, setSure] = useState(false);
  const [play, setPlay] = useState<PlayAt>({ src: 'p1', t: 0 });
  const [req, setReq] = useState<{ n: number; src: PlayAt['src']; t: number; play: boolean }>({ n: 0, src: 'p1', t: 0, play: false });
  const [sel, setSel] = useState<{ part: number; shot: number } | null>(null);
  const [videoOn, setVideoOn] = useState(() => lsGet('workVideo') !== 'off'), [chatOn, setChatOn] = useState(() => lsGet('workChat') !== 'off');
  const [videoMode, setVideoMode] = useState<'float' | 'dock'>(() => (lsGet('workVideoMode') === 'dock' ? 'dock' : 'float')), [chatMode, setChatMode] = useState<'float' | 'dock'>(() => (lsGet('workChatMode') === 'dock' ? 'dock' : 'float'));
  const [edChat, setEdChat] = useState(() => waitingSaid(id).length > 0);
  const [rects, setRects] = useState<Record<string, Rect | null>>({});
  const load = useCallback(() => { socialApi.get(id).then((r) => { setEp(r.episode); if (r.slots) setSlots(r.slots); }).catch((e) => { setError((e as Error).message); }); }, [id]);
  useEffect(() => {
    load();
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = (e: Event) => { const d = (e as CustomEvent<{ type: string; episodeId: string }>).detail; if (d?.type === 'social' && d.episodeId === id && !t) t = setTimeout(() => { t = null; load(); }, 350); };
    window.addEventListener('heyzubi:event', on);
    const poll = setInterval(load, 15_000);
    return () => { window.removeEventListener('heyzubi:event', on); clearInterval(poll); if (t) clearTimeout(t); };
  }, [id, load]);
  useEffect(() => { const on = (e: Event) => { if ((e as CustomEvent<{ id: string }>).detail?.id === id) { setChatOn(true); setEdChat(true); lsSet('workChat', ''); } }; window.addEventListener('social:say', on); return () => window.removeEventListener('social:say', on); }, [id]);
  const [fresh, seenFresh] = useFresh(ep);
  const current = useMemo<StageId>(() => {
    if (!ep) return 'story';
    for (const s of ['running', 'needs_you', 'failed', 'stale', 'ready'] as StageStatus[]) { const k = STAGES.find((x) => ep.stages[x].status === s); if (k) return k; }
    return 'schedule';
  }, [ep]);
  const onRect = useCallback((k: string, r: Rect | null) => setRects((x) => (x[k] === r ? x : { ...x, [k]: r })), []);
  // After a decision, follow the work to its next stage.
  const act = useCallback<Act>(async (fn, follow = true) => {
    setBusy(true); setError(null);
    try { const r = (await fn()) as { episode?: Episode }; if (r?.episode) setEp(r.episode); else load(); if (follow) { setPick(null); setView(null); } }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  }, [load]);
  const seek = useCallback((src: PlayAt['src'], t: number, go = false) => { setVideoOn(true); setPlay({ src, t }); setReq((q) => ({ n: q.n + 1, src, t, play: go })); }, []);
  const hasVideo = !!ep && (ep.render.parts.some((p) => p.versions.some((v) => v.file)) || !!ep.edit.final);
  const first = useRef(true);
  useEffect(() => { if (ep && first.current) { first.current = false; setPlay({ src: ep.edit.final && ['edit', 'cover', 'package', 'schedule'].includes(current) ? 'cut' : ep.render.parts[0].picked !== null ? 'p1' : 'p2', t: 0 }); } }, [ep, current]);
  if (!ep) return <div className="social__state">{error ? <>{error} <button type="button" className="link-btn" onClick={onBack}>Back</button></> : 'Loading…'}</div>;
  const stage = pick ?? current, v: View = view ?? (pick ? 'steps' : homeView(current)), st = ep.stages[stage], cs = ep.stages[current];
  const off = busy || !!ep.running;
  const pct = ep.capUsd ? Math.min(100, (ep.spent / ep.capUsd) * 100) : 0;
  // The editor plays the cut itself: the video window would only be in its way.
  const inEditor = v === 'editor' && !!ep.studio, chatHere = chatOn && (!inEditor || edChat);
  const floats = [videoOn && hasVideo && videoMode === 'float' && !(v === 'editor' && ep.studio) ? rects.video : null, chatOn && chatMode === 'float' ? rects.session : null];
  const keepRight = Math.max(0, ...floats.map((r) => (r && !r.min && r.x > window.innerWidth * 0.6 && r.x + r.w > window.innerWidth - 60 ? window.innerWidth - r.x + 12 : 0)));
  const docked = (videoOn && hasVideo && videoMode === 'dock' && !(v === 'editor' && ep.studio)) || (chatOn && (edChat || !(v === 'editor' && ep.studio)) && chatMode === 'dock');
  const openNotes = (ep.comments ?? []).filter((c) => !c.done).length;
  const video = videoOn && hasVideo && !inEditor ? <VideoWin ep={ep} play={play} setPlay={setPlay} req={req} act={act} mode={videoMode} onMode={(m) => { setVideoMode(m); lsSet('workVideoMode', m); }} onClose={() => { setVideoOn(false); lsSet('workVideo', 'off'); }} onRect={onRect} /> : null;
  const chat = chatHere ? <AgentChat id={id} stage={current} mode={chatMode} onMode={(m) => { setChatMode(m); lsSet('workChatMode', m); }} onClose={() => { if (inEditor) { setEdChat(false); return; } setChatOn(false); lsSet('workChat', 'off'); }} onRect={onRect} /> : null;
  const board = { ep, play, seek, sel, setSel, act, busy: off };
  return (
    <div className="wk">
      <header className="wk__head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="All episodes" title="All episodes"><ArrowLeft size={16} /></button>
        <div className="wk__name"><b>{ep.title}</b><small>Episode {ep.num}</small></div>
        <nav className="wk__steps" aria-label="Stages">
          {STAGES.map((k, i) => { const s = ep.stages[k].status; return <button key={k} type="button" className={`is-${s}${k === current ? ' is-now' : ''}${v === 'steps' && k === stage ? ' is-open' : ''}`} title={`${i + 1}. ${STAGE_INFO[k].name}: ${WORD[s].toLowerCase()}`} aria-label={`${STAGE_INFO[k].name}: ${WORD[s]}`} onClick={() => { setPick(k); setView('steps'); }}><i>{s === 'running' ? <Loader2 size={11} className="spin" aria-hidden /> : s === 'done' ? <CheckIcon size={11} aria-hidden /> : s === 'needs_you' ? <Hand size={11} aria-hidden /> : s === 'failed' ? <AlertTriangle size={11} aria-hidden /> : null}</i>{k === current && <b>{STAGE_INFO[k].name}</b>}</button>; })}
        </nav>
        <span className="wk__sp" />
        <span className="smoney" title="Spent of what you approved"><span><b>{usd(ep.spent)}</b> {ep.capUsd ? `of ${usd(ep.capUsd)}` : 'spent'}</span>{ep.capUsd > 0 && <i><em style={{ width: `${pct}%` }} /></i>}</span>
        {ep.running && <button type="button" className="btn btn--secondary btn--sm" onClick={() => void act(() => socialApi.stop(id), false)}><Square size={12} aria-hidden /> Stop</button>}
        <span className="wk__menu">
          <button type="button" className="icon-btn" aria-label="More" aria-expanded={menu} title="More" onClick={() => { setMenu(!menu); setSure(false); }}><Ellipsis size={16} /></button>
          {menu && <div className="wk__pop" onMouseLeave={() => setMenu(false)}>
            <label className="sswitch"><input type="checkbox" checked={ep.auto} onChange={(e) => void act(() => socialApi.auto(id, e.target.checked), false)} /> Run by itself</label>
            <button type="button" onClick={() => void act(async () => { await socialApi.archive(id, !ep.archived); onBack(); }, false)}><Archive size={14} aria-hidden /> {ep.archived ? 'Bring it back' : 'Put away'}</button>
            <button type="button" onClick={() => { for (const k of ['video', 'session']) lsSet(`win-${k}`, ''); lsSet('workVideo', ''); lsSet('workChat', ''); setVideoOn(false); setChatOn(false); setVideoMode('float'); setChatMode('float'); lsSet('workVideoMode', ''); lsSet('workChatMode', ''); setMenu(false); setTimeout(() => { setVideoOn(true); setChatOn(true); }, 30); }}><PictureInPicture2 size={14} aria-hidden /> Windows back in place</button>
            <button type="button" className="is-danger" disabled={!!ep.running} onClick={() => (sure ? void act(async () => { await socialApi.remove(id, ep.num); onBack(); }, false) : setSure(true))}><Trash2 size={14} aria-hidden /> {sure ? 'Delete for good?' : 'Delete'}</button>
          </div>}
        </span>
      </header>
      {['needs_you', 'failed', 'running', 'stale', 'ready'].includes(cs.status) && !(v === 'steps' && stage === current) && (
        <div className={`wk__now is-${cs.status}`} style={keepRight && !docked ? { marginRight: keepRight + 6 } : undefined}>{cs.status === 'running' ? <Loader2 size={14} className="spin" aria-hidden /> : cs.status === 'failed' ? <AlertTriangle size={14} aria-hidden /> : <Hand size={14} aria-hidden />}<span><b>{STAGE_INFO[current].name}</b> {cs.status === 'running' ? cs.progress ?? 'is working' : cs.status === 'needs_you' ? 'is waiting for you' : cs.status === 'failed' ? `stopped: ${cs.error ?? ''}` : cs.status === 'stale' ? 'is out of date' : 'is ready to run'}</span>{cs.status !== 'running' && <button type="button" className="btn btn--primary btn--sm" onClick={() => { setPick(current); setView('steps'); }}>{cs.status === 'needs_you' ? 'Decide' : 'Open'}</button>}</div>
      )}
      <div className="wk__body">
        <nav className="wk__rail" aria-label="Sections">
          {VIEWS.map(([k, l, I]) => <button key={k} type="button" className={v === k ? 'is-on' : ''} aria-current={v === k ? 'page' : undefined} onClick={() => { setView(k); setPick(null); }}><I size={16} aria-hidden /> {l}{k === 'storyboard' && openNotes > 0 && <em>{openNotes}</em>}</button>)}
          <hr />
          {MORE.map(([k, l, I]) => <button key={k} type="button" className={v === k ? 'is-on' : ''} aria-current={v === k ? 'page' : undefined} onClick={() => { setView(k); if (k !== 'steps') setPick(null); }}><I size={16} aria-hidden /> {l}</button>)}
          <span className="wk__sp" />
          {hasVideo && !videoOn && !inEditor && <button type="button" onClick={() => { setVideoOn(true); lsSet('workVideo', ''); }}><Play size={15} aria-hidden /> Video</button>}
          {!chatHere && <button type="button" onClick={() => { setChatOn(true); setEdChat(true); lsSet('workChat', ''); }}><MessageSquare size={15} aria-hidden /> Session</button>}
        </nav>
        <main className="wk__main" style={keepRight && !docked && !inEditor ? { paddingRight: keepRight } : undefined}>
          {error && <div className="social__note is-bad" role="alert"><AlertTriangle size={15} aria-hidden /><span>{error}</span><button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
          {v === 'storyboard' ? <StoryboardBoard {...board} />
            : v === 'editor' ? (ep.studio ? <StudioEditor ep={ep} act={act} busy={off} reload={load} fallback={<EditorBoard {...board} more={<EditPanel ep={ep} slots={slots} busy={off} act={act} keys={keys} onKeys={onKeys} hookTypes={hookTypes} />} />} more={<EditPanel ep={ep} slots={slots} busy={off} act={act} keys={keys} onKeys={onKeys} hookTypes={hookTypes} />} /> : <EditorBoard {...board} more={<EditPanel ep={ep} slots={slots} busy={off} act={act} keys={keys} onKeys={onKeys} hookTypes={hookTypes} />} />)
            : v === 'script' ? <div className="wk__pad"><StagePanel stage="script" ep={ep} slots={slots} busy={off} act={act} keys={keys} onKeys={onKeys} hookTypes={hookTypes} />{!ep.script && <p className="social__fine">There is no script yet.</p>}</div>
            : v === 'history' ? <div className="wk__pad"><ol className="slog">{ep.events.map((e) => <li key={e.id} className={`is-${e.kind}`}><time>{when(e.at)}</time><span>{e.stage ? <b>{STAGE_INFO[e.stage as StageId]?.name ?? e.stage}: </b> : null}{e.text}</span></li>)}</ol></div>
            : v === 'spending' ? <div className="wk__pad"><Spend ep={ep} act={act} id={id} /></div>
            : (
              <section className="sstage wk__pad" aria-label={STAGE_INFO[stage].name}>
                <div className="sstage__head">
                  <div><h2>{STAGE_INFO[stage].name}</h2><p>{STAGE_INFO[stage].what}{STAGE_INFO[stage].gate ? ` · ${STAGE_INFO[stage].gate}` : ''}</p></div>
                  <div className="sstage__acts">
                    {st.status === 'done' && st.approval && <span className="spill is-done" title={st.approval}><CheckIcon size={11} aria-hidden /> {st.approval.slice(0, 60)}</span>}
                    {st.status === 'done' && stage !== 'screens' && stage !== 'render' && stage !== 'schedule' && <button type="button" className="btn btn--secondary btn--sm" disabled={off} onClick={() => void act(() => socialApi.reopen(id, stage), false).then(() => setPick(stage))}>Open again</button>}
                  </div>
                </div>
                {st.error && <div className="social__note is-bad"><AlertTriangle size={15} aria-hidden /><span>{st.error}</span>{/key/i.test(st.error) && /TopView|kie/i.test(st.error) && <button type="button" className="link-btn" onClick={onKeys}>Connections</button>}</div>}
                {st.status === 'running' && <div className="social__note is-run"><Loader2 size={15} className="spin" aria-hidden /><span>{st.progress ?? 'Working'}</span></div>}
                {st.status === 'stale' && <div className="social__note is-warn"><AlertTriangle size={15} aria-hidden /><span>Something before this changed. What you see is from before; run it again.</span></div>}
                {st.status === 'idle' && <div className="social__note"><span>{ep.blocked[stage] || 'Not yet.'}</span></div>}
                <StagePanel stage={stage} ep={ep} slots={slots} busy={off} act={act} keys={keys} onKeys={onKeys} hookTypes={hookTypes} />
                {['ready', 'failed', 'stale'].includes(st.status) && stage !== 'schedule' && stage !== 'render' && !ep.blocked[stage] && <div className="sgate"><div className="sgate__t"><span>{st.status === 'failed' ? `It stopped: ${st.error ?? 'no reason given'}` : st.status === 'stale' ? 'Something before this changed, so this is out of date.' : 'Ready to run.'}</span></div><button type="button" className="btn btn--primary" disabled={busy} onClick={() => void act(() => socialApi.run(id, stage))}>{st.status === 'failed' ? 'Continue' : st.status === 'stale' ? 'Run again' : 'Run'}</button></div>}
              </section>
            )}
        </main>
        {docked && <aside className="wk__dock">{videoMode === 'dock' && video}{chatMode === 'dock' && chat}</aside>}
      </div>
      {videoMode === 'float' && video}
      {chatMode === 'float' && chat}
      {fresh.map((f, n) => <FreshWin key={f.key} ep={ep} f={f} n={n} last={n === fresh.length - 1} act={act} onClose={() => seenFresh(f.key)} />)}
    </div>
  );
}

function Spend({ ep, id, act }: { ep: Episode; id: string; act: Act }): ReactNode {
  const [cap, setCap] = useState('');
  return (
    <div className="sspend">
      <table className="social__table"><thead><tr><th>What</th><th>Provider</th><th>Cost</th></tr></thead><tbody>{ep.ledger.map((l, i) => <tr key={i} className={l.state === 'failed' ? 'is-off' : ''}><td>{l.what}<small>{l.model}</small></td><td>{l.provider}</td><td>{l.state === 'completed' ? usd(l.usd) : l.state === 'failed' ? 'failed, $0' : `about ${usd(l.estimate ?? 0)}`}</td></tr>)}{!ep.ledger.length && <tr><td colSpan={3}>Nothing spent yet.</td></tr>}</tbody></table>
      {ep.capUsd > 0 && <form className="sspend__cap" onSubmit={(e) => { e.preventDefault(); const n = Number(cap); if (n > 0) void act(() => socialApi.cap(id, n), false).then(() => setCap('')); }}><label>Limit for this episode<input className="text-input" inputMode="decimal" value={cap} placeholder={ep.capUsd.toFixed(2)} onChange={(e) => setCap(e.target.value)} /></label><button type="submit" className="btn btn--secondary btn--sm" disabled={!(Number(cap) > 0)}>Change</button></form>}
    </div>
  );
}
