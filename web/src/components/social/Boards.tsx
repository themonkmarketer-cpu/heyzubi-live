import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check as CheckIcon, Copy, EyeOff, MapPin, Pencil, Play, RefreshCw, Send, Sun, X } from 'lucide-react';
import { seriesFileUrl, epFileUrl, say, socialApi, voiceDrift, stillUrl, type Comment, type Episode, type Shot } from '../../lib/socialApi';
import { lsGet, lsSet } from '../../lib/storage';
import { Retake } from './StagePanels';
import type { Act } from './Workspace';

/** The storyboard (every shot with its still, notes and pins) and the editor (the cut on a timeline). */
export interface PlayAt { src: 'p1' | 'p2' | 'cut'; t: number }
export interface Block { part: number; n: number; i: number; x: Shot; s: number; e: number; a: number; b: number; at: number; len: number; dropped: boolean }
interface Draft { trims: NonNullable<Episode['edit']['options']['trims']>; drop: { part: number; shot: number }[]; brighten: { part: number; shot: number }[] }
export const shotLabel = (part: number, n: number) => `Part ${part} shot ${n}`;
const two = (n: number) => String(n).padStart(2, '0');
const sayTo = say;
const activeRetake = (ep: Episode, part: number, n: number) => ep.render.parts[part - 1].versions.filter((q) => q.kind === 'shot' && q.shot === n && q.state === 'completed' && q.file && !(q.note ?? '').startsWith('[off]')).pop();
const stillOf = (ep: Episode, part: number, n: number) => (ep.render.parts[part - 1].picked !== null ? stillUrl(ep.id, part, n, `${ep.render.parts[part - 1].picked}-${activeRetake(ep, part, n)?.v ?? 0}-${ep.review[part - 1]?.frames ?? 0}`) : null);

/** Every shot on one line of time: as planned and rendered ("board"), or as it is cut ("cut"). */
export function blocksOf(ep: Episode, mode: 'board' | 'cut', d?: Draft): Block[] {
  const o = ep.edit.options, trims = d?.trims ?? o.trims ?? [], drop = d?.drop ?? o.dropShots;
  const out: Block[] = [];
  let at = 0;
  (ep.script?.parts ?? []).forEach((p, k) => {
    const part = k + 1, rv = ep.review[k], starts = rv ? rv.shotStarts.map((f) => f / rv.fps) : p.shots.map((x) => x.start), end = rv ? rv.frames / rv.fps : p.shots[p.shots.length - 1]?.end ?? 30;
    p.shots.forEach((x, i) => {
      const s = starts[i] ?? x.start, e = starts[i + 1] ?? end;
      let a = s, b = e, dropped = false;
      const c = mode === 'cut' && !d ? ep.studio?.clips : undefined;
      if (c) { const q = c.find((z) => z.part === part && z.shot === x.n); out.push({ part, n: x.n, i, x, s, e, a, b, at: q?.start ?? 0, len: q?.dur ?? 0, dropped: !q }); return; }
      if (mode === 'cut') {
        if (part === 1) a = Math.max(a, o.trimStart); else b = Math.min(b, end - o.trimEnd);
        const t = trims.find((q) => q.part === part && q.shot === x.n);
        a += Math.min(t?.in ?? 0, Math.max(0, b - a - 0.3)); b = Math.max(a + Math.min(0.3, b - a), b - (t?.out ?? 0));
        dropped = drop.some((q) => q.part === part && q.shot === x.n) || b - a < 0.04;
      }
      const len = dropped ? 0 : b - a;
      out.push({ part, n: x.n, i, x, s, e, a, b, at, len, dropped });
      at += len;
    });
  });
  return out;
}
interface BoardProps { ep: Episode; play: PlayAt; seek: (src: PlayAt['src'], t: number, play?: boolean) => void; sel: { part: number; shot: number } | null; setSel: (s: { part: number; shot: number } | null) => void; act: Act; busy: boolean }
const nameOf = (ep: Episode, key?: string) => (key ? ep.cast.find((c) => c.key === key.toLowerCase())?.name ?? key : '');
const flagsOf = (ep: Episode, part: number, n: number): string[] => {
  const rv = ep.review[part - 1], l = rv?.lines.find((q) => q.shot === n), re = activeRetake(ep, part, n);
  if (!rv || re) return [];
  const sh = ep.script?.parts[part - 1].shots.find((q) => q.n === n), off = voiceDrift(l, sh);
  return [...(l && l.lips === false && !sh?.offscreen ? ['Mouth doesn’t move'] : []), ...(off !== null ? [`Voice ${off > 0 ? 'higher' : 'lower'} than ${nameOf(ep, l!.speaker)}’s sample (${off > 0 ? '+' : ''}${off}%)`] : []), ...(l && l.score < 0.7 ? [`Heard: “${l.heard || 'nothing'}”`] : []), ...rv.notes.filter((x) => new RegExp(`^Shot ${n}:`).test(x) && !/mouth doesn’t move/.test(x)).map((x) => x.replace(/^Shot \d+:\s*/, ''))];
};
const groupNow = (list: Block[], ep: Episode, play: PlayAt, mode: 'board' | 'cut'): number | null => {
  if (mode === 'cut') { if (play.src === 'cut') return play.t; const b = list.find((q) => !q.dropped && q.part === (play.src === 'p2' ? 2 : 1) && play.t >= q.a && play.t < q.b); return b ? b.at + play.t - b.a : null; }
  if (play.src === 'cut') { const c = blocksOf(ep, 'cut').find((q) => !q.dropped && play.t >= q.at && play.t < q.at + q.len), b = c && list.find((q) => q.part === c.part && q.n === c.n); return b && c ? b.at + (play.t - c.at + c.a - b.s) : null; }
  const b = list.find((q) => q.part === (play.src === 'p2' ? 2 : 1) && play.t >= q.s && play.t < q.e);
  return b ? b.at + play.t - b.s : null;
};

