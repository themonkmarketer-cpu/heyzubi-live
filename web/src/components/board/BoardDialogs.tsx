import { useRef, useState, type FormEvent } from 'react';
import type { KanbanCard, KanbanWorkflow } from '../../lib/kanbanApi';
import { Modal } from '../modals/Modal';
import { ADDABLE, isOwner, newKey, OWNER, type MovePlan } from './boardModel';

/**
 * The Board's dialogs. "Add task" asks only for what Hermes needs (a title) plus where it starts; "Move" appears only
 * when Hermes needs something for the move (a summary for Done) or the move has an agent side effect worth confirming
 * (it starts or stops an agent).
 */

/** A new card, and the steps it hands on to: each step is a card of its own that starts when the one before is done. */
export interface NewCard {
  column: string; title: string; body: string; assignee: string; key: string;
  steps: { who: string; what: string }[];
}

const MAX_STEPS = 6;

export function CreateDialog({ workflow, column, people, who, onCreate, onClose }: {
  workflow: KanbanWorkflow; column: string; people: string[]; who: (p: string) => string;
  onCreate: (card: NewCard) => Promise<string | null>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [steps, setSteps] = useState<{ who: string; what: string }[]>([]);
  const [where, setWhere] = useState(column);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey()); // one key per dialog: a double submit can't make two cards
  const cols = workflow.columns.filter((c) => ADDABLE.includes(c.key));
  const bots = people.filter((p) => !isOwner(p));
  const colLabel = (k: string, label: string) =>
    k === 'ready' ? (assignee ? `Ready: ${who(assignee)} starts now` : 'Ready') : k === 'todo' ? 'Todo: waits until you move it to Ready' : label;
  const setStep = (i: number, s: Partial<{ who: string; what: string }>) => setSteps((all) => all.map((x, j) => (j === i ? { ...x, ...s } : x)));

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    if (steps.some((s) => !s.who)) { setError('Pick who does each step.'); return; }
    setBusy(true);
    setError(null);
    const err = await onCreate({ column: where, title: t, body: body.trim(), assignee, key: key.current, steps });
    setBusy(false);
    if (err) setError(err); else onClose();
  };

  return (
    <Modal onClose={() => { if (!busy) onClose(); }} className="kb-modal" label="Add task">
      <form onSubmit={submit}>
        <div className="modal__header"><span className="modal__title">Add task</span></div>
        <div className="kb-modal__body">
          <label className="cfg-field">
            <span className="cfg-field__label">Title</span>
            <input className="text-input" autoFocus value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" />
          </label>
          <label className="cfg-field">
            <span className="cfg-field__label">What to do (optional)</span>
            <textarea className="text-input cfg-textarea" rows={3} value={body} maxLength={20_000} onChange={(e) => setBody(e.target.value)}
              placeholder="The brief for the bot: what done looks like, links, limits." />
          </label>
          <label className="cfg-field">
            <span className="cfg-field__label">Who does it</span>
            <select className="text-input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">No one yet</option>
              {bots.map((p) => <option key={p} value={p}>{who(p)}</option>)}
            </select>
          </label>
          <label className="cfg-field">
            <span className="cfg-field__label">Start in</span>
            <select className="text-input" value={where} onChange={(e) => setWhere(e.target.value)}>
              {cols.map((c) => <option key={c.key} value={c.key}>{colLabel(c.key, c.label)}</option>)}
            </select>
          </label>
          <div className="cfg-field kb-steps">
            <span className="cfg-field__label">Then hand to</span>
            {steps.map((s, i) => (
              <div key={i} className="kb-step">
                <span className="kb-step__n" aria-hidden>{i + 2}</span>
                <select className="text-input" value={s.who} onChange={(e) => setStep(i, { who: e.target.value })} aria-label={`Who does step ${i + 2}`}>
                  <option value="">Who?</option>
                  {bots.map((p) => <option key={p} value={p}>{who(p)}</option>)}
                  <option value={OWNER}>You (review)</option>
                </select>
                <input className="text-input" value={s.what} maxLength={4000} onChange={(e) => setStep(i, { what: e.target.value })}
                  placeholder={isOwner(s.who) ? 'What to check (optional)' : 'What to do with the result (optional)'} aria-label={`What step ${i + 2} does`} />
                <button type="button" className="icon-btn icon-btn--plain" aria-label={`Remove step ${i + 2}`} onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            {steps.length < MAX_STEPS && (
              <button type="button" className="kb-step__add" onClick={() => setSteps((all) => [...all, { who: '', what: '' }])}>+ Add a step</button>
            )}
            {steps.length > 0 && (
              <small className="kb-steps__how">Each step starts when the one before it is done, and gets its result. A step for You waits until you move it to Done.</small>
            )}
          </div>
          {error && <div className="cfg-error" role="alert">{error}</div>}
          <div className="kb-modal__actions">
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!title.trim() || busy}>{busy ? 'Adding…' : steps.length ? `Add ${steps.length + 1} cards` : 'Add task'}</button>
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
