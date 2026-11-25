import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownUp, CalendarClock, LayoutGrid, List, Pause, Play, Search, X } from 'lucide-react';
import { epFileUrl, seriesFileUrl, socialApi, usd, type Home } from '../../lib/socialApi';
import { lsGet, lsSet } from '../../lib/storage';
import '../../styles/social-home.css';

/**
 * The home page's three tabs: what is scheduled (with the free slots), what has been published, and the cast. Each can be
 * looked at as cards (a featured one, then a band of cards) or a list, searched, filtered and sorted; what was chosen is remembered in this browser.
 */
type TabId = 'scheduled' | 'published' | 'cast';
type View = 'cards' | 'list';
interface Item {
  key: string; title: string; sub: string; line?: string; badge: string; tone: 'done' | 'need' | 'free' | 'off' | 'plain';
  img: string | null; wide?: boolean; num: number; at: string | null; usd: number | null; text: string;
  facets: Record<string, string[]>; sorts: Record<string, number | string>;
  links: [string, string][]; later?: string | null; open?: () => void; voice?: string; slot?: { at: string; blocked: boolean };
  cells: ReactNode[];
}
interface TabDef { label: string; items: Item[]; filters: [string, string, string][]; sorts: [string, string][]; heads: string[]; empty: string }
interface Saved { tab: TabId; view: Partial<Record<TabId, View>>; sort: Partial<Record<TabId, string>>; down: Partial<Record<TabId, boolean>> }

