import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import type { KanbanCard, KanbanWorkflow } from '../../lib/kanbanApi';
import { Icon } from '../Icon';
import { duration, isOwner, moveTargets, preview, shortId } from './boardModel';

/**
 * One card on the Board. The column says where the task is in Hermes's workflow; the small "agent" line says what an
 * agent is doing with it (running, queued, failed), kept apart so the two are never confused.
 */

export function Grip() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden focusable="false">
      {[2, 7, 12].map((y) => [2.5, 7.5].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.2" fill="currentColor" />))}
    </svg>
  );
}

export function Who({ name, bots, size = 18, showName = true }: { name?: string | null; bots: Map<string, Bot>; size?: number; showName?: boolean }) {
  if (!name) return null;
  if (isOwner(name)) {
    return (
      <span className="kb-who" title="Your step: the chain waits until you move this card to Done">
        <span className="kb-who__dot is-you" style={{ width: size, height: size }} aria-hidden>Y</span>
        {showName && <span className="kb-who__name">You</span>}
      </span>
    );
  }
  const bot = bots.get(name);
  return (
    <span className="kb-who" title={bot ? `${bot.name} (Hermes profile ${name})` : `Hermes profile ${name}`}>
      {bot ? <BotAvatarFor bot={bot} size={size} /> : <span className="kb-who__dot" style={{ width: size, height: size }} aria-hidden>{name[0]?.toUpperCase()}</span>}
      {showName && <span className="kb-who__name">{bot?.name ?? name}</span>}
    </span>
  );
}

/** What an agent is doing with the card, from Hermes's run fields (never inferred from the column). */
export function agentState(card: KanbanCard, who: (p: string) => string): { tone: 'live' | 'queued' | 'fail' | 'warn'; text: string; title?: string } | null {
  if (card.status === 'running' || card.current_run_started_at) {
    return { tone: 'live', text: `Agent working${card.current_run_started_at ? ` · ${duration(card.current_run_started_at)}` : ''}`, title: 'An agent is running this task now' };
  }
  if (card.consecutive_failures) {
    return { tone: 'fail', text: `Last run failed${card.consecutive_failures > 1 ? ` ×${card.consecutive_failures}` : ''}`, title: card.last_failure_error || 'The last agent run failed' };
  }
  if (card.status === 'ready' && isOwner(card.assignee)) return { tone: 'warn', text: 'Waiting for your OK', title: 'Move it to Done to let the next step start' };
  if (card.status === 'ready' && card.assignee) return { tone: 'queued', text: `Queued for ${who(card.assignee)}`, title: 'Hermes hands Ready cards to their agent' };
  if (card.diagnostics?.length) {
    return { tone: 'warn', text: 'Needs a look', title: card.diagnostics.map((d) => d.message).filter(Boolean).join('\n') || 'Hermes flagged this task' };
  }
  return null;
}

interface CardProps {
  card: KanbanCard;
  /** How many cards wait on this one (shown on cards waiting on the owner). */
  blocking?: number;
  bots: Map<string, Bot>;
  workflow: KanbanWorkflow;
  who: (p: string) => string;
  dragging: boolean;
  open: boolean;
  onOpen: () => void;
  onMove: (to: string) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}

