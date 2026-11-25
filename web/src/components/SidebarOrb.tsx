import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Bot, LiveState, PanelName, ToolCallBody } from '@shared/types';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';
import { prefillComposer } from './Composer';
import { openPanel } from './LivePanels';
import '../styles/orb.css';

/** The icons that open a floating window when clicked (WhatsApp has its own). */
const WINDOW_OF: Record<string, PanelName | undefined> = { email: 'gmail', calendar: 'calendar', youtube: 'youtube', instagram: 'instagram', facebook: 'facebook', linkedin: 'linkedin', sheets: 'sheets' };

/**
 * Zubi HQ's orb and capability ring, at the bottom of the sidebar. The orb shows what the main team member
 * (Zubi) is doing right now, from the app's live state and the tool calls in her chat. While a tool that
 * belongs to a capability runs (Gmail, Calendar, WhatsApp…), a line joins the orb to that icon and small
 * particles flow back and forth through it. Nothing here is decorative: no tool call, no line.
 * Icons, colours, patterns and prompts come from Zubi HQ (video-wiki-tools/console.js).
 */

/**
 * Each capability's icon: the brand's own published file, kept unchanged in web/public/icons/integrations/ (sources
 * and terms are listed in that folder's SOURCES.md). Phone and Profit are generic Lucide line icons, drawn through
 * a mask so they take the ring's colour; brand logos are shown as images in their own colours.
 */
type CapKey = 'email' | 'calendar' | 'whatsapp' | 'linkedin' | 'youtube' | 'instagram' | 'facebook' | 'profit' | 'sheets' | 'notion' | 'phone';
const ICONS: Record<CapKey, { src: string; mask?: boolean; size?: number }> = {
  email: { src: '/icons/integrations/gmail.svg' },
  calendar: { src: '/icons/integrations/google-calendar.svg' },
  whatsapp: { src: '/icons/integrations/whatsapp.svg' },
  linkedin: { src: '/icons/integrations/linkedin.png' },
  youtube: { src: '/icons/integrations/youtube.png', size: 1.35 }, // the official file includes its clear space
  instagram: { src: '/icons/integrations/instagram.png' },
  facebook: { src: 'https://logos.composio.dev/api/facebook' }, // the same logo service Connect apps uses (see SOURCES.md)
  profit: { src: '/icons/integrations/analytics.svg', mask: true },
  sheets: { src: '/icons/integrations/google-sheets.svg' },
  notion: { src: 'https://logos.composio.dev/api/notion' }, // the same logo service Connect apps uses
  phone: { src: '/icons/integrations/phone.svg', mask: true },
};

/** A capability icon (decorative: the button or status line around it carries the name). */
function CapIcon({ k }: { k: CapKey }) {
  const ic = ICONS[k];
  if (!ic) return null;
  const st = ic.size ? ({ ['--is' as string]: ic.size } as CSSProperties) : undefined;
  return ic.mask
    ? <span className="sorb__mask" style={{ ...st, ['--m' as string]: `url(${ic.src})` } as CSSProperties} aria-hidden />
    : <img className="sorb__img" src={ic.src} alt="" draggable={false} style={st} />;
}

interface Cap { k: CapKey; n: string; c: string; re: RegExp; h: string; can: string; ready: 'yes' | 'part' | 'no'; ask: string }