const ms = (at: string) => Date.parse(`${at}:00+05:30`);
const fmt = (t: number, tz: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...o }).format(t);
const ist = (at: string) => `${fmt(ms(at), 'Asia/Kolkata', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} IST`;
const ny = (at: string) => `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ms(at))} New York`;
const cap = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const PLACE: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', whatsapp: 'WhatsApp' };
const ORDER = ['instagram', 'youtube', 'facebook', 'whatsapp'];
const toLinks = (l: Record<string, string>): [string, string][] => ORDER.filter((k) => /^https:\/\//.test(l[k] ?? '')).map((k) => [k, l[k]]);
const uniq = (a: string[]) => [...new Set(a.filter(Boolean))];

function build(home: Home, onOpen: (id: string) => void): Record<TabId, TabDef> {
  const now = Date.now();
  interface Post { key: string; num: number; title: string; trade: string; ai: string; keyword: string; cast: string[]; at: string | null; usd: number | null; img: string | null; links: [string, string][]; platforms: string[]; line: string; made: boolean; ready: boolean; ytAt: string | null; open?: () => void }
  const posts: Post[] = [
    ...home.history.map((h): Post => ({ key: `h${h.num}`, num: h.num, title: h.title, trade: h.trade, ai: h.aiEmployee, keyword: h.keyword, cast: h.cast.filter((c) => !/AI Employee|bookings/i.test(c)), at: h.slot, usd: h.usd, img: h.cover ? seriesFileUrl(h.cover) : null, links: toLinks(h.links), platforms: h.platforms, line: h.hook[0] ?? '', made: false, ready: true, ytAt: h.youtubeAt })),
    ...home.episodes.filter((e) => !e.archived && e.slot).map((e): Post => ({ key: e.id, num: e.num, title: e.title, trade: e.trade, ai: e.aiEmployee, keyword: e.keyword, cast: e.cast, at: e.slot, usd: e.spent, img: e.cover ? epFileUrl(e.id, e.cover) : null, links: toLinks(e.links), platforms: e.platforms, line: '', made: true, ready: e.scheduled, ytAt: null, open: () => onOpen(e.id) })),
  ];
  const isOut = (p: Post) => !p.at || ms(p.at) <= now;
  const postItem = (p: Post, published: boolean): Item => {
    const status = published ? 'Published' : p.ready ? 'Scheduled' : 'Being made';
    const later = p.ytAt && ms(p.ytAt) > now;
    return {
      key: p.key, num: p.num, title: p.title, sub: [cap(p.trade), p.ai && `${p.ai} AI Employee`].filter(Boolean).join(' · '), line: p.at ? `${ist(p.at)} · ${ny(p.at)}` : undefined,
      badge: `Ep ${p.num} · ${status}`, tone: published || p.ready ? 'done' : 'need', img: p.img, at: p.at, usd: p.usd,
      text: [p.num, p.title, p.trade, p.ai, p.keyword, p.line, ...p.cast].join(' ').toLowerCase(),
      facets: {
        status: [status], slot: p.at ? [p.at.slice(11)] : [], place: (published ? uniq([...p.links.filter(([k]) => k !== 'youtube' || !later).map(([k]) => k), ...p.platforms.filter((k) => k !== 'youtube' || !later)]) : p.platforms).map((k) => PLACE[k] ?? k),
        trade: [cap(p.trade)], ai: [p.ai], who: p.cast, month: p.at ? [fmt(ms(p.at), 'Asia/Kolkata', { month: 'long', year: 'numeric' })] : [], from: [p.made ? 'HeyZubi' : 'Claude session'],
      },
      sorts: { time: p.at ? ms(p.at) : 0, num: p.num, title: p.title.toLowerCase(), usd: p.usd ?? -1, trade: p.trade.toLowerCase(), ai: p.ai.toLowerCase() },
      links: p.links, later: later ? p.ytAt : null, open: p.open,
      cells: [
        <><b>{p.at ? ist(p.at) : '–'}</b><small>{p.at ? ny(p.at) : ''}</small></>,
        <><b>Ep {p.num}: {p.title}</b><small>{p.line || p.keyword}</small></>, cap(p.trade), p.ai,
        <Links key="l" item={p.links} later={later ? p.ytAt : null} also={p.platforms.filter((k) => !p.links.some(([x]) => x === k))} />,
        published ? (p.usd !== null ? usd(p.usd) : '–') : <span className={`spill is-${p.ready ? 'done' : 'needs_you'}`}>{status}</span>,
      ],
    };
  };
  const slotItem = (s: Home['slots'][number]): Item => {
    const blocked = s.taken === 'Blocked';
    return {
      key: `s${s.at}`, num: 9999, title: blocked ? 'Blocked slot' : 'Free slot', sub: blocked ? 'Kept free of reels' : 'The next episode can go here', line: `${ist(s.at)} · ${ny(s.at)}`, badge: blocked ? 'Blocked' : 'Free', tone: blocked ? 'off' : 'free',
      img: null, at: s.at, usd: null, text: `${blocked ? 'blocked' : 'free'} slot ${ist(s.at)}`.toLowerCase(),
      facets: { status: [blocked ? 'Blocked' : 'Free'], slot: [s.at.slice(11)], place: [], trade: [], ai: [], who: [], month: [], from: [] },
      sorts: { time: ms(s.at), num: 9999, title: 'zz', usd: -1, trade: 'zz', ai: 'zz' }, links: [], slot: { at: s.at, blocked },
      cells: [<><b>{ist(s.at)}</b><small>{ny(s.at)}</small></>, <span className="stab__free">{blocked ? 'Blocked' : 'Free slot'}</span>, '', '', '', <span className="spill">{blocked ? 'Blocked' : 'Free'}</span>],
    };
  };
  const out = posts.filter(isOut), soon = posts.filter((p) => !isOut(p));
  const open = home.slots.filter((s) => !s.taken || s.taken === 'Blocked');
  const cast = (home.series?.cast ?? []).map((c): Item => {
    const eps = [...(/\(Ep ([\d, ]+)\)/.exec(c.about)?.[1] ?? '').matchAll(/\d+/g)].map((m) => Number(m[0]));
    const regular = !!c.role, n = regular ? home.history.length : eps.length;
    const job = cap(c.about.replace(/\s*\(Ep [^)]*\)/, '')), first = regular ? 1 : eps[0] ?? 0, latest = regular ? home.history.length : eps[eps.length - 1] ?? 0;
    const trades = uniq(eps.map((x) => cap(home.history.find((h) => h.num === x)?.trade ?? '')));
    return {
      key: c.key, num: first, title: c.name, sub: job, line: regular ? 'In every episode' : `Episode${n === 1 ? '' : 's'} ${eps.join(', ')}`, badge: regular ? 'Series regular' : n > 1 ? `Owner · ${n} episodes` : 'Owner', tone: regular ? 'done' : 'plain', img: seriesFileUrl(c.image), wide: true, at: null, usd: null,
      text: `${c.name} ${c.about} ${c.look}`.toLowerCase(), facets: { role: [regular ? 'Series regular' : 'Business owner'], trade: trades, seen: [regular ? 'Every episode' : n > 1 ? 'Returning' : 'Once so far'], latest: [latest ? `Ep ${latest}` : ''] },
      sorts: { order: regular ? (c.role === 'hero' ? -2 : -1) : first, title: c.name.toLowerCase(), count: n, latest }, links: [], voice: seriesFileUrl(c.voice),
      cells: [<b key="n">{c.name}</b>, <>{job}<small>{c.look}</small></>, regular ? 'Every episode' : eps.map((x) => `Ep ${x}`).join(', '), trades.join(', ') || '–', <VoiceButton key="v" src={seriesFileUrl(c.voice)} name={c.name} />],
    };
  });
  const POST_SORTS: [string, string][] = [['time', 'Posting time'], ['num', 'Episode number'], ['title', 'Title'], ['trade', 'Trade'], ['ai', 'AI Employee'], ['usd', 'Cost']];
  return {
    scheduled: { label: 'Scheduled posts', items: [...soon.map((p) => postItem(p, false)), ...open.map(slotItem)], filters: [['status', 'Status', 'All statuses'], ['slot', 'Slot', 'Both slots'], ['place', 'Channel', 'All channels'], ['trade', 'Trade', 'All trades'], ['ai', 'AI Employee', 'All AI Employees'], ['who', 'Character', 'Everyone']], sorts: POST_SORTS, heads: ['When', 'Episode', 'Trade', 'AI Employee', 'Where', 'Status'], empty: 'Nothing is scheduled.' },
    published: { label: 'Published posts', items: out.map((p) => postItem(p, true)), filters: [['place', 'Channel', 'All channels'], ['trade', 'Trade', 'All trades'], ['ai', 'AI Employee', 'All AI Employees'], ['who', 'Character', 'Everyone'], ['month', 'Month', 'Any month'], ['slot', 'Posted at', 'Any time']], sorts: POST_SORTS, heads: ['When', 'Episode', 'Trade', 'AI Employee', 'Where', 'Cost'], empty: 'Nothing has been published yet.' },
    cast: { label: 'Cast', items: cast, filters: [['role', 'Role', 'All roles'], ['trade', 'Trade', 'All trades'], ['seen', 'Appears', 'Any'], ['latest', 'Last seen', 'Any episode']], sorts: [['order', 'First appearance'], ['title', 'Name'], ['count', 'Most episodes'], ['latest', 'Latest episode']], heads: ['Name', 'Who', 'Episodes', 'Trade', 'Voice'], empty: 'There is no cast yet.' },
  };
}
const DOWN_FIRST: Record<TabId, string[]> = { scheduled: ['usd'], published: ['time', 'num', 'usd'], cast: ['count', 'latest'] };

