import { memo, useCallback, useState } from 'react';
import { THEMES, THEME_ORDER, useConfigUI, type Theme } from '../configStore';
import { TasksIsland } from './config/TasksView';
import { RoutinesIsland } from './config/RoutinesView';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { displayName, useStore } from '../store';
import { api } from '../lib/api';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { UpdateRow } from './UpdateRow';
import { SidebarOrb } from './SidebarOrb';
import { keys } from '../lib/keys';
import { ChartNoAxesColumn, Clapperboard, Contact, LogOut, Settings } from 'lucide-react';
import { openClients } from './extras/clientsWindow';

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/** The HeyZubi wordmark, left-aligned (the word only: no mark, no LIVE). Hidden in the narrow sidebar. */
export function BrandLive() {
  return (
    <div className="brand-live" role="img" aria-label="HeyZubi">
      <span className="brand-live__text" aria-hidden>
        <b className="brand-live__word">HeyZubi</b>
      </span>
    </div>
  );
}

/** The theme button beside the sidebar toggle: a menu of the themes, with a tick on the one in use. */
function ThemeButton() {
  const theme = useConfigUI((s) => s.theme);
  const setTheme = useConfigUI((s) => s.setTheme);
  const [open, setOpen] = useState(false);
  const order: Theme[] = THEME_ORDER;
  const label = (t: Theme) => (t === 'dark' ? 'Legacy dark (default)' : THEMES[t].label);
  return (
    <span className="theme-btn">
      <button type="button" className="icon-btn icon-btn--plain" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}
        aria-label={`Theme: ${label(theme)}`} title="Theme">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden style={{ opacity: 0.66 }}>
          <circle cx="12" cy="12" r="8.5" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && (
        <Menu onClose={() => setOpen(false)} items={order.map((t) => ({ label: label(t), hint: t === theme ? '✓' : undefined, onSelect: () => setTheme(t) }))}>
          <div className="menu__header">Theme</div>
        </Menu>
      )}
    </span>
  );
}

