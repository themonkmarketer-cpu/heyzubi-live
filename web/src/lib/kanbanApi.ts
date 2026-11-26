import { ApiError } from './api';

/**
 * The Board view's data: Hermes's own Kanban, through HeyZubi's /api/kanban pass-through (server/src/routes-kanban.ts).
 * Shapes are Hermes's (its plugin's task dict and workflow); nothing here is HeyZubi's own copy.
 */

export interface KanbanCard {
  id: string;
  title: string;
  body?: string | null;
  assignee?: string | null;
  status: string;
  priority?: number;
  created_at?: number | null;
  completed_at?: number | null;
  latest_summary?: string | null;
  result?: string | null;
  comment_count?: number;
  progress?: { done: number; total: number } | null;
  link_counts?: { parents: number; children: number };
  current_run_started_at?: number | null;
  block_reason?: string | null;
  block_kind?: string | null;
  diagnostics?: { severity?: string; message?: string; kind?: string }[];
  created_by?: string | null;
  started_at?: number | null;
  tenant?: string | null;
  skills?: string[] | null;
  current_run_id?: number | null;
  consecutive_failures?: number | null;
  last_failure_error?: string | null;
}

/** One agent run of a task (Hermes's task_runs row). */
export interface KanbanRun {
  id: number;
  profile?: string | null;
  status?: string | null;
  outcome?: string | null;
  summary?: string | null;
  error?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
}

export interface KanbanBoardData {
  columns: { name: string; tasks: KanbanCard[] }[];
  assignees: string[];
  latest_event_id: number;
  now: number;
}

export interface KanbanWorkflow {
  columns: { key: string; label: string; icon: string; drag_target: boolean }[];
  /** For each status, the statuses a person may move a card to (Hermes's own rules). */
  manual: Record<string, string[]>;
}

export interface KanbanBoardMeta { slug: string; name: string; is_current?: boolean; total?: number }

export interface KanbanComment { id?: number; author?: string | null; body: string; created_at?: number }

/** A file on a task, stored by Hermes (its attachments folder); downloaded by id. */
export interface KanbanAttachment {
  id: number;
  task_id: string;
  filename: string;
  content_type?: string | null;
  size?: number | null;
  uploaded_by?: string | null;
  created_at?: number | null;
}

export interface KanbanTaskDetail {
  task: KanbanCard;
  comments: KanbanComment[];
  attachments?: KanbanAttachment[];
  runs?: KanbanRun[];
  links?: { parents: string[]; children: string[] };
  link_tasks?: { id: string; title: string; status: string }[];
}

export interface KanbanCardPatch {
  title?: string;
  body?: string;
  status?: string;
  assignee?: string;
  priority?: number;
  block_reason?: string;
  /** What was done: Hermes asks for it when a card moves to Done. */
  summary?: string;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/kanban${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

const q = (board: string) => (board ? `?board=${encodeURIComponent(board)}` : '');

export const kanbanApi = {
  boards: () => req<{ boards: KanbanBoardMeta[]; current: string }>('GET', '/boards'),
  workflow: () => req<KanbanWorkflow>('GET', '/workflow'),
  board: (board: string) => req<KanbanBoardData>('GET', `/board${q(board)}`),
  cursor: (board: string) => req<{ latest_event_id: number }>('GET', `/cursor${q(board)}`),
  task: (board: string, id: string) => req<KanbanTaskDetail>('GET', `/tasks/${encodeURIComponent(id)}${q(board)}`),
  /** `key` is Hermes's idempotency key: the same key never makes a second card, so a repeated submit is harmless. */
  create: (board: string, p: { title: string; body?: string; assignee?: string; priority?: number; triage?: boolean; key?: string; parents?: string[] }) =>
    req<{ task: KanbanCard | null; warning?: string }>('POST', `/tasks${q(board)}`, p),
  update: (board: string, id: string, p: KanbanCardPatch) => req<{ task: KanbanCard | null }>('PATCH', `/tasks/${encodeURIComponent(id)}${q(board)}`, p),
  comment: (board: string, id: string, body: string) => req<unknown>('POST', `/tasks/${encodeURIComponent(id)}/comments${q(board)}`, { body }),
  attachments: (board: string, id: string) => req<{ attachments: KanbanAttachment[] }>('GET', `/tasks/${encodeURIComponent(id)}/attachments${q(board)}`),
  attach: async (board: string, id: string, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await fetch(`/api/kanban/tasks/${encodeURIComponent(id)}/attachments${q(board)}`, { method: 'POST', credentials: 'include', body: form });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
      throw new ApiError(res.status, msg);
    }
    return res.json() as Promise<{ attachment: KanbanAttachment | null }>;
  },
  detach: (board: string, attachmentId: number) => req<{ ok: boolean }>('DELETE', `/attachments/${attachmentId}${q(board)}`),
  /** Every parent -> child link on the board (what each card unblocks). */
  links: (board: string) => req<{ links: [string, string][] }>('GET', `/links${q(board)}`),
  /** The prep assistant: a one-liner rewritten as a self-contained brief (nothing is created). */
  brief: (board: string, p: { title: string; body?: string; assignee?: string }) => req<{ title: string; body: string }>('POST', `/brief${q(board)}`, p),
  /** A readable page of a card's work: every run (or one), what happened, comments, the worker's log. */
  reportUrl: (board: string, id: string, run?: number) => `/api/kanban/tasks/${encodeURIComponent(id)}/report${board || run ? '?' : ''}${[board ? `board=${encodeURIComponent(board)}` : '', run ? `run=${run}` : ''].filter(Boolean).join('&')}`,
  /** `inline` shows plain raster images in the page; anything else downloads. */
  attachmentUrl: (board: string, attachmentId: number, inline = false) =>
    `/api/kanban/attachments/${attachmentId}${board || inline ? '?' : ''}${[board ? `board=${encodeURIComponent(board)}` : '', inline ? 'inline=1' : ''].filter(Boolean).join('&')}`,
};

/** Hermes's limit for one attachment. */
export const KANBAN_ATTACHMENT_MAX = 25 * 1024 * 1024;
