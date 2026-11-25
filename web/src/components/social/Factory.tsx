import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Archive, ArrowLeft, CalendarClock, Check as CheckIcon, Clapperboard, Copy, Download, Ellipsis, Film, ImageIcon, LayoutTemplate, Lightbulb, Loader2, MonitorSmartphone, PanelRightClose, PanelRightOpen, PenLine, RefreshCw, Trash2, Users, Volume2, X } from 'lucide-react';
import { epFileUrl, saidDone, seriesFileUrl, socialApi, usd, voiceDrift, waitingSaid, type ChatState, type Check, type Episode, type Shot, type Slot, type StageId, type Version } from '../../lib/socialApi';
import { lsGet, lsSet } from '../../lib/storage';
import { useStore } from '../../store';
import { Composer } from '../Composer';
import { genUrl } from '../GenerationsView';
import { VoiceCallBar } from '../VoiceCallBar';
import { Markdown } from '../Markdown';
import '../../styles/factory.css';

/**
 * Reels Factory: one episode. A progress line that always stays, one tab per step, and the Zubi window, which is the only
 * place anything is told, asked or approved. The tabs show; they never decide.
 */
type TabId = 'story' | 'script' | 'cast' | 'screens' | 'storyboard' | 'render' | 'cover' | 'schedule';
const TABS: { id: TabId; name: string; icon: typeof Film; stages: StageId[]; next: string; what: string }[] = [
  { id: 'story', name: 'Story', icon: Lightbulb, stages: ['story'], next: 'Build script', what: 'Four stories with their hooks. You pick one, or tell your own.' },
  { id: 'script', name: 'Script', icon: PenLine, stages: ['script'], next: 'Build cast', what: 'Every line and shot, and the keywords the rest of the flow is built on.' },
  { id: 'cast', name: 'Cast', icon: Users, stages: ['cast'], next: 'Draw screens', what: 'Who plays, how they look and how they sound.' },
  { id: 'screens', name: 'Screens', icon: MonitorSmartphone, stages: ['screens'], next: 'Build storyboard', what: 'What the phones and laptops show. Drawn before rendering, because video models can’t write text; they are laid onto the devices in the cut.' },
  { id: 'storyboard', name: 'Storyboard', icon: LayoutTemplate, stages: ['storyboard'], next: 'Render', what: 'The 24 shots as they will be sent to the video model, and the price. The last look before money is spent.' },
  { id: 'render', name: 'Render', icon: Film, stages: ['render', 'review', 'edit'], next: 'Pick the cover', what: 'Both parts, every edit, and the final cut.' },
  { id: 'cover', name: 'Cover', icon: ImageIcon, stages: ['cover', 'package'], next: 'Schedule', what: 'The cover frame and the captions.' },
  { id: 'schedule', name: 'Schedule', icon: CalendarClock, stages: ['schedule'], next: 'Done', what: 'When and where it goes out.' },
];
type S = 'todo' | 'done' | 'running' | 'needs' | 'failed' | 'ready';
function stateOf(ep: Episode, t: (typeof TABS)[number]): S {
  const st = t.stages.map((k) => ep.stages[k].status);
  if (st.includes('running')) return 'running';
  if (st.includes('failed')) return 'failed';
  if (st.includes('needs_you')) return 'needs';
  if (st.every((x) => x === 'done')) return 'done';
  return st.some((x) => ['ready', 'stale'].includes(x)) ? 'ready' : 'todo';
}
const SAYS: Record<S, string> = { todo: 'Not yet', done: 'Done', running: 'Working', needs: 'Your answer', failed: 'Stopped', ready: 'Next' };
export function activeTab(ep: Episode): TabId {
  const all = TABS.map((t) => ({ t, s: stateOf(ep, t) }));
  for (const want of ['running', 'failed', 'needs', 'ready'] as S[]) { const x = all.find((q) => q.s === want); if (x) return x.t.id; }
  return all.find((x) => x.s !== 'done')?.t.id ?? 'schedule';
}
const two = (n: number) => String(n).padStart(2, '0');
const label = (part: number, n: number) => `Part ${part} shot ${n}`;
const nameOf = (ep: Episode, key?: string) => (key ? ep.cast.find((c) => c.key === key.toLowerCase())?.name ?? key : '');
const when = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
/** Puts words into the Zubi window's box; nothing is sent. */
const mention = (text: string) => window.dispatchEvent(new CustomEvent('zubi:mention', { detail: text }));
const isOff = (v: Version) => (v.note ?? '').startsWith('[off]');