// Same ring order, colours and wording as Zubi HQ. Patterns are Zubi HQ's, narrowed where HeyZubi's own tool
// names would light the wrong icon (whatsapp_draft is not email; create_event_routine is not the calendar).
const CAPS: Cap[] = [
  { k: 'email', n: 'Email', c: '#e8c46a', re: /gmail|e-?mail|inbox|outlook|himalaya|imap|smtp/i, h: 'Checking your inbox', can: 'Read your latest emails, say which need a reply, draft a reply into Drafts (never sends without your yes).', ready: 'yes', ask: 'What are my last two emails, and do they need a reply?' },
  { k: 'calendar', n: 'Calendar', c: '#43d6a1', re: /calendar|gcal/i, h: 'Checking your calendar', can: 'Read today’s events, add an event at a time you say.', ready: 'yes', ask: 'What is on my calendar today?' },
  { k: 'whatsapp', n: 'WhatsApp', c: '#25d366', re: /whatsapp/i, h: 'Preparing a WhatsApp message', can: 'Draft a WhatsApp message, pick the group or number, preview it, and send only after you press Confirm.', ready: 'part', ask: '' },
  { k: 'linkedin', n: 'LinkedIn', c: '#4a8cff', re: /linkedin/i, h: 'Checking LinkedIn', can: 'Write a post (with an image) and publish it after your yes.', ready: 'part', ask: 'Write a LinkedIn post about ' },
  { k: 'youtube', n: 'YouTube', c: '#ff5a4f', re: /youtube|yt-dlp|higgsfield/i, h: 'Working on your video', can: 'Draft a short video and its SEO package (title, description, tags).', ready: 'part', ask: 'Make a 15-second YouTube video about ' },
  // Before Instagram: a Facebook reel is Facebook's, whatever words the tool uses.
  { k: 'facebook', n: 'Facebook', c: '#4a90ff', re: /facebook|\bfb\b/i, h: 'Checking Facebook', can: 'Show your Page’s reels and posts, once Facebook is connected.', ready: 'part', ask: 'Connect my Facebook Page' },
  { k: 'instagram', n: 'Instagram', c: '#f06aa8', re: /instagram|\breel/i, h: 'Checking Instagram', can: 'Make a GIF/reel and publish it after your yes.', ready: 'part', ask: 'Make an Instagram GIF about ' },
  { k: 'profit', n: 'Profit', c: '#c9a6ff', re: /profit|p&l|expense|revenue|ledger|gst/i, h: 'Checking your numbers', can: 'Answer “what is my profit?” from a money log.', ready: 'no', ask: 'What is my profit this month?' },
  { k: 'sheets', n: 'Sheets', c: '#34a853', re: /googlesheets|google ?sheets?|spreadsheet|xlsx|excel|openpyxl|\.csv\b/i, h: 'Working on your sheet', can: 'Show your latest Google Sheets, and build a sheet with totals from numbers you give.', ready: 'yes', ask: 'Build a Google Sheet: ' },
  { k: 'notion', n: 'Notion', c: '#e9e9e7', re: /notion/i, h: 'Reading Notion', can: 'Find and read your Notion pages and databases. Read only: only you and Claude Desktop write to Notion.', ready: 'part', ask: 'Find in my Notion: ' },
  { k: 'phone', n: 'Phone', c: '#ffb35a', re: /\bphone|twilio|vapi|\bsms\b/i, h: 'Placing your call', can: 'Call someone at a set time and ask your questions.', ready: 'no', ask: 'Call ' },
];

// Ring geometry, in the section's own pixels (the sidebar is a fixed width).
const W = 326, H = 236, CX = W / 2, CY = 112, R = 92, ORB = 86;
const POS = CAPS.map((_, i) => {
  const a = ((-90 + (i * 360) / CAPS.length) * Math.PI) / 180;
  return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
});

type Mode = 'idle' | 'thinking' | 'tool' | 'waiting' | 'done';

/** The capability a tool call belongs to: its name, the app tool slugs inside it, and the app the live line names. */
export function capFor(row: ToolCallBody | null, live: LiveState | undefined): Cap | null {
  const parts: string[] = [];
  if (row) {
    parts.push(row.name, row.label);
    // App calls through Composio carry the real tool slugs (GMAIL_FETCH_EMAILS…) in their arguments.
    if (/composio|^[A-Z0-9]+_[A-Z0-9_]+$/.test(row.name) && row.args) parts.push(...(JSON.stringify(row.args).match(/\b[A-Z][A-Z0-9]+_[A-Z0-9_]{3,}\b/g) ?? []).slice(0, 8));
  }
  if (live?.activity?.kind === 'connecting_service' && live.activity.detail) parts.push(live.activity.detail);
  const s = parts.join(' ');
  return s ? CAPS.find((c) => c.re.test(s)) ?? null : null;
}

/** What the orb shows, from real activity only (also drives the Gmail and Calendar panels). */
export function useOrbState(bot: Bot | undefined): { mode: Mode; cap: Cap | null; line: string } {
  const live = useStore((s) => (bot ? s.live[bot.id] : undefined));
  const rows = useStore((s) => (bot ? s.transcripts[bot.id]?.bySeq : undefined));

  // The newest tool call that is still running (or waiting for an approval).
  const current = useMemo(() => {
    if (!rows || !live || !(live.isRunning || live.awaiting)) return null;
    let best: { seq: number; body: ToolCallBody } | null = null;
    for (const r of Object.values(rows)) {
      if (r.body.type !== 'tool-call') continue;
      if (r.body.status !== 'running' && r.body.status !== 'awaiting-approval') continue;
      if (live.startedAt && r.createdAt < live.startedAt - 1000) continue; // a stale row from an earlier turn
      if (!best || r.seq > best.seq) best = { seq: r.seq, body: r.body };
    }
    return best?.body ?? null;
  }, [rows, live]);

  const liveCap = capFor(current, live);
  // A fast tool call would only flash: keep its line for a moment after it ends.
  const [held, setHeld] = useState<Cap | null>(null);
  useEffect(() => {
    if (liveCap) { setHeld(liveCap); return; }
    const t = setTimeout(() => setHeld(null), 1600);
    return () => clearTimeout(t);
  }, [liveCap?.k]); // eslint-disable-line react-hooks/exhaustive-deps

  // A check mark right after a turn finishes, like Zubi HQ.
  const [done, setDone] = useState(false);
  const was = useRef(false);
  useEffect(() => {
    const running = !!live?.isRunning;
    if (was.current && !running && !live?.awaiting) {
      setDone(true);
      const t = setTimeout(() => setDone(false), 2200);
      was.current = running;
      return () => clearTimeout(t);
    }
    was.current = running;
  }, [live?.isRunning, live?.awaiting]);

  const cap = liveCap ?? held;
  let mode: Mode = 'idle';
  if (live?.awaiting) mode = 'waiting';
  else if (live?.isRunning) mode = cap ? 'tool' : live.activity?.kind === 'thinking' || !live.activity ? 'thinking' : 'tool';
  else if (done) mode = 'done';
  const name = bot?.name ?? 'Zubi';
  const line =
    mode === 'waiting' ? `Waiting for you: ${live?.awaiting?.reason ?? ''}`.replace(/: $/, '')
    : mode === 'tool' ? (cap ? cap.h : current?.label ?? 'Working on it')
    : mode === 'thinking' ? 'Thinking…'
    : mode === 'done' ? 'Done'
    : `${name} is ready`;
  return { mode, cap: mode === 'tool' || mode === 'waiting' ? cap : null, line };
}

