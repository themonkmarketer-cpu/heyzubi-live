import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { useStore } from '../../store';
import { kanbanApi, type KanbanBoardData, type KanbanBoardMeta, type KanbanCard, type KanbanTaskDetail, type KanbanWorkflow } from '../../lib/kanbanApi';
import { Modal } from '../modals/Modal';
import { Icon } from '../Icon';
import '../../styles/board.css';

/**
 * The Board: Hermes's own Kanban, laid out like a simple card board. Columns, cards, order and the rules for moving
 * cards are Hermes's (its workflow and its dispatch order); this view only shows them and sends changes back through
 * Hermes, so the Hermes app and HeyZubi always show the same board.
 */

/** What each of Hermes's columns means, for the column header's tooltip and its empty state. */
const COLUMN_HINT: Record<string, string> = {
  triage: 'New ideas to sort out before they’re ready.',
  todo: 'Waiting on other tasks. Hermes moves a card to Ready once what it waits on is done.',
  scheduled: 'Starts at its set time.',
  ready: 'Ready to start. A card with someone assigned is picked up by their agent.',
  running: 'Being worked on now. Hermes moves cards here when an agent starts.',
  blocked: 'Needs something before it can go on.',
  review: 'Finished work waiting for a check.',
  done: 'Finished.',
};

/** Columns where a new card can start (Hermes creates cards in Ready, or in Triage when asked). */
const ADDABLE = new Set(['triage', 'todo', 'ready']);

const POLL_MS = 4000;

