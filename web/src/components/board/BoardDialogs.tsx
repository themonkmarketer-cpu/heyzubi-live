import { useRef, useState, type FormEvent } from 'react';
import type { KanbanCard, KanbanWorkflow } from '../../lib/kanbanApi';
import { Modal } from '../modals/Modal';
import { ADDABLE, newKey, type MovePlan } from './boardModel';

/**
 * The Board's dialogs. "Add task" asks only for what Hermes needs (a title) plus where it starts; "Move" appears only
 * when Hermes needs something for the move (a summary for Done) or the move has an agent side effect worth confirming
 * (it starts or stops an agent).
 */

export function CreateDialog({ workflow, column, onCreate, onClose }: {
  workflow: KanbanWorkflow; column: string;
  onCreate: (column: string, title: string, key: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [where, setWhere] = useState(column);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey()); // one key per dialog: a double submit can't make two cards
  const cols = workflow.columns.filter((c) => ADDABLE.includes(c.key));

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    const err = await onCreate(where, t, key.current);
    setBusy(false);
    if (err) setError(err); else onClose();
  };

  return (
    <Modal onClose={() => { if (!busy) onClose(); }} className="kb-modal kb-modal--small" label="Add task">
      <form onSubmit={submit}>
        <div className="modal__header"><span className="modal__title">Add task</span></div>
        <div className="kb-modal__body">
          <label className="cfg-field">
            <span className="cfg-field__label">Title</span>
            <input className="text-input" autoFocus value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" />
          </label>
          <label className="cfg-field">
            <span className="cfg-field__label">Start in</span>
            <select className="text-input" value={where} onChange={(e) => setWhere(e.target.value)}>
              {cols.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          {error && <div className="cfg-error" role="alert">{error}</div>}
          <div className="kb-modal__actions">
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!title.trim() || busy}>{busy ? 'Adding…' : 'Add task'}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

export function MoveDialog({ card, toLabel, plan, onCancel, onConfirm }: {
  card: KanbanCard; toLabel: string; plan: MovePlan;
  onCancel: () => void; onConfirm: (extra: { summary?: string; block_reason?: string }) => void;
}) {
  const [text, setText] = useState('');
  const ok = !plan.needsSummary || !!text.trim();
  const go = (e?: FormEvent) => {
    e?.preventDefault();
    if (!ok) return;
    const t = text.trim();
    onConfirm(plan.needsSummary ? { summary: t } : plan.asksReason && t ? { block_reason: t } : {});
  };
  return (
    <Modal onClose={onCancel} className="kb-modal kb-modal--small" label={`Move to ${toLabel}`}>
      <form onSubmit={go}>
        <div className="modal__header"><span className="modal__title">Move “{card.title}” to {toLabel}</span></div>
        <div className="kb-modal__body">
          {plan.effects.length > 0 && (
            <ul className="kb-effects" aria-label="What this changes for the agents">
              {plan.effects.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
          {(plan.needsSummary || plan.asksReason) && (
            <label className="cfg-field">
              <span className="cfg-field__label">{plan.needsSummary ? 'What was done?' : 'What is it waiting on? (optional)'}</span>
              <textarea className="text-input cfg-textarea" rows={3} autoFocus value={text} maxLength={plan.needsSummary ? 4000 : 2000}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go(); }}
                placeholder={plan.needsSummary ? 'A line on the outcome. Hermes keeps it with the task.' : 'For example: the client’s API keys'} />
            </label>
          )}
          <div className="kb-modal__actions">
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onCancel}>Cancel</button>
            <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!ok} autoFocus={!plan.needsSummary && !plan.asksReason}>Move to {toLabel}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** A plain confirm for one change with an agent side effect (assigning a Ready card). */
export function ConfirmDialog({ title, lines, action, onCancel, onConfirm }: { title: string; lines: string[]; action: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal onClose={onCancel} className="kb-modal kb-modal--small" label={title}>
      <div className="modal__header"><span className="modal__title">{title}</span></div>
      <div className="kb-modal__body">
        <ul className="kb-effects">{lines.map((l) => <li key={l}>{l}</li>)}</ul>
        <div className="kb-modal__actions">
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="cfg-btn cfg-btn--primary" autoFocus onClick={onConfirm}>{action}</button>
        </div>
      </div>
    </Modal>
  );
}
