import { useEffect, useMemo, useState } from 'react';
import type { Bot, Task } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi } from '../../lib/configApi';
import { lsGet, lsSet } from '../../lib/storage';
import { relativeShort } from '../../lib/time';
import { useConfigUI, useVersion } from '../../configStore';
import { useStore } from '../../store';
import { Glyph } from './glyphs';
import './ui';
import '../../styles/routines.css'; // the Sort control, shared with the Routines view

type Filter = 'all' | 'open' | 'done';
/** Tasks view order: waiting on you first (the default), newest first, or by bot. */
type Order = 'status' | 'newest' | 'bot';
const ORDERS: [Order, string][] = [['status', 'Needs you first'], ['newest', 'Newest'], ['bot', 'Bot']];

const STATE_LABEL: Record<Task['state'], string> = { working: 'Working on it', needs_input: 'Waiting on you', done: 'Done' };

function when(t: Task): string {
  const r = relativeShort(t.updatedAt);
  const ago = r === 'now' ? 'just now' : r === 'Yesterday' ? 'yesterday' : `${r} ago`;
  return t.state === 'done' ? `Completed ${ago}` : t.state === 'needs_input' ? `Asked ${ago}` : `Updated ${ago}`;
}

function TaskRow({ t, bot, showBot }: { t: Task; bot?: Bot; showBot: boolean }) {
  const open = () => { if (bot) { useStore.getState().selectBot(bot.id); useConfigUI.getState().setView('chat'); } };
  return (
    <button type="button" className={`task-row is-${t.state}`} onClick={open} disabled={!bot} title={bot ? `Open ${bot.name}` : undefined}>
      <span className={`task-row__check is-${t.state}`} aria-hidden>{t.state === 'done' ? <Glyph name="check_circle" size={18} /> : <span className="task-row__ring" />}</span>
      <span className="task-row__text">
        <span className="task-row__title">{t.title}</span>
        {t.note && <span className="task-row__note">{t.note}</span>}
        <span className="task-row__meta">
          {showBot && bot && <><BotAvatarFor bot={bot} size={14} /><span>{bot.name}</span><span aria-hidden>·</span></>}
          <span>{when(t)}</span>
        </span>
      </span>
      <span className={`task-chip is-${t.state}`}>{STATE_LABEL[t.state]}</span>
    </button>
  );
}

function useTasks(botId?: string): Task[] | null {
  const v = useVersion(botId ? `tasks:${botId}` : 'tasks');
  const [tasks, setTasks] = useState<Task[] | null>(null);
  useEffect(() => {
    let alive = true;
    (botId ? configApi.botTasks(botId) : configApi.tasks()).then((r) => { if (alive) setTasks(r.tasks); }).catch(() => { if (alive) setTasks([]); });
    return () => { alive = false; };
  }, [botId, v]);
  return tasks;
}

function sortTasks(list: Task[], order: Order = 'status', botName: (id: string) => string = () => '') {
  const rank = { needs_input: 0, working: 1, done: 2 } as const;
  const status = (a: Task, b: Task) => rank[a.state] - rank[b.state] || b.updatedAt - a.updatedAt;
  if (order === 'newest') return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  if (order === 'bot') return [...list].sort((a, b) => botName(a.botId).localeCompare(botName(b.botId)) || status(a, b));
  return [...list].sort(status);
}

