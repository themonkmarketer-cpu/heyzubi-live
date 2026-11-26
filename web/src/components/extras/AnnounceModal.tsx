import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { Modal } from '../modals/Modal';
import { jsonFetch } from './http';

const PLATFORMS = [
  { key: 'instagram', name: 'Instagram' },
  { key: 'facebook', name: 'Facebook' },
  { key: 'linkedin', name: 'LinkedIn' },
  { key: 'x', name: 'X' },
  { key: 'whatsapp', name: 'WhatsApp Status' },
  { key: 'youtube', name: 'YouTube' },
  { key: 'email', name: 'Email' },
] as const;

interface Draft { platform: string; name: string; text: string }

/** One announcement, written up for every platform. Drafts only: nothing is posted. */
export function AnnounceModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [picked, setPicked] = useState<string[]>(PLATFORMS.map((p) => p.key));
  const [busy, setBusy] = useState(false);
  const [secs, setSecs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (!busy) return;
    setSecs(0);
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const toggle = (k: string) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  const canWrite = text.trim().length >= 10 && picked.length > 0 && !busy;

  const write = async () => {
    if (!canWrite) return;
    setBusy(true); setError(null); setDrafts(null);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const r = await jsonFetch<{ drafts: Draft[] }>('/api/content/announce', 'POST', { text: text.trim(), link: link.trim(), platforms: picked }, ac.signal);
      setDrafts(r.drafts);
    } catch (e) {
      if (!ac.signal.aborted) setError((e as Error).message);
    } finally {
      if (!ac.signal.aborted) setBusy(false);
    }
  };

  const copy = async (d: Draft) => {
    try { await navigator.clipboard.writeText(d.text); setCopied(d.platform); setTimeout(() => setCopied((c) => (c === d.platform ? null : c)), 1800); }
    catch { setError('Couldn’t copy. Select the text and copy it by hand.'); }
  };

  return (
    <Modal onClose={onClose} className="announce-modal" label="Announce on every platform">
      <form onSubmit={(e) => { e.preventDefault(); void write(); }}>
        <div className="modal__header">
          <div className="modal__title">Announce on every platform</div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
        </div>
        <div className="announce-modal__body">
          <label className="announce-field">
            <span>What do you want to announce?</span>
            <textarea className="text-input" rows={4} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} autoFocus
              placeholder="New opening hours from Monday: 8 am to 8 pm, every day." />
          </label>
          <label className="announce-field">
            <span>Link (optional)</span>
            <input className="text-input" type="url" value={link} maxLength={300} onChange={(e) => setLink(e.target.value)} placeholder="https://" />
          </label>
          <div className="announce-plats" role="group" aria-label="Platforms">
            {PLATFORMS.map((p) => (
              <label key={p.key} className={`announce-plat${picked.includes(p.key) ? ' is-on' : ''}`}>
                <input type="checkbox" checked={picked.includes(p.key)} onChange={() => toggle(p.key)} />
                {p.name}
              </label>
            ))}
          </div>
          <p className="announce-note">Drafts only. Nothing is posted.</p>
          {busy && <div className="composer__note" role="status">Writing {picked.length} {picked.length === 1 ? 'draft' : 'drafts'}… {secs} s (this takes 10 to 40 seconds)</div>}
          {error && <div className="card__error announce-err" role="alert">{error}</div>}
          {drafts && (
            <div className="announce-drafts">
              {drafts.map((d) => (
                <div key={d.platform} className="announce-draft">
                  <div className="announce-draft__head">
                    <b>{d.name}</b>
                    <span className={`announce-draft__n${d.platform === 'x' && d.text.length > 280 ? ' is-over' : ''}`}>{d.text.length}{d.platform === 'x' ? '/280' : ''} characters</span>
                    <button type="button" className="link-btn" onClick={() => void copy(d)}>{copied === d.platform ? 'Copied' : 'Copy'}</button>
                  </div>
                  <div className="announce-draft__text">{d.text || 'No draft came back for this one.'}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>Close</button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={!canWrite}>{busy ? 'Writing…' : drafts ? 'Write them again' : 'Write the drafts'}</button>
        </div>
      </form>
    </Modal>
  );
}