export function HomeTabs({ home, onOpen, reload }: { home: Home; onOpen: (id: string) => void; reload: () => void }) {
  const [saved, setSaved] = useState<Saved>(() => { try { const s = JSON.parse(lsGet('socialHome') || '{}'); return { tab: ['scheduled', 'published', 'cast'].includes(s.tab) ? s.tab : 'scheduled', view: s.view ?? {}, sort: s.sort ?? {}, down: s.down ?? {} }; } catch { return { tab: 'scheduled', view: {}, sort: {}, down: {} }; } });
  const keep = (p: Partial<Saved>) => { const n = { ...saved, ...p }; setSaved(n); lsSet('socialHome', JSON.stringify(n)); };
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Record<TabId, Record<string, string>>>({ scheduled: {}, published: {}, cast: {} });
  const [err, setErr] = useState<string | null>(null);
  const tabs = useMemo(() => build(home, onOpen), [home, onOpen]);
  const tab = saved.tab, def = tabs[tab], view: View = saved.view[tab] === 'list' ? 'list' : 'cards';
  const sort = def.sorts.some(([k]) => k === saved.sort[tab]) ? saved.sort[tab]! : def.sorts[0][0];
  const down = saved.down[tab] ?? DOWN_FIRST[tab].includes(sort);
  const on = picked[tab];
  const set = (k: string, v: string) => setPicked({ ...picked, [tab]: { ...on, [k]: v } });
  const options = useMemo(() => Object.fromEntries(def.filters.map(([k]) => {
    const n = new Map<string, number>();
    for (const i of def.items) for (const v of i.facets[k] ?? []) if (v) n.set(v, (n.get(v) ?? 0) + 1);
    return [k, [...n].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))];
  })), [def]);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = def.items.filter((i) => words.every((w) => i.text.includes(w)) && def.filters.every(([k]) => !on[k] || (i.facets[k] ?? []).includes(on[k])));
    const dir = down ? -1 : 1;
    return list.sort((a, b) => { const x = a.sorts[sort], y = b.sorts[sort]; return (typeof x === 'string' ? x.localeCompare(String(y)) : x - Number(y)) * dir || a.num - b.num; });
  }, [def, q, on, sort, down]);
  const active = def.filters.some(([k]) => on[k]) || !!q;
  const toggle = useCallback((s: { at: string; blocked: boolean }) => { setErr(null); socialApi.block(s.at, s.blocked ? null : 'Blocked').then(reload).catch((e) => setErr((e as Error).message)); }, [reload]);

  return (
    <section className="stab" aria-label="Posts and cast">
      <div className="stab__top">
        <div className="stab__tabs" role="tablist" aria-label="What to show">
          {(Object.keys(tabs) as TabId[]).map((t) => <button key={t} type="button" role="tab" aria-selected={t === tab} className={t === tab ? 'is-on' : ''} onClick={() => { keep({ tab: t }); setQ(''); }}>{tabs[t].label} <b>{tabs[t].items.filter((i) => !i.slot).length}</b></button>)}
        </div>
        <label className="stab__search"><Search size={14} aria-hidden /><input className="text-input" type="search" value={q} placeholder={tab === 'cast' ? 'Search name, trade, look…' : 'Search title, trade, character, keyword…'} aria-label="Search" onChange={(e) => setQ(e.target.value)} /></label>
        <div className="stab__view" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'cards'} title="Cards" aria-label="Cards view" onClick={() => keep({ view: { ...saved.view, [tab]: 'cards' } })}><LayoutGrid size={15} aria-hidden /></button>
          <button type="button" aria-pressed={view === 'list'} title="List" aria-label="List view" onClick={() => keep({ view: { ...saved.view, [tab]: 'list' } })}><List size={15} aria-hidden /></button>
        </div>
      </div>
      <div className="stab__filters">
        {def.filters.map(([k, label, all]) => <label key={k}><span>{label}</span><select className="text-input" value={on[k] ?? ''} onChange={(e) => set(k, e.target.value)}><option value="">{all}</option>{options[k].map(([v, n]) => <option key={v} value={v}>{v} ({n})</option>)}</select></label>)}
        <label><span>Sort</span><span className="stab__sort"><select className="text-input" value={sort} onChange={(e) => keep({ sort: { ...saved.sort, [tab]: e.target.value }, down: { ...saved.down, [tab]: DOWN_FIRST[tab].includes(e.target.value) } })}>{def.sorts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select><button type="button" className="sicon" title={down ? 'Highest or latest first' : 'Lowest or earliest first'} aria-label={down ? 'Sorted highest or latest first. Reverse' : 'Sorted lowest or earliest first. Reverse'} onClick={() => keep({ down: { ...saved.down, [tab]: !down } })}><ArrowDownUp size={14} style={down ? { transform: 'scaleY(-1)' } : undefined} aria-hidden /></button></span></label>
        {active && <button type="button" className="link-btn stab__clear" onClick={() => { setPicked({ ...picked, [tab]: {} }); setQ(''); }}><X size={12} aria-hidden /> Clear</button>}
      </div>
      {err && <div className="card__error">{err}</div>}
      {shown.length === 0 ? <div className="social__empty"><span>{active ? 'Nothing matches those filters.' : def.empty}</span></div>
        : view === 'cards' ? <Showcase key={tab} tab={tab} label={def.label} items={shown} onSlot={toggle} /> : <Rows items={shown} heads={def.heads} wide={tab === 'cast'} onSlot={toggle} />}
      {tab === 'scheduled' && <p className="social__fine">Times are IST. Slots fill in order. Block a free one to keep it for something posted elsewhere.</p>}
      {tab === 'cast' && home.series && <p className="social__fine">{home.series.voices} more voices to cast from. The cast’s files at TopView last until {home.series.assetsExpire}.</p>}
    </section>
  );
}