/** Full Tasks view in the main column (sidebar → Tasks). */
export function TasksView() {
  const bots = useStore((s) => s.bots);
  const tasks = useTasks();
  const [filter, setFilter] = useState<Filter>('open');
  const [order, setOrder] = useState<Order>(() => (['status', 'newest', 'bot'].includes(lsGet('tasksSort') ?? '') ? lsGet('tasksSort') as Order : 'status'));
  const pickOrder = (o: Order) => { setOrder(o); lsSet('tasksSort', o); };
  const [botPick, setBotPick] = useState(() => lsGet('tasksBot') ?? '');
  const pickBot = (id: string) => { setBotPick(id); lsSet('tasksBot', id); };
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  // Only bots that have tasks are offered; a saved pick for a bot with none left shows everyone.
  const withTasks = useMemo(() => bots.filter((b) => (tasks ?? []).some((t) => t.botId === b.id)), [bots, tasks]);
  const botId = withTasks.some((b) => b.id === botPick) ? botPick : '';
  const mine = useMemo(() => (tasks ?? []).filter((t) => !botId || t.botId === botId), [tasks, botId]);
  const counts = useMemo(() => ({ open: mine.filter((t) => t.state !== 'done').length, done: mine.filter((t) => t.state === 'done').length }), [mine]);
  const shown = useMemo(() => sortTasks(mine.filter((t) => filter === 'all' || (filter === 'done' ? t.state === 'done' : t.state !== 'done')), order, (id) => byId.get(id)?.name ?? '~'), [mine, filter, order, byId]);

  return (
    <main className="chat tasks-view">
      <header className="tasks-view__header">
        <div className="tasks-view__title">Tasks</div>
        <div className="segmented" role="tablist" aria-label="Filter tasks">
          {([['open', `In progress${counts.open ? ` ${counts.open}` : ''}`], ['done', 'Done'], ['all', 'All']] as [Filter, string][]).map(([f, label]) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'is-active' : ''} onClick={() => setFilter(f)}>{label}</button>
          ))}
        </div>
      </header>
      <div className="tasks-view__scroll">
        <div className="tasks-view__inner">
          {!!tasks?.length && (
            <div className="routines-tools">
              <label className="routines-pick">
                <span>Bot</span>
                <select value={botId} onChange={(e) => pickBot(e.target.value)} aria-label="Filter tasks by bot">
                  <option value="">All bots</option>
                  {withTasks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
              <label className="routines-pick">
                <span>Sort</span>
                <select value={order} onChange={(e) => pickOrder(e.target.value as Order)} aria-label="Sort tasks">
                  {ORDERS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
                </select>
              </label>
            </div>
          )}
          {tasks === null ? <div className="cfg-empty">Loading…</div> : shown.length === 0 ? (
            <div className="tasks-empty">
              <Glyph name="tasks" size={28} opacity={0.35} />
              <div className="tasks-empty__title">{filter === 'done' ? 'Nothing finished yet' : 'Nothing in progress'}</div>
              <div className="tasks-empty__sub">Give someone on your team a multi-part request and every piece gets its own row here, so progress is easy to follow.</div>
            </div>
          ) : (
            <div className="task-list">{shown.map((t) => <TaskRow key={t.id} t={t} bot={byId.get(t.botId)} showBot />)}</div>
          )}
        </div>
      </div>
    </main>
  );
}

/** Sidebar entry for the Tasks view, with a count of tasks waiting on the user. */
export function TasksIsland() {
  const view = useConfigUI((s) => s.view);
  const tasks = useTasks();
  const waiting = tasks?.filter((t) => t.state === 'needs_input').length ?? 0;
  return (
    <button type="button" className={`sidebar-island${view === 'tasks' ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().setView(view === 'tasks' ? 'chat' : 'tasks')} title="Tasks" aria-pressed={view === 'tasks'}>
      <span className="sidebar-island__icon"><Glyph name="tasks" size={18} /></span>
      <span className="sidebar-island__label">Tasks</span>
      {waiting > 0 && <span className="sidebar-island__count" aria-label={`${waiting} waiting on you`}>{waiting}</span>}
    </button>
  );
}

/** Tasks for one bot (details panel → Tasks tab). */
export function BotTasks({ bot }: { bot: Bot }) {
  const tasks = useTasks(bot.id);
  const sorted = useMemo(() => sortTasks(tasks ?? []), [tasks]);
  return (
    <div className="details__sections">
      <section>
        <div className="section-label section-label--row">
          <span>Tasks</span>
          <button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.getState().setView('tasks')}>See all</button>
        </div>
        {tasks === null ? <div className="panel-card"><div className="panel-empty">Loading…</div></div> : sorted.length === 0 ? (
          <div className="panel-card"><div className="panel-empty">No tasks yet. Ask {bot.name} for a few things at once and they’ll be tracked here.</div></div>
        ) : (
          <div className="panel-card task-list task-list--compact">{sorted.map((t) => <TaskRow key={t.id} t={t} bot={bot} showBot={false} />)}</div>
        )}
      </section>
    </div>
  );
}
