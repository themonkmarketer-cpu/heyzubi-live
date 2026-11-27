import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clapperboard, Copy, Eye, Forward, Heart, Image as ImageIcon, ListChecks, MessageCircle, Play, SquareKanban, Table2, Type } from 'lucide-react';
import { useOpeningFrame } from '../lib/floatFrame';
import { create } from 'zustand';
import { useStore } from '../store';
import type { PanelName } from '@shared/types';
import { capFor, useOrbState } from './SidebarOrb';
import { prefillComposer } from './Composer';
import { useConfigUI } from '../configStore';
import { lsGet, lsSet } from '../lib/storage';
import { ReachCheck } from './extras/ReachCheck';
import '../styles/livepanels.css';

/**
 * Zubi Live's Gmail and Calendar panels, in the right-hand panel. A panel appears only when the main team member
 * actually uses that capability (the same real-activity signal that lights the orb), shows the latest emails or
 * today's events read live from the app's own Gmail / Google Calendar connection, and goes away when closed or
 * 10 minutes after the last use.
 */

type PanelKey = PanelName;
export const usePanels = create<Record<PanelKey, number | null>>(() => ({ gmail: null, calendar: null, youtube: null, instagram: null, facebook: null, linkedin: null, sheets: null, notion: null }));
const KEYS: PanelKey[] = ['calendar', 'gmail', 'youtube', 'instagram', 'facebook', 'linkedin', 'sheets', 'notion'];
/** Open a window now (an icon click, a request, or the capability being used). */
export const openPanel = (k: PanelKey) => usePanels.setState({ [k]: Date.now() });
const HIDE_AFTER = 10 * 60_000;

/**
 * Mounted once: opens a window when the team member asks for it (its open_window tool, chat or voice), and as a
 * backup whenever it really uses that capability.
 */
export function CapabilityWatcher() {
  const bot = useStore((s) => s.bots.find((b) => b.isPrimary));
  const { cap } = useOrbState(bot);
  useEffect(() => {
    const key: PanelKey | null = cap?.k === 'email' ? 'gmail' : cap?.k === 'calendar' ? 'calendar' : cap?.k === 'instagram' ? 'instagram' : cap?.k === 'facebook' ? 'facebook' : cap?.k === 'linkedin' ? 'linkedin' : cap?.k === 'sheets' ? 'sheets' : cap?.k === 'notion' ? 'notion' : null;
    if (key) openPanel(key);
  }, [cap?.k]);
  // A fast app call can finish before the orb sees it running: any new calendar or email tool call opens its window too.
  const rows = useStore((s) => (bot ? s.transcripts[bot.id]?.bySeq : undefined));
  const seen = useRef(new Set<number>());
  const since = useRef(Date.now() - 5000);
  useEffect(() => {
    if (!rows) return;
    for (const r of Object.values(rows)) {
      if (r.body.type !== 'tool-call' || seen.current.has(r.seq)) continue;
      seen.current.add(r.seq);
      if (r.createdAt < since.current) continue; // an earlier conversation's call
      const k = capFor(r.body, undefined)?.k;
      if (k === 'email') openPanel('gmail');
      else if (k === 'calendar' || k === 'instagram' || k === 'facebook' || k === 'linkedin' || k === 'sheets' || k === 'notion') openPanel(k);
      // The YouTube icon also lights for video making (Higgsfield, yt-dlp); only a real YouTube call opens its window.
      else if (k === 'youtube' && /youtube/i.test(`${r.body.name} ${r.body.label} ${JSON.stringify(r.body.args ?? '')}`)) openPanel('youtube');
    }
  }, [rows]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ panel: PanelKey; open: boolean }>).detail;
      if (d && KEYS.includes(d.panel)) usePanels.setState({ [d.panel]: d.open ? Date.now() : null });
    };
    window.addEventListener('heyzubi:panel', on);
    return () => window.removeEventListener('heyzubi:panel', on);
  }, []);
  return null;
}

/** The Calendar and Gmail windows: floating in the chat area at the shared size (lib/floatFrame.ts), drag by a title bar. */
export function LivePanels() {
  const { gmail, calendar, youtube, instagram, facebook, linkedin, sheets, notion } = usePanels();
  const waOpen = useStore((s) => s.waOpen);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // One step down and left of the WhatsApp window when both are open, so neither hides the other.
  const frame = useOpeningFrame(waOpen ? 1 : 0);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    const t = e.target as Element;
    if (e.button !== 0 || !t.closest('.lpanel__head') || t.closest('button, a') || !boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || !boxRef.current) return;
    const w = boxRef.current.offsetWidth;
    setPos({ x: Math.max(0, Math.min(window.innerWidth - w, e.clientX - drag.current.dx)), y: Math.max(0, Math.min(window.innerHeight - 60, e.clientY - drag.current.dy)) });
  };
  const onUp = () => { drag.current = null; };
  useEffect(() => {
    const t = setInterval(() => {
      const s = usePanels.getState();
      const now = Date.now();
      const patch: Partial<Record<PanelKey, null>> = {};
      for (const k of KEYS) { const at = s[k]; if (at && now - at > HIDE_AFTER) patch[k] = null; }
      if (Object.keys(patch).length) usePanels.setState(patch);
    }, 30_000);
    return () => clearInterval(t);
  }, []);
  if (!gmail && !calendar && !youtube && !instagram && !facebook && !linkedin && !sheets && !notion) return null;
  return (
    <div
      ref={boxRef} className="lpanels is-floating" role="region" aria-label="Zubi’s windows"
      style={{ left: pos?.x ?? frame.left, top: pos?.y ?? frame.top, right: 'auto', width: frame.width, maxHeight: frame.height }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
    >
      {calendar && <CalendarPanel key={`c${calendar}`} />}
      {gmail && <GmailPanel key={`g${gmail}`} />}
      {youtube && <YouTubePanel key={`y${youtube}`} />}
      {instagram && <InstagramPanel key={`i${instagram}`} />}
      {facebook && <FacebookPanel key={`f${facebook}`} />}
      {linkedin && <LinkedInPanel key={`l${linkedin}`} />}
      {sheets && <SheetsPanel key={`s${sheets}`} />}
      {notion && <NotionPanel key={`n${notion}`} />}
    </div>
  );
}

const ago = (t: number) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

function PanelHead({ title, open, href, onRefresh, onClose }: { title: string; open: string; href: string; onRefresh: () => void; onClose: () => void }) {
  return (
    <div className="lpanel__head">
      <b>{title}</b>
      <a className="lpanel__open" href={href} target="_blank" rel="noreferrer noopener">{open}</a>
      <button type="button" className="lpanel__icon" onClick={onRefresh} aria-label={`Refresh ${title}`} title="Refresh">↻</button>
      <button type="button" className="lpanel__icon" onClick={onClose} aria-label={`Close ${title}`} title="Close">×</button>
    </div>
  );
}