// ---------- the timeline ----------
function Timeline({ ep, play, seek, sel, setSel, act, mode, list, draft, setDraft }: BoardProps & { mode: 'board' | 'cut'; list: Block[]; draft?: Draft; setDraft?: (d: Draft) => void }) {
  const row = useRef<HTMLDivElement>(null);
  const T = Math.max(1, ...list.map((b) => b.at + b.len)), pc = (t: number) => `${(t / T) * 100}%`, now = groupNow(list, ep, play, mode);
  const [drag, setDrag] = useState<{ key: string; t: number } | null>(null);
  const go = (b: Block, t: number) => { setSel({ part: b.part, shot: b.n }); if (mode === 'cut' && ep.edit.final && play.src === 'cut') seek('cut', t); else seek(b.part === 2 ? 'p2' : 'p1', (mode === 'cut' ? b.a : b.s) + (t - b.at)); };
  const at = (e: React.MouseEvent | React.PointerEvent | PointerEvent) => { const r = row.current!.getBoundingClientRect(); return Math.min(T, Math.max(0, ((e.clientX - r.left) / r.width) * T)); };
  const jump = (e: React.MouseEvent) => { const t = at(e), b = list.find((q) => !q.dropped && t >= q.at && t < q.at + q.len); if (b) go(b, t); };
  const edge = (b: Block, side: 'in' | 'out') => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget as HTMLElement, x0 = e.clientX, w = row.current!.getBoundingClientRect().width, t0 = draft?.trims.find((q) => q.part === b.part && q.shot === b.n) ?? { part: b.part, shot: b.n, in: 0, out: 0 }, T0 = T;
    el.setPointerCapture(e.pointerId);
    let last = { ...t0 };
    const mv = (m: PointerEvent) => {
      const ds = ((m.clientX - x0) / w) * T0;
      if (mode === 'cut') { const room = b.e - b.s - 0.3; last = side === 'in' ? { ...t0, in: Math.max(0, Math.min(room - t0.out, Math.round((t0.in + ds) * 24) / 24)) } : { ...t0, out: Math.max(0, Math.min(room - t0.in, Math.round((t0.out - ds) * 24) / 24)) }; setDraft?.({ ...draft!, trims: [...draft!.trims.filter((q) => !(q.part === b.part && q.shot === b.n)), last] }); }
      else setDrag({ key: `${b.part}-${b.n}`, t: Math.round((b.at + b.len + ds) * 2) / 2 });
    };
    const up = (m: PointerEvent) => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); if (mode === 'board') { const ds = ((m.clientX - x0) / w) * T0; setDrag(null); if (Math.abs(ds) > 0.2) void act(() => socialApi.shotTime(ep.id, b.part, b.n, b.e + ds), false); } };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  };
  const toGlobal = (part: number, t: number): number | null => { const b = list.find((q) => q.part === part && !q.dropped && t >= q.a - 0.01 && t < q.b); return b ? b.at + Math.max(0, t - b.a) : null; };
  const tick = T > 40 ? 5 : 2, notes = (ep.comments ?? []).filter((c) => !c.done && c.shot);
  return (
    <div className="tl" aria-label="Timeline">
      <div className="tl__labels" aria-hidden><span /><span>SHOT</span>{mode === 'cut' && <><span>SCREEN</span><span>LINES</span><span>CLOCK</span></>}<span>PINS</span></div>
      <div className="tl__rows">
        <div ref={row} className="tl__ruler" onClick={jump}>{Array.from({ length: Math.floor(T / tick) + 1 }, (_, k) => <i key={k} style={{ left: pc(k * tick) }}>{k * tick}s</i>)}</div>
        <div className="tl__row is-shots">
          {list.filter((b) => !b.dropped).map((b) => {
            const on = sel?.part === b.part && sel.shot === b.n, f = flagsOf(ep, b.part, b.n).length > 0, edges = mode === 'cut' ? !!setDraft && !!ep.review[b.part - 1] : ep.render.parts[b.part - 1].picked === null && b.i < (ep.script!.parts[b.part - 1].shots.length - 1), tr = draft?.trims.find((q) => q.part === b.part && q.shot === b.n);
            return (
              <div key={`${b.part}-${b.n}`} className={`tl__shot is-p${b.part}${on ? ' is-on' : ''}${f ? ' is-flag' : ''}${draft?.brighten.some((q) => q.part === b.part && q.shot === b.n) ? ' is-lit' : ''}`} style={{ left: pc(b.at), width: pc(b.len) }}>
                <button type="button" title={`${shotLabel(b.part, b.n)} · ${b.len.toFixed(1)} s${b.x.line ? ` · ${nameOf(ep, b.x.speaker)}: ${b.x.line}` : ''}`} onClick={(e) => go(b, at(e))}><b>{two(b.n)}</b> <span>{b.x.line ? nameOf(ep, b.x.speaker) : b.x.screen ? 'Screen' : 'Silent'}</span></button>
                {edges && mode === 'cut' && <i className={`tl__edge is-in${tr?.in ? ' is-cut' : ''}`} title="Drag to trim the start" onPointerDown={edge(b, 'in')} />}
                {edges && <i className={`tl__edge is-out${tr?.out ? ' is-cut' : ''}`} title={mode === 'cut' ? 'Drag to trim the end' : 'Drag to move this cut'} onPointerDown={edge(b, 'out')} />}
              </div>
            );
          })}
          {drag && <i className="tl__ghost" style={{ left: pc(drag.t) }}><em>{drag.t.toFixed(1)} s</em></i>}
        </div>
        {mode === 'cut' && <>
          <div className="tl__row">{list.filter((b) => !b.dropped && b.x.screen).map((b) => <button key={`s${b.part}-${b.n}`} type="button" className={`tl__chip${ep.edit.options.screens[b.x.screen!]?.on === false ? ' is-off' : ''}`} style={{ left: pc(b.at), width: pc(b.len) }} title={ep.screens.find((q) => q.id === b.x.screen)?.title} onClick={() => go(b, b.at)}>{b.x.screen!.toUpperCase()}</button>)}</div>
          <div className="tl__row">{[1, 2].flatMap((p) => (ep.review[p - 1]?.lines ?? []).filter((l) => l.score > 0).map((l, k) => { const a = toGlobal(p, l.start); if (a === null) return null; const bad = l.score < 0.7 || l.lips === false; return <i key={`${p}-${k}`} className={`tl__line${bad && !activeRetake(ep, p, l.shot) ? ' is-bad' : ''}`} style={{ left: pc(a), width: pc(Math.min(l.end - l.start, T - a)) }} title={`${nameOf(ep, l.speaker)}: ${l.text}`} />; }))}</div>
          <div className="tl__row">{list.filter((b) => !b.dropped && b.x.clock).map((b) => <i key={`c${b.part}-${b.n}`} className="tl__clock" style={{ left: pc(b.at) }} title={`Clock ${b.x.clock}`}>{b.x.clock}</i>)}</div>
        </>}
        <div className="tl__row">{notes.map((c, k) => { const b = list.find((q) => q.part === c.part && q.n === c.shot && !q.dropped); return b ? <button key={c.id} type="button" className="tl__pin" style={{ left: pc(b.at + b.len / 2) }} title={c.text} onClick={() => go(b, b.at)}>{k + 1}</button> : null; })}</div>
        {now !== null && <div className="tl__head" style={{ left: pc(now) }} aria-hidden />}
      </div>
    </div>
  );
}

