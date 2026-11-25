import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Eye, Forward, Heart, Image as ImageIcon, MessageCircle, Play, Type } from 'lucide-react';
import { useOpeningFrame } from '../lib/floatFrame';
import { create } from 'zustand';
import { useStore } from '../store';
import type { PanelName } from '@shared/types';
import { capFor, useOrbState } from './SidebarOrb';
import { prefillComposer } from './Composer';
import { useConfigUI } from '../configStore';
import { lsGet, lsSet } from '../lib/storage';
import '../styles/livepanels.css';

/**
 * Zubi Live's Gmail and Calendar panels, in the right-hand panel. A panel appears only when the main team member
 * actually uses that capability (the same real-activity signal that lights the orb), shows the latest emails or
 * today's events read live from the app's own Gmail / Google Calendar connection, and goes away when closed or
 * 10 minutes after the last use.
 */

type PanelKey = PanelName;
export const usePanels = create<Record<PanelKey, number | null>>(() => ({ gmail: null, calendar: null, youtube: null, instagram: null, facebook: null, linkedin: null, sheets: null }));
const KEYS: PanelKey[] = ['calendar', 'gmail', 'youtube', 'instagram', 'facebook', 'linkedin', 'sheets'];
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
    const key: PanelKey | null = cap?.k === 'email' ? 'gmail' : cap?.k === 'calendar' ? 'calendar' : cap?.k === 'instagram' ? 'instagram' : cap?.k === 'facebook' ? 'facebook' : cap?.k === 'linkedin' ? 'linkedin' : cap?.k === 'sheets' ? 'sheets' : null;
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
      else if (k === 'calendar' || k === 'instagram' || k === 'facebook' || k === 'linkedin' || k === 'sheets') openPanel(k);
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
  const { gmail, calendar, youtube, instagram, facebook, linkedin, sheets } = usePanels();
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
  if (!gmail && !calendar && !youtube && !instagram && !facebook && !linkedin && !sheets) return null;
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
function GmailPanel() {
  const [data, setData] = useState<{ connected: boolean; emails: Email[]; error?: string; account?: string } | null>(null);
  const load = (fresh: boolean) => {
    fetch(`/api/panels/gmail${fresh ? '?fresh=1' : ''}`, { credentials: 'include' })
      .then((r) => r.json()).then(setData).catch(() => setData({ connected: true, emails: [], error: 'Couldn’t read Gmail just now.' }));
  };
  useEffect(() => { load(true); }, []);
  return (
    <section className="lpanel" aria-label="Gmail">
      <PanelHead title="GMAIL" open="Open" href="https://mail.google.com/" onRefresh={() => load(true)} onClose={() => usePanels.setState({ gmail: null })} />
      {!data ? <p className="lpanel__mut">Loading your inbox…</p>
        : !data.connected ? (
          <p className="lpanel__mut">Zubi has no Gmail account connected in her Composio. Ask her to connect Gmail.</p>
        ) : data.error ? <p className="lpanel__mut">{data.error}</p>
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
        )}
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

/** The posts as a grid (Instagram, YouTube, Facebook), newest first or by any count, with the totals above. */
function SocialGrid({ posts, empty }: { posts: SocialPost[]; empty: string }) {
  const [sort, setSort] = useState<'new' | CountKey>('new');
  const shown = useMemo(() => (sort === 'new' ? posts : [...posts].sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1))), [posts, sort]);
  if (!posts.length) return <p className="lpanel__mut">{empty}</p>;
  return (
    <>
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
  const [data, load] = usePanelData<{ connected: boolean; posts: SocialPost[]; profile?: IgProfile; error?: string }>('instagram', 'Instagram', { connected: true, posts: [] });
  const p = data?.profile;
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
                <div><b>@{p.username}</b>{p.name && <small>{p.name}</small>}</div>
                <span className="lig__stat"><b>{big(p.followers)}</b><small>followers</small></span>
                <span className="lig__stat"><b>{big(p.posts)}</b><small>posts</small></span>
              </div>
            )}
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
function LinkedInPanel() {
  const [data, setData] = useState<{ connected: boolean; profile?: LiProfile; error?: string } | null>(null);
  const load = (fresh: boolean) => {
    fetch(`/api/panels/linkedin${fresh ? '?fresh=1' : ''}`, { credentials: 'include' })
      .then((r) => r.json()).then(setData).catch(() => setData({ connected: true, error: 'Couldn’t read LinkedIn just now.' }));
  };
  useEffect(() => { load(true); }, []);
  const p = data?.profile;
  return (
    <section className="lpanel" aria-label="LinkedIn">
      <PanelHead title="LINKEDIN" open="Open" href={p?.url || 'https://www.linkedin.com/feed/'} onRefresh={() => load(true)} onClose={() => usePanels.setState({ linkedin: null })} />
      {!data ? <p className="lpanel__mut">Loading your LinkedIn…</p>
        : !data.connected ? <p className="lpanel__mut">Zubi has no LinkedIn account connected in her Composio. Ask her to connect LinkedIn.</p>
        : data.error ? <p className="lpanel__mut">{data.error}</p>
        : p && (
          <>
            <div className="lig__prof">
              {p.picture ? <img src={p.picture} alt="" referrerPolicy="no-referrer" /> : <span className="lig__pic" />}
              <div><b>{p.name}</b>{p.url && <small>{p.url.replace(/^https:\/\/www\./, '')}</small>}</div>
            </div>
            {p.headline && <p className="lli__head">{p.headline}</p>}
            <p className="lpanel__mut">LinkedIn doesn’t let apps read your posts or feed. Zubi can write a post (with an image) and publish it after your yes.</p>
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
