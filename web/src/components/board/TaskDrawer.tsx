import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Bot } from '@shared/types';
import { kanbanApi, type KanbanCard, type KanbanCardPatch, type KanbanTaskDetail, type KanbanWorkflow } from '../../lib/kanbanApi';
import { Icon } from '../Icon';
import { ConfirmDialog } from './BoardDialogs';
import { agentState } from './TaskCard';
import { ago, assignEffect, moveTargets, when } from './boardModel';

/**
 * A task's details, in a drawer beside the board (full screen on a phone). Fields save on their own when you leave
 * them, through Hermes's update; the header says whether that is saving, saved or failed, and a failed save keeps
 * what you typed. Before saving a field it checks Hermes's current copy: if someone changed the same field since you
 * opened it (in Hermes's app, or an agent), it asks which to keep instead of overwriting.
 */

type Field = 'title' | 'body' | 'assignee' | 'priority';
type Values = Record<Field, string>;

const valuesOf = (t: KanbanCard): Values => ({ title: t.title, body: t.body ?? '', assignee: t.assignee ?? '', priority: String(t.priority ?? 0) });
const FIELD_NAME: Record<Field, string> = { title: 'title', body: 'description', assignee: 'assignee', priority: 'priority' };

function patchOf(field: Field, v: string): KanbanCardPatch {
  if (field === 'priority') return { priority: Math.trunc(Number(v) || 0) };
  return { [field]: field === 'title' ? v.trim() : v } as KanbanCardPatch;
}

const minutes = (a?: number | null, b?: number | null) => (a && b ? `${Math.max(1, Math.round((b - a) / 60))} min` : '');

interface Props {
  board: string;
  id: string;
  version: number;
  workflow: KanbanWorkflow;
  bots: Map<string, Bot>;
  who: (p: string) => string;
  assignees: string[];
  onClose: () => void;
  onMove: (card: KanbanCard, to: string) => void;
  onChanged: () => void;
}

