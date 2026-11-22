import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Bot, LiveState, ToolCallBody } from '@shared/types';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';
import { prefillComposer } from './Composer';
import '../styles/orb.css';

/**
 * Zubi HQ's orb and capability ring, at the bottom of the sidebar. The orb shows what the main team member
 * (Zubi) is doing right now, from the app's live state and the tool calls in her chat. While a tool that
 * belongs to a capability runs (Gmail, Calendar, WhatsApp…), a line joins the orb to that icon and small
 * particles flow back and forth through it. Nothing here is decorative: no tool call, no line.
 * Icons, colours, patterns and prompts come from Zubi HQ (video-wiki-tools/console.js).
 */

const L = {
  email: '<svg viewBox="0 0 24 24"><rect x="2" y="4.5" width="20" height="15" rx="2" fill="#f5f5f5"/><path d="M3.6 18.5V7.6L12 14l8.4-6.4V18.5" fill="none" stroke="#d93025" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/><path d="M3.6 7.6L12 14l8.4-6.4" fill="none" stroke="#ea4335" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2.5" fill="#fff"/><path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h13A2.5 2.5 0 0 1 21 5.5V8H3z" fill="#4285f4"/><path d="M3 18.5h4.5V21H5.5A2.5 2.5 0 0 1 3 18.5z" fill="#34a853"/><path d="M16.5 21v-4.5H21v2a2.5 2.5 0 0 1-2.5 2.5z" fill="#fbbc04"/><text x="12" y="17.2" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="10.5" fill="#1a73e8">31</text></svg>',
  whatsapp: '<svg viewBox="0 0 24 24"><path d="M12 2.2A9.8 9.8 0 0 0 3.6 17L2.2 21.8l4.9-1.3A9.8 9.8 0 1 0 12 2.2z" fill="#25d366"/><path d="M8.3 7.3c.3-.5.8-.4 1 0l.9 1.8c.1.3 0 .6-.2.8l-.5.6c.8 1.5 1.9 2.5 3.4 3.2l.6-.7c.2-.2.5-.3.8-.1l1.8.9c.4.2.4.7.1 1.1-.5.8-1.4 1.2-2.4 1-3.1-.7-5.4-3-6-6-.1-.9.1-1.8.5-2.6z" fill="#fff"/></svg>',
  linkedin: '<svg viewBox="0 0 24 24"><rect x="2.5" y="2.5" width="19" height="19" rx="3" fill="#0a66c2"/><rect x="5.8" y="9.6" width="2.8" height="8.6" fill="#fff"/><circle cx="7.2" cy="6.6" r="1.7" fill="#fff"/><path d="M10.7 9.6h2.7v1.2c.5-.9 1.5-1.5 2.8-1.5 2.4 0 3 1.6 3 3.7v5.2h-2.8v-4.5c0-1.1-.2-1.9-1.4-1.9s-1.7.8-1.7 2v4.4h-2.6z" fill="#fff"/></svg>',
  instagram: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5.5" width="19" height="15" rx="2.5" fill="#d9c7a8"/><path d="M2.5 8a2.5 2.5 0 0 1 2.5-2.5h2.5L8.7 3.5h6.6l1.2 2H19A2.5 2.5 0 0 1 21.5 8v1.5h-19z" fill="#6b4a2f"/><rect x="2.5" y="9.5" width="19" height="2" fill="#e53935"/><rect x="2.5" y="11.5" width="19" height="1.1" fill="#fb8c00"/><rect x="2.5" y="12.6" width="19" height="1.1" fill="#fdd835"/><rect x="2.5" y="13.7" width="19" height="1.1" fill="#43a047"/><rect x="2.5" y="14.8" width="19" height="1.1" fill="#1e88e5"/><circle cx="12" cy="14.6" r="4.3" fill="#3b2a1e"/><circle cx="12" cy="14.6" r="2.7" fill="#1c1c24"/><circle cx="10.9" cy="13.5" r=".9" fill="#7aa7d8"/></svg>',
  youtube: '<svg viewBox="0 0 24 24"><rect x="1.5" y="4.5" width="21" height="15" rx="4.5" fill="#f00"/><path d="M9.7 8.6v6.8l5.9-3.4z" fill="#fff"/></svg>',
  excel: '<svg viewBox="0 0 24 24"><path d="M7 2.5h8.5L20.5 7.5v12.5A1.5 1.5 0 0 1 19 21.5H7A1.5 1.5 0 0 1 5.5 20V4A1.5 1.5 0 0 1 7 2.5z" fill="#21a366"/><path d="M15.5 2.5v5h5z" fill="#107c41"/><rect x="1.5" y="6.5" width="12.5" height="13" rx="1.8" fill="#107c41"/><path d="M4.5 9.8l5.5 6.8M10 9.8l-5.5 6.8" stroke="#fff" stroke-width="2.3" stroke-linecap="round"/></svg>',
  profit: '<svg viewBox="0 0 24 24"><rect x="2.5" y="2.5" width="19" height="19" rx="4" fill="#12b886"/><path d="M6 16l4-4.5 3 2.5 5-6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.5 8h3.5v3.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M3.2 8.4C3 6.9 5.7 4.2 8 4.2c.8 0 1.2.4 1.5 1.1l1 2.6c.2.6 0 1.2-.5 1.6L8.8 10.4c.9 1.9 2.4 3.5 4.5 4.6l1.2-1.2c.4-.4 1-.6 1.6-.4l2.5.9c.8.3 1.2.7 1.2 1.5 0 2.4-2.7 5.1-4.2 4.9C8.6 19.9 3.6 14.1 3.2 8.4z" fill="#f2f2f2"/></svg>',
};

