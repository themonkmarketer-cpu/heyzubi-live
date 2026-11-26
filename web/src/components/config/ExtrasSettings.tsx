import { useCallback, useEffect, useState } from 'react';
import { useAppPrefs, usePrefs, type PrefsPatch } from '../../lib/appPrefs';
import { relativeShort } from '../../lib/time';
import { useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import { ConfirmButton, Segmented } from './ui';
import { daysLeft, inTime, jdel, jget, jpost } from './ExtrasApi';

// ---------------------------------------------------------------------------
// General › Demo language and Voice confirm word

type Lang = 'en' | 'es';
interface ExtraPrefs { language?: Lang; voiceConfirmWord?: string }

export function DemoLanguageSettings() {
  const prefs = usePrefs() as (ReturnType<typeof usePrefs> & ExtraPrefs) | null;
  const [word, setWord] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const save = async (patch: ExtraPrefs, ok: string) => {
    setNote(null);
    const err = await useAppPrefs.getState().save(patch as PrefsPatch);
    setNote(err ?? ok);
    if (!err) setTimeout(() => setNote(null), 2000);
  };
  const lang: Lang = prefs?.language === 'es' ? 'es' : 'en';
  const savedWord = prefs?.voiceConfirmWord ?? '';
  const draft = word ?? savedWord;
  const saveWord = async () => {
    if (word === null || word.trim() === savedWord) { setWord(null); return; }
    await save({ voiceConfirmWord: word.trim() }, word.trim() ? 'Confirm word saved' : 'Confirm word removed');
    setWord(null);
  };
  return (
    <>
      <section className="cfg-section">
        <div className="cfg-section__label">Demo language</div>
        {!prefs ? <div className="cfg-field__hint">Loading…</div> : (
          <Segmented<Lang> label="Demo language" value={lang} options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]} onChange={(v) => { if (v !== lang) void save({ language: v }, v === 'es' ? 'Team answers in Spanish now' : 'Team answers in English now'); }} />
        )}
        <div className="cfg-field__hint">Español: every team member answers in Spanish, for demos to Spanish-speaking clients. The app’s own screens stay in English.</div>
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Voice confirm word</div>
        <form className="xm-pin-form" onSubmit={(e) => { e.preventDefault(); void saveWord(); }}>
          <input className="text-input" value={draft} maxLength={40} placeholder="e.g. pineapple" disabled={!prefs} onChange={(e) => setWord(e.target.value)} onBlur={() => void saveWord()} aria-label="Voice confirm word" />
          <button type="submit" className="cfg-btn cfg-btn--secondary" disabled={!prefs || word === null || word.trim() === savedWord}>Save</button>
        </form>
        <div className="cfg-field__hint">On a voice call, approving something risky (sending, posting, deleting) needs this word said out loud. Empty: risky things can only be approved in the chat.</div>
      </section>
      {note && <div className="cfg-field__hint" role="status">{note}</div>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Health › Ask Zubi to check

export function AskZubiButton({ disabled }: { disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primary = useStore((s) => s.bots.find((b) => b.isPrimary));
  const ask = async () => {
    const bot = useStore.getState().bots.find((b) => b.isPrimary);
    if (!bot) return;
    setBusy(true); setError(null);
    try {
      await jpost(`/api/bots/${encodeURIComponent(bot.id)}/messages`, { text: 'Run heyzubi_doctor and tell me what needs fixing in HeyZubi, step by step.' });
      useStore.getState().selectBot(bot.id);
      useConfigUI.getState().closeAppSettings();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <>
      <button type="button" className="cfg-btn" disabled={disabled || busy || !primary} onClick={() => void ask()} title={primary ? `${primary.name} checks HeyZubi and tells you what to fix` : 'No main team member yet'}>
        {busy ? 'Asking…' : `Ask ${primary?.name ?? 'Zubi'} to check`}
      </button>
      {error && <span className="cfg-error cfg-error--small">{error}</span>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Access map

type Access = 'read' | 'writes' | 'key';
interface AccessTool { name: string; kind: 'toolset' | 'app' | 'heyzubi'; access: Access; label: string }
interface AccessBot { id: string; name: string; role: string; profile: string; level: Access | null; label?: string; tools: AccessTool[]; apps: string[]; error?: string }

const ORDER: Record<Access, number> = { key: 0, writes: 1, read: 2 };

export function AccessMapBody() {
  const [data, setData] = useState<{ apps: string[]; bots: AccessBot[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setData(null); setError(null);
    jget<{ apps: string[]; bots: AccessBot[] }>('/api/hire/access-map').then(setData).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);
  return (
    <>
      <section className="cfg-section">
        <div className="cfg-field__hint">
          What each team member can reach, from the tools it has. <span className="hire-pill is-read">Read only</span> looks things up and changes nothing.{' '}
          <span className="hire-pill is-writes">Writes</span> can change or send things (it still asks you first for anything risky).{' '}
          <span className="hire-pill is-key">Holds a key</span> has its own password or key to an outside service.
        </div>
      </section>
      <section className="cfg-section">
        <div className="health-head">
          <div className="cfg-section__label">Team members</div>
          <span className="cfg-field__hint">{!data && !error ? 'Reading each team member’s tools…' : data ? `${data.bots.length} team member${data.bots.length === 1 ? '' : 's'}` : ''}</span>
          <button type="button" className="cfg-btn" onClick={load} disabled={!data && !error}>Check again</button>
        </div>
        {error && <div className="st-result is-bad">{error}</div>}
        {!data && !error && <div className="cfg-empty">Reading each team member’s tools…</div>}
        {data && data.bots.length === 0 && <div className="cfg-empty">No team members yet.</div>}
        {data?.bots.map((b) => (
          <div key={b.id} className="cfg-card xa-card">
            <div className="xa-card__head">
              <div className="cfg-row__title">{b.name}{b.role ? ` · ${b.role}` : ''}</div>
              {b.level && <span className={`hire-pill is-${b.level}`}>{b.label || (b.level === 'key' ? 'Holds a key' : b.level === 'writes' ? 'Writes' : 'Read only')}</span>}
            </div>
            {b.error ? <div className="cfg-row__sub">Couldn’t read its tools: {b.error}</div> : b.tools.length === 0 ? <div className="cfg-row__sub">No tools.</div> : (
              <div className="xa-pills">
                {[...b.tools].sort((x, y) => ORDER[x.access] - ORDER[y.access] || x.label.localeCompare(y.label)).map((t) => (
                  <span key={`${t.kind}:${t.name}`} className={`hire-pill is-${t.access}`} title={`${t.name}: ${t.label}`}>{t.kind === 'app' ? `${t.name} (apps)` : t.kind === 'heyzubi' ? 'HeyZubi tools' : t.name}</span>
                ))}
              </div>
            )}
            {b.apps.length > 0 && <div className="cfg-row__sub">Connected apps it can reach: {b.apps.join(', ')}</div>}
          </div>
        ))}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Recently deleted

interface DeletedBot { id: string; name: string; label: string; kind: string; deletedAt: number; goneAt: number }

export function DeletedBody() {
  const [data, setData] = useState<{ keepDays: number; bots: DeletedBot[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => { jget<{ keepDays: number; bots: DeletedBot[] }>('/api/deleted').then(setData).catch((e) => setMsg((e as Error).message)); }, []);
  useEffect(load, [load]);
  const restore = async (b: DeletedBot) => {
    setBusy(b.id); setMsg(null);
    try { await jpost(`/api/deleted/${encodeURIComponent(b.id)}/restore`); await useStore.getState().loadBots().catch(() => {}); setMsg(`${b.name} is back in the sidebar.`); load(); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  };
  const purge = async (b: DeletedBot) => {
    setMsg(null);
    try { await jdel(`/api/deleted/${encodeURIComponent(b.id)}`); load(); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <>
      <section className="cfg-section">
        <div className="cfg-field__hint">Deleted team members wait here for {data?.keepDays ?? 7} days with their chat, memories, skills and routines. Restore one to bring it all back.</div>
      </section>
      <section className="cfg-section">
        {!data ? <div className="cfg-empty">{msg ? '' : 'Loading…'}</div> : data.bots.length === 0 ? <div className="cfg-empty">Nothing deleted lately.</div> : (
          <div className="cfg-card">
            {data.bots.map((b) => {
              const d = daysLeft(b.goneAt);
              return (
                <div key={b.id} className="cfg-row">
                  <div className="cfg-row__text">
                    <div className="cfg-row__title">{b.name}{b.label ? ` · ${b.label}` : ''}{b.kind === 'room' ? ' (group chat)' : ''}</div>
                    <div className="cfg-row__sub">Deleted {relativeShort(b.deletedAt) === 'now' ? 'just now' : /^\d/.test(relativeShort(b.deletedAt)) ? `${relativeShort(b.deletedAt)} ago` : relativeShort(b.deletedAt).toLowerCase()} · {d <= 0 ? 'Removed for good today' : `Removed for good in ${d} day${d === 1 ? '' : 's'}`}</div>
                  </div>
                  <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy === b.id} onClick={() => void restore(b)}>{busy === b.id ? 'Restoring…' : 'Restore'}</button>
                  <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Delete for good" onConfirm={() => purge(b)}>Delete now</ConfirmButton>
                </div>
              );
            })}
          </div>
        )}
      </section>
      {msg && <div className="cfg-field__hint" role="status">{msg}</div>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Share links

interface ShareLink { token: string; botId: string; file: string; path: string; expiresAt: number; revoked: boolean; live: boolean; views: number; lastViewAt: number | null; createdAt: number }

export function SharesBody() {
  const bots = useStore((s) => s.bots);
  const [shares, setShares] = useState<ShareLink[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => { jget<{ shares: ShareLink[] }>('/api/shares').then((r) => setShares(r.shares)).catch((e) => setMsg((e as Error).message)); }, []);
  useEffect(load, [load]);
  const off = async (s: ShareLink) => {
    setMsg(null);
    try { await jdel(`/api/shares/${encodeURIComponent(s.token)}`); load(); } catch (e) { setMsg((e as Error).message); }
  };
  const nameOf = (id: string) => bots.find((b) => b.id === id)?.name ?? 'Removed team member';
  return (
    <>
      <section className="cfg-section">
        <div className="cfg-field__hint">
          Links are made from a team member’s Library (the Share button next to a file). A link shows that one file only, until it expires or you turn it off. Links open only for people who can reach this HeyZubi’s address.
        </div>
      </section>
      <section className="cfg-section">
        {!shares ? <div className="cfg-empty">{msg ? '' : 'Loading…'}</div> : shares.length === 0 ? <div className="cfg-empty">No links yet.</div> : (
          <div className="cfg-card">
            {shares.map((s) => {
              const state = s.live ? `expires ${inTime(s.expiresAt)}` : s.revoked ? 'turned off' : 'expired';
              return (
                <div key={s.token} className={`cfg-row${s.live ? '' : ' xsh-off'}`}>
                  <div className="cfg-row__text">
                    <div className="cfg-row__title">{s.file.split('/').pop()}</div>
                    <div className="cfg-row__sub">{nameOf(s.botId)} · {state} · {s.views} view{s.views === 1 ? '' : 's'}{s.lastViewAt ? `, last ${relativeShort(s.lastViewAt) === 'now' ? 'just now' : relativeShort(s.lastViewAt)}` : ''}</div>
                    <div className="cfg-row__sub xsh-link">{location.origin}{s.path}</div>
                  </div>
                  {s.live && <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Turn off link" onConfirm={() => off(s)}>Turn off</ConfirmButton>}
                </div>
              );
            })}
          </div>
        )}
      </section>
      {msg && <div className="cfg-field__hint" role="status">{msg}</div>}
    </>
  );
}
