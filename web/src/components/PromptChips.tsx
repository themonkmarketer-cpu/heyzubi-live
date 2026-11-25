import { useCallback, useEffect, useState } from 'react';
import { BookmarkPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Bot, SavedPrompt } from '@shared/types';
import { api } from '../lib/api';
import { Modal } from './modals/Modal';
import { Icon } from './Icon';
import '../styles/prompts.css';

/** How many chips show; the rest are in the list. */
const CHIPS = 5;

/** A team member's saved prompts, most used first; they follow changes made elsewhere (by the team member too). */
export function usePrompts(botId: string): SavedPrompt[] {
  const [got, setGot] = useState<{ botId: string; list: SavedPrompt[] }>({ botId, list: [] });
  useEffect(() => {
    let live = true;
    const load = () => { api.prompts(botId).then((r) => { if (live) setGot({ botId, list: r.prompts }); }).catch(() => { /* the chips just don't show */ }); };
    load();
    const on = (e: Event) => { const d = (e as CustomEvent<{ type: string; botId: string }>).detail; if (d?.type === 'prompts' && d.botId === botId) load(); };
    window.addEventListener('heyzubi:event', on);
    return () => { live = false; window.removeEventListener('heyzubi:event', on); };
  }, [botId]);
  return got.botId === botId ? got.list : [];
}

/** The row above the message box: up to five chips (they fill the box and never send), and the list of all of them. */
export function PromptChips({ bot, prompts, text, onPick }: { bot: Bot; prompts: SavedPrompt[]; text: string; onPick: (p: SavedPrompt) => void }) {
  const [open, setOpen] = useState<null | { draft?: string }>(null);
  const typed = text.trim();
  const isNew = typed.length > 0 && !prompts.some((p) => p.text === typed);
  return (
    <div className="pchips" role="group" aria-label={`Prompts for ${bot.name}`}>
      {prompts.slice(0, CHIPS).map((p) => (
        <button key={p.id} type="button" className="pchips__chip" onClick={() => onPick(p)} title={p.text}>{p.title}</button>
      ))}
      {isNew ? (
        <button type="button" className="pchips__chip pchips__tool" onClick={() => setOpen({ draft: typed })} title="Save what’s in the box as a prompt">
          <BookmarkPlus size={13} strokeWidth={2} aria-hidden />Save as prompt
        </button>
      ) : (
        <button type="button" className="pchips__chip pchips__tool" onClick={() => setOpen({})} title="Add, edit or delete prompts">
          {prompts.length ? <><Pencil size={12} strokeWidth={2} aria-hidden />{prompts.length > CHIPS ? `All ${prompts.length}` : 'Edit'}</> : <><Plus size={13} strokeWidth={2} aria-hidden />Add a prompt</>}
        </button>
      )}
      {open && <PromptsModal bot={bot} prompts={prompts} draft={open.draft} onClose={() => setOpen(null)} onPick={(p) => { setOpen(null); onPick(p); }} />}
    </div>
  );
}

function PromptsModal({ bot, prompts, draft, onClose, onPick }: { bot: Bot; prompts: SavedPrompt[]; draft?: string; onClose: () => void; onPick: (p: SavedPrompt) => void }) {
  // Which one is being written: a new one ('new'), a saved one (its id), or none.
  const [edit, setEdit] = useState<string | null>(draft || !prompts.length ? 'new' : null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState(draft ?? '');
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => onClose(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const start = (p?: SavedPrompt) => { setEdit(p?.id ?? 'new'); setTitle(p?.title ?? ''); setText(p?.text ?? ''); setError(null); setSure(null); };
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true); setError(null);
    try { await fn(); window.dispatchEvent(new CustomEvent('heyzubi:event', { detail: { type: 'prompts', botId: bot.id } })); after?.(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const save = () => run(() => (edit === 'new' ? api.addPrompt(bot.id, title, text) : api.updatePrompt(bot.id, edit!, title, text)), () => (draft ? close() : setEdit(null)));
  return (
    <Modal onClose={close} className="prompts-modal" label={`Prompts for ${bot.name}`}>
      <div className="modal__header">
        <div className="modal__title">Prompts for {bot.name}</div>
        <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
      </div>
      {edit ? (
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim() && !busy) void save(); }}>
          <div className="prompts-modal__body">
            <label className="prompts-modal__field"><span>Name on the chip</span>
              <input className="text-input" value={title} maxLength={40} placeholder="Optional: the first words are used" onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="prompts-modal__field"><span>Prompt</span>
              <textarea className="text-input prompts-modal__text" value={text} maxLength={2000} rows={6} onChange={(e) => setText(e.target.value)} />
            </label>
            {error && <div className="card__error" role="alert">{error}</div>}
          </div>
          <div className="modal__footer">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => (draft || !prompts.length ? close() : setEdit(null))}>Cancel</button>
            <button type="submit" className="btn btn--primary btn--sm" disabled={!text.trim() || busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      ) : (
        <>
          <div className="prompts-modal__body">
            {!prompts.length && <p className="prompts-modal__none">No prompts yet.</p>}
            <ul className="prompts-modal__list">
              {prompts.map((p, i) => (
                <li key={p.id} className="prompts-modal__row">
                  <button type="button" className="prompts-modal__use" onClick={() => onPick(p)} title="Put it in the message box">
                    <b>{p.title}</b>
                    <small>{[i < CHIPS ? 'Chip' : '', p.uses ? `used ${p.uses} ${p.uses === 1 ? 'time' : 'times'}` : 'not used yet', p.byBot ? `by ${bot.name}` : ''].filter(Boolean).join(' · ')}</small>
                  </button>
                  <button type="button" className="icon-btn" onClick={() => start(p)} aria-label={`Edit ${p.title}`} title="Edit"><Pencil size={14} /></button>
                  {sure === p.id
                    ? <button type="button" className="btn btn--secondary btn--sm" disabled={busy} autoFocus onBlur={() => setSure(null)} onClick={() => void run(() => api.deletePrompt(bot.id, p.id), () => setSure(null))}>Delete?</button>
                    : <button type="button" className="icon-btn" onClick={() => setSure(p.id)} aria-label={`Delete ${p.title}`} title="Delete"><Trash2 size={14} /></button>}
                </li>
              ))}
            </ul>
            {error && <div className="card__error" role="alert">{error}</div>}
          </div>
          <div className="modal__footer">
            <span className="prompts-modal__hint">The {CHIPS} most used show as chips.{bot.kind === 'room' ? '' : ` You can also ask ${bot.name} to add or change one.`}</span>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => start()}>Add a prompt</button>
          </div>
        </>
      )}
    </Modal>
  );
}
