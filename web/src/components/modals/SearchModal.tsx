import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppWindow, Contact, FileText, MessageSquare, Palette, Repeat, Settings, SquareKanban, X } from 'lucide-react';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { THEMES, THEME_ORDER, useConfigUI, type MainView } from '../../configStore';
import { SECTIONS } from '../config/AppSettings';
import { openPanel } from '../LivePanels';
import { displayName, useStore } from '../../store';
import { openClients, useBoardFocus } from '../extras/clientsWindow';
import { Icon } from '../Icon';
import { Modal } from './Modal';

interface Hit { kind: 'bot' | 'message' | 'card' | 'file' | 'client' | 'routine'; title: string; sub: string; botId?: string; seq?: number; card?: string; file?: string; client?: string; at?: number }
type HitKind = Exclude<Hit['kind'], 'bot'>;

/** The server's hits, in this order, under these headings (team members come from the list already loaded). */
const GROUPS: { kind: HitKind; label: string; icon: ReactNode }[] = [
  { kind: 'message', label: 'Messages', icon: <MessageSquare size={16} strokeWidth={1.8} /> },
  { kind: 'card', label: 'Kanban', icon: <SquareKanban size={16} strokeWidth={1.8} /> },
  { kind: 'file', label: 'Files', icon: <FileText size={16} strokeWidth={1.8} /> },
  { kind: 'client', label: 'Clients', icon: <Contact size={16} strokeWidth={1.8} /> },
  { kind: 'routine', label: 'Routines', icon: <Repeat size={16} strokeWidth={1.8} /> },
];

interface Item { key: string; open: () => void; row: (active: boolean, idx: number, hover: () => void) => ReactNode }