export function TaskCard({ card, blocking = 0, bots, workflow, who, dragging, open, onOpen, onMove, onDragStart, onDragEnd }: CardProps) {
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const text = preview(card.body || (card.status === 'done' || card.status === 'review' ? card.latest_summary : '') || '');
  const agent = agentState(card, who);
  const p = card.priority ?? 0;
  const prog = card.progress && card.progress.total > 0 ? card.progress : null;
  const targets = moveTargets(workflow, card);

  return (
    <article className={`kb-card${dragging ? ' is-dragging' : ''}${open ? ' is-open' : ''}`} draggable
      onDragStart={onDragStart} onDragEnd={onDragEnd} data-id={card.id}>
      <span className="kb-card__grip" aria-hidden title="Drag to another column"><Grip /></span>
      {(p !== 0 || agent) && (
        <div className="kb-card__top">
          {p !== 0 && <span className={`kb-pri${p > 0 ? ' is-up' : ''}`} title="Hermes priority: higher is picked up first">P{p}</span>}
          {agent && <span className={`kb-agent is-${agent.tone}`} title={agent.title}><i aria-hidden />{agent.text}</span>}
        </div>
      )}
      {/* The title is the card's button; its hit area covers the whole card. */}
      <button type="button" className="kb-card__open" onClick={onOpen} aria-haspopup="dialog">
        <span className="kb-card__title">{card.title}</span>
      </button>
      {text && <p className="kb-card__body">{text}</p>}
      {card.status === 'blocked' && card.block_reason && <p className="kb-card__why"><b>Waiting on:</b> {card.block_reason}</p>}
      {blocking > 0 && (isOwner(card.assignee) || card.status === 'blocked') && <p className="kb-card__blocking" title="Tasks that can’t start until this one is done">Blocking {blocking} task{blocking === 1 ? '' : 's'}</p>}
      {prog && (
        <div className="kb-prog" title={`${prog.done} of ${prog.total} sub-tasks done (Hermes)`}>
          <span className="kb-prog__bar"><i style={{ width: `${Math.round((prog.done / prog.total) * 100)}%` }} /></span>
          <span className="kb-prog__n">{prog.done}/{prog.total} sub-tasks</span>
        </div>
      )}
      <div className="kb-card__foot">
        {card.assignee ? <Who name={card.assignee} bots={bots} /> : <span className="kb-card__none">Unassigned</span>}
        <span className="kb-card__right">
          {!!card.comment_count && <span className="kb-meta" title={`${card.comment_count} comment${card.comment_count === 1 ? '' : 's'}`}><Icon name="chat_filled" size={11} opacity={0.7} />{card.comment_count}</span>}
          <span className="kb-meta kb-meta--id" title={card.id}>{shortId(card.id)}</span>
        </span>
      </div>
      <button ref={menuBtn} type="button" className="kb-card__more icon-btn icon-btn--plain" aria-label={`Actions for ${card.title}`} aria-haspopup="menu" aria-expanded={menu}
        onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}>
        <Icon name="more" size={14} />
      </button>
      {menu && (
        <CardMenu anchor={menuBtn.current} onClose={() => { setMenu(false); menuBtn.current?.focus(); }}
          items={[
            { label: 'Open details', onSelect: onOpen },
            ...targets.map((c) => ({ label: `Move to ${c.label}`, onSelect: () => onMove(c.key), group: 'move' })),
          ]}
          note={targets.length ? undefined : 'Hermes moves this card itself.'} />
      )}
    </article>
  );
}

interface MenuItem { label: string; onSelect: () => void; group?: string }

/** A small menu in a portal (so a column's scroll never clips it), with arrow keys, Home/End and Escape. */
export function CardMenu({ anchor, items, note, onClose }: { anchor: HTMLElement | null; items: MenuItem[]; note?: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = 220, h = 40 + items.length * 34;
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    const top = r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - 4 - h) : r.bottom + 4;
    setPos({ top, left });
  }, [anchor, items.length]);
  // Focus the first item once the menu is placed (it is hidden until then, and hidden items can't take focus).
  useEffect(() => { if (pos) ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus(); }, [!!pos]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', away);
    window.addEventListener('resize', onClose);
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('resize', onClose); };
  }, [anchor, onClose]);
  const key = (e: ReactKeyboardEvent) => {
    const list = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []);
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  let lastGroup: string | undefined;
  return createPortal(
    <div ref={ref} className="kb-menu" role="menu" style={pos ?? { visibility: 'hidden' }} onKeyDown={key}>
      {items.map((it) => {
        const head = it.group && it.group !== lastGroup;
        lastGroup = it.group;
        return (
          <div key={it.label} role="none">
            {head && <div className="kb-menu__sep" role="separator" />}
            <button type="button" role="menuitem" className="kb-menu__item" onClick={() => { onClose(); it.onSelect(); }}>{it.label}</button>
          </div>
        );
      })}
      {note && <div className="kb-menu__note">{note}</div>}
    </div>,
    document.body,
  );
}
