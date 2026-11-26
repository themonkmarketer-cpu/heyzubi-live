import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';

/**
 * Hire from a file or a role bundle (server/src/hire.ts): pick one, see what the employee gets (its role, model,
 * skills, and every tool with its "read only / writes / holds a key" label), then hire.
 */

type Access = 'read' | 'writes' | 'key';
interface HireFile {
  format: 'heyzubi.hire'; version: 1; exportedAt?: number;
  employee: { name: string; role: string; description: string; instructions: string };
  engine: { provider: string | null; model: string | null };
  soul: string; skills: { name: string }[]; agentSkillsOff: string[]; toolsets: string[]; mcpServers: string[];
}
interface AccessInfo { level: Access; label: string; tools: { name: string; kind: 'toolset' | 'app' | 'heyzubi'; access: Access; label: string }[] }
interface Review { file: HireFile; warnings: string[]; access: AccessInfo; from: string }

const call = async <T,>(method: string, path: string, body?: unknown, raw?: string): Promise<T> => {
  const r = await fetch(`/api/hire${path}`, { method, credentials: 'include', headers: { 'content-type': 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HeyZubi answered ${r.status}`);
  return j as T;
};

const Pill = ({ a, label }: { a: Access; label: string }) => <span className={`hire-pill is-${a}`}>{label}</span>;

export function HirePanel({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [bundles, setBundles] = useState<{ id: string; file: HireFile; access: AccessInfo }[] | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [name, setName] = useState('');
  const [useModel, setUseModel] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { call<{ bundles: { id: string; file: HireFile; access: AccessInfo }[] }>('GET', '/bundles').then((r) => setBundles(r.bundles)).catch((e) => setError(e.message)); }, []);

  const open = (r: Review) => { setReview(r); setName(r.file.employee.name); setUseModel(true); setError(null); };
  const readFile = async (f: File) => {
    setError(null);
    if (f.size > 1_000_000) return setError('That file is over 1 MB.');
    try { const r = await call<Omit<Review, 'from'>>('POST', '/review', undefined, await f.text()); open({ ...r, from: f.name }); } catch (e) { setError((e as Error).message); }
  };
  const hire = async () => {
    if (!review) return;
    setBusy(true); setError(null);
    try {
      const { bot } = await call<{ bot: { id: string } }>('POST', '', { file: review.file, name: name.trim(), useModel });
      const st = useStore.getState();
      await st.loadBots().catch(() => {});
      st.selectBot(bot.id);
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  if (review) {
    const f = review.file;
    const model = f.engine.model ? `${f.engine.model} (${f.engine.provider})` : null;
    return (
      <div className="hire">
        <div className="hire__from">From {review.from} <Pill a={review.access.level} label={review.access.label} /></div>
        <label className="hire__row"><span>Name</span><input className="text-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="Name" /></label>
        {f.employee.role && <div className="hire__row"><span>Role</span><b>{f.employee.role}</b></div>}
        {f.employee.description && <p className="hire__desc">{f.employee.description}</p>}
        <div className="hire__row is-top"><span>Tools</span>
          {review.access.tools.length === 0 ? <i>This HeyZubi’s usual tools</i> : (
            <ul className="hire__tools">{review.access.tools.map((t) => <li key={`${t.kind}:${t.name}`}>{t.kind === 'app' ? `${t.name} (connected apps)` : t.kind === 'heyzubi' ? 'HeyZubi tools' : t.name} <Pill a={t.access} label={t.label} /></li>)}</ul>
          )}
        </div>
        <div className="hire__row"><span>Skills</span>{f.skills.length ? `${f.skills.length}: ${f.skills.map((s) => s.name).slice(0, 4).join(', ')}${f.skills.length > 4 ? '…' : ''}` : 'None of its own'}</div>
        {f.soul.trim() && <div className="hire__row"><span>Character</span>Its own SOUL ({Math.round(f.soul.length / 100) / 10}k characters)</div>}
        {model && <label className="hire__row"><span>Model</span><span><input type="checkbox" checked={useModel} onChange={(e) => setUseModel(e.target.checked)} /> Use {model}</span></label>}
        <p className="hire__note">A hire file holds no keys or sign-ins: apps it uses must be connected on this HeyZubi. Anything that sends, posts or deletes still waits for your OK.</p>
        {review.warnings.map((w) => <div key={w} className="hire__warn">{w}</div>)}
        {error && <div className="card__error">{error}</div>}
        <div className="modal__footer">
          <button type="button" className="link-btn link-btn--small" style={{ marginRight: 'auto' }} onClick={() => setReview(null)}>Back</button>
          <button type="button" className="btn btn--primary btn--sm" disabled={busy || !name.trim()} onClick={() => void hire()}>{busy ? 'Hiring…' : `Hire ${name.trim() || ''}`.trim()}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="hire">
      <div className="hire__label">Start from a role</div>
      {!bundles ? <p className="hire__note">Loading…</p> : (
        <div className="hire__bundles">
          {bundles.map((b) => (
            <button key={b.id} type="button" className="hire__bundle" onClick={() => open({ file: b.file, access: b.access, warnings: [], from: `the ${b.file.employee.role} role` })}>
              <span className="hire__bundle-top"><b>{b.file.employee.role}</b><Pill a={b.access.level} label={b.access.label} /></span>
              <span className="hire__bundle-sub">{b.file.employee.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="hire__label">Or from a hire file</div>
      <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readFile(f); }} />
      <button type="button" className="btn btn--secondary btn--sm" onClick={() => input.current?.click()}>Choose a hire file…</button>
      <p className="hire__note">Export one from any team member’s settings (Hire file → Export).</p>
      {error && <div className="card__error">{error}</div>}
      <div className="modal__footer">
        <button type="button" className="link-btn link-btn--small" style={{ marginRight: 'auto' }} onClick={onBack}>Make one from scratch</button>
      </div>
    </div>
  );
}