export function SidebarOrb() {
  const bot = useStore((s) => s.bots.find((b) => b.isPrimary));
  const { mode, cap, line } = useOrbState(bot);
  const [hover, setHover] = useState<Cap | null>(null);
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!bot) return null;

  const pick = (c: Cap) => {
    // WhatsApp, Email, Calendar, LinkedIn, YouTube, Instagram, Facebook and Sheets open their windows; the rest start a request to Zubi.
    if (c.k === 'whatsapp') { useStore.getState().set({ waOpen: true }); return; }
    const win = WINDOW_OF[c.k];
    if (win) { openPanel(win); return; }
    useConfigUI.getState().setView('chat');
    useStore.getState().selectBot(bot.id);
    prefillComposer(bot.id, c.ask);
  };

  const i = cap ? CAPS.indexOf(cap) : -1;
  const to = i >= 0 ? POS[i] : null;
  const path = to ? `M${CX},${CY} L${to.x.toFixed(1)},${to.y.toFixed(1)}` : '';
  const tip = hover ?? null;

  return (
    <section className="sorb" aria-label={`${bot.name}: ${line}`} style={{ ['--cc' as string]: cap?.c ?? 'var(--color-brand)' } as CSSProperties}>
      <div className="sorb__stage" style={{ width: W, height: H }}>
        <svg className="sorb__lines" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden>
          <circle className="sorb__track" cx={CX} cy={CY} r={R} />
          {to && cap && (
            <g key={cap.k} style={{ color: cap.c }}>
              <path className="sorb__pipe" d={path} />
              <path className="sorb__core" d={path} />
              {!reduce && Array.from({ length: 7 }, (_, n) => (
                <circle key={n} className="sorb__atom" r={n % 3 === 0 ? 2.6 : 1.8}>
                  <animateMotion
                    dur={`${1.5 + (n % 3) * 0.25}s`} repeatCount="indefinite" path={path} calcMode="linear"
                    keyPoints={n % 2 ? '1;0;1' : '0;1;0'} keyTimes="0;0.5;1" begin={`-${(n * 0.23).toFixed(2)}s`}
                  />
                </circle>
              ))}
            </g>
          )}
        </svg>

        <div className="sorb__orb" data-m={mode} style={{ left: CX, top: CY, width: ORB, height: ORB }}>
          <div className="sorb__ring" />
          <div className="sorb__ring is-r2" />
          <div className="sorb__ball">
            {mode === 'done' ? <span className="sorb__check">✓</span> : cap ? <span className="sorb__ic"><CapIcon k={cap.k} /></span> : null}
          </div>
        </div>

        {CAPS.map((c, n) => (
          <button
            key={c.k} type="button"
            className={`sorb__node is-${c.ready}${cap?.k === c.k ? ' is-on' : ''}`}
            style={{ left: POS[n].x, top: POS[n].y, ['--nc' as string]: c.c } as CSSProperties}
            onClick={() => pick(c)}
            onMouseEnter={() => setHover(c)} onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(c)} onBlur={() => setHover(null)}
            aria-label={`${c.n}: ${c.can}`}
          >
            <i><CapIcon k={c.k} /></i>
          </button>
        ))}

        {tip && (
          <div className="sorb__tip" role="tooltip">
            <b>{tip.n} · {tip.ready === 'yes' ? 'Ready' : tip.ready === 'part' ? 'Partly ready' : 'Not connected'}</b>
            <span>{tip.can}</span>
            <small>{tip.k === 'whatsapp' || WINDOW_OF[tip.k] ? `Click to open ${tip.n}` : `Click to ask ${bot.name}`}</small>
          </div>
        )}
      </div>
      <div className={`sorb__line is-${mode}`} role="status">{cap && mode === 'tool' ? <b>{cap.n.toUpperCase()}</b> : null}{line}</div>
    </section>
  );
}