/** Everything the dashboard can open, so search finds it by name: views, app windows, settings pages, themes. */
interface Place { key: string; label: string; sub: string; words?: string; icon: ReactNode; go: () => void }
const VIEWS: [MainView, string, string][] = [
  ['chat', 'Chat', 'Back to the chat'], ['board', 'Kanban', 'The board: cards from Ready to Done'], ['tasks', 'Tasks', 'Everything the team is working on'],
  ['routines', 'Routines', 'Scheduled jobs and reminders'], ['generations', 'Gallery', 'Pictures and videos made'], ['social', 'Reels Factory', 'Reels from idea to post'],
  ['usage', 'Usage', 'Spend and activity'],
];
const WINDOWS: [Parameters<typeof openPanel>[0], string][] = [
  ['gmail', 'Gmail'], ['calendar', 'Calendar'], ['notion', 'Notion'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['linkedin', 'LinkedIn'], ['youtube', 'YouTube'], ['sheets', 'Google Sheets'],
];

export function SearchModal() {
  const bots = useStore((s) => s.bots);
  const setModal = useStore((s) => s.setModal);
  const selectBot = useStore((s) => s.selectBot);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<{ q: string; hits: Hit[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setModal(null), [setModal]);
  const needle = q.trim();

  const team = useMemo(() => {
    const ordered = [...bots].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.lastActivityAt - a.lastActivityAt);
    const n = needle.toLowerCase();
    if (!n) return ordered;
    return ordered.filter((b) => `${b.name} ${b.label} ${b.description}`.toLowerCase().includes(n));
  }, [bots, needle]);

  // Everything else comes from the server, a moment after typing stops.
  useEffect(() => {
    if (needle.length < 2) { setHits(null); setSearching(false); return; }
    const ac = new AbortController();
    setSearching(true);
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(needle)}`, { credentials: 'include', signal: ac.signal })
        .then((r) => (r.ok ? r.json() : { q: needle, hits: [] }))
        .then((j: { q: string; hits: Hit[] }) => { setHits({ q: needle, hits: Array.isArray(j.hits) ? j.hits : [] }); setSearching(false); })
        .catch(() => { if (!ac.signal.aborted) { setHits({ q: needle, hits: [] }); setSearching(false); } });
    }, 200);
    return () => { clearTimeout(t); ac.abort(); };
  }, [needle]);

  // The dashboard's own places, all of them when the box is empty (so search doubles as a menu), else the ones that match.
  const places = useMemo<Place[]>(() => {
    const ui = useConfigUI.getState;
    const go = (fn: () => void) => () => { fn(); close(); };
    const list: Place[] = [
      ...VIEWS.map(([v, label, sub]) => ({ key: `view:${v}`, label, sub, icon: <SquareKanban size={16} strokeWidth={1.8} />, go: go(() => ui().setView(v)) })),
      ...WINDOWS.map(([k, label]) => ({ key: `win:${k}`, label, sub: `Open the ${label} window`, icon: <AppWindow size={16} strokeWidth={1.8} />, go: go(() => openPanel(k)) })),
      { key: 'win:whatsapp', label: 'WhatsApp', sub: 'Open the WhatsApp window', icon: <AppWindow size={16} strokeWidth={1.8} />, go: go(() => useStore.setState({ waOpen: true })) },
      { key: 'win:clients', label: 'Clients', sub: 'Your clients and their notes', icon: <Contact size={16} strokeWidth={1.8} />, go: go(() => openClients(null)) },
      { key: 'do:hire', label: 'Add a team member', sub: 'Hire a new AI employee', words: 'new bot hire create', icon: <Settings size={16} strokeWidth={1.8} />, go: () => setModal('create') },
      ...SECTIONS.map((x) => ({ key: `set:${x.id}`, label: x.label, sub: 'Settings', words: 'settings', icon: <Settings size={16} strokeWidth={1.8} />, go: go(() => ui().openAppSettings(x.id)) })),
      ...THEME_ORDER.map((t) => ({ key: `theme:${t}`, label: `Theme: ${THEMES[t].label}`, sub: THEMES[t].hint, words: 'theme colour color look', icon: <Palette size={16} strokeWidth={1.8} />, go: go(() => ui().setTheme(t)) })),
    ];
    const n = needle.toLowerCase();
    return n ? list.filter((p) => `${p.label} ${p.sub} ${p.words ?? ''}`.toLowerCase().includes(n)) : list;
  }, [needle, close, setModal]);

  const toChat = useCallback((id: string) => { useConfigUI.getState().setView('chat'); selectBot(id); close(); }, [selectBot, close]);
  const openHit = useCallback((h: Hit) => {
    if ((h.kind === 'message' || h.kind === 'routine' || h.kind === 'bot') && h.botId) toChat(h.botId);
    else if (h.kind === 'card') { useBoardFocus.setState({ card: h.card ?? null }); useConfigUI.getState().setView('board'); close(); }
    else if (h.kind === 'file' && h.botId && h.file) window.open(`/api/bots/${h.botId}/files/open?path=${encodeURIComponent(h.file)}`, '_blank', 'noopener');
    else if (h.kind === 'client') { openClients(h.client ?? null); close(); }
  }, [toChat, close]);

  // One list for the arrow keys: team members first, then each group of hits.
  const sections = useMemo(() => {
    const out: { label: string; items: Item[] }[] = [];
    if (team.length) {
      out.push({ label: 'Team', items: team.map((b) => ({
        key: `bot:${b.id}`,
        open: () => toChat(b.id),
        row: (on, idx, hover) => (
          <button key={`bot:${b.id}`} type="button" role="option" aria-selected={on} data-idx={idx} className={`search-row${on ? ' is-active' : ''}`} onMouseMove={hover} onClick={() => toChat(b.id)}>
            <BotAvatarFor bot={b} size={28} />
            <span className="search-row__text">
              <span className="search-row__name">{displayName(b)}</span>
              <span className="search-row__sub">{b.lastPreview ?? (b.description || 'No messages yet')}</span>
            </span>
          </button>
        ),
      })) });
    }
    if (places.length) {
      out.push({ label: 'Go to', items: places.map((p) => ({
        key: p.key,
        open: p.go,
        row: (on, idx, hover) => (
          <button key={p.key} type="button" role="option" aria-selected={on} data-idx={idx} className={`search-row${on ? ' is-active' : ''}`} onMouseMove={hover} onClick={p.go}>
            <span className="search-row__kind" aria-hidden>{p.icon}</span>
            <span className="search-row__text">
              <span className="search-row__name">{p.label}</span>
              <span className="search-row__sub">{p.sub}</span>
            </span>
          </button>
        ),
      })) });
    }
    const got = hits && hits.q === needle ? hits.hits : [];
    for (const g of GROUPS) {
      const list = got.filter((h) => h.kind === g.kind);
      if (!list.length) continue;
      out.push({ label: g.label, items: list.map((h, i) => {
        const key = `${g.kind}:${h.botId ?? ''}:${h.seq ?? h.card ?? h.file ?? h.client ?? h.title}:${i}`;
        return {
          key,
          open: () => openHit(h),
          row: (on, idx, hover) => (
            <button key={key} type="button" role="option" aria-selected={on} data-idx={idx} className={`search-row${on ? ' is-active' : ''}`} onMouseMove={hover} onClick={() => openHit(h)}
              title={h.kind === 'file' ? 'Opens in a new tab' : undefined}>
              <span className="search-row__kind" aria-hidden>{g.icon}</span>
              <span className="search-row__text">
                <span className="search-row__name">{h.title}</span>
                <span className="search-row__sub">{h.sub}{h.at ? ` · ${new Date(h.at).toLocaleDateString()}` : ''}</span>
              </span>
            </button>
          ),
        };
      }) });
    }
    return out;
  }, [team, places, hits, needle, toChat, openHit]);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, flat.length - 1))); }, [flat.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let idx = 0;
  return (
    <Modal onClose={close} className="search-modal" label="Search">
      <div className="search-modal__field">
        <span className="search-modal__icon"><Icon name="search" size={18} opacity={0.56} /></span>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search team, chats, Kanban, files, clients, settings…"
          aria-label="Search"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter' && flat[active]) { e.preventDefault(); flat[active].open(); }
          }}
        />
        <button type="button" className="search-modal__close" onClick={close} aria-label="Close search" title="Close (Esc)"><X size={18} strokeWidth={2} /></button>
      </div>
      <div className="search-modal__results" ref={listRef} role="listbox">
        {sections.map((s) => (
          <div key={s.label} className="search-modal__group" role="group" aria-label={s.label}>
            <div className="search-modal__section">{s.label}</div>
            {s.items.map((it) => { const i = idx++; return it.row(i === active, i, () => setActive(i)); })}
          </div>
        ))}
        {needle.length >= 2 && searching && <div className="search-modal__section search-modal__busy" role="status">Searching chats, Kanban, files and clients…</div>}
        {!flat.length && !searching && <div className="search-modal__empty">{needle ? `Nothing matches “${needle}”` : 'No one on your team yet'}</div>}
        {needle.length === 1 && <div className="search-modal__section search-modal__busy">Type one more letter to search chats, Kanban, files and clients.</div>}
      </div>
    </Modal>
  );
}