// ---------- the page ----------
export function FactoryPage({ id, onBack, onKeys }: { id: string; onBack: () => void; onKeys: () => void }) {
  const [ep, setEp] = useState<Episode | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [tab, setTab] = useState<TabId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<null | 'menu' | 'history' | 'spending'>(null);
  const [sure, setSure] = useState(false);
  const [open, setOpen] = useState(() => lsGet('zubiPanel') !== 'shut');
  const load = useCallback(() => { socialApi.get(id).then((r) => { setEp(r.episode); if (r.slots) setSlots(r.slots); setError(null); }).catch((e) => setError((e as Error).message)); }, [id]);
  useEffect(() => {
    load();
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = (e: Event) => { const d = (e as CustomEvent<{ type: string; episodeId: string }>).detail; if (d?.type === 'social' && d.episodeId === id && !t) t = setTimeout(() => { t = null; load(); }, 350); };
    window.addEventListener('heyzubi:event', on);
    const poll = setInterval(load, 15_000);
    return () => { window.removeEventListener('heyzubi:event', on); clearInterval(poll); if (t) clearTimeout(t); };
  }, [id, load]);
  const now = ep ? activeTab(ep) : 'story';
  // The page follows the work; a tab you opened yourself stays until the work moves on.
  useEffect(() => { setTab(null); }, [now]);
  useEffect(() => { const on = () => { setOpen(true); lsSet('zubiPanel', ''); }; window.addEventListener('zubi:mention', on); return () => window.removeEventListener('zubi:mention', on); }, []);
  if (!ep) return <div className="social__state">{error ? <>{error} <button type="button" className="link-btn" onClick={onBack}>Back</button></> : 'Loading…'}</div>;
  const cur = TABS.find((t) => t.id === (tab ?? now))!, s = stateOf(ep, cur), run = ep.running ? ep.stages[ep.running] : null, at = TABS.findIndex((t) => t.id === now);
  const pct = ep.capUsd ? Math.min(100, (ep.spent / ep.capUsd) * 100) : 0;
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { setError((e as Error).message); } };
  const V = VIEWS[cur.id];
  return (
    <div className="fx">
      <header className="fx__head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="All episodes" title="All episodes"><ArrowLeft size={16} /></button>
        <div className="fx__name"><b>Episode {ep.num}: {ep.title}</b><small>{run ? run.progress ?? 'Working' : s === 'needs' && cur.id === now ? 'Waiting for your answer in the Zubi window' : now === 'schedule' && stateOf(ep, TABS[7]) === 'done' ? 'All done' : ''}</small></div>
        <span className="fx__sp" />
        <span className="fx__money" title="Spent of this episode’s limit"><span><b>{usd(ep.spent)}</b>{ep.capUsd ? ` of ${usd(ep.capUsd)}` : ' spent'}</span>{ep.capUsd > 0 && <i><em style={{ width: `${pct}%` }} /></i>}</span>
        <span className="fx__menu">
          <button type="button" className="icon-btn" aria-label="More" title="More" aria-expanded={menu === 'menu'} onClick={() => { setMenu(menu ? null : 'menu'); setSure(false); }}><Ellipsis size={16} /></button>
          {menu === 'menu' && <div className="fx__pop">
            <button type="button" onClick={() => setMenu('history')}><RefreshCw size={14} aria-hidden /> History</button>
            <button type="button" onClick={() => setMenu('spending')}><Download size={14} aria-hidden /> Spending</button>
            <button type="button" onClick={() => { setMenu(null); onKeys(); }}><Clapperboard size={14} aria-hidden /> Connections</button>
            <button type="button" onClick={() => void act(async () => { await socialApi.archive(id, !ep.archived); onBack(); })}><Archive size={14} aria-hidden /> {ep.archived ? 'Bring it back' : 'Put away'}</button>
            <button type="button" className="is-danger" disabled={!!ep.running} onClick={() => (sure ? void act(async () => { await socialApi.remove(id, ep.num); onBack(); }) : setSure(true))}><Trash2 size={14} aria-hidden /> {sure ? 'Delete for good?' : 'Delete'}</button>
          </div>}
        </span>
        <button type="button" className="icon-btn" aria-label={open ? 'Hide the Zubi window' : 'Show the Zubi window'} title={open ? 'Hide the Zubi window' : 'Show the Zubi window'} onClick={() => { setOpen(!open); lsSet('zubiPanel', open ? 'shut' : ''); }}>{open ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button>
      </header>
      <nav className="fx__line" aria-label="Progress">
        {TABS.map((t, i) => { const x = stateOf(ep, t), I = t.icon; return (
          <button key={t.id} type="button" className={`is-${x}${t.id === now ? ' is-now' : ''}${t.id === cur.id ? ' is-open' : ''}${i <= at ? ' is-past' : ''}`} aria-current={t.id === now ? 'step' : undefined} aria-label={`${i + 1}. ${t.name}: ${SAYS[x]}`} onClick={() => setTab(t.id)}>
            <i>{x === 'done' ? <CheckIcon size={15} aria-hidden /> : x === 'running' ? <Loader2 size={15} className="spin" aria-hidden /> : x === 'failed' ? <AlertTriangle size={15} aria-hidden /> : <I size={15} aria-hidden />}</i>
            <b>{t.name}</b><small>{SAYS[x]}</small>
          </button>); })}
      </nav>
      <div className="fx__body">
        <main className="fx__main">
          {error && <div className="social__note is-bad" role="alert"><AlertTriangle size={15} aria-hidden /><span>{error}</span><button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
          <div className="fx__title"><h2>{cur.name}</h2><span className={`fx__chip is-${s}`}>{s === 'needs' ? 'Waiting for your answer' : SAYS[s]}</span>{s !== 'todo' && cur.next !== 'Done' && <small>Next: {cur.next}</small>}<p>{cur.what}</p></div>
          {run && cur.stages.includes(ep.running!) && <div className="fx__run"><Loader2 size={14} className="spin" aria-hidden /> {run.progress ?? 'Working'}</div>}
          {cur.stages.some((k) => ep.stages[k].status === 'failed') && <div className="social__note is-bad"><AlertTriangle size={15} aria-hidden /><span>{cur.stages.map((k) => ep.stages[k].error).filter(Boolean).join(' ')}</span></div>}
          <V ep={ep} slots={slots} />
        </main>
        {open && <ZubiPanel id={id} ep={ep} onChange={load} onShut={() => { setOpen(false); lsSet('zubiPanel', 'shut'); }} />}
      </div>
      {(menu === 'history' || menu === 'spending') && <div className="fx__sheet" role="dialog" aria-label={menu}><header><b>{menu === 'history' ? 'History' : 'Spending'}</b><button type="button" className="icon-btn" aria-label="Close" onClick={() => setMenu(null)}><X size={15} /></button></header><div>{menu === 'history'
        ? <ol className="fx__log">{ep.events.map((e) => <li key={e.id} className={`is-${e.kind}`}><time>{when(e.at)}</time><span>{e.stage && <b>{TABS.find((t) => t.stages.includes(e.stage as StageId))?.name ?? e.stage}: </b>}{e.text}</span></li>)}</ol>
        : <table className="social__table"><thead><tr><th>What</th><th>Provider</th><th>Cost</th></tr></thead><tbody>{ep.ledger.map((l, i) => <tr key={i} className={l.state === 'failed' ? 'is-off' : ''}><td>{l.what}<small>{l.model}</small></td><td>{l.provider}</td><td>{l.state === 'completed' ? usd(l.usd) : l.state === 'failed' ? 'failed, $0' : `about ${usd(l.estimate ?? 0)}`}</td></tr>)}{!ep.ledger.length && <tr><td colSpan={3}>Nothing spent yet.</td></tr>}</tbody></table>}</div></div>}
    </div>
  );
}

// ---------- shared ----------
interface VP { ep: Episode; slots: Slot[] }
const Empty = ({ t }: { t: string }) => <div className="social__empty"><b>{t}</b></div>;
function Checks({ list, title }: { list: Check[]; title: string }) {
  const [all, setAll] = useState(false);
  if (!list.length) return null;
  const no = list.filter((c) => !c.ok), shown = all ? list : no;
  return <div className="fx__checks"><button type="button" aria-expanded={all} onClick={() => setAll(!all)}><b>{title}</b><span className={`fx__chip is-${no.some((c) => c.level === 'must') ? 'failed' : no.length ? 'needs' : 'done'}`}>{no.length ? `${list.length - no.length} of ${list.length} met` : `all ${list.length} met`}</span></button>{shown.length > 0 && <ul>{shown.map((c) => <li key={c.id} className={c.ok ? 'is-ok' : ''}>{c.ok ? <CheckIcon size={13} aria-hidden /> : <AlertTriangle size={13} aria-hidden />}<span>{c.label}{c.detail ? <small> {c.detail}</small> : null}</span></li>)}</ul>}</div>;
}
function CopyIt({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return <button type="button" className="sicon" title="Copy" aria-label="Copy" onClick={() => void navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); })}>{ok ? <CheckIcon size={13} /> : <Copy size={13} />}</button>;
}