const ago = (sec?: number | null) => {
  if (!sec) return '';
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

const preview = (text?: string | null) => (text ?? '').replace(/[#*_`>[\]]/g, '').replace(/\s+/g, ' ').trim();

function useBotByProfile() {
  const bots = useStore((s) => s.bots);
  return useMemo(() => new Map(bots.filter((b) => b.hermesProfile).map((b) => [b.hermesProfile as string, b])), [bots]);
}

function Assignee({ name, bots }: { name?: string | null; bots: Map<string, Bot> }) {
  if (!name) return null;
  const bot = bots.get(name);
  return (
    <span className="kb-who" title={bot ? `${bot.name} (Hermes profile ${name})` : name}>
      {bot ? <BotAvatarFor bot={bot} size={18} /> : <span className="kb-who__dot" aria-hidden>{name[0]?.toUpperCase()}</span>}
      <span className="kb-who__name">{bot?.name ?? name}</span>
    </span>
  );
}

function Card({ card, bots, dragging, onOpen, onDragStart, onDragEnd }: {
  card: KanbanCard; bots: Map<string, Bot>; dragging: boolean;
  onOpen: () => void; onDragStart: (e: DragEvent) => void; onDragEnd: () => void;
}) {
  const body = preview(card.latest_summary || card.body);
  const warn = (card.diagnostics?.length ?? 0) > 0;
  return (
    <button type="button" className={`kb-card${dragging ? ' is-dragging' : ''}${card.status === 'running' ? ' is-running' : ''}`}
      draggable onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={onOpen} aria-label={`${card.title}. Open to edit or move.`}>
      <span className="kb-card__title">{card.title}</span>
      {body && <span className="kb-card__body">{body}</span>}
      <span className="kb-card__meta">
        <Assignee name={card.assignee} bots={bots} />
        {!!card.priority && <span className="kb-chip" title="Priority: higher runs first">P{card.priority}</span>}
        {card.progress && <span className="kb-chip" title="Sub-tasks done">{card.progress.done}/{card.progress.total}</span>}
        {!!card.comment_count && <span className="kb-chip" title="Comments"><Icon name="chat_filled" size={11} /> {card.comment_count}</span>}
        {card.status === 'running' && <span className="kb-chip kb-chip--live" title="An agent is working on this">Running {card.current_run_started_at ? ago(card.current_run_started_at).replace(' ago', '') : ''}</span>}
        {warn && <span className="kb-chip kb-chip--warn" title={card.diagnostics!.map((d) => d.message).filter(Boolean).join('\n') || 'Hermes flagged this card'}>!</span>}
      </span>
    </button>
  );
}

function QuickAdd({ column, onAdd }: { column: string; onAdd: (title: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) ref.current?.focus(); }, [open]);
  if (!open) {
    return <button type="button" className="kb-add" onClick={() => setOpen(true)}><Icon name="plus" size={12} /> Add a card</button>;
  }
  const submit = async () => {
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    const ok = await onAdd(title);
    setBusy(false);
    if (ok) { setText(''); ref.current?.focus(); } // stays open for the next card, as on a paper board
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setText(''); }
  };
  return (
    <div className="kb-compose">
      <textarea ref={ref} className="kb-compose__input" rows={2} maxLength={300} value={text} placeholder="What needs doing?" aria-label={`New card in ${column}`}
        onChange={(e) => setText(e.target.value)} onKeyDown={key} />
      <div className="kb-compose__row">
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={!text.trim() || busy} onClick={() => void submit()}>{busy ? 'Adding…' : 'Add card'}</button>
        <button type="button" className="icon-btn icon-btn--plain" aria-label="Cancel" onClick={() => { setOpen(false); setText(''); }}><Icon name="close" size={12} /></button>
      </div>
    </div>
  );
}

export function BoardView() {
  const bots = useBotByProfile();
  const [boards, setBoards] = useState<KanbanBoardMeta[]>([]);
  const [slug, setSlug] = useState('');
  const [workflow, setWorkflow] = useState<KanbanWorkflow | null>(null);
  const [data, setData] = useState<KanbanBoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [doneFor, setDoneFor] = useState<KanbanCard | null>(null);
  const cursor = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const say = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  }, []);

  const reload = useCallback(async (board = slug) => {
    try {
      const d = await kanbanApi.board(board);
      cursor.current = d.latest_event_id;
      setData(d);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [slug]);

  useEffect(() => {
    kanbanApi.workflow().then(setWorkflow).catch((e) => setError((e as Error).message));
    kanbanApi.boards().then((r) => { setBoards(r.boards); setSlug((s) => s || r.current); }).catch(() => {});
  }, []);
  useEffect(() => { void reload(slug); }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Changes made in Hermes (its app, its agents, its dispatcher) come in through Hermes's event counter.
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.visibilityState === 'hidden' || drag) return;
      try {
        const { latest_event_id } = await kanbanApi.cursor(slug);
        if (latest_event_id !== cursor.current) await reload(slug);
      } catch { /* the next tick tries again */ }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [slug, drag, reload]);

  const columns = useMemo(() => {
    if (!workflow || !data) return [];
    const byName = new Map(data.columns.map((c) => [c.name, c.tasks]));
    return workflow.columns.map((c) => ({ ...c, cards: byName.get(c.key) ?? [] }));
  }, [workflow, data]);

  const allowed = useCallback((from: string, to: string) => {
    if (!workflow || from === to) return false;
    const col = workflow.columns.find((c) => c.key === to);
    return !!col?.drag_target && (workflow.manual[from] ?? []).includes(to);
  }, [workflow]);

  /** Move a card through Hermes. Done asks what was done first (Hermes wants that before it closes a card). */
  const move = useCallback(async (card: KanbanCard, to: string, extra: { summary?: string } = {}) => {
    if (to === 'done' && !extra.summary) { setDoneFor(card); return; }
    // Show it in the new column straight away; Hermes's answer (or refusal) settles it.
    setData((d) => d && ({ ...d, columns: d.columns.map((c) => ({
      ...c,
      tasks: c.name === to ? [{ ...card, status: to }, ...c.tasks.filter((t) => t.id !== card.id)] : c.tasks.filter((t) => t.id !== card.id),
    })) }));
    try {
      await kanbanApi.update(slug, card.id, { status: to, ...(extra.summary ? { summary: extra.summary } : {}) });
    } catch (e) {
      say(`Hermes didn’t move “${card.title}”: ${(e as Error).message}`);
    }
    await reload();
  }, [slug, reload, say]);

  const add = useCallback(async (column: string, title: string) => {
    try {
      const r = await kanbanApi.create(slug, { title, ...(column === 'triage' ? { triage: true } : {}) });
      // Hermes starts a card in Ready (or Triage); a card added to Todo is then moved there, one of Hermes's own moves.
      if (column === 'todo' && r.task && r.task.status !== 'todo') await kanbanApi.update(slug, r.task.id, { status: 'todo' });
      if (r.warning) say(r.warning);
      await reload();
      return true;
    } catch (e) {
      say(`Couldn’t add the card: ${(e as Error).message}`);
      return false;
    }
  }, [slug, reload, say]);

  const dragStart = (card: KanbanCard) => (e: DragEvent) => {
    e.dataTransfer.setData('text/plain', card.id);
    e.dataTransfer.effectAllowed = 'move';
    setDrag({ id: card.id, from: card.status });
  };
  const dragEnd = () => { setDrag(null); setOver(null); };

  const findCard = (id: string) => data?.columns.flatMap((c) => c.tasks).find((t) => t.id === id) ?? null;

  if (error && !data) {
    return (
      <main className="chat kb-view">
        <header className="tasks-view__header"><div className="tasks-view__title">Board</div></header>
        <div className="kb-state"><div className="cfg-error">Couldn’t open Hermes’s board: {error}</div><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void reload()}>Try again</button></div>
      </main>
    );
  }

  const total = data?.columns.reduce((n, c) => n + c.tasks.length, 0) ?? 0;

  return (
    <main className="chat kb-view">
      <header className="tasks-view__header kb-head">
        <div className="kb-head__title">
          <div className="tasks-view__title">Board</div>
          <span className="kb-head__sub">Hermes’s task board · {total} {total === 1 ? 'card' : 'cards'}</span>
        </div>
        {boards.length > 1 && (
          <select className="text-input kb-head__switch" value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="Board">
            {boards.map((b) => <option key={b.slug} value={b.slug}>{b.name || b.slug}</option>)}
          </select>
        )}
      </header>

      {!workflow || !data ? <div className="kb-state"><div className="cfg-empty">Opening Hermes’s board…</div></div> : (
        <div className="kb-scroll">
          <div className="kb-columns">
            {columns.map((col) => {
              const canDrop = !!drag && allowed(drag.from, col.key);
              const state = !drag ? '' : drag.from === col.key ? ' is-source' : canDrop ? ' is-target' : ' is-closed';
              return (
                <section key={col.key} className={`kb-col${state}${over === col.key && canDrop ? ' is-over' : ''}`} aria-label={`${col.label}, ${col.cards.length} cards`}
                  onDragOver={(e) => { if (!canDrop) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== col.key) setOver(col.key); }}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === col.key ? null : o)); }}
                  onDrop={(e) => { e.preventDefault(); const card = drag && findCard(drag.id); dragEnd(); if (card && canDrop) void move(card, col.key); }}>
                  <header className="kb-col__head" title={COLUMN_HINT[col.key] ?? ''}>
                    <span className="kb-col__icon" aria-hidden>{col.icon}</span>
                    <span className="kb-col__name">{col.label}</span>
                    <span className="kb-col__count">{col.cards.length}</span>
                  </header>
                  <div className="kb-col__cards">
                    {canDrop && <div className="kb-drop">Drop to move to {col.label}</div>}
                    {col.cards.map((card) => (
                      <Card key={card.id} card={card} bots={bots} dragging={drag?.id === card.id}
                        onOpen={() => setOpenId(card.id)} onDragStart={dragStart(card)} onDragEnd={dragEnd} />
                    ))}
                    {!col.cards.length && !canDrop && <div className="kb-col__empty">{COLUMN_HINT[col.key] ?? 'No cards'}</div>}
                  </div>
                  {ADDABLE.has(col.key) && <QuickAdd column={col.label} onAdd={(t) => add(col.key, t)} />}
                </section>
              );
            })}
          </div>
        </div>
      )}

      {toast && (
        <div className="kb-toast" role="alert">
          <span>{toast}</span>
          <button type="button" className="icon-btn icon-btn--plain" aria-label="Dismiss" onClick={() => setToast(null)}><Icon name="close" size={12} /></button>
        </div>
      )}

      {openId && workflow && (
        <CardEditor board={slug} id={openId} workflow={workflow} bots={bots} assignees={data?.assignees ?? []}
          onClose={() => setOpenId(null)} onChanged={() => void reload()} onMove={(card, to) => { setOpenId(null); void move(card, to); }} say={say} />
      )}
      {doneFor && <DoneDialog card={doneFor} onCancel={() => setDoneFor(null)} onDone={(summary) => { const c = doneFor; setDoneFor(null); void move(c, 'done', { summary }); }} />}
    </main>
  );
}