interface Cap { k: keyof typeof L; n: string; c: string; re: RegExp; h: string; can: string; ready: 'yes' | 'part' | 'no'; ask: string }

// Same ring order, colours and wording as Zubi HQ. Patterns are Zubi HQ's, narrowed where HeyZubi's own tool
// names would light the wrong icon (whatsapp_draft is not email; create_event_routine is not the calendar).
const CAPS: Cap[] = [
  { k: 'email', n: 'Email', c: '#e8c46a', re: /gmail|e-?mail|inbox|outlook|himalaya|imap|smtp/i, h: 'Checking your inbox', can: 'Read your latest emails, say which need a reply, draft a reply into Drafts (never sends without your yes).', ready: 'yes', ask: 'What are my last two emails, and do they need a reply?' },
  { k: 'calendar', n: 'Calendar', c: '#43d6a1', re: /calendar|gcal/i, h: 'Checking your calendar', can: 'Read today’s events, add an event at a time you say.', ready: 'yes', ask: 'What is on my calendar today?' },
  { k: 'whatsapp', n: 'WhatsApp', c: '#25d366', re: /whatsapp/i, h: 'Preparing a WhatsApp message', can: 'Draft a WhatsApp message, pick the group or number, preview it, and send only after you press Confirm.', ready: 'part', ask: '' },
  { k: 'linkedin', n: 'LinkedIn', c: '#4a8cff', re: /linkedin/i, h: 'Checking LinkedIn', can: 'Write a post (with an image) and publish it after your yes.', ready: 'part', ask: 'Write a LinkedIn post about ' },
  { k: 'youtube', n: 'YouTube', c: '#ff5a4f', re: /youtube|yt-dlp|higgsfield/i, h: 'Working on your video', can: 'Draft a short video and its SEO package (title, description, tags).', ready: 'part', ask: 'Make a 15-second YouTube video about ' },
  { k: 'instagram', n: 'Instagram', c: '#f06aa8', re: /instagram|\breel/i, h: 'Checking Instagram', can: 'Make a GIF/reel and publish it after your yes.', ready: 'part', ask: 'Make an Instagram GIF about ' },
  { k: 'profit', n: 'Profit', c: '#c9a6ff', re: /profit|p&l|expense|revenue|ledger|gst/i, h: 'Checking your numbers', can: 'Answer “what is my profit?” from a money log.', ready: 'no', ask: 'What is my profit this month?' },
  { k: 'excel', n: 'Excel', c: '#b6f05a', re: /xlsx|excel|spreadsheet|openpyxl|googlesheets|\.csv\b/i, h: 'Building your Excel report', can: 'Turn numbers you say into an .xlsx report with totals and a chart.', ready: 'part', ask: 'Build an Excel report: ' },
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
function capFor(row: ToolCallBody | null, live: LiveState | undefined): Cap | null {
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

/** What the orb shows, from real activity only. */
function useOrbState(bot: Bot | undefined): { mode: Mode; cap: Cap | null; line: string } {
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
    // Same as clicking a node in Zubi HQ: WhatsApp opens its window; the rest start a request to Zubi.
    if (c.k === 'whatsapp') { useStore.getState().set({ waOpen: true }); return; }
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
            {mode === 'done' ? <span className="sorb__check">✓</span> : cap ? <span className="sorb__ic" dangerouslySetInnerHTML={{ __html: L[cap.k] }} /> : null}
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
            <i dangerouslySetInnerHTML={{ __html: L[c.k] }} />
          </button>
        ))}

        {tip && (
          <div className="sorb__tip" role="tooltip">
            <b>{tip.n} · {tip.ready === 'yes' ? 'Ready' : tip.ready === 'part' ? 'Partly ready' : 'Not connected'}</b>
            <span>{tip.can}</span>
            <small>{tip.k === 'whatsapp' ? 'Click to open WhatsApp' : `Click to ask ${bot.name}`}</small>
          </div>
        )}
      </div>
      <div className={`sorb__line is-${mode}`} role="status">{cap && mode === 'tool' ? <b>{cap.n.toUpperCase()}</b> : null}{line}</div>
    </section>
  );
}
