import { useState } from 'react';
import { useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import { jpost } from './ExtrasApi';

const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric' });

/** "Add a nightly trend scout": a routine that looks at what's rising in a field each night and saves a report. */
export function TrendScoutForm() {
  const bots = useStore((s) => s.bots);
  const team = bots.filter((b) => b.kind !== 'room' && !(b as { hidden?: boolean }).hidden);
  const [open, setOpen] = useState(false);
  const [botId, setBotId] = useState('');
  const [topic, setTopic] = useState('');
  const [hour, setHour] = useState(22);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const pick = botId || team.find((b) => b.isPrimary)?.id || team[0]?.id || '';
  const add = async () => {
    if (!pick || !topic.trim() || busy) return;
    setBusy(true); setMsg(null);
    try {
      let timezone = 'UTC';
      try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* keep UTC */ }
      await jpost('/api/content/trend-scout', { botId: pick, topic: topic.trim(), hour, timezone });
      useConfigUI.getState().bump('routines');
      setMsg({ text: `Added. ${team.find((b) => b.id === pick)?.name ?? 'It'} scouts every night at ${hourLabel(hour)} and saves a report in its Library.` });
      setTopic(''); setOpen(false);
    } catch (e) { setMsg({ text: (e as Error).message, bad: true }); }
    finally { setBusy(false); }
  };
  if (!team.length) return null;
  return (
    <div className="xt-scout">
      {!open ? (
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setOpen(true); setMsg(null); }}>Add a nightly trend scout</button>
      ) : (
        <form className="cfg-card xt-scout__form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <div className="cfg-row__title">Add a nightly trend scout</div>
          <div className="cfg-row__sub">Each night it looks at what’s new and rising in your field, picks the 5 most useful trends with links and an idea for each, and saves the report in its Library. It never posts or contacts anyone.</div>
          <div className="xt-scout__fields">
            <label className="routines-pick">
              <span>Team member</span>
              <select value={pick} onChange={(e) => setBotId(e.target.value)} aria-label="Team member">
                {team.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <label className="routines-pick">
              <span>At</span>
              <select value={hour} onChange={(e) => setHour(Number(e.target.value))} aria-label="Hour">
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </label>
          </div>
          <input className="text-input" value={topic} maxLength={200} placeholder="What to watch, e.g. AI tools for small US businesses" onChange={(e) => setTopic(e.target.value)} aria-label="Topic" autoFocus />
          <div className="xt-scout__actions">
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || topic.trim().length < 3}>{busy ? 'Adding…' : 'Add routine'}</button>
          </div>
        </form>
      )}
      {msg && <div className={msg.bad ? 'cfg-error cfg-error--small' : 'cfg-field__hint'} role="status">{msg.text}</div>}
    </div>
  );
}
