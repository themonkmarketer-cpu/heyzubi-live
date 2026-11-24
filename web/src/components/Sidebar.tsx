import { memo, useCallback, useState } from 'react';
import { useConfigUI } from '../configStore';
import { TasksIsland } from './config/TasksView';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { displayName, useStore } from '../store';
import { api } from '../lib/api';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { SidebarOrb } from './SidebarOrb';
import { UpdateRow } from './UpdateRow';
import zubiMark from '../assets/zubi-live.svg';

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/** The HeyZubi LIVE logo (as in Zubi HQ): the Zubi mark, the HeyZubi wordmark and a red LIVE. */
export function BrandLive() {
  return (
    <div className="brand-live" role="img" aria-label="HeyZubi Live">
      <img className="brand-live__mark" src={zubiMark} alt="" width={30} height={30} />
      <span className="brand-live__text" aria-hidden>
        <b className="brand-live__word">HeyZubi</b>
        <span className="brand-live__live">LIVE</span>
      </span>
    </div>
  );
}

/** Sidebar entry for the Generations gallery (like Tasks). */
function GenerationsIsland() {
  const view = useConfigUI((s) => s.view);
  const on = view === 'generations';
  return (
    <button type="button" className={`sidebar-island${on ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().setView(on ? 'chat' : 'generations')} title="Generations" aria-pressed={on}>
      <span className="sidebar-island__icon">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.8" /><path d="M21 16l-5-5-8 9" />
        </svg>
      </span>
      <span className="sidebar-island__label">Generations</span>
    </button>
  );
}

function previewFor(bot: Bot, running: boolean, awaiting: string | null) {
  if (awaiting) return `Waiting for you: ${awaiting}`;
  if (running && !bot.lastPreview) return 'Working…';
  return bot.lastPreview ?? 'No messages yet';
}

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

  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
      <div className="sidebar__titlebar">
        <BrandLive />
        <div className="sidebar__controls">
          <button type="button" className="icon-btn icon-btn--plain" onClick={() => set({ sidebarCollapsed: !collapsed })} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title="Toggle sidebar (⌘B)">
            <Icon name="sidebar" opacity={0.66} />
          </button>
          {!collapsed && (
            <>
              <button type="button" className="icon-btn" onClick={() => setModal('search')} aria-label="Search" title="Search (⌘K)">
                <Icon name="search" opacity={0.66} />
              </button>
              <button type="button" className="icon-btn" onClick={() => setModal('create')} aria-label="Add a team member" title="Add a team member">
                <Icon name="plus" opacity={0.66} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="sidebar__scroll">
        <TasksIsland />
        <GenerationsIsland />
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
        <div className="bot-list">
          {(collapsed ? others : groupedByTeam(others)).map((b) =>
            'teamHeader' in b ? (
              <div key={`team-${b.teamHeader}`} className="bot-list__team">{b.teamHeader}</div>
            ) : collapsed ? (
              <button key={b.id} type="button" className={`bot-rail-item${selectedBotId === b.id ? ' is-selected' : ''}`} onClick={() => selectBot(b.id)} title={displayName(b)}>
                <BotAvatarFor bot={b} size={36} />
              </button>
            ) : (
              <BotRow key={b.id} bot={b} selected={selectedBotId === b.id} running={!!live[b.id]?.isRunning} awaiting={live[b.id]?.awaiting?.reason ?? null} onSelect={selectBot} />
            ),
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
      </div>

      {!collapsed && <SidebarOrb />}
      <UpdateRow collapsed={collapsed} />

      <div className="sidebar__footer">
        <div className="sidebar__fade" />
        {!collapsed && (
          <div className="account">
            <button type="button" className="account__btn" onClick={() => setAccountMenu(!accountMenu)} aria-haspopup="menu" aria-expanded={accountMenu} title={user?.email}>
              <span className="account__initials">{initials(user?.name ?? user?.email ?? '')}</span>
              <span className="account__name">{user?.name ?? user?.email}</span>
            </button>
            {accountMenu && (
              <Menu
                placement="above"
                onClose={() => setAccountMenu(false)}
                items={[
                  { label: 'Settings', hint: '⌘,', onSelect: () => useConfigUI.getState().openAppSettings() },
                  { label: 'Connect apps', onSelect: () => setModal('apps') },
                  { label: 'Log out', danger: true, onSelect: logout },
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