/** Sidebar entry for the Generations gallery (like Tasks). */
function GenerationsIsland() {
  const view = useConfigUI((s) => s.view);
  const on = view === 'generations';
  return (
    <button type="button" className={`sidebar-island${on ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().setView(on ? 'chat' : 'generations')} title="Gallery" aria-pressed={on}>
      <span className="sidebar-island__icon">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.8" /><path d="M21 16l-5-5-8 9" />
        </svg>
      </span>
      <span className="sidebar-island__label">Gallery</span>
    </button>
  );
}

/** Sidebar entry for Reels Factory: the cartoon reel pipeline, in place of the chat. */
function SocialIsland() {
  const on = useConfigUI((s) => s.view === 'social');
  return (
    <button type="button" className={`sidebar-island${on ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().setView(on ? 'chat' : 'social')} title="Reels Factory" aria-pressed={on}>
      <span className="sidebar-island__icon"><Clapperboard size={18} strokeWidth={1.7} aria-hidden /></span>
      <span className="sidebar-island__label">Reels Factory</span>
    </button>
  );
}

/** Sidebar entry for Kanban: Hermes's own task board, as cards in columns. */
function BoardIsland() {
  const view = useConfigUI((s) => s.view);
  const on = view === 'board';
  return (
    <button type="button" className={`sidebar-island${on ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().setView(on ? 'chat' : 'board')} title="Kanban" aria-pressed={on}>
      <span className="sidebar-island__icon">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16M15 4v16" /><path d="M5.5 8h1.5M11.5 8h1M17.5 8h1" />
        </svg>
      </span>
      <span className="sidebar-island__label">Kanban</span>
    </button>
  );
}

/** Sidebar entry for Usage: each team member's turns, tokens and cost, as a workspace of its own (like Routines). */
function UsageIsland() {
  const on = useConfigUI((s) => s.view === 'usage');
  return (
    <button type="button" className={`sidebar-island${on ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().setView(on ? 'chat' : 'usage')} title="Usage" aria-pressed={on}>
      <span className="sidebar-island__icon"><ChartNoAxesColumn size={18} strokeWidth={1.7} aria-hidden /></span>
      <span className="sidebar-island__label">Usage</span>
    </button>
  );
}

/**
 * Capabilities: Zubi's orb and the ring of what it can do. It sits beside Usage at the top of the nav at the bottom of
 * the sidebar; the orb opens across the whole row, above it. It starts open and highlighted every time the app
 * loads; the entry closes and opens it, and in the narrow sidebar it widens the sidebar and opens it.
 */
function CapabilitiesIsland() {
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const [open, setOpen] = useState(true);
  // Opening it also opens the main team member's chat: the capabilities are theirs.
  const toZubi = () => { const z = useStore.getState().bots.find((b) => b.isPrimary); useConfigUI.getState().setView('chat'); if (z) useStore.getState().selectBot(z.id); };
  const click = () => {
    if (collapsed) { useStore.getState().set({ sidebarCollapsed: false }); setOpen(true); toZubi(); return; }
    if (!open) toZubi();
    setOpen(!open);
  };
  const shown = open && !collapsed;
  return (
    <>
      {shown && <div id="sidebar-capabilities" className="sidebar-caps"><SidebarOrb /></div>}
      <button type="button" className={`sidebar-island${shown ? ' is-open is-active' : ''}`} onClick={click} title={shown ? 'Hide capabilities' : 'Show capabilities'}
        aria-expanded={shown} aria-controls="sidebar-capabilities">
        <span className="sidebar-island__icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="3.2" /><circle cx="12" cy="12" r="8.5" strokeDasharray="2 3" /><circle cx="12" cy="3.5" r="1.4" fill="currentColor" /><circle cx="19.4" cy="16.3" r="1.4" fill="currentColor" /><circle cx="4.6" cy="16.3" r="1.4" fill="currentColor" />
          </svg>
        </span>
        <span className="sidebar-island__label">Capabilities</span>
        <span className={`sidebar-island__chev${shown ? '' : ' is-up'}`} aria-hidden><Icon name="chev_down" size={12} opacity={0.6} /></span>
      </button>
    </>
  );
}

function previewFor(bot: Bot, running: boolean, awaiting: string | null) {
  if (awaiting) return `Waiting for you: ${awaiting}`;
  if (running && !bot.lastPreview) return 'Working…';
  return bot.lastPreview ?? 'No messages yet';
}

/** How many tiles per row the team list uses: rows with the last message for a small team, then 2, then 3 per row. */
const teamColumns = (n: number) => (n <= 4 ? 1 : n <= 9 ? 2 : 3);

/** A team member as a compact tile (when the team is bigger): mascot, name and role; the last message on hover. */
const BotTile = memo(function BotTile({ bot, selected, running, awaiting, onSelect }: { bot: Bot; selected: boolean; running: boolean; awaiting: string | null; onSelect: (id: string) => void }) {
  return (
    <button type="button" className={`bot-tile${selected ? ' is-selected' : ''}`} onClick={() => onSelect(bot.id)} aria-current={selected || undefined}
      title={`${displayName(bot)}\n${previewFor(bot, running, awaiting)}`}>
      <span className="bot-row__avatar">
        <BotAvatarFor bot={bot} size={32} />
        {(running || awaiting || bot.unread > 0) && (
          <span className={`status-dot ${awaiting ? 'is-attention' : running ? 'is-working' : 'is-unread'}`} aria-label={awaiting ? 'Needs attention' : running ? 'Working' : 'Unread activity'} />
        )}
      </span>
      <span className="bot-tile__text">
        <span className="bot-tile__name">{bot.name}</span>
        <span className="bot-tile__role">{bot.kind === 'room' ? 'Group' : bot.label || ''}</span>
      </span>
    </button>
  );
});

const BotRow = memo(function BotRow({ bot, selected, running, awaiting, onSelect }: { bot: Bot; selected: boolean; running: boolean; awaiting: string | null; onSelect: (id: string) => void }) {
  return (
    <button type="button" className={`bot-row${selected ? ' is-selected' : ''}`} onClick={() => onSelect(bot.id)} aria-current={selected || undefined}>
      <span className="bot-row__avatar">
        <BotAvatarFor bot={bot} size={36} />
        {(running || awaiting || bot.unread > 0) && (
          <span className={`status-dot ${awaiting ? 'is-attention' : running ? 'is-working' : 'is-unread'}`} aria-label={awaiting ? 'Needs attention' : running ? 'Working' : 'Unread activity'} />
        )}
      </span>
      <span className="bot-row__text">
        <span className="bot-row__name">{displayName(bot)}</span>
        <span className="bot-row__preview">{previewFor(bot, running, awaiting)}</span>
      </span>
    </button>
  );
});

export function Sidebar() {
  const bots = useStore((s) => s.bots);
  const live = useStore((s) => s.live);
  const storeSelectedBotId = useStore((s) => s.selectedBotId);
  const inTasks = useConfigUI((s) => s.view === 'tasks');
  const selectedBotId = inTasks ? null : storeSelectedBotId; // nothing highlighted while the Tasks view is open
  const user = useStore((s) => s.user);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const set = useStore((s) => s.set);
  const storeSelectBot = useStore((s) => s.selectBot);
  // Picking a bot (even the one already selected) leaves the Tasks view.
  const selectBot = useCallback((id: string) => { useConfigUI.getState().setView('chat'); storeSelectBot(id); }, [storeSelectBot]);
  const setModal = useStore((s) => s.setModal);
  const [accountMenu, setAccountMenu] = useState(false);
  const logout = async () => { await api.logout().catch(() => {}); location.reload(); };
  const primary = bots.find((b) => b.isPrimary);
  const others = bots.filter((b) => !b.isPrimary).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  // Group chats (rooms) sit apart from the team members, under their own heading.
  const members = others.filter((b) => b.kind !== 'room');
  const groups = others.filter((b) => b.kind === 'room');
  const cols = teamColumns(others.length);
  const entry = (b: Bot) => (collapsed ? (
    <button key={b.id} type="button" className={`bot-rail-item${selectedBotId === b.id ? ' is-selected' : ''}`} onClick={() => selectBot(b.id)} title={displayName(b)}>
      <BotAvatarFor bot={b} size={36} />
    </button>
  ) : cols > 1 ? (
    <BotTile key={b.id} bot={b} selected={selectedBotId === b.id} running={!!live[b.id]?.isRunning} awaiting={live[b.id]?.awaiting?.reason ?? null} onSelect={selectBot} />
  ) : (
    <BotRow key={b.id} bot={b} selected={selectedBotId === b.id} running={!!live[b.id]?.isRunning} awaiting={live[b.id]?.awaiting?.reason ?? null} onSelect={selectBot} />
  ));

  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
      <div className="sidebar__titlebar">
        <BrandLive />
        <div className="sidebar__controls">
          <button type="button" className="icon-btn icon-btn--plain" onClick={() => set({ sidebarCollapsed: !collapsed })} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={`Toggle sidebar (${keys('B')})`}>
            <Icon name="sidebar" opacity={0.66} />
          </button>
          <ThemeButton />
          {!collapsed && (
            <>
              <button type="button" className="icon-btn" onClick={() => setModal('search')} aria-label="Search" title={`Search (${keys('K')})`}>
                <Icon name="search" opacity={0.66} />
              </button>
              <button type="button" className="icon-btn" onClick={() => openClients()} aria-label="Clients" title="Clients">
                <Contact size={18} strokeWidth={1.7} style={{ opacity: 0.66 }} aria-hidden />
              </button>
              <button type="button" className="icon-btn" onClick={() => setModal('create')} aria-label="Add a team member" title="Add a team member">
                <Icon name="plus" opacity={0.66} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="sidebar__scroll">
        {primary && (
          <div className="pinned">
            <button type="button" className={`pinned__tile${selectedBotId === primary.id ? ' is-selected' : ''}`} onClick={() => selectBot(primary.id)} title={displayName(primary)}>
              <span className="pinned__avatar">
                <BotAvatarFor bot={primary} size={collapsed ? 44 : 60} star />
                {live[primary.id]?.isRunning && <span className="status-dot is-working pinned__dot" />}
              </span>
              {!collapsed && <span className="pinned__label">{displayName(primary)}</span>}
            </button>
          </div>
        )}
        <div className={`bot-list${!collapsed && cols > 1 ? ` is-grid cols-${cols}` : ''}`}>
          {(collapsed ? members : groupedByTeam(members)).map((b) =>
            'teamHeader' in b ? <div key={`team-${b.teamHeader}`} className="bot-list__team">{b.teamHeader}</div> : entry(b),
          )}
          {!collapsed && others.length === 0 && (
            <button type="button" className="bot-list__empty" onClick={() => setModal('create')}>
              <span className="bot-list__empty-plus"><Icon name="plus" size={14} opacity={0.66} /></span>
              <span>
                <span className="bot-row__name">Add a team member</span>
                <span className="bot-row__preview">Give it a job, like research or inbox triage</span>
              </span>
            </button>
          )}
        </div>
        {groups.length > 0 && (
          <div className={`bot-list is-groups${!collapsed && cols > 1 ? ` is-grid cols-${cols}` : ''}`} aria-label="Groups">
            {collapsed ? <div className="bot-list__rule" aria-hidden /> : <div className="bot-list__team">Groups</div>}
            {groups.map(entry)}
          </div>
        )}
      </div>

      {/* The views, at the bottom just above Updates: Usage and Capabilities (its orb opens upwards), then Kanban and Gallery,
          then Routines and Tasks, then Reels Factory. Two to a row; one per row in the narrow sidebar. */}
      <nav className="sidebar-nav is-tiles" aria-label="Views">
        <CapabilitiesIsland />
        <UsageIsland />
        <BoardIsland />
        <GenerationsIsland />
        <RoutinesIsland />
        <TasksIsland />
        <SocialIsland />
      </nav>

      <UpdateRow collapsed={collapsed} />

      <div className="sidebar__footer">
        <div className="sidebar__fade" />
        {!collapsed && (
          <div className="account">
            <button type="button" className="account__btn" onClick={() => setAccountMenu(!accountMenu)} aria-haspopup="menu" aria-expanded={accountMenu} title={user?.email}>
              {user?.avatarUrl
                ? <img className="account__photo" src={user.avatarUrl} alt="" width={36} height={36} />
                : <span className="account__initials">{initials(user?.name ?? user?.email ?? '')}</span>}
              <span className="account__name">{user?.displayName || user?.name || user?.email}</span>
            </button>
            {accountMenu && (
              <Menu
                placement="above"
                onClose={() => setAccountMenu(false)}
                items={[
                  { label: 'Settings', icon: <Settings size={16} strokeWidth={1.8} />, onSelect: () => useConfigUI.getState().openAppSettings() },
                  { label: 'Log out', icon: <LogOut size={16} strokeWidth={1.8} />, danger: true, onSelect: logout },
                ]}
              >
                <div className="menu__header">{user?.email}</div>
              </Menu>
            )}
          </div>
        )}
        <button type="button" className="icon-btn icon-btn--bordered" onClick={() => setModal('apps')} aria-label="Connect apps" title="Connect apps">
          <Icon name="apps" />
        </button>
      </div>
    </aside>
  );
}

/** Bots grouped by team (from Theo): a heading per team, its manager first; bots without a team after. */
function groupedByTeam(bots: Bot[]): (Bot | { teamHeader: string })[] {
  const teams = [...new Set(bots.map((b) => b.team).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b));
  if (!teams.length) return bots;
  const out: (Bot | { teamHeader: string })[] = [];
  for (const t of teams) {
    out.push({ teamHeader: t });
    out.push(...bots.filter((b) => b.team === t).sort((a, b) => Number(b.isManager) - Number(a.isManager)));
  }
  const rest = bots.filter((b) => !b.team);
  if (rest.length) out.push({ teamHeader: 'Team members' }, ...rest);
  return out;
}