// ---------- 1 story ----------
function StoryTab({ ep }: VP) {
  if (!ep.story.options.length) return ep.story.picked ? <div className="fx__card"><h3>{ep.story.picked.title}</h3><p>{ep.story.picked.problem}</p></div> : <Empty t="Four stories are on their way" />;
  return <div className="fx__grid is-2">{ep.story.options.map((o, i) => {
    const on = ep.story.picked?.title === o.title;
    return <article key={i} className={`fx__card is-pick${on ? ' is-on' : ''}${ep.story.picked && !on ? ' is-dim' : ''}`} title={ep.story.picked ? undefined : 'Put this number into the Zubi window'} onClick={() => { if (!ep.story.picked) mention(String(i + 1)); }}>
      <header><em>{i + 1}</em><h3>{o.title}</h3>{on && <span className="fx__chip is-done">Picked</span>}</header>
      <small>{o.trade} · {o.aiEmployee} AI Employee</small>
      <blockquote>“{o.hookLine}” <cite>{o.hookSpeaker}</cite></blockquote><blockquote>“{o.secondLine}” <cite>{o.secondSpeaker}</cite></blockquote>
      <p>{o.problem}</p><p className="fx__fine">Odd detail: {o.unexpected}</p><p className="fx__fine">{o.why}</p>
    </article>; })}</div>;
}

// ---------- 2 script ----------
function ScriptTab({ ep }: VP) {
  const s = ep.script;
  if (!s) return <Empty t="The script comes after the story" />;
  const k = s.keywords;
  return <>
    <div className="fx__grid is-2">
      <section className="fx__card is-keys"><h3>Keywords</h3>
        <dl><dt>Search phrase</dt><dd><b>{k.primary}</b></dd><dt>Owner side</dt><dd>{k.ownerSide}</dd><dt>Also</dt><dd>{k.secondary.join(' · ')}</dd><dt>YouTube title</dt><dd>{k.youtubeTitle}</dd><dt>Facebook tags</dt><dd className="fx__tags">{k.facebookTags.map((t) => <span key={t}>{t}</span>)}</dd>{k.evidence?.length > 0 && <><dt>What people search</dt><dd className="fx__fine">{k.evidence.slice(0, 4).join(' · ')}</dd></>}{ep.pack && <><dt>Used in</dt><dd className="fx__fine">{ep.pack.keywordPlaces.join('; ')}</dd></>}</dl>
      </section>
      <section className="fx__card"><h3>{s.aiEmployee.icon} {s.aiEmployee.name} AI Employee</h3><p>{s.aiEmployee.howItWorks}</p><p className="fx__fine">{ep.aiConfirmed === 'yes' ? 'Confirmed: one of your AI Employees really does this.' : 'Not confirmed yet that one of your AI Employees really does this.'}</p><p><b>Tip:</b> {s.tip}</p><p className="fx__fine">Odd detail: {s.unexpected} · Running gag: {s.runningGag}</p></section>
    </div>
    <Checks list={ep.checks} title="Series rules" />
    <div className="fx__grid is-2">{s.parts.map((p, i) => <section key={i} className="fx__card"><h3>Part {i + 1} <small>{i ? '0:30 to 1:00' : '0:00 to 0:30'}</small></h3><ol className="fx__lines">{p.shots.map((x) => <li key={x.n} title={`${x.camera}. ${x.picture}`} onClick={() => mention(`${label(i + 1, x.n)}: `)}><em>{two(x.n)}</em>{x.line ? <span><b>{nameOf(ep, x.speaker)}{x.offscreen ? ' (off screen)' : ''}</b> “{x.line}”</span> : <span className="fx__fine">{x.picture}</span>}{x.screen && <i>{x.screen.toUpperCase()}</i>}</li>)}</ol></section>)}</div>
  </>;
}