function Links({ item, later, also = [] }: { item: [string, string][]; later?: string | null; also?: string[] }) {
  return <span className="stab__links">{item.map(([k, u]) => <a key={k} href={u} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{PLACE[k]}{k === 'youtube' && later ? ` (${fmt(ms(later), 'Asia/Kolkata', { day: 'numeric', month: 'short' })})` : ''}</a>)}{also.map((k) => <span key={k}>{PLACE[k] ?? k}</span>)}</span>;
}

// One voice at a time, whichever button started it.
let audio: HTMLAudioElement | null = null;
function useVoice(src?: string): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const mine = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { mine.current?.pause(); }, [src]);
  const play = () => {
    if (!src) return;
    if (on) { mine.current?.pause(); return; }
    audio?.pause();
    const a = new Audio(src);
    audio = a; mine.current = a;
    a.onplay = () => setOn(true); a.onpause = () => setOn(false); a.onended = () => setOn(false); a.onerror = () => setOn(false);
    void a.play().catch(() => setOn(false));
  };
  return [on, play];
}
function VoiceButton({ src, name }: { src: string; name: string }) {
  const [on, play] = useVoice(src);
  return <button type="button" className="btn btn--secondary btn--sm" aria-label={`${on ? 'Stop' : 'Play'} ${name}’s voice`} onClick={play}>{on ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />} Voice</button>;
}

