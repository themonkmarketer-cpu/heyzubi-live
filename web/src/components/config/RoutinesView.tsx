import { useEffect, useMemo, useState } from 'react';
import type { Bot, Routine } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi } from '../../lib/configApi';
import { lsGet, lsSet } from '../../lib/storage';
import { relativeShort } from '../../lib/time';
import { useConfigUI, useVersion } from '../../configStore';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Glyph } from './glyphs';
import { ConfirmButton, nextRunLabel, Switch } from './ui';
import { TrendScoutForm } from './ExtrasTrendScout';
import '../../styles/routines.css';

/**
 * Routines across the whole team (sidebar → Routines), like the Tasks view: each with its bot, schedule, next and last
 * run, and its instructions one click away. Filters: active or paused, bot, and trigger (a schedule or an app event).
 * Order: next run, last run, newest, bot or name. The choices are remembered in this browser.
 */

type Status = 'active' | 'paused' | 'all';
type Trigger = 'any' | 'schedule' | 'event';
type Order = 'next' | 'last' | 'newest' | 'bot' | 'name';

const ORDERS: [Order, string][] = [['next', 'Next run'], ['last', 'Last run'], ['newest', 'Newest'], ['bot', 'Bot'], ['name', 'Name']];
const isEvent = (r: Routine) => r.schedule.startsWith('event:');

function useAllRoutines(): Routine[] | null {
  const v = useVersion('routines');
  const [list, setList] = useState<Routine[] | null>(null);
  useEffect(() => {
    let alive = true;
    configApi.allRoutines().then((r) => { if (alive) setList(r.routines); }).catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, [v]);
  return list;
}

function lastRan(ts: number | null) {
  if (!ts) return 'Not run yet';
  const r = relativeShort(ts);
  if (r === 'now') return 'Ran just now';
  if (/^\d+[mh]$/.test(r)) return `Ran ${r} ago`;
  return r === 'Yesterday' ? 'Ran yesterday' : `Ran ${r}`;
}

function sortRoutines(list: Routine[], order: Order, botName: (id: string) => string) {
  // Next run first; event routines (no set time) after the timed ones; paused ones last.
  const next = (r: Routine) => (!r.enabled ? Number.MAX_VALUE : r.nextRunAt ?? Number.MAX_SAFE_INTEGER);
  const by: Record<Order, (a: Routine, b: Routine) => number> = {
    next: (a, b) => next(a) - next(b) || a.name.localeCompare(b.name),
    last: (a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0) || a.name.localeCompare(b.name),
    newest: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
    bot: (a, b) => botName(a.botId).localeCompare(botName(b.botId)) || next(a) - next(b),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return [...list].sort(by[order]);
}

function RoutineCard({ r, bot, open, onToggleOpen }: { r: Routine; bot?: Bot; open: boolean; onToggleOpen: () => void }) {
  const [enabled, setEnabled] = useState(r.enabled);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setEnabled(r.enabled), [r.enabled]);
  const flash = (t: string) => { setNote(t); setTimeout(() => setNote(null), 2500); };
  const toggle = async (v: boolean) => {
    setEnabled(v);
    try { await configApi.setRoutine(r.id, v); flash(v ? 'Resumed' : 'Paused'); } catch (e) { setEnabled(!v); flash((e as Error).message || 'Couldn’t change it'); }
  };
  const openBot = () => { if (bot) { useStore.getState().selectBot(bot.id); useConfigUI.getState().setView('chat'); } };
  const when = enabled ? (isEvent(r) ? 'When it happens' : nextRunLabel(r.nextRunAt, r.timezone) || 'No next run') : 'Paused';

  return (
    <div className={`routine-card${open ? ' is-open' : ''}${enabled ? '' : ' is-paused'}`}>
      <div className="routine-card__row">
        <button type="button" className="routine-card__main" onClick={onToggleOpen} aria-expanded={open}>
          {bot ? <BotAvatarFor bot={bot} size={30} /> : <span className="routine-card__nobot" aria-hidden><Icon name="clock" size={14} /></span>}
          <span className="routine-card__text">
            <span className="routine-card__name">{r.name}</span>
            <span className="routine-card__sub">{bot?.name ?? 'Removed bot'} · {r.description || r.schedule}</span>
            <span className="routine-card__meta">
              <span className={`routine-card__when${enabled ? '' : ' is-off'}`}>{when}</span>
              <span aria-hidden>·</span>
              <span>{lastRan(r.lastRunAt)}</span>
            </span>
          </span>
          <Icon name={open ? 'chev_down' : 'chev_right'} size={12} opacity={0.5} />
        </button>
        <Switch on={enabled} onChange={toggle} label={`${r.name} ${enabled ? 'on' : 'paused'}`} />
      </div>
      {open && (
        <div className="routine-card__details">
          <div className="routine-card__label">What it does</div>
          <div className="routine-card__prompt">{r.prompt}</div>
          <dl className="routine-card__facts">
            <dt>Trigger</dt><dd>{isEvent(r) ? 'An app event' : 'A schedule'} · {r.description || r.schedule}</dd>
            {!isEvent(r) && <><dt>Time zone</dt><dd>{r.timezone}</dd></>}
            {r.lastRunAt ? <><dt>Last run</dt><dd>{new Date(r.lastRunAt).toLocaleString()}</dd></> : null}
            {r.createdAt ? <><dt>Created</dt><dd>{new Date(r.createdAt).toLocaleDateString()}</dd></> : null}
          </dl>
          <div className="routine-card__actions">
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => configApi.runRoutine(r.id).then(() => flash('Running now')).catch((e) => flash(e.message))}>
              <Glyph name="play" size={12} /> Run now
            </button>
            {bot && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={openBot}>Open {bot.name}</button>}
            <span className="routine-card__sp" />
            {note && <span className="routine-card__note" role="status">{note}</span>}
            <ConfirmButton title="Delete" confirmLabel="Delete routine" onConfirm={() => configApi.deleteRoutine(r.id)}><Glyph name="trash" size={13} /> Delete</ConfirmButton>
          </div>
        </div>
      )}
    </div>
  );
}