/** Hermes closes a card only with a word on what was done; this asks for it. */
function DoneDialog({ card, onCancel, onDone }: { card: KanbanCard; onCancel: () => void; onDone: (summary: string) => void }) {
  const [text, setText] = useState('');
  return (
    <Modal onClose={onCancel} className="kb-modal kb-modal--small" label="Mark as done">
      <div className="modal__header"><span className="modal__title">Mark “{card.title}” done</span></div>
      <div className="kb-modal__body">
        <label className="cfg-field__label" htmlFor="kb-done">What was done?</label>
        <textarea id="kb-done" className="text-input cfg-textarea" rows={3} autoFocus value={text} maxLength={4000} onChange={(e) => setText(e.target.value)}
          placeholder="A line on the outcome. Hermes keeps it with the card." />
        <div className="kb-modal__actions">
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="cfg-btn cfg-btn--primary" disabled={!text.trim()} onClick={() => onDone(text.trim())}>Mark done</button>
        </div>
      </div>
    </Modal>
  );
}

function CardEditor({ board, id, workflow, bots, assignees, onClose, onChanged, onMove, say }: {
  board: string; id: string; workflow: KanbanWorkflow; bots: Map<string, Bot>; assignees: string[];
  onClose: () => void; onChanged: () => void; onMove: (card: KanbanCard, to: string) => void; say: (m: string) => void;
}) {
  const [detail, setDetail] = useState<KanbanTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  // Opening fills the form; later refreshes (after a comment) only bring in the comments, so unsaved edits stay.
  const load = useCallback((fillForm = true) => {
    kanbanApi.task(board, id).then((d) => {
      if (!fillForm) { setDetail((prev) => (prev ? { ...prev, comments: d.comments } : d)); return; }
      setDetail(d);
      setTitle(d.task.title);
      setBody(d.task.body ?? '');
      setAssignee(d.task.assignee ?? '');
      setPriority(d.task.priority ?? 0);
    }).catch((e) => setError((e as Error).message));
  }, [board, id]);
  useEffect(() => load(), [load]);

  const t = detail?.task;
  const changes = t ? {
    ...(title.trim() && title.trim() !== t.title ? { title: title.trim() } : {}),
    ...(body !== (t.body ?? '') ? { body } : {}),
    ...(assignee !== (t.assignee ?? '') ? { assignee } : {}),
    ...(priority !== (t.priority ?? 0) ? { priority } : {}),
  } : {};
  const dirty = Object.keys(changes).length > 0;

  const save = async () => {
    if (!t || !dirty) return;
    setBusy(true);
    try {
      await kanbanApi.update(board, t.id, changes);
      onChanged();
      onClose();
    } catch (e) { say(`Hermes didn’t save the card: ${(e as Error).message}`); } finally { setBusy(false); }
  };

  const addComment = async () => {
    if (!t || !comment.trim()) return;
    setBusy(true);
    try { await kanbanApi.comment(board, t.id, comment.trim()); setComment(''); load(false); onChanged(); }
    catch (e) { say(`Couldn’t add the comment: ${(e as Error).message}`); } finally { setBusy(false); }
  };

  const targets = t ? workflow.columns.filter((c) => c.drag_target && c.key !== t.status && (workflow.manual[t.status] ?? []).includes(c.key)) : [];
  const here = t ? workflow.columns.find((c) => c.key === t.status) : null;
  const people = Array.from(new Set([...assignees, ...(t?.assignee ? [t.assignee] : [])]));

  return (
    <Modal onClose={onClose} className="kb-modal" label="Card">
      <div className="modal__header">
        <span className="kb-modal__where">{here ? `${here.icon} ${here.label}` : t?.status}{t ? <span className="kb-modal__id"> · {t.id}</span> : null}</span>
        <button type="button" className="modal__close" onClick={onClose} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
      </div>
      {error ? <div className="kb-modal__body"><div className="cfg-error">{error}</div></div> : !t ? <div className="kb-modal__body"><div className="cfg-empty">Loading…</div></div> : (
        <div className="kb-modal__body">
          <input className="kb-modal__title" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />

          <div className="kb-modal__grid">
            <label className="cfg-field">
              <span className="cfg-field__label">Move to</span>
              <select className="text-input" value="" onChange={(e) => e.target.value && onMove(t, e.target.value)} disabled={!targets.length}>
                <option value="">{targets.length ? 'Choose a column…' : 'Hermes moves this one'}</option>
                {targets.map((c) => <option key={c.key} value={c.key}>{c.icon} {c.label}</option>)}
              </select>
            </label>
            <label className="cfg-field">
              <span className="cfg-field__label">Assigned to</span>
              <select className="text-input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Nobody</option>
                {people.map((p) => <option key={p} value={p}>{bots.get(p)?.name ? `${bots.get(p)!.name} (${p})` : p}</option>)}
              </select>
            </label>
            <label className="cfg-field">
              <span className="cfg-field__label">Priority</span>
              <input className="text-input" type="number" min={-100} max={100} value={priority} onChange={(e) => setPriority(Math.trunc(Number(e.target.value) || 0))} />
            </label>
          </div>
          {assignee && t.status === 'ready' && <div className="kb-modal__note">Assigned cards in Ready are picked up by their agent.</div>}

          <label className="cfg-field">
            <span className="cfg-field__label">Description</span>
            <textarea className="text-input cfg-textarea" rows={5} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} placeholder="Add more detail…" />
          </label>

          {(t.latest_summary || t.result) && (
            <div className="kb-modal__update">
              <div className="cfg-field__label">Latest update</div>
              <div className="kb-modal__text">{t.latest_summary || t.result}</div>
            </div>
          )}

          <div className="kb-modal__actions">
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onClose}>Close</button>
            <button type="button" className="cfg-btn cfg-btn--primary" disabled={!dirty || busy || !title.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
          </div>

          <div className="kb-comments">
            <div className="cfg-field__label">Comments{detail!.comments.length ? ` · ${detail!.comments.length}` : ''}</div>
            {detail!.comments.map((c, i) => (
              <div key={c.id ?? i} className="kb-comment">
                <div className="kb-comment__who">{c.author || 'Someone'} <span>{ago(c.created_at)}</span></div>
                <div className="kb-comment__text">{c.body}</div>
              </div>
            ))}
            <div className="kb-comment-add">
              <textarea className="text-input cfg-textarea" rows={2} value={comment} maxLength={10000} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment…" />
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!comment.trim() || busy} onClick={() => void addComment()}>Comment</button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