export function TaskDrawer({ board, id, version, workflow, bots, who, assignees, onClose, onMove, onChanged }: Props) {
  const [detail, setDetail] = useState<KanbanTaskDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Values | null>(null);
  const base = useRef<Values | null>(null); // Hermes's value when this drawer last agreed with it, per field
  const [save, setSave] = useState<{ state: 'idle' | 'saving' | 'saved' | 'error'; msg?: string; field?: Field }>({ state: 'idle' });
  const [conflict, setConflict] = useState<{ field: Field; theirs: string; mine: string } | null>(null);
  const [confirm, setConfirm] = useState<{ assignee: string; line: string } | null>(null);
  const [discard, setDiscard] = useState(false);
  const [comment, setComment] = useState('');
  const [commenting, setCommenting] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef<Values | null>(null);
  draftRef.current = draft;

  /** Bring in Hermes's copy; fields you are editing keep your text (and their base, for the conflict check). */
  const load = useCallback(async () => {
    try {
      const d = await kanbanApi.task(board, id);
      setDetail(d);
      setLoadError(null);
      const fresh = valuesOf(d.task);
      const cur = draftRef.current, b = base.current;
      if (!cur || !b) { base.current = fresh; setDraft(fresh); return; }
      const next = { ...cur }, nb = { ...b };
      (Object.keys(fresh) as Field[]).forEach((f) => { if (cur[f] === b[f]) { next[f] = fresh[f]; nb[f] = fresh[f]; } });
      base.current = nb;
      setDraft(next);
    } catch (e) { setLoadError((e as Error).message); }
  }, [board, id]);

  // Another card: start clean, and put the cursor in its title.
  useEffect(() => {
    base.current = null; draftRef.current = null;
    setDraft(null); setDetail(null); setSave({ state: 'idle' }); setConflict(null);
    void load().then(() => titleRef.current?.focus());
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Hermes changed something on the board (its event counter moved): refresh what isn't being edited.
  useEffect(() => { if (detail) void load(); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = detail?.task;

  const write = useCallback(async (field: Field, value: string, force = false): Promise<boolean> => {
    if (!t || !base.current) return false;
    if (field === 'title' && !value.trim()) { setSave({ state: 'error', msg: 'A task needs a title.', field }); return false; }
    setSave({ state: 'saving', field });
    try {
      if (!force) {
        // Someone else's change to the same field since we last agreed with Hermes? Ask, don't overwrite.
        const fresh = valuesOf((await kanbanApi.task(board, t.id)).task);
        if (fresh[field] !== base.current[field] && fresh[field] !== value) {
          setConflict({ field, theirs: fresh[field], mine: value });
          setSave({ state: 'idle' });
          return false;
        }
      }
      const r = await kanbanApi.update(board, t.id, patchOf(field, value));
      base.current = { ...base.current, [field]: field === 'title' ? value.trim() : value };
      if (r.task) setDetail((d) => (d ? { ...d, task: { ...d.task, ...r.task } } : d));
      setSave({ state: 'saved', field });
      onChanged();
      return true;
    } catch (e) {
      setSave({ state: 'error', msg: (e as Error).message, field });
      return false;
    }
  }, [t, board, onChanged]);

  const commit = (field: Field) => {
    if (!draft || !base.current || draft[field] === base.current[field]) return;
    void write(field, draft[field]);
  };
  const set = (field: Field, v: string) => setDraft((d) => (d ? { ...d, [field]: v } : d));

  const pickAssignee = (v: string) => {
    if (!t) return;
    set('assignee', v);
    const line = assignEffect(t, v, who);
    if (line) setConfirm({ assignee: v, line });
    else void write('assignee', v);
  };

  const dirty = (Object.keys(draft ?? {}) as Field[]).filter((f) => draft && base.current && draft[f] !== base.current[f]);

  /** Closing saves what is still open; if that fails, it asks before dropping your text. */
  const requestClose = useCallback(async () => {
    const cur = draftRef.current, b = base.current;
    const open = cur && b ? (Object.keys(cur) as Field[]).filter((f) => f !== 'assignee' && cur[f] !== b[f]) : [];
    for (const f of open) {
      if (!(await write(f, cur![f]))) { setDiscard(true); return; }
    }
    onClose();
  }, [write, onClose]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && !confirm && !conflict && !discard) { e.preventDefault(); void requestClose(); }
  };

  const addComment = async () => {
    if (!t || !comment.trim() || commenting) return;
    setCommenting(true);
    try {
      await kanbanApi.comment(board, t.id, comment.trim());
      setComment('');
      const d = await kanbanApi.task(board, t.id);
      setDetail((prev) => (prev ? { ...prev, comments: d.comments, task: { ...prev.task, comment_count: d.comments.length } } : d));
      onChanged();
    } catch (e) { setSave({ state: 'error', msg: `Comment not added: ${(e as Error).message}` }); }
    finally { setCommenting(false); }
  };

  const here = t ? workflow.columns.find((c) => c.key === t.status) : null;
  const targets = t ? moveTargets(workflow, t) : [];
  const people = Array.from(new Set([...assignees, ...(t?.assignee ? [t.assignee] : [])]));
  const agent = t ? agentState(t, who) : null;
  const runs = [...(detail?.runs ?? [])].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
  const lastRun = runs[0];
  const linked = (lid: string) => detail?.link_tasks?.find((l) => l.id === lid);

  return (
    <aside className="kb-drawer" role="dialog" aria-label={t ? `Task: ${t.title}` : 'Task'} onKeyDown={onKey}>
      <header className="kb-drawer__head">
        <span className="kb-status" data-s={t?.status}>{here ? here.label : t?.status ?? '…'}</span>
        <span className={`kb-save is-${save.state}`} role="status" aria-live="polite">
          {save.state === 'saving' ? 'Saving…' : save.state === 'saved' ? 'Saved' : save.state === 'error' ? 'Not saved' : ''}
        </span>
        <span className="kb-drawer__sp" />
        <button type="button" className="icon-btn icon-btn--plain" aria-label="Close task details" onClick={() => void requestClose()}><Icon name="close" size={14} /></button>
      </header>

      {loadError && !t ? (
        <div className="kb-drawer__body"><div className="cfg-error">Couldn’t open this task: {loadError}</div><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void load()}>Try again</button></div>
      ) : !t || !draft ? (
        <div className="kb-drawer__body"><div className="cfg-empty">Opening the task…</div></div>
      ) : (
        <div className="kb-drawer__body">
          {save.state === 'error' && (
            <div className="kb-banner is-error" role="alert">
              <span>{save.msg}{/[.!?]$/.test(save.msg ?? '') ? '' : '.'}{save.field ? ' Your text is kept.' : ''}</span>
              {save.field && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void write(save.field!, draft[save.field!])}>Retry</button>}
            </div>
          )}
          {conflict && (
            <div className="kb-banner is-warn" role="alert">
              <span>The {FIELD_NAME[conflict.field]} was changed in Hermes while you were editing{conflict.field !== 'body' ? `: it’s now “${conflict.theirs || 'nobody'}”` : ''}.</span>
              <span className="kb-banner__acts">
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { const c = conflict; setConflict(null); base.current = { ...base.current!, [c.field]: c.theirs }; set(c.field, c.theirs); }}>Use theirs</button>
                <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => { const c = conflict; setConflict(null); void write(c.field, c.mine, true); }}>Keep mine</button>
              </span>
            </div>
          )}

          <textarea ref={titleRef} className="kb-drawer__title" rows={2} value={draft.title} maxLength={300} aria-label="Title"
            onChange={(e) => set('title', e.target.value.replace(/\n/g, ' '))} onBlur={() => commit('title')}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }} />

          <div className="kb-drawer__grid">
            <label className="cfg-field">
              <span className="cfg-field__label">Move to</span>
              <select className="text-input" value="" onChange={(e) => e.target.value && onMove(t, e.target.value)} disabled={!targets.length}>
                <option value="">{targets.length ? 'Choose…' : 'Hermes moves it'}</option>
                {targets.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
            <label className="cfg-field">
              <span className="cfg-field__label">Assigned to</span>
              <select className="text-input" value={draft.assignee} onChange={(e) => pickAssignee(e.target.value)}>
                <option value="">Nobody</option>
                {people.map((p) => <option key={p} value={p}>{bots.get(p)?.name ? `${bots.get(p)!.name} (${p})` : p}</option>)}
              </select>
            </label>
            <label className="cfg-field">
              <span className="cfg-field__label">Priority</span>
              <input className="text-input" type="number" min={-1000} max={1000} step={1} value={draft.priority}
                onChange={(e) => set('priority', e.target.value)} onBlur={() => commit('priority')}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            </label>
          </div>

          <section className="kb-sec" aria-label="Agent">
            <div className="cfg-field__label">Agent</div>
            {agent ? <span className={`kb-agent is-${agent.tone}`} title={agent.title}><i aria-hidden />{agent.text}</span>
              : <span className="kb-muted">{lastRun ? 'No agent is working on this now.' : 'No agent has worked on this yet.'}</span>}
            {lastRun && (
              <div className="kb-run">
                <span>Last run{lastRun.profile ? ` by ${who(lastRun.profile)}` : ''}: {lastRun.outcome || lastRun.status || 'running'}</span>
                <span className="kb-muted">{when(lastRun.started_at)}{lastRun.ended_at ? ` · took ${minutes(lastRun.started_at, lastRun.ended_at)}` : ''}</span>
                {lastRun.error && <span className="kb-run__err">{lastRun.error}</span>}
              </div>
            )}
            {!!t.consecutive_failures && t.last_failure_error && lastRun?.error !== t.last_failure_error && <div className="kb-run__err">{t.last_failure_error}</div>}
          </section>

          <label className="cfg-field">
            <span className="cfg-field__label">Description</span>
            <textarea className="text-input cfg-textarea" rows={6} value={draft.body} maxLength={20000} placeholder="Add more detail…"
              onChange={(e) => set('body', e.target.value)} onBlur={() => commit('body')}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur(); }} />
          </label>

          {t.status === 'blocked' && t.block_reason && <div className="kb-sec"><div className="cfg-field__label">Waiting on</div><div className="kb-text">{t.block_reason}</div></div>}
          {(t.latest_summary || t.result) && (
            <div className="kb-sec kb-sec--soft"><div className="cfg-field__label">Latest update</div><div className="kb-text">{t.latest_summary || t.result}</div></div>
          )}

          {!!(detail!.links?.parents.length || detail!.links?.children.length) && (
            <div className="kb-sec">
              {!!detail!.links!.parents.length && <><div className="cfg-field__label">Waits on</div>{detail!.links!.parents.map((p) => <LinkRow key={p} id={p} row={linked(p)} workflow={workflow} />)}</>}
              {!!detail!.links!.children.length && <><div className="cfg-field__label">Sub-tasks</div>{detail!.links!.children.map((c) => <LinkRow key={c} id={c} row={linked(c)} workflow={workflow} />)}</>}
            </div>
          )}

          <div className="kb-comments">
            <div className="cfg-field__label">Comments{detail!.comments.length ? ` · ${detail!.comments.length}` : ''}</div>
            {detail!.comments.map((c, i) => (
              <div key={c.id ?? i} className="kb-comment">
                <div className="kb-comment__who">{c.author || 'Someone'} <span>{ago(c.created_at)}</span></div>
                <div className="kb-comment__text">{c.body}</div>
              </div>
            ))}
            <div className="kb-comment-add">
              <textarea className="text-input cfg-textarea" rows={2} value={comment} maxLength={10000} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment…" aria-label="New comment" />
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!comment.trim() || commenting} onClick={() => void addComment()}>{commenting ? 'Adding…' : 'Comment'}</button>
            </div>
          </div>

          <dl className="kb-facts">
            <dt>ID</dt><dd><code>{t.id}</code></dd>
            {t.created_at ? <><dt>Created</dt><dd>{when(t.created_at)}{t.created_by ? ` by ${t.created_by}` : ''}</dd></> : null}
            {t.started_at ? <><dt>First started</dt><dd>{when(t.started_at)}</dd></> : null}
            {t.completed_at ? <><dt>Completed</dt><dd>{when(t.completed_at)}</dd></> : null}
            {t.skills?.length ? <><dt>Skills</dt><dd>{t.skills.join(', ')}</dd></> : null}
            {t.tenant ? <><dt>Tenant</dt><dd>{t.tenant}</dd></> : null}
          </dl>
        </div>
      )}

      {confirm && t && (
        <ConfirmDialog title={`Assign to ${who(confirm.assignee)}?`} lines={[confirm.line]} action="Assign"
          onCancel={() => { setConfirm(null); set('assignee', base.current?.assignee ?? ''); }}
          onConfirm={() => { const a = confirm.assignee; setConfirm(null); void write('assignee', a); }} />
      )}
      {discard && (
        <ConfirmDialog title="Close without saving?" lines={[`Hermes didn’t save your ${dirty.map((f) => FIELD_NAME[f]).join(' and ') || 'changes'}. Closing drops them.`]} action="Close anyway"
          onCancel={() => setDiscard(false)} onConfirm={() => { setDiscard(false); onClose(); }} />
      )}
    </aside>
  );
}

function LinkRow({ id, row, workflow }: { id: string; row?: { title: string; status: string }; workflow: KanbanWorkflow }) {
  const col = row ? workflow.columns.find((c) => c.key === row.status) : null;
  return (
    <div className="kb-link">
      <span className="kb-status" data-s={row?.status}>{col?.label ?? row?.status ?? '?'}</span>
      <span className="kb-link__title">{row?.title ?? id}</span>
    </div>
  );
}