/** Full Routines view in the main column (sidebar → Routines). */
export function RoutinesView() {
  const bots = useStore((s) => s.bots);
  const list = useAllRoutines();
  const [saved] = useState(() => { try { return JSON.parse(lsGet('routinesView') ?? '{}'); } catch { return {}; } });
  const [status, setStatus] = useState<Status>(saved.status ?? 'active');
  const [botId, setBotId] = useState<string>(saved.botId ?? '');
  const [trigger, setTrigger] = useState<Trigger>(saved.trigger ?? 'any');
  const [order, setOrder] = useState<Order>(saved.order ?? 'next');
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => { lsSet('routinesView', JSON.stringify({ status, botId, trigger, order })); }, [status, botId, trigger, order]);

  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const botName = (id: string) => byId.get(id)?.name ?? '~';
  const all = list ?? [];
  const counts = { active: all.filter((r) => r.enabled).length, paused: all.filter((r) => !r.enabled).length };
  const withRoutines = bots.filter((b) => all.some((r) => r.botId === b.id));
  const shown = sortRoutines(all.filter((r) =>
    (status === 'all' || (status === 'active' ? r.enabled : !r.enabled))
    && (!botId || r.botId === botId)
    && (trigger === 'any' || (trigger === 'event' ? isEvent(r) : !isEvent(r)))), order, botName);
  const filtered = !!botId || trigger !== 'any';
  const clear = () => { setBotId(''); setTrigger('any'); };

  return (
    <main className="chat tasks-view routines-view">
      <header className="tasks-view__header">
        <div className="tasks-view__title">Routines</div>
        <div className="segmented" role="tablist" aria-label="Show routines">
          {([['active', `Active${counts.active ? ` ${counts.active}` : ''}`], ['paused', `Paused${counts.paused ? ` ${counts.paused}` : ''}`], ['all', 'All']] as [Status, string][]).map(([s, label]) => (
            <button key={s} type="button" role="tab" aria-selected={status === s} className={status === s ? 'is-active' : ''} onClick={() => setStatus(s)}>{label}</button>
          ))}
        </div>
      </header>
      <div className="tasks-view__scroll">
        <div className="tasks-view__inner">
          <TrendScoutForm />
          {all.length > 0 && (
            <div className="routines-tools">
              <label className="routines-pick">
                <span>Bot</span>
                <select value={botId} onChange={(e) => setBotId(e.target.value)} aria-label="Filter by bot">
                  <option value="">All bots</option>
                  {withRoutines.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
              <label className="routines-pick">
                <span>Trigger</span>
                <select value={trigger} onChange={(e) => setTrigger(e.target.value as Trigger)} aria-label="Filter by trigger">
                  <option value="any">Any</option>
                  <option value="schedule">Schedule</option>
                  <option value="event">App event</option>
                </select>
              </label>
              <label className="routines-pick">
                <span>Sort</span>
                <select value={order} onChange={(e) => setOrder(e.target.value as Order)} aria-label="Sort routines">
                  {ORDERS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
                </select>
              </label>
              {filtered && <button type="button" className="link-btn link-btn--small" onClick={clear}>Clear filters</button>}
            </div>
          )}
          {list === null ? <div className="cfg-empty">Loading…</div> : all.length === 0 ? (
            <div className="tasks-empty">
              <Icon name="clock" size={28} opacity={0.35} />
              <div className="tasks-empty__title">No routines yet</div>
              <div className="tasks-empty__sub">Ask anyone on your team in chat, for example “send me a summary every weekday at 8am”, and it shows up here.</div>
            </div>
          ) : shown.length === 0 ? (
            <div className="tasks-empty">
              <div className="tasks-empty__title">{status === 'paused' && !filtered ? 'Nothing paused' : 'No routines match'}</div>
              {filtered && <button type="button" className="link-btn" onClick={clear}>Clear filters</button>}
            </div>
          ) : (
            <div className="routine-list">
              {shown.map((r) => <RoutineCard key={r.id} r={r} bot={byId.get(r.botId)} open={openId === r.id} onToggleOpen={() => setOpenId((o) => (o === r.id ? null : r.id))} />)}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

/** Sidebar entry for the Routines view. */
export function RoutinesIsland() {
  const view = useConfigUI((s) => s.view);
  const on = view === 'routines';
  return (
    <button type="button" className={`sidebar-island${on ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().setView(on ? 'chat' : 'routines')} title="Routines" aria-pressed={on}>
      <span className="sidebar-island__icon"><Icon name="clock" size={18} /></span>
      <span className="sidebar-island__label">Routines</span>
    </button>
  );
}