// ---------- the storyboard ----------
type Size = 'fit' | 'medium' | 'large';
export function StoryboardBoard(p: BoardProps) {
  const { ep, busy, sel } = p;
  const [size, setSize] = useState<Size>(() => (['fit', 'medium', 'large'].includes(lsGet('sbSize') ?? '') ? (lsGet('sbSize') as Size) : 'medium'));
  const [part, setPart] = useState(0);
  const [only, setOnly] = useState(false);
  const [notes, setNotes] = useState(() => lsGet('sbNotes') !== 'off');
  const [pin, setPin] = useState<{ part: number; shot: number; x: number; y: number } | null>(null);
  const list = useMemo(() => blocksOf(ep, 'board'), [ep]);
  const mine = useRef<HTMLDivElement>(null);
  useEffect(() => { if (sel) mine.current?.querySelector(`[data-shot="${sel.part}-${sel.shot}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [sel]);
  if (!ep.script) return <p className="social__fine wk__pad">The storyboard appears once there is a script.</p>;
  const open = (ep.comments ?? []).filter((c) => !c.done), flagged = list.filter((b) => flagsOf(ep, b.part, b.n).length || open.some((c) => c.part === b.part && c.shot === b.n));
  const shown = (only ? flagged : list).filter((b) => !part || b.part === part), T = list.reduce((a, b) => a + b.len, 0);
  return (
    <div className="sb">
      <div className="sb__bar">
        <div className="seg" role="group" aria-label="Part">{[[0, 'All'], [1, 'Part 1'], [2, 'Part 2']].map(([k, l]) => <button key={k} type="button" aria-pressed={part === k} onClick={() => setPart(Number(k))}>{l}</button>)}</div>
        <div className="seg" role="group" aria-label="Size">{([['fit', 'Fit all'], ['medium', 'Medium'], ['large', 'Large']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={size === k} onClick={() => { setSize(k); lsSet('sbSize', k); }}>{l}</button>)}</div>
        <button type="button" className="btn btn--secondary btn--sm" aria-pressed={only} disabled={!flagged.length && !only} onClick={() => setOnly(!only)}><AlertTriangle size={13} aria-hidden /> Worth a look ({flagged.length})</button>
        <span className="wk__sp" />
        <small>{list.length} shots · {T.toFixed(1)} s</small>
        <button type="button" className="btn btn--secondary btn--sm" aria-pressed={notes} onClick={() => { setNotes(!notes); lsSet('sbNotes', notes ? 'off' : ''); }}>Comments{open.length ? ` (${open.length})` : ''}</button>
      </div>
      <div className="sb__mid">
        <div ref={mine} className={`sb__grid is-${size}`}>
          {shown.map((b) => <Card key={`${b.part}-${b.n}`} {...p} b={b} size={size} open={open.filter((c) => c.part === b.part && c.shot === b.n)} all={open} pin={pin?.part === b.part && pin.shot === b.n ? pin : null} setPin={setPin} />)}
          {!shown.length && <p className="social__fine">Nothing to look at here.</p>}
        </div>
        {notes && <Comments {...p} list={list} />}
      </div>
      <Timeline {...p} mode="board" list={list} />
      {ep.render.parts.some((q) => q.picked === null) && !busy && <small className="tl__hint">Drag the edge between two shots to set their times, until that part is rendered.</small>}
    </div>
  );
}
function Card({ ep, b, size, open, all, pin, setPin, play, seek, sel, setSel, act, busy }: BoardProps & { b: Block; size: Size; open: Comment[]; all: Comment[]; pin: { part: number; shot: number; x: number; y: number } | null; setPin: (p: { part: number; shot: number; x: number; y: number } | null) => void }) {
  const [edit, setEdit] = useState(false), [take, setTake] = useState(false), [note, setNote] = useState('');
  const [f, setF] = useState<Record<string, string>>({});
  const x = b.x, img = stillOf(ep, b.part, b.n), on = sel?.part === b.part && sel.shot === b.n, flags = flagsOf(ep, b.part, b.n), re = activeRetake(ep, b.part, b.n), who = ep.cast.find((c) => c.key === (x.speaker ?? '').toLowerCase());
  const face = who?.image ? (who.kind === 'series' ? seriesFileUrl(who.image) : epFileUrl(ep.id, who.image)) : null;
  const val = (k: 'picture' | 'camera' | 'line' | 'delivery') => f[k] ?? x[k] ?? '';
  const live = play.src !== 'cut' && (play.src === 'p2' ? 2 : 1) === b.part && play.t >= b.s && play.t < b.e;
  const save = () => void act(async () => socialApi.shot(ep.id, b.part, b.n, f), false).then(() => { setEdit(false); setF({}); });
  const addPin = () => { if (!note.trim() || !pin) return; void act(() => socialApi.comment(ep.id, { text: note.trim(), part: b.part, shot: b.n, x: pin.x, y: pin.y }), false).then(() => { setPin(null); setNote(''); }); };
  return (
    <article className={`sbc${on ? ' is-on' : ''}${live ? ' is-live' : ''}${flags.length ? ' is-flag' : ''}`} data-shot={`${b.part}-${b.n}`} onClick={() => setSel({ part: b.part, shot: b.n })}>
      <header><b>{two(b.n)}</b><span>{x.line ? who?.name ?? x.speaker : x.screen ? 'Screen insert' : 'Silent'}</span><small>P{b.part} · {b.s.toFixed(1)}–{b.e.toFixed(1)} s</small></header>
      <div className="sbc__in">
        <div className="sbc__pic" title={img ? 'Click a spot to pin a comment there' : undefined} onClick={(e) => { if (!img) return; const r = e.currentTarget.getBoundingClientRect(); setPin({ part: b.part, shot: b.n, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }); setNote(''); }}>
          {img ? <img src={img} alt={`${shotLabel(b.part, b.n)}`} loading="lazy" draggable={false} /> : <span className="sbc__no">{face ? <img src={face} alt="" loading="lazy" /> : null}<em>Not rendered</em></span>}
          {open.filter((c) => c.x !== undefined).map((c) => <i key={c.id} className="sbc__pin" style={{ left: `${c.x! * 100}%`, top: `${(c.y ?? 0.5) * 100}%` }} title={c.text}>{all.indexOf(c) + 1}</i>)}
          {pin && <i className="sbc__pin is-new" style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}><MapPin size={11} /></i>}
          {img && <button type="button" className="sbc__play" aria-label={`Play ${shotLabel(b.part, b.n)}`} title="Play" onClick={(e) => { e.stopPropagation(); setSel({ part: b.part, shot: b.n }); seek(b.part === 2 ? 'p2' : 'p1', b.s + 0.02, true); }}><Play size={14} /></button>}
          {re && <em className="sbc__re">Retaken</em>}
        </div>
        <div className="sbc__txt">
          {edit ? (
            <form onSubmit={(e) => { e.preventDefault(); save(); }} onClick={(e) => e.stopPropagation()}>
              {([['picture', 'See', 3], ['camera', 'Moves', 2], ...(x.line !== undefined ? [['line', 'Line', 2] as const, ['delivery', 'How', 1] as const] : [])] as const).map(([k, l, n]) => <label key={k}><b>{l}</b><textarea className="text-input" rows={n} value={val(k)} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>)}
              <div><button type="button" className="btn btn--secondary btn--sm" onClick={() => { setEdit(false); setF({}); }}>Cancel</button><button type="submit" className="btn btn--primary btn--sm" disabled={busy || !Object.keys(f).length}>Save</button></div>
            </form>
          ) : (
            <>
              {size !== 'fit' && <p><b>See</b> {x.picture}</p>}
              {size !== 'fit' && <p><b>Moves</b> {x.camera}</p>}
              <p><b>{x.line ? who?.name ?? x.speaker : 'Sound'}</b> {x.line ? `“${x.line}”` : x.sound || 'No line'}</p>
              {size === 'large' && <p><b>Timing</b> planned {x.start}–{x.end} s{ep.review[b.part - 1] ? `, rendered ${b.s.toFixed(1)}–${b.e.toFixed(1)} s` : ''}{x.delivery ? ` · ${x.delivery}` : ''}</p>}
              {(x.screen || x.clock) && <p className="sbc__tags">{x.screen && <em>Screen {x.screen.slice(1)}</em>}{x.clock && <em>Clock {x.clock}</em>}</p>}
              {flags.slice(0, size === 'fit' ? 1 : 4).map((t, k) => <p key={k} className="sbc__flag"><AlertTriangle size={12} aria-hidden /> {t}</p>)}
              <div className="sbc__acts" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="sicon" title="Change this shot’s plan" aria-label={`Change ${shotLabel(b.part, b.n)}`} disabled={busy} onClick={() => setEdit(true)}><Pencil size={13} /></button>
                {img && <button type="button" className="sicon" title="Retake this shot" aria-label={`Retake ${shotLabel(b.part, b.n)}`} disabled={busy} onClick={() => setTake(!take)}><RefreshCw size={13} /></button>}
                {flags.length > 0 && <button type="button" className="btn btn--secondary btn--sm" onClick={() => sayTo(ep.id, `${shotLabel(b.part, b.n)}: ${flags.join(' ')} Fix it.`)}><Send size={12} aria-hidden /> Fix it</button>}
              </div>
              {take && <div onClick={(e) => e.stopPropagation()}><Retake ep={ep} part={b.part} busy={busy} act={act} only={b.n} /></div>}
            </>
          )}
          {pin && <form className="sbc__note" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); addPin(); }}><textarea className="text-input" rows={2} autoFocus value={note} placeholder="What about this spot?" aria-label="Pinned comment" onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setPin(null); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addPin(); } }} /><div><button type="button" className="btn btn--secondary btn--sm" onClick={() => setPin(null)}>Cancel</button><button type="submit" className="btn btn--primary btn--sm" disabled={!note.trim()}>Pin it</button></div></form>}
        </div>
      </div>
    </article>
  );
}

function Comments({ ep, act, seek, setSel, list }: BoardProps & { list: Block[] }) {
  const [t, setT] = useState(''), [ok, setOk] = useState(false), [done, setDone] = useState(false);
  const all = ep.comments ?? [], open = all.filter((c) => !c.done), whole = open.filter((c) => !c.shot), shots = open.filter((c) => c.shot), past = all.filter((c) => c.done);
  const line = (c: Comment) => `${c.shot ? shotLabel(c.part!, c.shot) : 'Whole video'}: ${c.text}`;
  const add = () => { if (t.trim()) void act(() => socialApi.comment(ep.id, { text: t.trim() }), false).then(() => setT('')); };
  const row = (c: Comment) => {
    const b = c.shot ? list.find((q) => q.part === c.part && q.n === c.shot) : null;
    return (
      <li key={c.id} className={c.done ? 'is-done' : ''}>
        <header>{!c.done && <b>{open.indexOf(c) + 1}</b>}<button type="button" disabled={!b} onClick={() => { if (b) { setSel({ part: b.part, shot: b.n }); if (ep.render.parts[b.part - 1].picked !== null) seek(b.part === 2 ? 'p2' : 'p1', c.t ?? b.s + 0.02); } }}>{c.shot ? `P${c.part} · ${two(c.shot)}` : 'Whole video'}</button><span /><button type="button" className="sicon" title={c.done ? 'Open it again' : 'Dealt with'} aria-label={c.done ? 'Open this comment again' : 'Tick this comment off'} onClick={() => void act(() => socialApi.setComment(ep.id, c.id, { done: !c.done }), false)}><CheckIcon size={13} /></button><button type="button" className="sicon" title="Delete" aria-label="Delete this comment" onClick={() => void act(() => socialApi.dropComment(ep.id, c.id), false)}><X size={13} /></button></header>
        <p>{c.text}</p>
        {!c.done && <button type="button" className="link-btn" onClick={() => sayTo(ep.id, `${line(c)} (comment ${c.id}; tick it off once it is dealt with)`)}>Fix it</button>}
      </li>
    );
  };
  return (
    <aside className="sbn" aria-label="Comments">
      <h3>Overall <small>{whole.length} open</small></h3>
      <textarea className="text-input" rows={2} value={t} placeholder="A note on the whole video: the story, the feel, the length." aria-label="Comment on the whole video" onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } }} />
      <div className="sbn__row"><small>Enter adds it</small><button type="button" className="btn btn--secondary btn--sm" disabled={!t.trim()} onClick={add}>Add note</button></div>
      <ul>{whole.map(row)}</ul>
      <h3>Shots <small>{shots.length} open</small></h3>
      {!shots.length && <p className="social__fine">Click a spot on any still to pin a comment there.</p>}
      <ul>{shots.map(row)}</ul>
      {open.length > 0 && <div className="sbn__row"><button type="button" className="btn btn--primary btn--sm" onClick={() => sayTo(ep.id, `Deal with my open comments:\n${open.map((c) => `- ${line(c)} (comment ${c.id})`).join('\n')}\nTick each one off once it is dealt with.`)}><Send size={12} aria-hidden /> Fix all {open.length}</button><button type="button" className="btn btn--secondary btn--sm" onClick={() => void navigator.clipboard.writeText(open.map(line).join('\n')).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); })}>{ok ? <CheckIcon size={12} aria-hidden /> : <Copy size={12} aria-hidden />} Copy</button></div>}
      {past.length > 0 && <button type="button" className="link-btn" aria-expanded={done} onClick={() => setDone(!done)}>{done ? 'Hide' : 'Show'} {past.length} dealt with</button>}
      {done && <ul>{past.map(row)}</ul>}
    </aside>
  );
}

// ---------- the editor ----------
export function EditorBoard(p: BoardProps & { more: ReactNode }) {
  const { ep, sel, setSel, act, busy, seek, more } = p;
  const o = ep.edit.options;
  const saved = useMemo<Draft>(() => ({ trims: o.trims ?? [], drop: o.dropShots, brighten: o.brighten ?? [] }), [o]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rest, setRest] = useState(false);
  const d = draft ?? saved, changed = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => { setDraft(null); }, [ep.edit.version]);
  const list = useMemo(() => blocksOf(ep, 'cut', d), [ep, d]);
  const st = ep.stages.edit, can = ep.review.every(Boolean) && ep.render.parts.every((q) => q.picked !== null);
  if (!ep.script || !can) return <div className="wk__pad"><div className="social__empty"><b>The editor opens once both parts are rendered and reviewed</b><span>{ep.render.parts.some((q) => q.picked === null) ? 'A part is still missing.' : 'The review hasn’t run yet.'}</span></div></div>;
  const T = list.reduce((a, b) => a + b.len, 0), b = sel ? list.find((q) => q.part === sel.part && q.n === sel.shot) : null, gone = list.filter((q) => q.dropped);
  const has = (l: { part: number; shot: number }[]) => !!b && l.some((q) => q.part === b.part && q.shot === b.n);
  const flip = (k: 'drop' | 'brighten', x: Block) => setDraft({ ...d, [k]: d[k].some((q) => q.part === x.part && q.shot === x.n) ? d[k].filter((q) => !(q.part === x.part && q.shot === x.n)) : [...d[k], { part: x.part, shot: x.n }] });
  const t = b ? d.trims.find((q) => q.part === b.part && q.shot === b.n) ?? { part: b.part, shot: b.n, in: 0, out: 0 } : null;
  const setTrim = (k: 'in' | 'out', v: number) => { if (!b || !t) return; const room = b.e - b.s - 0.3; setDraft({ ...d, trims: [...d.trims.filter((q) => !(q.part === b.part && q.shot === b.n)), { ...t, [k]: Math.max(0, Math.min(room - t[k === 'in' ? 'out' : 'in'], v || 0)) }] }); };
  const make = () => void act(async () => { await socialApi.edit(ep.id, { trims: d.trims, dropShots: d.drop, brighten: d.brighten }); return socialApi.run(ep.id, 'edit'); }, false);
  const ready = ['needs_you', 'ready', 'failed', 'stale'].includes(st.status), wait = ep.blocked.edit;
  const img = b && stillOf(ep, b.part, b.n);
  return (
    <div className="edb">
      <div className="sb__bar">
        <b>{T.toFixed(1)} s</b><small>{list.length - gone.length} shots{ep.edit.version ? ` · cut v${ep.edit.version}` : ''}{ep.edit.lufs ? ` · ${ep.edit.lufs} LUFS` : ''}</small>
        <span className="wk__sp" />
        {changed && <button type="button" className="btn btn--secondary btn--sm" onClick={() => setDraft(null)}>Undo changes</button>}
        <button type="button" className={`btn btn--sm ${changed || !ep.edit.final ? 'btn--primary' : 'btn--secondary'}`} disabled={busy || !ready || !!wait} title={wait ? wait : ready ? undefined : st.status === 'done' ? 'The cut is approved. Open the Edit step again to change it.' : 'Approve the review first.'} onClick={make}><RefreshCw size={13} aria-hidden /> {ep.edit.final ? 'Make the cut again' : 'Make the cut'}</button>
      </div>
      <Timeline {...p} mode="cut" list={list} draft={d} setDraft={ready ? setDraft : undefined} />
      <small className="tl__hint">{wait && ready ? `${wait} You can already plan the trims here.` : ready ? 'Drag a shot’s edges to trim it. Click a shot to change it below. Nothing happens until you make the cut.' : st.status === 'done' ? 'This cut is approved. Open the Edit step again to change it.' : 'The cut can be changed once the review is approved.'}</small>
      {gone.length > 0 && <p className="edb__gone">Left out: {gone.map((x) => <button key={`${x.part}-${x.n}`} type="button" className="btn btn--secondary btn--sm" disabled={!ready || busy} onClick={() => flip('drop', x)}>P{x.part} · {two(x.n)} put back</button>)}</p>}
      {b && t ? (
        <section className="edb__one" aria-label={shotLabel(b.part, b.n)}>
          {img && <button type="button" className="edb__pic" title="Play this shot" onClick={() => seek(b.part === 2 ? 'p2' : 'p1', b.s + 0.02, true)}><img src={img} alt={shotLabel(b.part, b.n)} /></button>}
          <div className="edb__txt">
            <h3>{shotLabel(b.part, b.n)} <small>{b.dropped ? 'left out' : `${b.len.toFixed(2)} s in the cut, ${(b.e - b.s).toFixed(2)} s rendered`}</small></h3>
            <p>{b.x.line ? <><b>{nameOf(ep, b.x.speaker)}</b> “{b.x.line}”</> : b.x.picture}</p>
            <div className="edb__ctl">
              <label>Trim start<input className="text-input" type="number" min={0} step={0.05} value={Number(t.in.toFixed(2))} disabled={!ready} onChange={(e) => setTrim('in', Number(e.target.value))} /></label>
              <label>Trim end<input className="text-input" type="number" min={0} step={0.05} value={Number(t.out.toFixed(2))} disabled={!ready} onChange={(e) => setTrim('out', Number(e.target.value))} /></label>
              <button type="button" className="btn btn--secondary btn--sm" aria-pressed={has(d.brighten)} disabled={!ready} onClick={() => flip('brighten', b)}><Sun size={13} aria-hidden /> {has(d.brighten) ? 'Brightened' : 'Brighten'}</button>
              <button type="button" className="btn btn--secondary btn--sm" aria-pressed={has(d.drop)} disabled={!ready} onClick={() => flip('drop', b)}>{has(d.drop) ? <><RefreshCw size={13} aria-hidden /> Put back</> : <><EyeOff size={13} aria-hidden /> Leave out</>}</button>
              <button type="button" className="sicon" title="Close" aria-label="Close this shot" onClick={() => setSel(null)}><X size={14} /></button>
            </div>
            {flagsOf(ep, b.part, b.n).map((x, k) => <p key={k} className="sbc__flag"><AlertTriangle size={12} aria-hidden /> {x}</p>)}
            <Retake ep={ep} part={b.part} busy={busy} act={act} only={b.n} />
          </div>
        </section>
      ) : <p className="social__fine">Click a shot on the timeline.</p>}
      <button type="button" className="link-btn edb__more" aria-expanded={rest} onClick={() => setRest(!rest)}>{rest ? 'Hide' : 'Sound, captions, screens and approval'}</button>
      {rest && <div className="edb__rest">{more}</div>}
    </div>
  );
}
