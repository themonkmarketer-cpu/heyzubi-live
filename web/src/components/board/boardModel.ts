import type { KanbanCard, KanbanWorkflow } from '../../lib/kanbanApi';

/**
 * The Board's rules, all taken from Hermes (plugins/kanban/dashboard/plugin_api.py and hermes_cli/kanban_workflow.py),
 * kept apart from the view so they read in one place:
 * - columns and their order are Hermes's workflow; which moves a person may make is its `manual` table;
 * - a column's order is Hermes's dispatch order (priority high to low, then oldest first); Done is newest first.
 *   Hermes has no free card position, so a card can't be reordered by hand, only re-prioritised;
 * - some moves have agent side effects in Hermes itself, which the Board names before doing them.
 */

/** What each of Hermes's columns means (header tooltip and empty state). */
export const COLUMN_HINT: Record<string, string> = {
  triage: 'New ideas to sort out before they’re ready.',
  todo: 'Waiting on other tasks. Hermes moves a card to Ready once what it waits on is done.',
  scheduled: 'Starts at its set time. Hermes moves cards here.',
  ready: 'Ready to start. A card with someone assigned is picked up by their agent.',
  running: 'An agent is working on these. Hermes moves cards here when a run starts.',
  blocked: 'Needs something before it can go on.',
  review: 'Finished work waiting for a check. Hermes moves cards here.',
  done: 'Finished.',
};

/** Columns a new card can start in: Hermes creates in Ready, in Triage when asked, and Todo is one move from Ready. */
export const ADDABLE = ['ready', 'triage', 'todo'];

export function canMove(workflow: KanbanWorkflow | null, from: string, to: string) {
  if (!workflow || from === to) return false;
  const col = workflow.columns.find((c) => c.key === to);
  return !!col?.drag_target && (workflow.manual[from] ?? []).includes(to);
}

export function moveTargets(workflow: KanbanWorkflow, card: KanbanCard) {
  return workflow.columns.filter((c) => canMove(workflow, card.status, c.key));
}

/** Hermes's order inside a column: Done newest first, the rest by priority (high first), then oldest first. */
export function comesBefore(column: string, a: KanbanCard, b: KanbanCard) {
  if (column === 'done') return (b.completed_at ?? 0) < (a.completed_at ?? 0);
  const pa = a.priority ?? 0, pb = b.priority ?? 0;
  if (pa !== pb) return pa > pb;
  return (a.created_at ?? 0) < (b.created_at ?? 0);
}

/** Where a card will land among `cards` (shown cards of the target column), so the drop marker shows Hermes's real place for it. */
export function landingIndex(column: string, card: KanbanCard, cards: KanbanCard[]) {
  const moved = column === 'done' ? { ...card, completed_at: Date.now() / 1000 } : card;
  const others = cards.filter((c) => c.id !== card.id);
  const i = others.findIndex((c) => comesBefore(column, moved, c));
  return i < 0 ? others.length : i;
}

// ---------- search and filters (only fields Hermes has) ----------

export interface Filters { q: string; assignee: string | null; priority: string | null; tenant: string | null }
export const NO_FILTERS: Filters = { q: '', assignee: null, priority: null, tenant: null };
export const UNASSIGNED = '__none__';
export const PRIORITISED = '__set__';

export const isFiltering = (f: Filters) => !!(f.q.trim() || f.assignee || f.priority || f.tenant);

export function matches(card: KanbanCard, f: Filters) {
  const q = f.q.trim().toLowerCase();
  if (q && !card.title.toLowerCase().includes(q) && !card.id.toLowerCase().includes(q)) return false;
  if (f.assignee === UNASSIGNED ? !!card.assignee : !!f.assignee && card.assignee !== f.assignee) return false;
  if (f.priority === PRIORITISED ? !card.priority : f.priority !== null && String(card.priority ?? 0) !== f.priority) return false;
  if (f.tenant && card.tenant !== f.tenant) return false;
  return true;
}

// ---------- moves with agent side effects (Hermes's own behaviour, named before it happens) ----------

export interface MovePlan {
  /** Hermes refuses Done without a word on the outcome. */
  needsSummary: boolean;
  /** Blocked takes an optional reason. */
  asksReason: boolean;
  /** Plain-language effects on agents; when there are any the move is confirmed first. */
  effects: string[];
}

export function planMove(card: KanbanCard, to: string, who: (profile: string) => string): MovePlan {
  const effects: string[] = [];
  const agent = card.assignee ? who(card.assignee) : null;
  if (card.status === 'running') {
    effects.push(to === 'ready'
      ? `${agent ?? 'The agent'}’s current run stops, and the card goes back in the queue to be picked up again.`
      : `${agent ?? 'The agent'}’s current run stops. Hermes ends it as “reclaimed”.`);
  } else if (to === 'ready' && agent) {
    effects.push(`In Ready, ${agent}’s agent picks this card up and starts working on it.`);
  }
  if (card.status === 'done' && (card.link_counts?.children ?? 0) > 0) {
    effects.push('Reopening it sends the tasks that depend on it back to wait for it.');
  }
  return { needsSummary: to === 'done', asksReason: to === 'blocked', effects };
}

/** A new assignee on a Ready card is handed to that agent at once (Hermes's dispatcher). */
export function assignEffect(card: KanbanCard, assignee: string, who: (profile: string) => string) {
  if (!assignee || card.status !== 'ready' || assignee === card.assignee) return null;
  return `${who(assignee)}’s agent picks this card up from Ready and starts working on it.`;
}

// ---------- small formatting ----------

export const preview = (text?: string | null) => (text ?? '').replace(/[#*_`>[\]]/g, '').replace(/\s+/g, ' ').trim();

export function ago(sec?: number | null) {
  if (!sec) return '';
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function duration(fromSec?: number | null) {
  if (!fromSec) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - fromSec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const when = (sec?: number | null) => (sec ? new Date(sec * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');

/** A key for Hermes's create, new for each card. */
export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

/** Short task id for cards ("t_8f3a…" stays readable); the drawer shows the whole id. */
export const shortId = (id: string) => (id.length > 10 ? id.slice(0, 10) : id);