// ---------- 3 cast ----------
function CastTab({ ep }: VP) {
  const play = useRef<HTMLAudioElement | null>(null);
  if (!ep.cast.length) return <Empty t="The cast comes after the script" />;
  const src = (c: Episode['cast'][0], f?: string) => (f ? (c.kind === 'series' ? seriesFileUrl(f) : epFileUrl(ep.id, f)) : null);
  return <div className="fx__grid is-cast">{ep.cast.map((c) => { const img = src(c, c.image), v = src(c, c.voiceFile); return (
    <article key={c.key} className="fx__card is-person">
      {img ? <a href={img}><img src={img} alt={c.name} loading="lazy" /></a> : <span className="fx__noimg"><Users size={22} aria-hidden /><small>{c.kind === 'described' ? 'In words only' : 'Not drawn yet'}</small></span>}
      <header><h3>{c.name}</h3><small>{({ series: 'Series', sheet: 'New character', ref: 'New, one picture', described: 'Extra' } as const)[c.kind]}</small></header>
      <p className="fx__fine">{c.castLine || c.lock}</p>
      {v && <button type="button" className="fx__voice" onClick={() => { play.current?.pause(); const a = new Audio(v); play.current = a; void a.play().catch(() => {}); }}><Volume2 size={13} aria-hidden /> {c.voice?.voiceName ?? 'Voice'}{c.voiceSeconds ? ` · ${c.voiceSeconds.toFixed(1)} s` : ''}</button>}
    </article>); })}</div>;
}

// ---------- 4 screens ----------
function ScreensTab({ ep }: VP) {
  if (!ep.screens.length) return <Empty t="The screens are drawn once the cast is approved" />;
  const where = (id: string) => (ep.script?.parts ?? []).flatMap((p, i) => p.shots.filter((x) => (ep.edit.options.screenOn?.[`${i + 1}-${x.n}`] ?? x.screen) === id).map((x) => label(i + 1, x.n))).join(', ');
  return <div className="fx__grid is-screens">{ep.screens.map((q) => { const st = ep.edit.screenStats?.[q.id]; return (
    <article key={q.id} className="fx__card is-screen" onClick={() => mention(`Screen ${q.id.slice(1)}: `)}><a href={epFileUrl(ep.id, q.png)} onClick={(e) => e.stopPropagation()}><img src={`${epFileUrl(ep.id, q.png)}&v=${ep.updatedAt}`} alt={q.title} loading="lazy" /></a><h3>{q.title}</h3><small>{where(q.id) ? `Seen in ${where(q.id)}` : 'Not used'}</small>{st?.frames > 0 && <small>{st.ok ? `Fits ${st.good} of ${st.frames} frames` : st.why}</small>}</article>); })}</div>;
}

// ---------- 5 storyboard ----------
function BoardTab({ ep }: VP) {
  const s = ep.script, b = ep.storyboard;
  if (!s || !b) return <Empty t="The storyboard comes after the screens" />;
  return <>
    <div className="fx__card is-row"><div><h3>{b.quoteUsd === null ? 'No price yet' : `Up to ${usd(b.quoteUsd)}`}</h3><small>{b.usualUsd ? `Usually about ${usd(b.usualUsd)} for both parts on TopView` : 'Both parts, 480p Seedance 2.5 on TopView'}</small></div><div><h3>{b.chars.map((n) => n.toLocaleString()).join(' + ')}</h3><small>characters in the two prompts (limit 7,500 each)</small></div><div><h3>{b.refs.map((r) => r.images.length).join(' + ')} pictures, {b.refs.map((r) => r.audio.length).join(' + ')} voices</h3><small>sent as references</small></div></div>
    <Checks list={b.checks} title="Prompt checks" />
    {s.parts.map((p, i) => <section key={i}><h3 className="fx__h3">Part {i + 1} <small>{p.time}</small></h3><div className="fx__grid is-board">{p.shots.map((x) => <ShotCard key={x.n} ep={ep} part={i + 1} x={x} />)}</div></section>)}
  </>;
}
function ShotCard({ ep, part, x }: { ep: Episode; part: number; x: Shot }) {
  const c = ep.cast.find((q) => q.key === x.speaker?.toLowerCase()), scr = ep.screens.find((q) => q.id === x.screen);
  const img = scr ? epFileUrl(ep.id, scr.png) : c?.image ? (c.kind === 'series' ? seriesFileUrl(c.image) : epFileUrl(ep.id, c.image)) : null;
  return <article className="fx__card is-shot" title="Put this shot into the Zubi window" onClick={() => mention(`${label(part, x.n)}: `)}><header><em>{two(x.n)}</em><b>{x.line ? nameOf(ep, x.speaker) : scr ? 'Screen' : 'Silent'}</b><small>{x.start}–{x.end} s</small></header><div>{img && <img src={img} alt="" loading="lazy" className={scr ? 'is-scr' : ''} />}<p>{x.picture}</p></div>{x.line && <blockquote>“{x.line}”</blockquote>}<small className="fx__fine">{x.camera}{x.clock ? ` · clock ${x.clock}` : ''}</small></article>;
}

