import { useEffect, useRef, useState } from 'react';
import type { Bot } from '@shared/types';
import { Modal } from '../modals/Modal';
import { jsonFetch } from './http';

/**
 * One-job workers: one Kanban card for one team member, with a spending cap, a time limit and a step limit.
 * Hermes enforces the time and step limits; HeyZubi stops the card when it reaches its spending cap.
 */

export interface Worker { card: string; profile: string; title: string; capUsd: number; spentUsd: number; createdAt: number; stoppedAt: number | null; stopReason: string | null }

const usd = (n: number) => `$${n < 1 && n > 0 ? n.toFixed(n < 0.1 ? 3 : 2) : n.toFixed(2)}`;

export function NewWorkerDialog({ bots, onClose, onMade }: { bots: Map<string, Bot>; onClose: () => void; onMade: (w: Worker) => void }) {
  const people = [...bots.entries()].filter(([, b]) => b.kind !== 'room');
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [bot, setBot] = useState(people[0]?.[0] ?? '');
  const [cap, setCap] = useState('1.00');
  const [minutes, setMinutes] = useState('30');
  const [turns, setTurns] = useState('40');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capN = Number(cap), minN = Math.round(Number(minutes)), turnN = Math.round(Number(turns));
  const ok = !!title.trim() && !!bot && capN >= 0.01 && capN <= 50 && minN >= 1 && minN <= 240 && turnN >= 1 && turnN <= 200 && !busy;

  const start = async () => {
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      const r = await jsonFetch<{ worker: Worker }>('/api/workers', 'POST', { title: title.trim(), brief: brief.trim(), bot, capUsd: capN, maxMinutes: minN, maxTurns: turnN });
      onMade(r.worker);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <Modal onClose={() => { if (!busy) onClose(); }} className="kb-modal" label="New worker">
      <form onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <div className="modal__header"><span className="modal__title">New worker</span></div>
        <div className="kb-modal__body">
          <p className="kb-worker__how">A worker does one job on its own card, then stops. It prepares things for you to review; it doesn’t send, post, pay or delete.</p>
          <label className="cfg-field">
            <span className="cfg-field__label">Job title</span>
            <input className="text-input" autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Find 20 florists in Austin with their emails" />
          </label>
          <label className="cfg-field">
            <span className="cfg-field__label">Brief (optional)</span>
            <textarea className="text-input cfg-textarea" rows={4} value={brief} maxLength={12_000} onChange={(e) => setBrief(e.target.value)} placeholder="What to do, where to look, and what done looks like." />
          </label>
          <label className="cfg-field">
            <span className="cfg-field__label">Team member</span>
            <select className="text-input" value={bot} onChange={(e) => setBot(e.target.value)}>
              {!people.length && <option value="">No team member can take cards</option>}
              {people.map(([profile, b]) => <option key={profile} value={profile}>{b.label ? `${b.name} · ${b.label}` : b.name}</option>)}
            </select>
          </label>
          <div className="kb-worker__limits">
            <label className="cfg-field">
              <span className="cfg-field__label">Spending cap ($)</span>
              <input className="text-input" type="number" min={0.01} max={50} step={0.01} value={cap} onChange={(e) => setCap(e.target.value)} />
            </label>
            <label className="cfg-field">
              <span className="cfg-field__label">Time limit (minutes)</span>
              <input className="text-input" type="number" min={1} max={240} step={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </label>
            <label className="cfg-field">
              <span className="cfg-field__label">Step limit</span>
              <input className="text-input" type="number" min={1} max={200} step={1} value={turns} onChange={(e) => setTurns(e.target.value)} />
            </label>
          </div>
          {error && <div className="cfg-error" role="alert">{error}</div>}
          <div className="kb-modal__actions">
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!ok}>{busy ? 'Starting…' : 'Start the worker'}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** The workers so far: what each has spent of its cap, and why it stopped. */
export function WorkersPopover({ who, version, onClose, onOpen }: { who: (profile: string) => string; version: number; onClose: () => void; onOpen: (card: string) => void }) {
  const [list, setList] = useState<Worker[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    jsonFetch<{ workers: Worker[] }>('/api/workers').then((r) => { if (live) { setList(r.workers); setError(null); } }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [version]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose(); };
    const t = setTimeout(() => document.addEventListener('mousedown', down));
    return () => { clearTimeout(t); document.removeEventListener('mousedown', down); };
  }, [onClose]);

  return (
    <div ref={ref} className="kb-filter__pop kb-workers" role="dialog" aria-label="Workers"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <b className="kb-workers__title">Workers</b>
      {error ? <div className="cfg-error">{error}</div>
        : !list ? <div className="cfg-empty">Loading…</div>
        : !list.length ? <div className="cfg-empty">No workers yet. Start one with New worker.</div>
        : (
          <ul className="kb-workers__list">
            {list.map((w) => (
              <li key={w.card}>
                <button type="button" className="kb-workers__row" onClick={() => onOpen(w.card)} title="Open its card">
                  <span className="kb-workers__name">{w.title}</span>
                  <span className="kb-workers__sub">
                    {who(w.profile)} · {usd(w.spentUsd)} of {usd(w.capUsd)}
                    {' · '}{w.stoppedAt ? `Stopped: ${w.stopReason || 'finished'}` : 'Working or waiting'}
                  </span>
                  <span className="kb-workers__bar" aria-hidden><span style={{ width: `${Math.min(100, (w.spentUsd / (w.capUsd || 1)) * 100)}%` }} /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
