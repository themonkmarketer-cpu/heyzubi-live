import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Toolkit } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type ComputerDetails } from '../../lib/configApi';
import { api } from '../../lib/api';
import { relativeShort } from '../../lib/time';
import { notifyEnabled, notifySupported, setNotify } from '../../lib/notify';
import { backgroundOf, byId, customUrl, useWallpaper } from '../../lib/wallpapers';
import { useConfigUI, type AppSection, type Theme } from '../../configStore';
import { useStore } from '../../store';
import { computerStatusText } from '../DetailsPanel';
import { Icon } from '../Icon';
import { ToolkitLogo } from '../ToolkitLogo';
import { Glyph } from './glyphs';
import { ConfirmButton } from './ui';
import { EngineSettings } from '../EngineSettings';

const SECTIONS: { id: AppSection; label: string }[] = [
  { id: 'status', label: 'Status' },
  { id: 'general', label: 'General' },
  { id: 'teams', label: 'Teams' },
  { id: 'computer', label: 'Computer' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'apps', label: 'Connected apps' },
  { id: 'api', label: 'Outside programs' },
  { id: 'desktop', label: 'Windows app' },
  { id: 'account', label: 'Account' },
];

/** Full-window settings page, opened from the account menu. */
export function AppSettings() {
  const section = useConfigUI((s) => s.appSettings);
  const close = useConfigUI((s) => s.closeAppSettings);
  const open = useConfigUI((s) => s.openAppSettings);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-root')) { e.preventDefault(); close(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);
  if (!section) return null;
  return createPortal(
    <div className="app-settings" role="dialog" aria-modal="true" aria-label="Settings">
      <aside className="app-settings__nav">
        <button type="button" className="app-settings__back" onClick={close}><Glyph name="arrow_left" size={14} /> Back to your team</button>
        <div className="app-settings__heading">Settings</div>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className={`cfg-nav__item${section === s.id ? ' is-active' : ''}`} onClick={() => open(s.id)} aria-current={section === s.id || undefined}>
            {s.label}
          </button>
        ))}
      </aside>
      <div className="app-settings__main">
        <button type="button" className="app-settings__close icon-btn" onClick={close} aria-label="Close settings" title="Close (Esc)"><Icon name="close" opacity={0.8} /></button>
        <div className="app-settings__page">
          {section === 'status' && <StatusSection />}
          {section === 'general' && <GeneralSection />}
          {section === 'teams' && <TeamsSection />}
          {section === 'computer' && <ComputerSection />}
          {section === 'permissions' && <PermissionsSection />}
          {section === 'apps' && <AppsSection />}
          {section === 'api' && <ApiKeysSection />}
          {section === 'desktop' && <DesktopSection />}
          {section === 'account' && <AccountSection />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="app-settings__head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ThemeTile({ value, label, current, onPick }: { value: Theme; label: string; current: Theme; onPick: (t: Theme) => void }) {
  return (
    <button type="button" role="radio" aria-checked={current === value} className={`theme-tile${current === value ? ' is-active' : ''}`} onClick={() => onPick(value)}>
      <span className={`theme-tile__art is-${value}`} aria-hidden>
        <span className="theme-tile__side" />
        <span className="theme-tile__pane"><i /><i /><b /></span>
      </span>
      <span className="theme-tile__label">{label}</span>
    </button>
  );
}