function Rows({ items, heads, wide, onSlot }: { items: Item[]; heads: string[]; wide: boolean; onSlot: (s: { at: string; blocked: boolean }) => void }) {
  return (
    <div className="stab__rows">
      <table className="social__table">
        <thead><tr><th aria-label="Picture" />{heads.map((h) => <th key={h}>{h}</th>)}<th aria-label="Action" /></tr></thead>
        <tbody>{items.map((i) => (
          <tr key={i.key} className={i.slot ? 'is-slot' : ''}>
            <td className={`stab__pic${wide ? ' is-wide' : ''}`}>{i.img ? <img src={i.img} alt="" loading="lazy" /> : <span><CalendarClock size={15} aria-hidden /></span>}</td>
            {i.cells.map((c, n) => <td key={n} data-label={heads[n]}>{c}</td>)}
            <td>{i.slot ? <button type="button" className="btn btn--secondary btn--sm" onClick={() => onSlot(i.slot!)}>{i.slot.blocked ? 'Free it' : 'Block'}</button> : i.open ? <button type="button" className="btn btn--secondary btn--sm" onClick={i.open}>Open</button> : null}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/** What a card offers: the episode, its posts, a voice, a slot to block or free. */
function Acts({ it, onSlot, big }: { it: Item; onSlot: (s: { at: string; blocked: boolean }) => void; big?: boolean }) {
  const [on, play] = useVoice(it.voice);
  return (
    <div className={big ? 'sshow__btns' : 'sshow__cta'}>
      {it.open && <button type="button" className={big ? 'btn btn--primary btn--sm' : ''} onClick={it.open}>Open the episode</button>}
      {it.links.map(([k, u]) => <a key={k} href={u} target="_blank" rel="noreferrer" className={big ? 'btn btn--secondary btn--sm' : ''}>Watch on {PLACE[k]}{k === 'youtube' && it.later ? ` (${fmt(ms(it.later), 'Asia/Kolkata', { day: 'numeric', month: 'short' })})` : ''}</a>)}
      {it.voice && <button type="button" className={big ? 'btn btn--secondary btn--sm' : ''} onClick={play}>{on ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />} {on ? 'Stop the voice' : 'Hear the voice'}</button>}
      {it.slot && <button type="button" className={big ? 'btn btn--secondary btn--sm' : ''} onClick={() => onSlot(it.slot!)}>{it.slot.blocked ? 'Free this slot' : 'Block this slot'}</button>}
    </div>
  );
}
const Pic = ({ it }: { it: Item }) => (it.img
  ? <img src={it.img} alt="" loading="lazy" draggable={false} />
  : <span className="sshow__blank"><CalendarClock size={30} aria-hidden /><b>{it.slot ? (it.slot.blocked ? 'Blocked' : 'Free') : `Ep ${it.num}`}</b><small>{it.at ? ist(it.at) : 'No cover yet'}</small></span>);
/** The first item large, like a page's banner; the rest as cards in a coloured band, four to a row. */
function Showcase({ tab, label, items, onSlot }: { tab: TabId; label: string; items: Item[]; onSlot: (s: { at: string; blocked: boolean }) => void }) {
  const [hero, ...rest] = items;
  return (
    <div className={`sshow is-${tab}`}>
      <article className={`sshow__hero${hero.wide ? ' is-wide' : ''}`}>
        {hero.img && <span className="sshow__glow" style={{ backgroundImage: `url("${hero.img}")` }} aria-hidden />}
        <div className="sshow__say">
          <span className={`sshow__badge is-${hero.tone}`}>{hero.badge}</span>
          <h3>{hero.title}</h3>
          <p>{hero.sub}</p>
          {hero.line && <small>{hero.line}</small>}
          <Acts it={hero} onSlot={onSlot} big />
          {hero.usd !== null && hero.usd > 0 && <small className="sshow__usd">{usd(hero.usd)}</small>}
        </div>
        <span className="sshow__poster"><Pic it={hero} /></span>
      </article>
      {rest.length > 0 && (
        <section className="sshow__band" aria-label={label}>
          <h3>{label}</h3>
          <div className={`sshow__grid${rest[0].wide ? ' is-wide' : ''}`}>
            {rest.map((it) => (
              <article key={it.key} className={`sshow__card is-${it.tone}`}>
                <button type="button" className="sshow__pic" onClick={() => (it.open ? it.open() : it.links[0] ? window.open(it.links[0][1], '_blank', 'noopener') : it.slot ? onSlot(it.slot) : undefined)} aria-label={it.title} tabIndex={it.open || it.links[0] ? 0 : -1}>
                  <Pic it={it} /><span className="sshow__badge">{it.badge}</span>
                </button>
                <div className="sshow__txt"><b>{it.title}</b><span>{it.sub}</span>{it.line && <small>{it.line}</small>}</div>
                <Acts it={it} onSlot={onSlot} />
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