// ---------- 6 render ----------
interface EditRow { key: string; text: string; state: 'work' | 'in' | 'off' | 'bad'; usd?: number; at: number }
function edits(ep: Episode, part: number): EditRow[] {
  const P = ep.render.parts[part - 1], o = ep.edit.options, mine = <T extends { part: number }>(l: T[] | undefined) => (l ?? []).filter((d) => d.part === part);
  return [
    ...P.versions.filter((v) => v.kind === 'shot' || v.kind === 'voice').map((v) => ({ key: `v${v.v}`, at: v.at, usd: v.usd, text: v.provider === 'elevenlabs' ? `Shot ${v.shot}: line said again` : `Shot ${v.shot}: new take`, state: v.state === 'failed' ? 'bad' as const : v.state !== 'completed' ? 'work' as const : isOff(v) || (v.kind === 'voice' && v.v !== P.picked) ? 'off' as const : 'in' as const })),
    ...mine(o.dropShots).map((d) => ({ key: `d${d.shot}`, at: 0, text: `Shot ${d.shot}: left out`, state: 'in' as const })), ...mine(o.trims).map((d) => ({ key: `t${d.shot}`, at: 0, text: `Shot ${d.shot}: trimmed ${(d.in + d.out).toFixed(2)} s`, state: 'in' as const })), ...mine(o.brighten).map((d) => ({ key: `b${d.shot}`, at: 0, text: `Shot ${d.shot}: brightened`, state: 'in' as const })),
    ...Object.entries(o.screenOn ?? {}).filter(([k]) => k.startsWith(`${part}-`)).map(([k, v]) => ({ key: `s${k}`, at: 0, text: `Shot ${k.slice(2)}: ${v ? `screen ${v.slice(1)} put on` : 'screen taken off'}`, state: 'in' as const })),
  ];
}
function notes(ep: Episode, part: number): string[] {
  const rv = ep.review[part - 1];
  if (!rv) return [];
  const shown = (n: number) => ep.render.parts[part - 1].versions.some((v) => v.kind === 'shot' && v.shot === n && v.state === 'completed' && !isOff(v));
  return [...rv.lines.flatMap((l) => { const x = ep.script?.parts[part - 1].shots.find((q) => q.n === l.shot); if (!x || shown(l.shot)) return []; const d = voiceDrift(l, x); return [...(l.lips === false && !x.offscreen ? [`Shot ${l.shot}: ${nameOf(ep, l.speaker)}’s mouth doesn’t move`] : []), ...(l.score < 0.7 ? [`Shot ${l.shot}: heard “${l.heard || 'nothing'}”`] : []), ...(d !== null ? [`Shot ${l.shot}: ${nameOf(ep, l.speaker)}’s voice is ${Math.abs(d)}% ${d > 0 ? 'higher' : 'lower'} than the sample`] : [])]; }), ...rv.notes.filter((x) => !x.startsWith('[') && !/mouth doesn’t move/.test(x) && !shown(Number(/^Shot (\d+):/.exec(x)?.[1] ?? 0)))];
}
function partState(ep: Episode, part: number): { s: S; t: string } {
  const P = ep.render.parts[part - 1], e = ep.stages, working = P.versions.find((v) => v.state === 'submitted' || v.state === 'quoted');
  if (working?.kind === 'shot') return { s: 'running', t: `Retaking shot ${working.shot}` };
  if (working) return { s: 'running', t: 'Rendering' };
  if (P.picked === null) return e.render.status === 'running' ? { s: 'running', t: part === 1 ? 'Waits for Part 2' : 'Starting' } : e.render.status === 'failed' ? { s: 'failed', t: 'Stopped' } : { s: 'todo', t: 'Not rendered yet' };
  if (e.review.status === 'running') return { s: 'running', t: e.review.progress?.startsWith(`Part ${part}`) || !/^Part \d/.test(e.review.progress ?? '') ? e.review.progress ?? 'Checking' : 'Waiting' };
  if (e.edit.status === 'running' || ['stale', 'ready'].includes(e.edit.status)) return { s: 'running', t: e.edit.status === 'running' ? 'Updating' : 'Update comes next' };
  if (e.edit.status === 'done') return { s: 'done', t: 'Approved' };
  if (e.edit.status === 'needs_you') return { s: 'needs', t: 'Ready to watch' };
  return { s: 'ready', t: 'Rendered' };
}
function RenderTab({ ep }: VP) {
  const st = ep.stages.edit, cut: { s: S; t: string } = !ep.edit.final ? { s: ep.running === 'edit' ? 'running' : 'todo', t: ep.running === 'edit' ? 'Being made' : 'Not made yet' } : st.status === 'running' ? { s: 'running', t: 'Being made again' } : st.status === 'done' ? { s: 'done', t: 'Approved' } : st.status === 'needs_you' ? { s: 'needs', t: 'Waiting for your approval' } : st.status === 'failed' ? { s: 'failed', t: 'Stopped' } : { s: 'running', t: 'Out of date' };
  return <>
    <div className="fx__grid is-2">{[1, 2].map((n) => { const P = ep.render.parts[n - 1], v = P.versions.find((q) => q.v === P.picked), file = ep.edit.partFiles?.[n - 1] ?? v?.file ?? null, x = partState(ep, n), list = edits(ep, n), look = ep.stages.edit.status === 'done' ? [] : notes(ep, n); return (
      <article key={n} className={`fx__card is-video is-${x.s}`}>
        <div className="fx__vid">{file ? <video key={file} src={epFileUrl(ep.id, file)} controls preload="metadata" playsInline /> : <span><Film size={26} aria-hidden /></span>}</div>
        <div className="fx__side">
          <header><h3>Part {n}</h3><span className={`fx__chip is-${x.s}`}>{x.s === 'running' && <Loader2 size={11} className="spin" aria-hidden />}{x.t}</span></header>
          <small>{n === 1 ? '0:00 to 0:30' : '0:30 to 1:00'}{v ? ` · ${v.kind === 'import' ? 'your clip' : `version ${v.v}`}${P.versions.filter((q) => q.usd).length ? ` · ${usd(P.versions.reduce((a, q) => a + (q.usd ?? 0), 0))}` : ''}` : ''}</small>
          {list.length > 0 && <ul className="fx__edits">{list.map((q) => <li key={q.key} className={`is-${q.state}`}>{q.state === 'work' ? <Loader2 size={12} className="spin" aria-hidden /> : q.state === 'in' ? <CheckIcon size={12} aria-hidden /> : q.state === 'bad' ? <AlertTriangle size={12} aria-hidden /> : <X size={12} aria-hidden />}<span>{q.text}{q.state === 'off' ? ' (not used)' : q.state === 'bad' ? ' (failed)' : ''}</span>{q.usd ? <small>{usd(q.usd)}</small> : null}</li>)}</ul>}
          {look.length > 0 && <div className="fx__look"><b>Worth a look</b><ul>{look.slice(0, 6).map((q, i) => <li key={i} title="Put this into the Zubi window" onClick={() => mention(`Part ${n}, ${q}. Fix it.`)}>{q}</li>)}</ul></div>}
          {!list.length && !look.length && file && <p className="fx__fine">No edits. Tell Zubi what to change: a shot, a line or a time.</p>}
        </div>
      </article>); })}</div>
    <div className="fx__grid is-2">
      <article className={`fx__card is-video is-${cut.s}`}>
        <div className="fx__vid">{ep.edit.final ? <video key={ep.edit.final} src={epFileUrl(ep.id, ep.edit.final)} controls preload="metadata" playsInline /> : <span><Clapperboard size={26} aria-hidden /></span>}</div>
        <div className="fx__side"><header><h3>Final cut</h3><span className={`fx__chip is-${cut.s}`}>{cut.s === 'running' && ep.running === 'edit' && <Loader2 size={11} className="spin" aria-hidden />}{cut.t}</span></header>
          {ep.edit.final && <><small>Version {ep.edit.version} · {ep.edit.seconds?.toFixed(1)} s · {ep.edit.lufs} LUFS</small><p className="fx__fine">With captions, clock, screens, theme and sounds.</p><a className="fx__dl" href={epFileUrl(ep.id, ep.edit.final, true)}><Download size={13} aria-hidden /> Download</a></>}
        </div>
      </article>
      <article className="fx__card"><Checks list={ep.edit.checks} title="Checks of the cut" />{!ep.edit.checks.length && <p className="fx__fine">The checks come with the cut.</p>}</article>
    </div>
  </>;
}