interface Email { id: string; from: string; subject: string; snippet: string; at: number; unread?: boolean }
interface TriageMail { id: string; from: string; email: string; subject: string; snippet: string; at: number; why: string[]; link: string; waitingFor?: number }
interface Triage { connected: boolean; account?: string; vips?: string[]; top: TriageMail[]; waiting: TriageMail[]; error?: string }

function MailRow({ e, waiting }: { e: TriageMail; waiting?: boolean }) {
  return (
    <li className="lmail is-triage">
      <div className="lmail__top"><a href={e.link} target="_blank" rel="noreferrer noopener"><b>{e.from}</b></a><span>{waiting && e.waitingFor ? `waiting ${ago(Date.now() - e.waitingFor)}` : ago(e.at)}</span></div>
      <div className="lmail__subj">{e.subject}</div>
      {e.snippet && <div className="lmail__snip">{e.snippet}</div>}
      {e.why.length > 0 && <div className="lmail__why">{e.why.map((w) => <span key={w} className={w === 'Looks automated' ? 'is-low' : ''}>{w}</span>)}</div>}
    </li>
  );
}

type GmailView = 'latest' | 'triage' | 'waiting';
/** Latest emails; Triage (sorted by who matters, with the reasons); Waiting on you (real people you haven't answered). */
function GmailPanel() {
  const [view, setView] = useState<GmailView>(() => ((['latest', 'triage', 'waiting'] as const).find((v) => v === lsGet('gmailView')) ?? 'latest'));
  const [data, setData] = useState<{ connected: boolean; emails: Email[]; error?: string; account?: string } | null>(null);
  const [tri, setTri] = useState<Triage | null>(null);
  const [vipEdit, setVipEdit] = useState<string | null>(null);
  const loadTriage = (fresh: boolean) => {
    fetch(`/api/panels/gmail/triage${fresh ? '?fresh=1' : ''}`, { credentials: 'include' })
      .then((r) => r.json()).then(setTri).catch(() => setTri({ connected: true, top: [], waiting: [], error: 'Couldn’t sort your inbox just now.' }));
  };
  const load = (fresh: boolean) => {
    fetch(`/api/panels/gmail${fresh ? '?fresh=1' : ''}`, { credentials: 'include' })
      .then((r) => r.json()).then(setData).catch(() => setData({ connected: true, emails: [], error: 'Couldn’t read Gmail just now.' }));
    if (view !== 'latest' || tri) loadTriage(fresh);
  };
  useEffect(() => { load(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (v: GmailView) => { setView(v); lsSet('gmailView', v); if (v !== 'latest' && !tri) loadTriage(false); };
  const saveVips = async () => {
    const list = (vipEdit ?? '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    await fetch('/api/prefs', { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vips: list }) }).catch(() => {});
    setVipEdit(null); setTri(null); loadTriage(true);
  };
  const off = !!data && !data.connected;
  const list = view === 'triage' ? tri?.top ?? [] : tri?.waiting ?? [];
  return (
    <section className="lpanel" aria-label="Gmail">
      <PanelHead title="GMAIL" open="Open" href="https://mail.google.com/" onRefresh={() => load(true)} onClose={() => usePanels.setState({ gmail: null })} />
      {!off && (
        <div className="lmail__tabs" role="tablist" aria-label="Gmail view">
          {([['latest', 'Latest'], ['triage', 'Triage'], ['waiting', 'Waiting on you']] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'is-active' : ''} onClick={() => pick(k)}>
              {l}{k === 'waiting' && tri?.waiting?.length ? ` (${tri.waiting.length})` : ''}
            </button>
          ))}
        </div>
      )}
      {!data ? <p className="lpanel__mut">Loading your inbox…</p>
        : off ? <p className="lpanel__mut">Zubi has no Gmail account connected in her Composio. Ask her to connect Gmail.</p>
        : view === 'latest' ? (data.error ? <p className="lpanel__mut">{data.error}</p>
          : data.emails.length === 0 ? <p className="lpanel__mut">Your inbox is empty.</p>
          : (
            <ul className="lpanel__list">
              {data.account && <li className="lpanel__acct">{data.account}</li>}
              {data.emails.map((e) => (
                <li key={e.id} className={`lmail${e.unread ? ' is-unread' : ''}`}>
                  <div className="lmail__top"><b>{e.from}</b><span>{ago(e.at)}</span></div>
                  <div className="lmail__subj">{e.subject}</div>
                  {e.snippet && <div className="lmail__snip">{e.snippet}</div>}
                </li>
              ))}
            </ul>
          ))
        : !tri ? <p className="lpanel__mut">Sorting your inbox…</p>
        : tri.error ? <p className="lpanel__mut">{tri.error}</p>
        : (
          <>
            {view === 'triage' && (
              <div className="lmail__vips">
                {vipEdit === null
                  ? <span>VIPs: {tri.vips?.length ? tri.vips.join(', ') : 'none yet'} <button type="button" className="link-btn" onClick={() => setVipEdit((tri.vips ?? []).join(', '))}>Edit</button></span>
                  : <span><input className="text-input" value={vipEdit} onChange={(e) => setVipEdit(e.target.value)} placeholder="name@client.com, client.com" aria-label="VIPs: emails or domains" /> <button type="button" className="link-btn" onClick={() => void saveVips()}>Save</button></span>}
              </div>
            )}
            {list.length === 0
              ? <p className="lpanel__mut">{view === 'triage' ? 'Nothing stands out in the last two weeks.' : 'Nobody is waiting on your reply.'}</p>
              : <ul className="lpanel__list">{list.map((e) => <MailRow key={e.id} e={e} waiting={view === 'waiting'} />)}</ul>}
          </>
        )}
      {!off && view === 'waiting' && list.length > 0 && <AskZubi ask="Draft replies (drafts only, don't send) to the people waiting on me in Gmail: " label="Draft replies with Zubi" />}
    </section>
  );
}

interface Ev { id: string; title: string; start: string; end: string; allDay: boolean; where: string; link: string }
const ZONES: [string, string][] = [['LON', 'Europe/London'], ['NYC', 'America/New_York'], ['SYD', 'Australia/Sydney']];
function weekNo(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
}
function CalendarPanel() {
  const [now, setNow] = useState(() => new Date());
  const [data, setData] = useState<{ connected: boolean; events: Ev[]; error?: string; note?: string; accounts?: string[] } | null>(null);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const load = (fresh: boolean) => {
    fetch(`/api/panels/calendar${fresh ? '?fresh=1' : ''}`, { credentials: 'include' })
      .then((r) => r.json()).then(setData).catch(() => setData({ connected: true, events: [], error: 'Couldn’t read the calendar just now.' }));
  };
  useEffect(() => { load(true); }, []);
  const h = now.getHours() % 12, m = now.getMinutes(), s = now.getSeconds();
  const hand = (deg: number, len: number, w: number, cls: string) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return <line className={cls} x1="32" y1="32" x2={32 + len * Math.cos(a)} y2={32 + len * Math.sin(a)} strokeWidth={w} strokeLinecap="round" />;
  };
  const tm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <section className="lpanel" aria-label="Calendar">
      <PanelHead title="CALENDAR" open="Open cal" href="https://calendar.google.com/" onRefresh={() => load(true)} onClose={() => usePanels.setState({ calendar: null })} />
      <div className="lcal__clock">
        <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden>
          <circle cx="32" cy="32" r="30" className="lcal__face" />
          {hand(h * 30 + m / 2, 15, 3, 'lcal__h')}
          {hand(m * 6, 22, 2, 'lcal__m')}
          {hand(s * 6, 25, 1, 'lcal__s')}
        </svg>
        <div>
          <div className="lcal__date"><b>Wk{weekNo(now)}</b> | {now.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} ({now.toLocaleDateString([], { weekday: 'short' })})</div>
          <div className="lcal__time">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
          <div className="lcal__zones">
            {ZONES.map(([n, z]) => <span key={n}><small>{n}</small>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: z })}</span>)}
          </div>
        </div>
      </div>
      {!data ? <p className="lpanel__mut">Loading today…</p>
        : !data.connected ? (
          <p className="lpanel__mut">Zubi has no Google Calendar connected in her Composio. Ask her to connect it.</p>
        ) : data.error ? <p className="lpanel__mut">{data.error}</p>
        : data.events.length === 0 ? <p className="lpanel__mut">Nothing on your calendar today{data.accounts?.length ? ` (${data.accounts.join(', ')})` : ''}.</p>
        : (
          <ul className="lpanel__list">
            {data.note && <li className="lpanel__acct">{data.note}</li>}
            {data.events.map((e) => (
              <li key={e.id} className={`lev${!e.allDay && new Date(e.end).getTime() < now.getTime() ? ' is-past' : ''}`}>
                <span className="lev__time">{e.allDay ? 'All day' : `${tm(e.start)}–${tm(e.end)}`}</span>
                <span className="lev__title">{e.link ? <a href={e.link} target="_blank" rel="noreferrer noopener">{e.title}</a> : e.title}{e.where && <small> · {e.where}</small>}</span>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

/** "Ask Zubi" at the foot of a window: puts a starter request in the main team member's composer. */
function AskZubi({ ask, label }: { ask: string; label: string }) {
  const bot = useStore((s) => s.bots.find((b) => b.isPrimary));
  if (!bot) return null;
  return (
    <button
      type="button" className="lpanel__ask"
      onClick={() => { useConfigUI.getState().setView('chat'); useStore.getState().selectBot(bot.id); prefillComposer(bot.id, ask); }}
    >
      {label}
    </button>
  );
}

export interface SocialPost { id: string; title: string; kind: 'video' | 'picture' | 'album' | 'text'; link: string; thumb: string; at: number; views: number | null; likes: number | null; comments: number | null; shares: number | null }

/** The counts on every post, in the order they're shown; a dash where the app gives no number. */
const COUNTS = [
  { k: 'views', word: 'views', label: 'Views', Icon: Eye },
  { k: 'likes', word: 'likes', label: 'Likes', Icon: Heart },
  { k: 'comments', word: 'comments', label: 'Comments', Icon: MessageCircle },
  { k: 'shares', word: 'shares', label: 'Shares', Icon: Forward },
] as const;
type CountKey = (typeof COUNTS)[number]['k'];

const KIND_ICON = { video: Play, picture: ImageIcon, album: Copy, text: Type };
/** The media-type filter's choices, in this order. */
const KINDS = [
  { k: 'video' as const, label: 'Videos', Icon: Play },
  { k: 'picture' as const, label: 'Images', Icon: ImageIcon },
  { k: 'album' as const, label: 'Carousels', Icon: Copy },
  { k: 'text' as const, label: 'Text', Icon: Type },
];
const big = (n: number) => n.toLocaleString(undefined, n >= 10_000 ? { notation: 'compact', maximumFractionDigits: 1 } : undefined);

/** One tile: the picture, what kind of post it is and its counts; the caption and age on hover. */
function SocialTile({ post }: { post: SocialPost }) {
  const [src, setSrc] = useState(post.thumb);
  useEffect(() => setSrc(post.thumb), [post.thumb]);
  const Kind = KIND_ICON[post.kind];
  const when = post.at ? `${ago(post.at)} ago` : '';
  const label = [post.title || (post.kind === 'video' ? 'Video' : 'Post'), ...COUNTS.filter((c) => post[c.k] !== null).map((c) => `${big(post[c.k]!)} ${c.word}`), when].filter(Boolean).join(', ');
  return (
    <a className="sgrid__tile" href={post.link || undefined} target="_blank" rel="noreferrer noopener" aria-label={label}>
      {src
        // YouTube has no large picture for some videos: fall back to the one every video has.
        ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setSrc(src.includes('/hq720.jpg') ? src.replace('/hq720.jpg', '/mqdefault.jpg') : '')} />
        : <span className="sgrid__text">{post.title || 'No picture'}</span>}
      <span className="sgrid__kind" aria-hidden><Kind size={12} strokeWidth={2.4} fill={post.kind === 'video' ? 'currentColor' : 'none'} /></span>
      <span className="sgrid__hover" aria-hidden><b>{post.title}</b><small>{when}</small></span>
      <span className="sgrid__n" aria-hidden>
        {post.views !== null && <span className="sgrid__views"><Eye size={13} strokeWidth={2.2} />{big(post.views)}</span>}
        <span className="sgrid__row">{COUNTS.slice(1).map((c) => <span key={c.k}><c.Icon size={11} strokeWidth={2.4} />{post[c.k] === null ? '–' : big(post[c.k]!)}</span>)}</span>
      </span>
    </a>
  );
}

/** The posts as a grid (Instagram, YouTube, Facebook, LinkedIn), newest first or by any count, with the totals above. */
function SocialGrid({ posts: all, empty }: { posts: SocialPost[]; empty: string }) {
  const [sort, setSort] = useState<'new' | CountKey>('new');
  const [kind, setKind] = useState<'all' | SocialPost['kind']>('all');
  // Only the media types this account actually has; the filter hides itself when there is just one.
  const kinds = useMemo(() => KINDS.filter((k) => all.some((p) => p.kind === k.k)), [all]);
  const posts = useMemo(() => (kind === 'all' ? all : all.filter((p) => p.kind === kind)), [all, kind]);
  useEffect(() => { if (kind !== 'all' && !all.some((p) => p.kind === kind)) setKind('all'); }, [all, kind]);
  const shown = useMemo(() => (sort === 'new' ? posts : [...posts].sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1))), [posts, sort]);
  if (!all.length) return <p className="lpanel__mut">{empty}</p>;
  return (
    <>
      {kinds.length > 1 && (
        <div className="sgrid__kinds" role="radiogroup" aria-label="Media type">
          {[{ k: 'all' as const, label: 'All', Icon: null }, ...kinds].map((k) => {
            const n = k.k === 'all' ? all.length : all.filter((p) => p.kind === k.k).length;
            return (
              <button key={k.k} type="button" role="radio" aria-checked={kind === k.k} className={kind === k.k ? 'is-active' : ''} onClick={() => setKind(k.k)}>
                {k.Icon && <k.Icon size={11} strokeWidth={2.4} aria-hidden />}{k.label} <span>{n}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="sgrid__bar">
        <div className="sgrid__sort" role="radiogroup" aria-label="Order">
          {[['new', 'Newest'] as const, ...COUNTS.map((c) => [c.k, c.label] as const)].map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={sort === k} className={sort === k ? 'is-active' : ''} onClick={() => setSort(k)}>{l}</button>
          ))}
        </div>
      </div>
      <dl className="sgrid__sum" aria-label={`Totals for these ${posts.length} posts`}>
        {COUNTS.map((c) => {
          const known = posts.filter((p) => p[c.k] !== null);
          return <div key={c.k} title={known.length && known.length < posts.length ? `${known.length} of these ${posts.length} posts have a ${c.word} count` : undefined}><dd><c.Icon size={13} strokeWidth={2.2} aria-hidden />{known.length ? big(known.reduce((a, p) => a + p[c.k]!, 0)) : '–'}</dd><dt>{c.label}</dt></div>;
        })}
      </dl>
      <div className="sgrid">{shown.map((p) => <SocialTile key={p.id} post={p} />)}</div>
    </>
  );
}

/** Loads a window's data; `load(true)` asks again now. */
function usePanelData<T>(path: string, name: string, fallback: T): [T | null, (fresh: boolean) => void] {
  const [data, setData] = useState<T | null>(null);
  const asked = useRef(0);
  const load = (fresh: boolean) => {
    const mine = ++asked.current; // a slower answer for another Page must not replace a newer one
    fetch(`/api/panels/${path}${fresh ? `${path.includes('?') ? '&' : '?'}fresh=1` : ''}`, { credentials: 'include' })
      .then((r) => r.json()).then((j) => { if (mine === asked.current) setData(j); })
      .catch(() => { if (mine === asked.current) setData({ ...fallback, error: `Couldn’t read ${name} just now.` }); });
  };
  useEffect(() => { setData(null); load(true); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  return [data, load];
}

function YouTubePanel() {
  const [data, load] = usePanelData<{ configured: boolean; posts: SocialPost[]; channel?: string; studio?: string; error?: string }>('youtube', 'YouTube', { configured: true, posts: [] });
  return (
    <section className="lpanel" aria-label="YouTube">
      <PanelHead title="YOUTUBE" open="Studio" href={data?.studio ?? 'https://studio.youtube.com/'} onRefresh={() => load(true)} onClose={() => usePanels.setState({ youtube: null })} />
      {!data ? <p className="lpanel__mut">Loading your channel…</p>
        : !data.configured ? <p className="lpanel__mut">No YouTube channel is set for this app yet.</p>
        : data.error ? <p className="lpanel__mut">{data.error}</p>
        : (
          <>
            {data.channel && <div className="lig__prof"><img src="/icons/integrations/youtube.png" alt="" className="is-mark" /><div><b>{data.channel}</b><small>Latest public videos</small></div></div>}
            <SocialGrid posts={data.posts} empty="No public videos yet. Private uploads don’t show here." />
          </>
        )}
      <AskZubi ask="Make a 15-second YouTube video about " label="Make a video with Zubi" />
    </section>
  );
}

interface IgProfile { username: string; name: string; followers: number; posts: number; picture: string }
function InstagramPanel() {
  // Which account to show: the one picked before, else the server's choice (the series' own account).
  const [acct, setAcct] = useState(() => lsGet('igAccount') ?? '');
  const [data, load] = usePanelData<{ connected: boolean; posts: SocialPost[]; profile?: IgProfile; account?: string; accounts?: { id: string; label: string }[]; error?: string }>(`instagram${acct ? `?account=${encodeURIComponent(acct)}` : ''}`, 'Instagram', { connected: true, posts: [] });
  const p = data?.profile;
  const pick = (id: string) => { lsSet('igAccount', id); setAcct(id); };
  return (
    <section className="lpanel" aria-label="Instagram">
      <PanelHead title="INSTAGRAM" open="Open" href={p?.username ? `https://www.instagram.com/${encodeURIComponent(p.username)}/` : 'https://www.instagram.com/'} onRefresh={() => load(true)} onClose={() => usePanels.setState({ instagram: null })} />
      {!data ? <p className="lpanel__mut">Loading your Instagram…</p>
        : !data.connected ? <p className="lpanel__mut">Zubi has no Instagram account connected in her Composio. Ask her to connect Instagram.</p>
        : data.error ? <p className="lpanel__mut">{data.error}</p>
        : (
          <>
            {p && (
              <div className="lig__prof">
                {p.picture ? <img src={p.picture} alt="" referrerPolicy="no-referrer" /> : <span className="lig__pic" />}
                <div>
                  {(data.accounts?.length ?? 0) > 1 ? (
                    <select className="lfb__pick" aria-label="Instagram account" value={data.account} onChange={(e) => pick(e.target.value)}>
                      {data.accounts!.map((x) => <option key={x.id} value={x.id}>@{x.label}</option>)}
                    </select>
                  ) : <b>@{p.username}</b>}
                  {p.name && <small>{p.name}</small>}
                </div>
                <span className="lig__stat"><b>{big(p.followers)}</b><small>followers</small></span>
                <span className="lig__stat"><b>{big(p.posts)}</b><small>posts</small></span>
              </div>
            )}
            {data.posts.length > 0 && <ReachCheck key={data.account ?? ''} posts={data.posts} followers={p?.followers} />}
            <SocialGrid posts={data.posts} empty="No posts yet." />
          </>
        )}
      <AskZubi ask="Make an Instagram GIF about " label="Make a post with Zubi" />
    </section>
  );
}

interface FbProfile { name: string; followers: number | null; link: string }
function FacebookPanel() {
  // Which Page to show: the one picked before, else the server's choice (the handle that matches Instagram).
  const [page, setPage] = useState(() => lsGet('fbPage') ?? '');
  const [data, load] = usePanelData<{ connected: boolean; posts: SocialPost[]; page?: string; pages?: { id: string; name: string; username: string }[]; profile?: FbProfile; note?: string; error?: string }>(`facebook${page ? `?page=${encodeURIComponent(page)}` : ''}`, 'Facebook', { connected: true, posts: [] });
  const p = data?.profile;
  const pick = (id: string) => { lsSet('fbPage', id); setPage(id); };
  return (
    <section className="lpanel" aria-label="Facebook">
      <PanelHead title="FACEBOOK" open="Open" href={p?.link || 'https://www.facebook.com/'} onRefresh={() => load(true)} onClose={() => usePanels.setState({ facebook: null })} />
      {!data ? <p className="lpanel__mut">Loading your Facebook Page…</p>
        : !data.connected ? <p className="lpanel__mut">Facebook isn’t connected yet. Ask Zubi to connect it: she sends you a link, you sign in to Facebook and pick your Page. Then press ↻ here.</p>
        : data.error ? <p className="lpanel__mut">{data.error}</p>
        : (
          <>
            {p && (
              <div className="lig__prof">
                <img src="https://logos.composio.dev/api/facebook" alt="" className="is-mark" />
                <div>
                  {(data.pages?.length ?? 0) > 1 ? (
                    <select className="lfb__pick" aria-label="Facebook Page" value={data.page} onChange={(e) => pick(e.target.value)}>
                      {data.pages!.map((x) => <option key={x.id} value={x.id}>{x.name}{x.username ? ` (@${x.username})` : ''}</option>)}
                    </select>
                  ) : <b>{p.name}</b>}
                  <small>Facebook Page</small>
                </div>
                {p.followers !== null && <span className="lig__stat"><b>{big(p.followers)}</b><small>followers</small></span>}
              </div>
            )}
            {data.note && <div className="lpanel__acct">{data.note}</div>}
            {p && <SocialGrid posts={data.posts} empty="No posts on this Page yet." />}
          </>
        )}
      {data && !data.connected
        ? <AskZubi ask="Connect my Facebook Page to your Composio and send me the sign-in link." label="Connect Facebook with Zubi" />
        : <AskZubi ask="Make a Facebook post about " label="Make a post with Zubi" />}
    </section>
  );
}

interface LiProfile { name: string; headline: string; picture: string; url: string }
interface LiExport { at: number; file: string; posts: SocialPost[] }
function LinkedInPanel() {
  const [data, load] = usePanelData<{ connected: boolean; profile?: LiProfile; export?: LiExport | null; error?: string }>('linkedin', 'LinkedIn', { connected: true });
  // The file last uploaded (or removed) here, which is newer than what the window loaded with.
  const [own, setOwn] = useState<LiExport | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [sure, setSure] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const p = data?.profile;
  const exp = own === undefined ? data?.export ?? null : own;
  const send = async (init: RequestInit) => {
    setBusy(true); setProblem(''); setSure(false);
    try {
      const r = await fetch('/api/panels/linkedin/export', { credentials: 'include', ...init });
      const j = await r.json();
      if (r.ok) setOwn(j.export); else setProblem(j.error ?? 'That file couldn’t be read.');
    } catch { setProblem('Couldn’t reach the server. Try again.'); }
    setBusy(false);
  };
  const upload = (f?: File) => {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { setProblem('That file is too big (8 MB at most).'); return; }
    void send({ method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) }, body: f });
  };
  return (
    <section className="lpanel" aria-label="LinkedIn">
      <PanelHead title="LINKEDIN" open="Open" href={p?.url || 'https://www.linkedin.com/feed/'} onRefresh={() => load(true)} onClose={() => usePanels.setState({ linkedin: null })} />
      <input ref={file} type="file" hidden accept=".xls,.xlsx,.csv" aria-label="LinkedIn export file" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
      {!data ? <p className="lpanel__mut">Loading your LinkedIn…</p>
        : exp ? (
          <>
            <div className="lig__prof">
              <img src="https://logos.composio.dev/api/linkedin" alt="" className="is-mark" />
              <div><b>LinkedIn Page</b><small title={exp.file}>Uploaded {new Date(exp.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</small></div>
              <span className="lli__acts">
                <button type="button" disabled={busy} onClick={() => file.current?.click()}>{busy ? 'Reading…' : 'Update'}</button>
                <button type="button" disabled={busy} onClick={() => (sure ? void send({ method: 'DELETE' }) : setSure(true))} onBlur={() => setSure(false)}>{sure ? 'Remove all?' : 'Remove'}</button>
              </span>
            </div>
            {problem && <p className="lli__bad" role="alert">{problem}</p>}
            <SocialGrid posts={exp.posts} empty="No posts in that file." />
            <p className="lli__note">Views are LinkedIn’s impressions. To refresh them, export again and press Update.</p>
          </>
        ) : (
          <>
            {p && (
              <div className="lig__prof">
                {p.picture ? <img src={p.picture} alt="" referrerPolicy="no-referrer" /> : <span className="lig__pic" />}
                <div><b>{p.name}</b>{p.url && <small>{p.url.replace(/^https:\/\/www\./, '')}</small>}</div>
              </div>
            )}
            {data.error ? <p className="lpanel__mut">{data.error}</p> : !data.connected && <p className="lpanel__mut">Zubi has no LinkedIn account connected in her Composio. Ask her to connect LinkedIn.</p>}
            <p className="lli__head">LinkedIn doesn’t let apps read your Page’s posts. To see their views, likes, comments and shares here, on LinkedIn open your Page, then <b>Analytics</b>, <b>Content</b>, <b>Export</b>, and upload that file.</p>
            {problem && <p className="lli__bad" role="alert">{problem}</p>}
            <button type="button" className="lli__up" disabled={busy} onClick={() => file.current?.click()}>{busy ? 'Reading…' : 'Upload the export'}</button>
          </>
        )}
      <AskZubi ask="Write a LinkedIn post about " label="Write a post with Zubi" />
    </section>
  );
}

interface Sheet { id: string; name: string; at: number; by: string; link: string }
function SheetsPanel() {
  const [data, setData] = useState<{ connected: boolean; sheets: Sheet[]; account?: string; error?: string } | null>(null);
  const load = (fresh: boolean) => {
    fetch(`/api/panels/sheets${fresh ? '?fresh=1' : ''}`, { credentials: 'include' })
      .then((r) => r.json()).then(setData).catch(() => setData({ connected: true, sheets: [], error: 'Couldn’t read Google Sheets just now.' }));
  };
  useEffect(() => { load(true); }, []);
  return (
    <section className="lpanel" aria-label="Google Sheets">
      <PanelHead title="SHEETS" open="Open" href="https://docs.google.com/spreadsheets/" onRefresh={() => load(true)} onClose={() => usePanels.setState({ sheets: null })} />
      {!data ? <p className="lpanel__mut">Loading your sheets…</p>
        : !data.connected ? <p className="lpanel__mut">Zubi has no Google Sheets account connected in her Composio. Ask her to connect Google Sheets.</p>
        : data.error ? <p className="lpanel__mut">{data.error}</p>
        : data.sheets.length === 0 ? <p className="lpanel__mut">No spreadsheets yet.</p>
        : (
          <>
            {data.account && <div className="lpanel__acct">{data.account} · recently changed</div>}
            <ul className="lpanel__list">
              {data.sheets.map((x) => (
                <li key={x.id} className="lsheet">
                  <img src="/icons/integrations/google-sheets.svg" alt="" />
                  <div className="lmedia__body">
                    <a href={x.link} target="_blank" rel="noreferrer noopener" className="lmedia__title">{x.name}</a>
                    <span className="lmedia__meta">{ago(x.at)} ago{x.by ? ` · by ${x.by}` : ''}</span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      <AskZubi ask="Build a Google Sheet: " label="Build a sheet with Zubi" />
    </section>
  );
}

// ---------- Notion: reel signals from the post tracker, task signals, recently edited pages and memories ----------

type NSection<T> = { state: 'ok'; data: T } | { state: 'unset' | 'unshared' | 'error'; error?: string };
interface NPost { title: string; platform: string; status: string; at: string; views: number | null; likes: number | null; comments: number | null; link: string; page: string }
interface NTask { title: string; status: string; due: string; project: string; page: string }
interface NPage { title: string; kind?: string; type?: string; at: number; page: string }
interface NotionData {
  connected: boolean; configured?: boolean; error?: string; loading?: boolean; refreshing?: boolean; at?: number;
  posts?: NSection<{ totals: { posts: number; views: number; likes: number; comments: number }; platforms: { name: string; posts: number; views: number; likes: number; comments: number }[]; best: NPost | null; fresh72: number; scheduled: { count: number; next: NPost | null }; upcoming?: NPost[]; latest: NPost[] }>;
  tasks?: NSection<{ open: number; items?: NTask[]; done?: NTask[]; overdue: NTask[]; today: NTask[]; soon: NTask[]; waiting: NTask[] }>;
  memories?: NSection<NPage[]>;
  recent?: NSection<NPage[]>;
  links?: { memories?: string };
}

const day = (iso: string) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');

/** Why a section has nothing to show. */
function NWhy({ s, what }: { s: NSection<unknown> | undefined; what: string }) {
  if (!s || s.state === 'ok') return null;
  return (
    <p className="lpanel__mut">
      {s.state === 'unshared' ? `Zubi’s Notion connection can’t see ${what} yet. In Notion, open it, then ••• › Connections, and add Composio (Zubi’s connection).`
        : s.state === 'unset' ? `No ${what} is set for this window.`
        : s.error ?? `Couldn’t read ${what} just now.`}
    </p>
  );
}

const NLink = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
  href ? <a href={href} target="_blank" rel="noreferrer noopener" className={className}>{children}</a> : <span className={className}>{children}</span>;

function NotionPanel() {
  const [data, load] = usePanelData<NotionData>('notion', 'Notion', { connected: true });
  // The server reads Notion in the background (a minute or more); check back while it does.
  useEffect(() => {
    if (!data?.loading && !data?.refreshing) return;
    const t = setTimeout(() => load(false), 6000);
    return () => clearTimeout(t);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ q: string; results: NPage[]; error?: string } | null>(null);
  const search = (e?: React.FormEvent) => {
    e?.preventDefault();
    const s = q.trim();
    if (!s) { setFound(null); return; }
    fetch(`/api/panels/notion/search?q=${encodeURIComponent(s)}`, { credentials: 'include' })
      .then((r) => r.json()).then((j) => setFound({ q: s, results: j.results ?? [], error: j.error }))
      .catch(() => setFound({ q: s, results: [], error: 'Couldn’t search Notion just now.' }));
  };
  return (
    <section className="lpanel lnotion" aria-label="Notion">
      <PanelHead title="NOTION" open="Open" href="https://www.notion.so/" onRefresh={() => load(true)} onClose={() => usePanels.setState({ notion: null })} />
      <form className="lnotion__search" onSubmit={search} role="search">
        <input type="search" value={q} onChange={(e) => { setQ(e.target.value); if (!e.target.value) setFound(null); }} placeholder="Find a Notion page…" aria-label="Find a Notion page" maxLength={100} />
      </form>
      {!found && data?.at ? <div className="lpanel__acct">Read {ago(data.at) === 'now' ? 'just now' : `${ago(data.at)} ago`}{data.refreshing ? ' · updating…' : ''}</div> : null}
      {found ? (
        <div className="lnotion__sec">
          <h4>Pages matching “{found.q}”</h4>
          {found.error ? <p className="lpanel__mut">{found.error}</p> : !found.results.length ? <p className="lpanel__mut">Nothing Zubi’s Notion connection can see matches.</p> : (
            <ul className="lpanel__list">{found.results.map((p, i) => <li key={i} className="lnotion__row"><NLink href={p.page} className="lmedia__title">{p.title}</NLink><span className="lmedia__meta">{p.kind === 'database' ? 'Database · ' : ''}{ago(p.at)} ago</span></li>)}</ul>
          )}
        </div>
      ) : !data ? <p className="lpanel__mut">Loading your Notion…</p>
        : data.loading ? <p className="lpanel__mut">Reading your Notion. The first read takes a minute or two (long task notes come one at a time); this fills in by itself.</p>
        : data.error ? <p className="lpanel__mut">{data.error}</p>
        : (
          <NotionViews data={data} />
        )}
      <AskZubi ask="Find in my Notion: " label="Ask Zubi about Notion" />
    </section>
  );
}

// ---------- Notion views: the task list and post tracker shown the way Notion's own templates show them ----------

type NView = 'todo' | 'table' | 'board' | 'calendar' | 'content';
const NVIEWS: { id: NView; label: string; Icon: typeof ListChecks }[] = [
  { id: 'todo', label: 'To-do', Icon: ListChecks },
  { id: 'table', label: 'Table', Icon: Table2 },
  { id: 'board', label: 'Board', Icon: SquareKanban },
  { id: 'calendar', label: 'Calendar', Icon: CalendarDays },
  { id: 'content', label: 'Content', Icon: Clapperboard },
];
const NVIEW_KEY = 'hz.notion.view';

/** Local YYYY-MM-DD for a date (the owner's own day). */
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return isoDay(d); };

/** What a Notion status means, for its colour and its board column. */
type NKind = 'todo' | 'doing' | 'waiting' | 'blocked' | 'done';
const kindOf = (status: string): NKind =>
  /done|complete|implemented|shipped|published/i.test(status) ? 'done' : /block/i.test(status) ? 'blocked' : /wait|draft|review/i.test(status) ? 'waiting' : /progress|doing|working/i.test(status) ? 'doing' : 'todo';
const KIND_ORDER: NKind[] = ['todo', 'doing', 'waiting', 'blocked', 'done'];
/** Board and table order: the way work moves; a status that says nothing (Unknown, none) goes last. */
const rankOf = (status: string) => (!status || /unknown/i.test(status) ? 99 : KIND_ORDER.indexOf(kindOf(status)));

const NStatus = ({ s }: { s: string }) => <span className={`nstatus is-${kindOf(s)}`}>{s || 'No status'}</span>;

type NPosts = Extract<NonNullable<NotionData['posts']>, { state: 'ok' }>['data'];

function NotionViews({ data }: { data: NotionData }) {
  const [view, setViewState] = useState<NView>(() => {
    const v = lsGet(NVIEW_KEY);
    return NVIEWS.some((x) => x.id === v) ? (v as NView) : 'todo';
  });
  const setView = (v: NView) => { setViewState(v); lsSet(NVIEW_KEY, v); };
  const tasks = data.tasks?.state === 'ok' ? data.tasks.data : null;
  const posts = data.posts?.state === 'ok' ? data.posts.data : null;
  // An older answer (before `items`) still works: its buckets hold the tasks that matter most.
  const items = tasks ? tasks.items ?? [...new Map([...tasks.overdue, ...tasks.today, ...tasks.soon, ...tasks.waiting].map((t) => [t.page || t.title, t])).values()] : [];
  const done = tasks?.done ?? [];
  const today = isoDay(new Date());
  return (
    <>
      <div className="nviews" role="tablist" aria-label="Notion views">
        {NVIEWS.map(({ id, label, Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} className={`nviews__tab${view === id ? ' is-active' : ''}`} onClick={() => setView(id)}>
            <Icon size={13} strokeWidth={2} aria-hidden />{label}
          </button>
        ))}
      </div>
      {view === 'content' ? (
        <>
          <NWhy s={data.posts} what="the post tracker" />
          {posts && <NContent posts={posts} />}
        </>
      ) : (
        <>
          <NWhy s={data.tasks} what="the task list" />
          {tasks && (view === 'todo' ? <NTodo items={items} done={done} today={today} />
            : view === 'table' ? <NTable items={items} today={today} />
            : view === 'board' ? <NBoard items={items} done={done} today={today} />
            : <NCalendar items={items} posts={posts?.upcoming ?? []} today={today} />)}
        </>
      )}
    </>
  );
}

/** To-do list: checkboxes grouped by when they are due. */
function NTodo({ items, done, today }: { items: NTask[]; done: NTask[]; today: string }) {
  const [showDone, setShowDone] = useState(false);
  const week = addDays(today, 7);
  const groups: { label: string; warn?: boolean; list: NTask[] }[] = [
    { label: 'Overdue', warn: true, list: items.filter((t) => t.due && t.due < today) },
    { label: 'Today', list: items.filter((t) => t.due === today) },
    { label: 'Next 7 days', list: items.filter((t) => t.due > today && t.due <= week) },
    { label: 'Later', list: items.filter((t) => t.due > week) },
    { label: 'No date', list: items.filter((t) => !t.due) },
  ].filter((g) => g.list.length);
  if (!items.length && !done.length) return <p className="lpanel__mut">No open tasks. Nice.</p>;
  const row = (t: NTask, i: number, isDone = false) => (
    <li key={i} className={`ntodo__item${isDone ? ' is-done' : ''}`}>
      <span className={`ntodo__box is-${isDone ? 'done' : kindOf(t.status)}`} aria-hidden>{isDone && <Check size={10} strokeWidth={3} />}</span>
      <span className="ntodo__body">
        <NLink href={t.page} className="ntodo__title">{t.title}</NLink>
        <span className="lmedia__meta">{[t.due && day(t.due), t.status, t.project].filter(Boolean).join(' · ')}</span>
      </span>
    </li>
  );
  return (
    <div className="ntodo">
      {groups.map((g) => (
        <div key={g.label} className="ntodo__group">
          <h4 className={g.warn ? 'is-warn' : undefined}>{g.label} <span>{g.list.length}</span></h4>
          <ul>{g.list.map((t, i) => row(t, i))}</ul>
        </div>
      ))}
      {done.length > 0 && (
        <div className="ntodo__group">
          <button type="button" className="ntodo__more" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
            {showDone ? 'Hide' : 'Show'} done this week ({done.length})
          </button>
          {showDone && <ul>{done.map((t, i) => row(t, i, true))}</ul>}
        </div>
      )}
    </div>
  );
}

/** Table: one row per task, sorted by the column header picked. */
function NTable({ items, today }: { items: NTask[]; today: string }) {
  const [sort, setSort] = useState<'due' | 'status' | 'title'>('due');
  const rows = useMemo(() => {
    const l = [...items];
    const due = (t: NTask) => t.due || '9999';
    if (sort === 'title') l.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'status') l.sort((a, b) => rankOf(a.status) - rankOf(b.status) || a.status.localeCompare(b.status));
    else l.sort((a, b) => (due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : 0));
    return l;
  }, [items, sort]);
  if (!items.length) return <p className="lpanel__mut">No open tasks.</p>;
  const th = (k: typeof sort, label: string) => (
    <th aria-sort={sort === k ? 'ascending' : 'none'}><button type="button" onClick={() => setSort(k)} className={sort === k ? 'is-on' : undefined}>{label}</button></th>
  );
  return (
    <div className="ntable">
      <table>
        <thead><tr>{th('title', 'Task')}{th('status', 'Status')}{th('due', 'Due')}</tr></thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={i}>
              <td><NLink href={t.page} className="ntable__title">{t.title}</NLink>{t.project && <span className="ntable__proj">{t.project}</span>}</td>
              <td><NStatus s={t.status} /></td>
              <td className={t.due && t.due < today ? 'is-warn' : undefined}>{t.due ? day(t.due) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Board: a column per status, in the order work moves. */
function NBoard({ items, done, today }: { items: NTask[]; done: NTask[]; today: string }) {
  const cols = useMemo(() => {
    const m = new Map<string, NTask[]>();
    for (const t of [...items, ...done]) { const k = t.status || 'No status'; m.set(k, [...(m.get(k) ?? []), t]); }
    return [...m.entries()].sort(([a], [b]) => rankOf(a) - rankOf(b));
  }, [items, done]);
  if (!cols.length) return <p className="lpanel__mut">No tasks to show.</p>;
  return (
    <div className="nboard" role="list">
      {cols.map(([status, list]) => (
        <div key={status} className={`nboard__col is-${kindOf(status)}`} role="listitem" aria-label={`${status}: ${list.length}`}>
          <div className="nboard__head"><NStatus s={status} /><span>{list.length}</span></div>
          {list.map((t, i) => (
            <NLink key={i} href={t.page} className="nboard__card">
              <span className="nboard__title">{t.title}</span>
              {(t.due || t.project) && (
                <span className="nboard__meta">
                  {t.due && <span className={kindOf(status) !== 'done' && t.due < today ? 'is-warn' : undefined}>{day(t.due)}</span>}
                  {t.project && <span className="lnotion__tag">{t.project}</span>}
                </span>
              )}
            </NLink>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Calendar: a month of tasks by due date and posts by publish date; the picked day's list below. */
function NCalendar({ items, posts, today }: { items: NTask[]; posts: NPost[]; today: string }) {
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [pick, setPick] = useState(today);
  const byDay = useMemo(() => {
    const m = new Map<string, { tasks: NTask[]; posts: NPost[] }>();
    const at = (d: string) => { if (!m.has(d)) m.set(d, { tasks: [], posts: [] }); return m.get(d)!; };
    for (const t of items) if (t.due) at(t.due).tasks.push(t);
    for (const p of posts) if (p.at) at(isoDay(new Date(p.at))).posts.push(p);
    return m;
  }, [items, posts]);
  const first = new Date(`${month}-01T12:00:00`);
  const lead = (first.getDay() + 6) % 7; // weeks start on Monday
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  const shift = (n: number) => { const d = new Date(first); d.setMonth(d.getMonth() + n); setMonth(isoDay(d).slice(0, 7)); };
  const sel = byDay.get(pick);
  const undated = items.filter((t) => !t.due).length;
  return (
    <div className="ncal">
      <div className="ncal__bar">
        <button type="button" className="lpanel__icon" onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft size={14} /></button>
        <b>{first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</b>
        <button type="button" className="lpanel__icon" onClick={() => shift(1)} aria-label="Next month"><ChevronRight size={14} /></button>
      </div>
      <div className="ncal__grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="ncal__dow" aria-hidden>{d}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={i} />;
          const e = byDay.get(d);
          const late = !!e?.tasks.length && d < today;
          return (
            <button key={i} type="button" aria-pressed={pick === d}
              className={`ncal__day${d === today ? ' is-today' : ''}${pick === d ? ' is-pick' : ''}`} onClick={() => setPick(d)}
              aria-label={`${day(d)}: ${e?.tasks.length ?? 0} tasks, ${e?.posts.length ?? 0} posts`}>
              <span>{Number(d.slice(8))}</span>
              <span className="ncal__dots" aria-hidden>
                {e?.tasks.slice(0, 3).map((_, j) => <i key={`t${j}`} className={late ? 'is-warn' : 'is-task'} />)}
                {e?.posts.slice(0, 2).map((_, j) => <i key={`p${j}`} className="is-post" />)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="lnotion__sec">
        <h4>{pick === today ? 'Today' : day(pick)}</h4>
        {!sel || (!sel.tasks.length && !sel.posts.length) ? <p className="lpanel__mut">Nothing due{undated ? ` · ${undated} tasks have no date` : ''}.</p> : (
          <ul className="lpanel__list">
            {sel.tasks.map((t, i) => <li key={`t${i}`} className="ncal__item"><i className={pick < today ? 'is-warn' : 'is-task'} aria-hidden /><NLink href={t.page} className="lmedia__title">{t.title}</NLink><NStatus s={t.status} /></li>)}
            {sel.posts.map((p, i) => <li key={`p${i}`} className="ncal__item"><i className="is-post" aria-hidden /><NLink href={p.page} className="lmedia__title">{p.title}</NLink><span className="lnotion__tag">{p.platform || 'Post'}</span></li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Content calendar: what's scheduled next, then how the live posts are doing. */
function NContent({ posts }: { posts: NPosts }) {
  const upcoming = posts.upcoming ?? (posts.scheduled.next ? [posts.scheduled.next] : []);
  return (
    <div className="ncontent">
      <div className="lnotion__sec">
        <h4>Scheduled <span className="ncontent__n">{posts.scheduled.count}</span></h4>
        {!upcoming.length ? <p className="lpanel__mut">Nothing scheduled.</p> : (
          <ul className="lpanel__list">
            {upcoming.map((p, i) => (
              <li key={i} className="ncontent__row">
                <span className="ncontent__date"><b>{new Date(p.at).getDate()}</b>{new Date(p.at).toLocaleDateString(undefined, { month: 'short' })}</span>
                <NLink href={p.page} className="lmedia__title">{p.title}</NLink>
                <span className="lnotion__tag">{p.platform || 'Post'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="lnotion__sec">
        <h4>Live <span className="ncontent__n">{posts.totals.posts}</span></h4>
        <dl className="sgrid__sum" aria-label={`Totals for ${posts.totals.posts} live posts`}>
          <div><dd><Eye size={13} strokeWidth={2.2} aria-hidden />{big(posts.totals.views)}</dd><dt>Views</dt></div>
          <div><dd><Heart size={13} strokeWidth={2.2} aria-hidden />{big(posts.totals.likes)}</dd><dt>Likes</dt></div>
          <div><dd><MessageCircle size={13} strokeWidth={2.2} aria-hidden />{big(posts.totals.comments)}</dd><dt>Comments</dt></div>
          <div><dd>{posts.fresh72}</dd><dt>First 72 h</dt></div>
        </dl>
        {posts.best && <p className="lnotion__line">Best this week: <NLink href={posts.best.link || posts.best.page}>{posts.best.title}</NLink> ({posts.best.platform}, {big(posts.best.views ?? 0)} views)</p>}
        <ul className="lpanel__list">
          {posts.latest.map((p, i) => (
            <li key={i} className="lnotion__post">
              <span className="lnotion__tag">{p.platform || '—'}</span>
              <NLink href={p.link || p.page} className="lmedia__title">{p.title}</NLink>
              <span className="lnotion__n"><Eye size={11} aria-hidden />{p.views === null ? '–' : big(p.views)} <Heart size={11} aria-hidden />{p.likes === null ? '–' : big(p.likes)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