function GeneralSection() {
  const theme = useConfigUI((s) => s.theme);
  const setTheme = useConfigUI((s) => s.setTheme);
  return (
    <>
      <PageHead title="General" />
      <section className="cfg-section">
        <div className="cfg-section__label">Theme</div>
        <div className="theme-tiles" role="radiogroup" aria-label="Theme">
          <ThemeTile value="system" label="System" current={theme} onPick={setTheme} />
          <ThemeTile value="pearl" label="Pearl" current={theme} onPick={setTheme} />
          <ThemeTile value="sand" label="Sand" current={theme} onPick={setTheme} />
          <ThemeTile value="obsidian" label="Obsidian" current={theme} onPick={setTheme} />
        </div>
        <div className="cfg-field__hint">Pearl is clean and neutral, Sand warm and quiet, Obsidian a calm dark. System follows your device: Pearl by day, Obsidian at night.</div>
        <div className="cfg-section__label theme-group__label">Legacy</div>
        <div className="theme-tiles theme-tiles--legacy" role="radiogroup" aria-label="Legacy theme">
          <ThemeTile value="light" label="Legacy light" current={theme} onPick={setTheme} />
          <ThemeTile value="dark" label="Legacy dark" current={theme} onPick={setTheme} />
          <ThemeTile value="navy" label="Navy" current={theme} onPick={setTheme} />
        </div>
      </section>
      <ChatWallpaperSetting />
      <NotificationsSetting />
    </>
  );
}

