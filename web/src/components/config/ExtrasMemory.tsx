import { useCallback, useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { Glyph } from './glyphs';
import { jdel, jget, jpost } from './ExtrasApi';
import { shortDate } from './ui';

interface Gauge { used: number; limit: number; percent: number }
interface Usage { notes: Gauge; user: Gauge }
interface Pin { id: string; text: string; createdAt: number }

function Bar({ label, g }: { label: string; g: Gauge }) {
  const pct = Math.max(0, Math.min(100, Math.round(g.percent)));
  const full = pct >= 90;
  return (
    <div className={`cfg-meter${full ? ' is-full' : ''}`}>
      <div className="cfg-meter__label"><span>{label}</span><span>{g.used.toLocaleString()} / {g.limit.toLocaleString()} characters</span></div>
      <div className="cfg-meter__track"><span style={{ width: `${Math.max(2, pct)}%` }} /></div>
      {full && <div className="cfg-field__hint">Full: new things push old ones out. Pin what must stay.</div>}
    </div>
  );
}

/** How full the bot's own memory files are (its notes, and what it knows about you). */
export function MemoryGauge({ bot, refresh }: { bot: Bot; refresh?: unknown }) {
  const [usage, setUsage] = useState<Usage | null | undefined>(undefined);
  useEffect(() => {
    let on = true;
    jget<{ usage: Usage | null }>(`/api/bot-memory/${bot.id}/memory-usage`).then((r) => { if (on) setUsage(r.usage); }).catch(() => { if (on) setUsage(null); });
    return () => { on = false; };
  }, [bot.id, refresh]);
  if (usage === null) return null;
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">How full its memory is</div>
      {usage === undefined ? <div className="cfg-field__hint">Loading…</div> : (
        <div className="xm-gauges">
          <Bar label="Its notes" g={usage.notes} />
          <Bar label="What it knows about you" g={usage.user} />
        </div>
      )}
    </section>
  );
}

/** Rules that go with every message to this bot and never get pushed out of its memory. */
export function PinnedRules({ bot }: { bot: Bot }) {
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/bot-memory/${bot.id}/pins`;
  const load = useCallback(() => { jget<{ pins: Pin[] }>(base).then((r) => setPins(r.pins)).catch((e) => { setPins([]); setError((e as Error).message); }); }, [base]);
  useEffect(load, [load]);
  const add = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setError(null);
    try { setPins((await jpost<{ pins: Pin[] }>(base, { text: t })).pins); setText(''); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async (p: Pin) => {
    setError(null);
    try { setPins((await jdel<{ pins: Pin[] }>(`${base}/${encodeURIComponent(p.id)}`)).pins); }
    catch (e) { setError((e as Error).message); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Pinned rules</div>
      <div className="cfg-field__hint">Pinned rules go with every message to this bot and are never pushed out of its memory.</div>
      {pins && pins.length > 0 && (
        <div className="cfg-list">
          {pins.map((p) => (
            <div key={p.id} className="cfg-item">
              <span className="cfg-item__icon"><Glyph name="spark" size={14} /></span>
              <div className="cfg-item__text">
                <div className="cfg-item__body">{p.text}</div>
                <div className="cfg-item__meta"><span>Pinned {shortDate(p.createdAt)}</span></div>
              </div>
              <div className="cfg-item__actions">
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void remove(p)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <form className="xm-pin-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input className="text-input" value={text} maxLength={500} placeholder={`e.g. Always sign emails as “The HeyZubi team”`} onChange={(e) => setText(e.target.value)} aria-label="New pinned rule" />
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!text.trim() || busy}>{busy ? 'Pinning…' : 'Pin'}</button>
      </form>
      {error && <div className="cfg-error cfg-error--small">{error}</div>}
    </section>
  );
}