// ---------- 7 cover ----------
function CoverTab({ ep }: VP) {
  const c = ep.cover, p = ep.pack;
  const [k, setK] = useState<'instagram' | 'facebook' | 'youtube' | 'whatsapp'>('instagram');
  if (!c.candidates.length) return <Empty t="Covers are pulled once the final cut is approved" />;
  const texts: Record<string, [string, string][]> = p ? { instagram: [['Caption', p.instagram], ['First comment', p.commentInstagram], ['Alt text', p.altText]], facebook: [['Caption', p.facebook], ['First comment', p.commentFacebook], ['Tags', p.facebookTags.join(', ')]], youtube: [['Title', p.youtubeTitle], ['Description', p.youtubeDescription], ['Pinned comment', p.youtubeComment ?? ''], ['Tags', p.youtubeTags.join(', ')]], whatsapp: [['Status line', p.whatsapp ?? '']] } : {};
  return <div className="fx__grid is-cover">
    <section className="fx__card"><h3>Cover</h3><div className="fx__covers">{c.candidates.map((q, i) => <figure key={q.file} className={c.picked === q.file ? 'is-on' : c.picked ? 'is-dim' : ''} title={c.picked ? undefined : 'Put this number into the Zubi window'} onClick={() => { if (!c.picked) mention(`Cover ${i + 1}`); }}><img src={epFileUrl(ep.id, q.file)} alt={`Frame at ${q.t.toFixed(1)} seconds`} loading="lazy" /><figcaption><em>{i + 1}</em> {q.t.toFixed(1)} s{c.picked === q.file && <CheckIcon size={13} aria-hidden />}</figcaption></figure>)}</div></section>
    <section className="fx__card"><header><h3>Captions</h3>{p && <div className="fx__seg" role="tablist">{(['instagram', 'facebook', 'youtube', 'whatsapp'] as const).filter((x) => p.platforms.includes(x)).map((x) => <button key={x} type="button" role="tab" aria-selected={k === x} onClick={() => setK(x)}>{({ instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', whatsapp: 'WhatsApp' } as const)[x]}</button>)}</div>}</header>
      {!p ? <p className="fx__fine">{ep.running === 'package' ? 'Being written' : 'They are written once a cover is picked.'}</p> : <>{(texts[k] ?? []).filter(([, t]) => t).map(([l, t]) => <div key={l} className="fx__text"><small>{l} <CopyIt text={t} /></small><p>{t}</p></div>)}<Checks list={p.checks} title="Caption rules" /><div className="fx__text"><small>Keywords used</small><p>{p.keywordPlaces.join('\n')}</p></div></>}
    </section>
  </div>;
}

// ---------- 8 schedule ----------
const PLAT: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook Page', youtube: 'YouTube Shorts', whatsapp: 'WhatsApp Status' };
const FILES: [string, string][] = [['reel-v1.mp4', 'The reel'], ['cover.jpg', 'Cover'], ['caption-us-ig.txt', 'Instagram caption'], ['caption-us-fb.txt', 'Facebook caption'], ['youtube.txt', 'YouTube texts'], ['comment-ig.txt', 'Instagram comment'], ['comment-fb.txt', 'Facebook comment'], ['comment-youtube.txt', 'YouTube comment'], ['whatsapp-status.mp4', 'WhatsApp copy'], ['caption-whatsapp.txt', 'WhatsApp line'], ['alt-text.txt', 'Alt text'], ['keywords.json', 'Keywords']];
function ScheduleTab({ ep, slots }: VP) {
  const p = ep.pack;
  if (!p?.folder || ep.stages.package.status !== 'done') return <Empty t="The schedule comes after the captions" />;
  const slot = slots.find((x) => x.at === p.slot);
  return <>
    <div className="fx__card is-row"><div><h3>{slot?.label ?? `${p.slot?.replace('T', ' ')} IST`}</h3><small>{slot?.us ?? ''}</small></div><div><h3>{ep.schedule.method === 'heyzubi' ? 'HeyZubi schedules it' : ep.schedule.method === 'zubi' ? 'Zubi schedules it' : ep.schedule.method === 'self' ? 'You schedule it' : 'Nothing is scheduled yet'}</h3><small>{ep.schedule.askedAt ? `Asked ${when(ep.schedule.askedAt)}` : ''}</small></div></div>
    <div className="fx__grid is-4">{p.platforms.map((k) => { const r = ep.schedule.results[k], s: S = !r ? 'todo' : r.status === 'failed' ? 'failed' : r.status === 'asked' || (r.status === 'scheduled' && !!r.due) ? 'running' : 'done'; return <article key={k} className="fx__card"><header><h3>{PLAT[k]}</h3></header><span className={`fx__chip is-${s}`}>{s === 'running' && <Loader2 size={11} className="spin" aria-hidden />}{r ? (k === 'whatsapp' && r.status === 'scheduled' ? 'Posts at its time' : k === 'whatsapp' && r.status === 'live' ? 'Posted' : ({ asked: 'Being scheduled', scheduled: 'Scheduled', live: 'Live', failed: 'Not done' } as Record<string, string>)[r.status]) : 'Not scheduled'}</span>{r?.link && <p><a href={r.link} target="_blank" rel="noreferrer">Open</a></p>}{r?.note && <p className="fx__fine">{r.note}</p>}</article>; })}</div>
    <div className="fx__grid is-2"><article className="fx__card is-video"><div className="fx__vid">{ep.edit.final && <video controls preload="none" playsInline poster={ep.cover.picked ? epFileUrl(ep.id, ep.cover.picked) : undefined} src={epFileUrl(ep.id, ep.edit.final)} />}</div><div className="fx__side"><h3>The reel</h3><p className="fx__pre">{p.instagram}</p></div></article>
      <article className="fx__card"><h3>Publish pack</h3><ul className="fx__files">{FILES.filter(([f]) => p.platforms.includes('whatsapp') || !/whatsapp/.test(f)).map(([f, l]) => <li key={f}><a href={epFileUrl(ep.id, `${p.folder}/${f}`, true)}><Download size={13} aria-hidden /> {l}</a></li>)}</ul></article></div>
  </>;
}
const VIEWS: Record<TabId, (p: VP) => ReactNode> = { story: StoryTab, script: ScriptTab, cast: CastTab, screens: ScreensTab, storyboard: BoardTab, render: RenderTab, cover: CoverTab, schedule: ScheduleTab };

// ---------- the Zubi window ----------
const PIC = /\[Attached picture: ([^\s\]]+) — [^\]]*\]/g;
function ZubiPanel({ id, ep, onChange, onShut }: { id: string; ep: Episode; onChange: () => void; onShut: () => void }) {
  const [chat, setChat] = useState<ChatState | null>(null);
  const bot = useStore((s) => s.bots.find((b) => b.isPrimary));
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [w, setW] = useState(() => Math.min(620, Math.max(300, Number(lsGet('zubiWidth')) || 400)));
  const stick = useRef(true), end = useRef<HTMLDivElement>(null);
  const load = useCallback(() => { socialApi.chat(id, null).then(setChat).catch((e) => setErr((e as Error).message)); }, [id]);
  useEffect(() => {
    load();
    const on = (e: Event) => { const d = (e as CustomEvent<{ type: string; episodeId: string }>).detail; if (d?.type === 'social' && d.episodeId === id) load(); };
    window.addEventListener('heyzubi:event', on);
    const t = setInterval(load, 8000);
    return () => { window.removeEventListener('heyzubi:event', on); clearInterval(t); };
  }, [id, load]);
  const last = chat?.messages[chat.messages.length - 1]?.id, working = chat?.busy ?? null, step = chat?.step ?? null;
  useEffect(() => { if (stick.current) end.current?.scrollIntoView({ block: 'nearest' }); }, [last, working, step?.text, chat?.did.length]);
  useEffect(() => { stick.current = true; end.current?.scrollIntoView({ block: 'nearest' }); }, [last]);
  const send = useCallback(async (t: string) => {
    setErr(null); setSending(true);
    try { setChat(await socialApi.say(id, t, null)); onChange(); } finally { setSending(false); }
  }, [id, onChange]);
  // Corrections kept from before are sent once Zubi is free.
  const ready = !!chat && !working && !sending;
  useEffect(() => { const q = waitingSaid(id); if (ready && q.length) { saidDone(id, q.length); void send(q.join('\n')).catch((e) => { setErr((e as Error).message); window.dispatchEvent(new CustomEvent('zubi:mention', { detail: q.join('\n') })); }); } }, [ready, id, send]);
  const drag = (e: React.PointerEvent) => { const el = e.currentTarget as HTMLElement, x0 = e.clientX, w0 = w; let v = w0; el.setPointerCapture(e.pointerId); const mv = (m: PointerEvent) => { v = Math.min(620, Math.max(300, w0 + x0 - m.clientX)); setW(v); }; const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); lsSet('zubiWidth', String(Math.round(v))); }; el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); };
  const name = chat?.agent ?? 'Zubi', ask = chat?.messages.slice().reverse().find((m) => m.data.proposals?.some((p) => p.state === 'open'))?.data.proposals?.filter((p) => p.state === 'open') ?? [];
  const hint = useMemo(() => { const k = ask[0]?.kind; if (working) return ''; if (k === 'story') return 'with a number, or your own story'; if (k === 'cover') return 'with a number, or a time in the cut'; if (k === 'schedule') return '“schedule”, or “I’ll do it”'; if (ask.length > 1) return 'with numbers, “all”, or what to change'; if (ask.length) return '“approve”, or what to change'; return ''; }, [ask, working]);
  const reply = chat?.messages.slice().reverse().find((m) => m.role === 'agent' && !m.data.step);
  const quiet = (m: ChatState['messages'][0]) => m.data.step && m.role === 'agent';
  return (
    <aside className="zp" style={{ width: w }} aria-label={`${name} window`}>
      <i className="zp__edge" onPointerDown={drag} />
      <header><span className={`zp__dot${chat?.online ? ' is-on' : ''}`} aria-hidden /><b>{name}</b><small>{working ? working.toLowerCase() : step ? 'working' : chat && !chat.online ? 'not answering' : ask.length ? 'waiting for you' : ''}</small><span className="fx__sp" /><button type="button" className="sicon" aria-label="Hide" title="Hide" onClick={onShut}><X size={14} /></button></header>
      <div className="zp__list" role="log" aria-live="polite" onScroll={(e) => { const x = e.currentTarget; stick.current = x.scrollHeight - x.scrollTop - x.clientHeight < 120; }} onLoadCapture={() => { if (stick.current) end.current?.scrollIntoView({ block: 'nearest' }); }}>
        {chat?.messages.map((m) => quiet(m) ? <p key={m.id} className="zp__step"><CheckIcon size={12} aria-hidden /> {m.text}<time>{when(m.at)}</time></p> : (
          <article key={m.id} className={`zp__m is-${m.role}${m.data.error ? ' is-bad' : ''}`}>
            <small>{m.role === 'you' ? 'You' : name} · {when(m.at)}</small>
            {m.role === 'you' ? <><p>{m.text.replace(PIC, '').trim()}</p>{[...m.text.matchAll(PIC)].map((x) => <div key={x[1]} className="zp__pics"><img src={genUrl(x[1])} alt="Attached" loading="lazy" /></div>)}</> : <Markdown text={m.text} />}
            {(!!m.data.did?.length || !!m.data.no?.length) && <ul className="zp__did">{m.data.did?.map((d, i) => <li key={`d${i}`}><CheckIcon size={12} aria-hidden /> {d}</li>)}{m.data.no?.map((d, i) => <li key={`n${i}`} className="is-no"><X size={12} aria-hidden /> {d}</li>)}</ul>}
            {!!m.data.images?.length && <div className="zp__pics">{m.data.images.map((p) => <a key={p} href={epFileUrl(id, p)}><img src={epFileUrl(id, p)} alt="What was looked at" loading="lazy" /></a>)}</div>}
            {!!m.data.proposals?.length && <ol className="zp__asks">{m.data.proposals.map((p, i) => <li key={i} className={`is-${p.state}`}><span>{m.data.proposals!.length > 1 ? `${i + 1}. ` : ''}{p.label}</span><em>{p.state === 'done' ? 'Yes' : p.state === 'no' ? 'No' : p.state === 'old' ? 'Asked again later' : 'Waiting for your answer'}</em>{p.why && <small>{p.why}</small>}</li>)}</ol>}
          </article>))}
        {!chat?.messages.length && chat && <p className="zp__hi">Everything about this episode happens here: what is ready, what it costs, and your answers.</p>}
        {(working || step) && <p className="zp__busy"><Loader2 size={13} className="spin" aria-hidden /> {working ?? step!.text}<small>{step && !working ? 'Type “stop” to stop it' : ''}</small></p>}
        {working && chat!.did.length > 0 && <ul className="zp__did">{chat!.did.map((d, i) => <li key={i}><CheckIcon size={12} aria-hidden /> {d}</li>)}</ul>}
        <div ref={end} />
      </div>
      {err && <div className="card__error zp__err">{err}</div>}
      <VoiceCallBar />
      {bot && <Composer bot={bot} running={!!working} target={{
        key: `socialDraft-${id}`, label: `Write to ${name} about Episode ${ep.num}`, hint: hint ? `Reply ${hint}` : '', checkVoice: ask.length > 0 || !!working, reply: reply ? { id: reply.id, text: reply.text } : null,
        // Kept in the box while Zubi works: sent later by itself, it could answer a question that wasn't there yet.
        send: async (t) => { if (working || sending) throw new Error(`${name} is still working. Your message stays in the box; press Enter when it is done.`); await send(t); },
        stop: () => socialApi.chatStop(id),
      }} />}
    </aside>
  );
}
