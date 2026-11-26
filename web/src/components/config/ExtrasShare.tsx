import { useState } from 'react';
import { inTime, jpost } from './ExtrasApi';

const CHOICES: { hours: number; label: string }[] = [
  { hours: 1, label: '1 hour' }, { hours: 24, label: '1 day' }, { hours: 72, label: '3 days' }, { hours: 168, label: '7 days' }, { hours: 720, label: '30 days' },
];

/** Library row › Share (shown under the row): pick how long the link lasts, then copy it. */
export function SharePanel({ botId, file, name, onClose }: { botId: string; file: string; name: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const make = async (hours: number) => {
    setBusy(true); setError(null); setCopied(false);
    try {
      const r = await jpost<{ share: { path: string; expiresAt: number } }>('/api/shares', { botId, file, hours });
      setLink({ url: `${location.origin}${r.share.path}`, expiresAt: r.share.expiresAt });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.url); setCopied(true); } catch { setError('Couldn’t copy: select the link and copy it.'); }
  };
  return (
    <div className="xsh-pop" role="group" aria-label={`Share ${name}`}>
      {!link ? (
        <>
          <span className="xsh-pop__label">Share {name} with a link that lasts</span>
          <div className="xsh-pop__choices">
            {CHOICES.map((c) => <button key={c.hours} type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void make(c.hours)}>{c.label}</button>)}
            <button type="button" className="link-btn link-btn--small" onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <input className="text-input xsh-link" readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Share link" />
          <div className="xsh-pop__choices">
            <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onClose}>Done</button>
          </div>
          <span className="xsh-pop__label">Works {inTime(link.expiresAt).replace(/^in /, 'for ')}, for this one file only. Turn it off in Settings › Share links.</span>
        </>
      )}
      {busy && <span className="xsh-pop__label">Making the link…</span>}
      {error && <span className="cfg-error cfg-error--small">{error}</span>}
    </div>
  );
}