/** Teams (from Theo): the primary bot is the CEO; teams have a manager; ready-made teams; export and import. */
function TeamsSection() {
  const bots = useStore((s) => s.bots);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.teams>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => { api.teams().then(setData).catch((e) => setMsg((e as Error).message)); }, []);
  useEffect(load, [load, bots.length]);
  const ceo = bots.find((b) => b.isPrimary);
  const nameOf = (id: string | null) => bots.find((b) => b.id === id)?.name ?? '';
  const ready = async (key: string, team: string) => {
    setBusy(key); setMsg(null);
    try { await api.addReadyTeam(key); await useStore.getState().loadBots(); setMsg(`${team} team added. Its bots are in the sidebar.`); load(); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  };
  const exportTeam = async (name: string) => {
    try {
      const file = await api.exportTeam(name);
      const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.heyzubi-team.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { setMsg((e as Error).message); }
  };
  const importTeam = async (f: File | undefined) => {
    if (!f) return;
    setBusy('import'); setMsg(null);
    try { await api.importTeam(JSON.parse(await f.text())); await useStore.getState().loadBots(); setMsg('Team imported. Its bots are in the sidebar.'); load(); }
    catch (e) { setMsg(e instanceof SyntaxError ? 'That file isn’t a team file.' : (e as Error).message); } finally { setBusy(null); }
  };
  return (
    <>
      <PageHead title="Teams" />
      <section className="cfg-section">
        <div className="cfg-field__hint">{ceo ? `${ceo.name} is the CEO: every team reports to ${ceo.name}, and work for a team goes through its manager.` : ''} Set a bot’s team and manager in its settings.</div>
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Your teams</div>
        {!data ? <div className="cfg-empty">Loading…</div> : data.teams.length === 0 ? <div className="cfg-empty">No teams yet. Add a ready-made one below, or give bots a team in their settings.</div> : (
          <div className="cfg-card">
            {data.teams.map((t) => (
              <div key={t.name} className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{t.name}</div>
                  <div className="cfg-row__sub">{t.managerId ? `Manager: ${nameOf(t.managerId)}` : 'No manager yet'}{t.memberIds.length ? ` · ${t.memberIds.map(nameOf).join(', ')}` : ''}</div>
                </div>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void exportTeam(t.name)}>Export</button>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Ready-made teams</div>
        <div className="cfg-field__hint">Each is a manager and a team member with their roles written. {data ? `Room for ${data.room} more bot${data.room === 1 ? '' : 's'} on this computer.` : ''} Bots only cost money when they work.</div>
        <div className="cfg-card">
          {data?.ready.map((r) => (
            <div key={r.key} className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">{r.team}</div>
                <div className="cfg-row__sub">{r.blurb} · {r.size} bots</div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy || (data?.room ?? 0) < r.size} onClick={() => void ready(r.key, r.team)}>{busy === r.key ? 'Adding…' : 'Add'}</button>
            </div>
          ))}
        </div>
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Import a team</div>
        <label className="cfg-btn cfg-btn--secondary" style={{ display: 'inline-flex', cursor: 'pointer' }}>
          {busy === 'import' ? 'Importing…' : 'Choose a team file'}
          <input type="file" accept="application/json,.json" hidden onChange={(e) => { void importTeam(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <div className="cfg-field__hint">A team file comes from Export: names, roles and instructions only, no chats, memories or keys.</div>
      </section>
      {msg && <div className="cfg-field__hint" role="status">{msg}</div>}
    </>
  );
}

/** The chat wallpaper: what's on now, and the picker (opened over the chat, so its preview shows there too). */
function ChatWallpaperSetting() {
  const pref = useWallpaper((s) => s.pref);
  const bg = backgroundOf(pref.wallpaper, customUrl(pref.wallpaperFile));
  const name = pref.wallpaper === 'custom' ? 'Your picture' : byId(pref.wallpaper)?.name ?? 'Default';
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Chat wallpaper</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <span aria-hidden style={{ width: 56, height: 40, borderRadius: 8, flexShrink: 0, border: '0.5px solid var(--color-border-secondary)', background: bg ?? 'var(--color-bg-chrome)' }} />
          <div className="cfg-row__text">
            <div className="cfg-row__title">{name}</div>
            <div className="cfg-row__sub">The background behind your chats: 10 built-in wallpapers or a picture of your own.</div>
          </div>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { useConfigUI.getState().closeAppSettings(); useWallpaper.getState().openPicker(); }}>Change…</button>
        </div>
      </div>
    </section>
  );
}

/** HeyZubi for Windows (from Vello's Pointer Assistant): pair a PC so its talk keys can ask a bot about the screen. */
function DesktopSection() {
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof api.desktopDevices>>['devices'] | null>(null);
  const [pairing, setPairing] = useState<{ code: string; key: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [, tick] = useState(0);
  // The app ships with each deploy (scripts/pack.sh); the manifest is missing when it was packed without .NET.
  const [download, setDownload] = useState<{ version: string; size: number; sha256: string } | null | undefined>(undefined);
  // Inside the Windows app itself (its window adds HeyZubiDesktop/<version> to the user agent).
  const inApp = /HeyZubiDesktop\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? null;
  useEffect(() => {
    fetch('/downloads/heyzubi-windows.json', { cache: 'no-store' })
      .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() : null))
      .then((j) => setDownload(j && typeof j.sha256 === 'string' ? j : null))
      .catch(() => setDownload(null));
  }, []);
  const load = useCallback(() => { api.desktopDevices().then((r) => setDevices(r.devices)).catch((e) => setMsg((e as Error).message)); }, []);
  useEffect(load, [load]);
  // While a code is out, watch for the computer to show up, and count down.
  useEffect(() => {
    if (!pairing) return;
    const t = setInterval(() => { tick((n) => n + 1); load(); if (Date.now() > pairing.expiresAt) setPairing(null); }, 3000);
    return () => clearInterval(t);
  }, [pairing, load]);
  const known = devices?.length ?? 0;
  const [startCount, setStartCount] = useState(0);
  useEffect(() => { if (pairing && devices && devices.length > startCount) { setPairing(null); setMsg('Paired. Hold the talk keys on that computer and ask away.'); } }, [devices, pairing, startCount]);
  const pair = async () => {
    setMsg(null); setCopied(false);
    try {
      const r = await api.desktopPair();
      const key = `hzpair1.${btoa(JSON.stringify({ u: location.origin, c: r.code })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
      setStartCount(known);
      setPairing({ code: r.code, key, expiresAt: r.expiresAt });
    } catch (e) { setMsg((e as Error).message); }
  };
  const copy = async () => { if (!pairing) return; try { await navigator.clipboard.writeText(pairing.key); setCopied(true); } catch { setMsg('Couldn’t copy: select the key and copy it.'); } };
  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 60000)) : 0;
  return (
    <>
      <PageHead title="Windows app" />
      <section className="cfg-section">
        <div className="cfg-field__hint">
          HeyZubi for Windows is your whole HeyZubi in its own window, with its own taskbar icon and Windows notifications. It also adds the talk keys: hold Ctrl + Win in any app, ask about what’s on your screen and let go, and your bot answers out loud while an orange spark points at the thing to click (it only looks, talks and points; each question’s screenshots are used for that one answer). Closing the window keeps it in the tray. A paired computer is signed in to HeyZubi as you; removing it here signs it out.
        </div>
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Get the app</div>
        {inApp ? (
          <div className="cfg-card" style={{ padding: 12 }}>
            <div className="cfg-row__title">You’re using HeyZubi for Windows {inApp}.</div>
            <div className="cfg-row__sub">Talk keys, pairing and “start with Windows” are in its tray icon’s menu: Talk keys and pairing.</div>
          </div>
        ) : download === undefined ? <div className="cfg-empty">Checking…</div> : !download ? (
          <div className="cfg-empty">The Windows app isn’t included in this install (it was packed on a computer without .NET).</div>
        ) : (
          <div className="cfg-card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <a className="cfg-btn cfg-btn--primary" style={{ textDecoration: 'none' }} href="/downloads/HeyZubi.exe" download="HeyZubi.exe">Download HeyZubi for Windows</a>
              <span className="cfg-row__sub">Version {download.version} · {Math.max(1, Math.round(download.size / 1024))} KB · Windows 10 or 11, 64-bit</span>
            </div>
            <ol className="cfg-field__hint" style={{ margin: '10px 0 0', paddingLeft: 18 }}>
              <li>It needs Microsoft’s free <a href="https://dotnet.microsoft.com/download/dotnet/10.0" target="_blank" rel="noreferrer">.NET 10 Desktop Runtime</a> (x64). Many PCs already have it; the app tells you if it’s missing.</li>
              <li>Put HeyZubi.exe anywhere (for example a HeyZubi folder in Documents) and open it. It isn’t signed yet, so Windows may say it’s from an unknown publisher: choose <b>More info</b> › <b>Run anyway</b>.</li>
              <li>It opens its settings: pair it with a key from <b>Pair a computer</b> below. After that it lives in the tray.</li>
            </ol>
            <div className="cfg-row__sub" style={{ marginTop: 8, wordBreak: 'break-all' }}>SHA-256 {download.sha256}</div>
          </div>
        )}
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Pair a computer</div>
        {!pairing ? (
          <button type="button" className="cfg-btn cfg-btn--primary" style={{ alignSelf: 'flex-start' }} onClick={() => void pair()}>Pair a computer</button>
        ) : (
          <div className="cfg-card" style={{ padding: 12 }}>
            <div className="cfg-row__title">Paste this pairing key into HeyZubi for Windows (Settings › Pair). It works once, for {left} more minute{left === 1 ? '' : 's'}.</div>
            <pre className="cfg-skill-view" style={{ margin: '8px 0', userSelect: 'all', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{pairing.key}</pre>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy key'}</button>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setPairing(null)}>Cancel</button>
            </div>
            <div className="cfg-row__sub" style={{ marginTop: 8 }}>Or type the server address and the code {pairing.code}. Waiting for the computer…</div>
          </div>
        )}
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Paired computers</div>
        {!devices ? <div className="cfg-empty">Loading…</div> : devices.length === 0 ? <div className="cfg-empty">No computers yet.</div> : (
          <div className="cfg-card">
            {devices.map((d) => (
              <div key={d.id} className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{d.name}</div>
                  <div className="cfg-row__sub">Paired {relativeShort(d.createdAt)} ago · {d.lastUsedAt ? `last used ${relativeShort(d.lastUsedAt)} ago` : 'not used yet'}</div>
                </div>
                <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Remove computer" onConfirm={async () => { await api.deleteDesktopDevice(d.id); load(); }}>Remove</ConfirmButton>
              </div>
            ))}
          </div>
        )}
      </section>
      {msg && <div className="cfg-field__hint" role="status">{msg}</div>}
    </>
  );
}

/** Outside programs (from Theo's local API): keys that let n8n or a script message a bot. */
function ApiKeysSection() {
  const [keys, setKeys] = useState<Awaited<ReturnType<typeof api.apiKeys>>['keys'] | null>(null);
  const [name, setName] = useState('n8n');
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => { api.apiKeys().then((r) => setKeys(r.keys)).catch((e) => setMsg((e as Error).message)); }, []);
  useEffect(load, [load]);
  const create = async () => {
    setMsg(null);
    try { const r = await api.createApiKey(name); setFresh({ name: r.name, key: r.key }); load(); } catch (e) { setMsg((e as Error).message); }
  };
  const origin = location.origin;
  const example = fresh ? `curl -X POST ${origin}/api/inbound/messages \\\n  -H "Authorization: Bearer ${fresh.key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"bot":"Zubi","text":"New lead from the website form: …","wait":true}'` : '';
  return (
    <>
      <PageHead title="Outside programs" />
      <section className="cfg-section">
        <div className="cfg-field__hint">
          Let n8n, a script or another app send a bot a message. It shows in the chat as “Outside program”, and because it isn’t your own words the bot can look things up and draft, but never send, share, post or delete anything.
        </div>
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">New key</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="text-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="What will use it, e.g. n8n" aria-label="Key name" />
          <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => void create()}>Create key</button>
        </div>
        {fresh && (
          <div className="cfg-card" style={{ marginTop: 10, padding: 12 }}>
            <div className="cfg-row__title">Copy this key now: it won’t be shown again.</div>
            <pre className="cfg-skill-view" style={{ margin: '8px 0', userSelect: 'all' }}>{fresh.key}</pre>
            <div className="cfg-row__sub">Example (with "wait": true the reply comes back in the response):</div>
            <pre className="cfg-skill-view" style={{ margin: '8px 0' }}>{example}</pre>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setFresh(null)}>Done</button>
          </div>
        )}
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Keys</div>
        {!keys ? <div className="cfg-empty">Loading…</div> : keys.length === 0 ? <div className="cfg-empty">No keys yet.</div> : (
          <div className="cfg-card">
            {keys.map((k) => (
              <div key={k.id} className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{k.name}</div>
                  <div className="cfg-row__sub">Made {relativeShort(k.createdAt)} ago · {k.lastUsedAt ? `last used ${relativeShort(k.lastUsedAt)} ago` : 'not used yet'}</div>
                </div>
                <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Remove key" onConfirm={async () => { await api.deleteApiKey(k.id); load(); }}>Remove</ConfirmButton>
              </div>
            ))}
          </div>
        )}
      </section>
      {msg && <div className="cfg-field__hint" role="status">{msg}</div>}
    </>
  );
}

/** Desktop notifications when a bot finishes or needs your OK while HeyZubi isn't in front. */
function NotificationsSetting() {
  const [on, setOn] = useState(notifyEnabled());
  const [note, setNote] = useState('');
  if (!notifySupported()) return null;
  const toggle = async () => {
    const next = await setNotify(!on);
    setOn(next);
    setNote(!on && !next ? (Notification.permission === 'denied'
      ? 'Your browser is blocking notifications for this site: allow them in the site settings (the icon left of the address), then try again.'
      : 'Notifications weren’t allowed. Inside Zubi HQ, open HeyZubi on its own to turn them on.') : '');
    if (next) try { new Notification('HeyZubi notifications are on', { body: 'You’ll hear when a bot is done or needs your OK while you’re in another window.' }); } catch { /* fine */ }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Notifications</div>
      <label className="cfg-row" style={{ cursor: 'pointer' }}>
        <div>
          <div>Tell me when a bot is done or needs my OK</div>
          <div className="cfg-row__sub">Only while HeyZubi isn’t the window in front. Click a notification to open that chat.</div>
        </div>
        <input type="checkbox" checked={on} onChange={() => void toggle()} aria-label="Desktop notifications" />
      </label>
      {note && <div className="cfg-field__hint">{note}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------

interface StatusCard { key: string; title: string; ok: boolean; state: string; line: string }
interface StatusData { checked: number; cards: StatusCard[]; dataMode: { live: boolean; text: string }; google: { gmail: boolean; calendar: boolean } }

/** Status, after Zubi HQ's Settings: live checks, data mode, the agent's model and effort, a test prompt. */
function StatusSection() {
  const [data, setData] = useState<StatusData | null>(null);
  const [checking, setChecking] = useState(false);
  const [test, setTest] = useState<{ busy: boolean; ok?: boolean; text?: string; ms?: number } | null>(null);
  const primary = useStore((s) => s.bots.find((b) => b.isPrimary));
  const open = useConfigUI((s) => s.openAppSettings);
  const check = useCallback(() => {
    setChecking(true);
    fetch('/api/status', { credentials: 'include' }).then((r) => r.json()).then(setData).catch(() => {}).finally(() => setChecking(false));
  }, []);
  useEffect(check, [check]);
  const runTest = async () => {
    setTest({ busy: true });
    try {
      const r = await fetch('/api/status/test-agent', { method: 'POST', credentials: 'include' });
      const j = await r.json();
      setTest({ busy: false, ok: !!j.ok, text: j.ok ? j.reply : j.error || 'No answer.', ms: j.ms });
    } catch { setTest({ busy: false, ok: false, text: 'Couldn’t reach the server.' }); }
  };
  const card = (k: string) => data?.cards.find((c) => c.key === k);
  const placeholder: StatusCard[] = ['Obsidian', 'Google', 'Voice', 'Agent'].map((t) => ({ key: t.toLowerCase(), title: t, ok: false, state: '', line: '' }));
  return (
    <>
      <PageHead title="Status" sub="Live checks of what HeyZubi depends on. Keys stay on the server and are never shown here." />
      <section className="cfg-section">
        <div className="st-cards">
          {(data?.cards ?? placeholder).map((c) => (
            <div key={c.key} className={`st-card${data ? (c.ok ? ' is-ok' : ' is-bad') : ''}`}>
              <div className="st-card__title"><i />{c.title}</div>
              <div className="st-card__state">{data ? c.state : 'Checking…'}</div>
              <div className="st-card__line">{data ? c.line : ''}</div>
            </div>
          ))}
        </div>
        <div className="st-mode">
          <span className={`st-mode__dot${data?.dataMode.live ? ' is-live' : ''}`} />
          <span><b>Data mode</b> · {data ? `${data.dataMode.live ? 'Live' : 'Partly live'} · ${data.dataMode.text}` : '…'}</span>
          <button type="button" className="cfg-btn" onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Re-check'}</button>
        </div>
        {data && <div className="cfg-field__hint">Checked {relativeShort(data.checked)}.</div>}
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Agent</div>
        <div className="cfg-field__hint">{primary ? `${primary.name} runs on Hermes. Model and reasoning effort apply to every task ${primary.name} does in HeyZubi.` : 'No main team member yet.'}</div>
        {primary && <div className="st-engine"><EngineSettings bot={primary} /></div>}
        <div className="st-test">
          <button type="button" className="cfg-btn" onClick={runTest} disabled={!primary || test?.busy}>{test?.busy ? 'Testing…' : 'Test agent'}</button>
          <span className="cfg-field__hint">Runs one short paid prompt in a separate test conversation, so it never lands in your chat.</span>
        </div>
        {test && !test.busy && <div className={`st-result${test.ok ? ' is-ok' : ' is-bad'}`}>{test.ok ? '✓' : '✗'} {test.text}{test.ms ? ` · ${(test.ms / 1000).toFixed(1)} s` : ''}</div>}
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Voice</div>
        <div className="cfg-field__hint">{card('voice')?.state || '…'} · {card('voice')?.line ?? ''}. Checked without starting a call. Spend by service is under Voice chat in each team member’s panel.</div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Google</div>
        <div className="st-google">
          <span className={data?.google.gmail ? 'is-ok' : 'is-bad'}>{data?.google.gmail ? '✓' : '✗'} Gmail</span>
          <span className={data?.google.calendar ? 'is-ok' : 'is-bad'}>{data?.google.calendar ? '✓' : '✗'} Google Calendar</span>
          <button type="button" className="cfg-btn" onClick={() => open('apps')}>Manage connections</button>
        </div>
        <div className="cfg-field__hint">Read through Zubi’s own Composio connection (the accounts her Gmail and Calendar tools use). They power the Gmail and Calendar panels.</div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Obsidian</div>
        <div className="cfg-field__hint">{card('obsidian')?.state || '…'} · {card('obsidian')?.line ?? ''}. The vault is read-only here; Zubi and Claude write to it through the shared brain.</div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

const screenLabel = (id: string) => (id === 'default' ? 'Main screen' : `Screen ${Number(id.replace('screen-', '')) - 98 || id}`);

function ComputerSection() {
  const computer = useStore((s) => s.computer);
  const bots = useStore((s) => s.bots);
  const [details, setDetails] = useState<ComputerDetails | null>(null);
  const [busy, setBusy] = useState<'wake' | 'sleep' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { configApi.computerDetails().then(setDetails).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load, computer?.status, computer?.screens.length]);

  const status = computer?.status ?? details?.computer.status;
  const running = status === 'running';
  const transitioning = status === 'starting' || status === 'resuming' || status === 'creating' || status === 'suspending';
  const act = async (kind: 'wake' | 'sleep') => {
    setBusy(kind); setNote(null);
    try { kind === 'wake' ? await configApi.wake() : await configApi.sleep(); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(null); }
  };
  const byId = new Map(bots.map((b) => [b.id, b]));
  // The server says how many screens the computer can hold; 4 until it does.
  const maxScreens = computer?.maxScreens ?? details?.computer.maxScreens ?? 4;

  return (
    <>
      <PageHead title="Computer" sub="Your team shares one computer. Each team member works on their own screen." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className={`computer-status-dot is-${running ? 'on' : transitioning ? 'busy' : 'off'}`} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">Bots’ computer · {computerStatusText(computer ?? null)}</div>
              <div className="cfg-row__sub">
                {details ? `Goes to sleep after ${details.hibernation.idleMinutes} idle minutes when nobody is watching. Starts again on its own once someone on your team has work.` : 'Checking…'}
              </div>
            </div>
            {running || status === 'suspending' ? (
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!running || !!busy} onClick={() => act('sleep')}>{busy === 'sleep' || status === 'suspending' ? 'Going to sleep…' : 'Sleep'}</button>
            ) : (
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={transitioning || !!busy} onClick={() => act('wake')}>{busy === 'wake' || transitioning ? 'Waking…' : 'Wake'}</button>
            )}
          </div>
          {computer?.error && status === 'error' && <div className="cfg-error cfg-error--inset">{computer.error}</div>}
          {note && <div className="cfg-error cfg-error--inset">{note}</div>}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Screens in use{details && maxScreens ? ` · ${details.screens.length} of ${maxScreens}` : ''}</div>
        <div className="cfg-card">
          {!details ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : details.screens.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">No one on your team has used the computer yet.</div>
          ) : details.screens.map((s) => {
            const bot = byId.get(s.botId);
            return (
              <div key={s.botId} className="cfg-row">
                {bot ? <BotAvatarFor bot={bot} size={28} /> : <span className="cfg-row__ph" />}
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{bot?.name ?? 'Removed team member'}</div>
                  <div className="cfg-row__sub">{screenLabel(s.screenId)} · used {relativeShort(s.lastUsedAt) === 'now' ? 'just now' : `${relativeShort(s.lastUsedAt)}${/^\d/.test(relativeShort(s.lastUsedAt)) ? ' ago' : ''}`}</div>
                </div>
                <ConfirmButton
                  className="cfg-btn cfg-btn--secondary"
                  confirmLabel="Reset screen"
                  disabled={!running}
                  title={running ? 'Closes everything open on this screen' : 'Wake the computer first'}
                  onConfirm={async () => { try { await configApi.resetScreen(s.botId); setNote(null); load(); } catch (e) { setNote((e as Error).message); } }}
                >
                  Reset
                </ConfirmButton>
              </div>
            );
          })}
        </div>
        <div className="cfg-field__hint">Reset closes every window on that team member’s screen, so it starts clean next time.{maxScreens ? ` Up to ${maxScreens} team members can have a screen at once${details && details.screens.length >= maxScreens ? '; reset one to free it for someone else on your team' : ''}.` : ''}</div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function humanizeTool(slug: string): { app: string; action: string } {
  const parts = slug.split(/[_:]/).filter(Boolean);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (parts.length < 2) return { app: cap(slug), action: '' };
  return { app: cap(parts[0]), action: cap(parts.slice(1).join(' ')) };
}

function PermissionsSection() {
  const [policies, setPolicies] = useState<{ tool: string; mode: string }[] | null>(null);
  const load = useCallback(() => { configApi.policies().then((r) => setPolicies(r.policies)).catch(() => setPolicies([])); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHead title="Permissions" sub="Actions your team can take without asking first. Remove one and they’ll ask again next time." />
      <section className="cfg-section">
        <div className="cfg-card">
          {policies === null ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : policies.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">Nothing here yet. When you choose “Always allow” on an approval, it shows up here.</div>
          ) : policies.map((p) => {
            const h = humanizeTool(p.tool);
            return (
              <div key={p.tool} className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{h.app}{h.action ? ` · ${h.action}` : ''}</div>
                  <div className="cfg-row__sub">{p.mode === 'always_allow' ? 'Always allowed' : p.mode === 'blocked' ? 'Never allowed' : 'Asks first'} · <code className="cfg-code">{p.tool}</code></div>
                </div>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => configApi.deletePolicy(p.tool).then(load).catch(() => {})}>Ask again</button>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function AppsSection() {
  const version = useStore((s) => s.connectionsVersion);
  const [apps, setApps] = useState<Toolkit[] | null>(null);
  useEffect(() => { configApi.connectedApps().then((r) => setApps(r.connectedApps ?? [])).catch(() => setApps([])); }, [version]);
  const openApps = () => { useConfigUI.getState().closeAppSettings(); useStore.getState().setModal('apps'); };
  return (
    <>
      <PageHead title="Connected apps" sub="Apps your team can use for you, like email, calendar and docs." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{apps === null ? 'Checking…' : apps.length ? `${apps.length} app${apps.length === 1 ? '' : 's'} connected` : 'No apps connected yet'}</div>
              <div className="cfg-row__sub">Your team asks before doing anything that changes data in an app.</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--primary" onClick={openApps}>{apps?.length ? 'Manage apps' : 'Connect apps'}</button>
          </div>
          {apps?.map((a) => (
            <div key={a.slug} className="cfg-row">
              <ToolkitLogo name={a.name} logo={a.logo} size={28} radius={7} />
              <div className="cfg-row__text">
                <div className="cfg-row__title">{a.name}</div>
                {a.description && <div className="cfg-row__sub">{a.description}</div>}
              </div>
              <span className="cfg-chip">Connected</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function AccountSection() {
  const user = useStore((s) => s.user);
  const [busy, setBusy] = useState(false);
  const initials = (user?.name ?? user?.email ?? '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <>
      <PageHead title="Account" />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className="account__initials">{initials}</span>
            <div className="cfg-row__text">
              <div className="cfg-row__title">{user?.name}</div>
              <div className="cfg-row__sub">{user?.email}</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={async () => { setBusy(true); await configApi.logout().catch(() => {}); location.reload(); }}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
