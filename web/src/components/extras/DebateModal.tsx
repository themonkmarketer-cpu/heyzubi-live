import { useState } from 'react';
import type { Bot } from '@shared/types';
import { Icon } from '../Icon';
import { Modal } from '../modals/Modal';
import { jsonFetch } from './http';

/** Start a debate in a group chat: the members argue it in turns, then one judges. */
export function DebateModal({ room, onClose }: { room: Bot; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [rounds, setRounds] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = question.trim().length >= 5 && !busy;

  const start = async () => {
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      await jsonFetch<{ ok: true; judge: string; speakers: string[]; rounds: number }>(`/api/rooms/${encodeURIComponent(room.id)}/debate`, 'POST', { question: question.trim(), rounds });
      onClose();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <Modal onClose={onClose} className="create-modal debate-modal" label="Start a debate">
      <form onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <div className="modal__header">
          <div className="modal__title">Start a debate in {room.name}</div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
        </div>
        <div className="create-modal__body" style={{ alignItems: 'stretch' }}>
          <label className="announce-field">
            <span>The question</span>
            <textarea className="text-input" rows={3} maxLength={600} value={question} onChange={(e) => setQuestion(e.target.value)} autoFocus
              placeholder="Should we raise prices by 10% in January?" />
          </label>
          <div className="announce-field">
            <span>Rounds</span>
            <div className="debate-rounds" role="radiogroup" aria-label="Rounds">
              {[1, 2, 3].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={rounds === n} className={`btn btn--sm ${rounds === n ? 'btn--primary' : 'btn--secondary'}`} onClick={() => setRounds(n)}>{n}</button>
              ))}
            </div>
          </div>
          <p className="announce-note">Each member speaks in turn, every round. One of them judges at the end.</p>
          {error && <div className="card__error" role="alert">{error}</div>}
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={!ok}>{busy ? 'Starting…' : 'Start the debate'}</button>
        </div>
      </form>
    </Modal>
  );
}
