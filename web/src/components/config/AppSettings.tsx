import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Toolkit } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type ComputerDetails } from '../../lib/configApi';
import { api, type Webhook, type WebhookInput } from '../../lib/api';
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
import { USAGE_ROWS, usd } from '../VoiceSettings';
import { DictationSection, PointerSection, ProductsSection } from './ProductSettings';
import { removePhoto, saveDisplayName, uploadPhoto } from '../../lib/profile';
import type { XaiUsage } from '../../voice/api';
import { AccessMapBody, AskZubiButton, DeletedBody, DemoLanguageSettings, SharesBody } from './ExtrasSettings';

const SECTIONS: { id: AppSection; label: string }[] = [
  { id: 'status', label: 'Status' },
  { id: 'usage', label: 'Usage' },
  { id: 'products', label: 'Products' },
  { id: 'pointer', label: 'Pointer Assistant' },
  { id: 'dictation', label: 'Dictation' },
  { id: 'general', label: 'General' },
  { id: 'teams', label: 'Teams' },
  { id: 'computer', label: 'Computer' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'apps', label: 'Connected apps' },
  { id: 'access', label: 'Access map' },
  { id: 'shares', label: 'Share links' },
  { id: 'deleted', label: 'Recently deleted' },
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
          {section === 'usage' && <UsageSection />}
          {section === 'products' && <ProductsSection />}
          {section === 'pointer' && <PointerSection />}
          {section === 'dictation' && <DictationSection />}
          {section === 'general' && <GeneralSection />}
          {section === 'teams' && <TeamsSection />}
          {section === 'computer' && <ComputerSection />}
          {section === 'permissions' && <PermissionsSection />}
          {section === 'apps' && <AppsSection />}
          {section === 'api' && <ApiKeysSection />}
          {section === 'desktop' && <DesktopSection />}
          {section === 'account' && <AccountSection />}
          {section === 'access' && <><PageHead title="Access map" sub="What each team member can read, change or holds a key to." /><AccessMapBody /></>}
          {section === 'shares' && <><PageHead title="Share links" sub="Links that show one Library file to a client, until they expire." /><SharesBody /></>}
          {section === 'deleted' && <><PageHead title="Recently deleted" sub="Team members you deleted, kept for a while so you can bring them back." /><DeletedBody /></>}
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
      <DemoLanguageSettings />
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
      <WebhooksSection />
    </>
  );
}

const EMPTY_HOOK: WebhookInput & { auth: 'bearer' | 'hmac' } = { name: '', bot: null, trust: 'approve', required: [], prompt: '', auth: 'bearer' };

/** Webhooks: an outside system hands work to a team member; every call becomes a card on the Kanban. */
function WebhooksSection() {
  const bots = useStore((s) => s.bots);
  const team = bots.filter((b) => b.hermesProfile);
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [form, setForm] = useState<(WebhookInput & { auth: 'bearer' | 'hmac' }) | null>(null);
  const [fields, setFields] = useState('');
  const [fresh, setFresh] = useState<{ hook: Webhook; secret: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => { api.webhooks().then((r) => setHooks(r.hooks)).catch((e) => setMsg((e as Error).message)); }, []);
  useEffect(load, [load]);
  const who = (p: string | null) => (p ? team.find((b) => b.hermesProfile === p)?.name ?? p : 'Nobody yet (Triage)');
  const create = async () => {
    if (!form) return;
    setMsg(null);
    try {
      const r = await api.createWebhook({ ...form, name: form.name.trim() || 'Webhook', required: fields.split(/[\s,]+/).filter(Boolean) });
      setFresh(r); setForm(null); setFields(''); load();
    } catch (e) { setMsg((e as Error).message); }
  };
  const setTrust = async (h: Webhook, trust: 'approve' | 'allow') => { try { await api.patchWebhook(h.id, { trust }); load(); } catch (e) { setMsg((e as Error).message); } };
  const url = (h: Webhook) => `${location.origin}${h.path}`;
  const sample = '{"name":"Jane Doe","email":"jane@example.com","message":"I’d like a quote"}';
  const example = !fresh ? '' : fresh.hook.auth === 'bearer'
    ? `curl -X POST ${url(fresh.hook)} \\\n  -H "Authorization: Bearer ${fresh.secret}" \\\n  -H "Content-Type: application/json" \\\n  -d '${sample}'`
    : `BODY='${sample}'\nSIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac '${fresh.secret}' | sed 's/^.* //')\ncurl -X POST ${url(fresh.hook)} \\\n  -H "X-Hub-Signature-256: sha256=$SIG" \\\n  -H "Content-Type: application/json" \\\n  -d "$BODY"`;
  return (
    <>
      <section className="cfg-section">
        <div className="cfg-section__label">Webhooks</div>
        <div className="cfg-field__hint">
          A website form, Stripe, Zapier or a CRM can hand work to a team member. Each webhook has its own address and secret, the fields its data must have, and a standing instruction. Every call becomes a card on the Kanban: with “Approve first” it waits in Triage for you; with “Start at once” it goes straight to Ready. The data is treated as information only, and nothing is sent, posted or deleted without you.
        </div>
        {!form && !fresh && <button type="button" className="cfg-btn cfg-btn--primary" style={{ marginTop: 10 }} onClick={() => setForm({ ...EMPTY_HOOK, bot: team.find((b) => b.hermesProfile !== 'default')?.hermesProfile ?? null })}>New webhook</button>}
        {form && (
          <div className="cfg-card hook-form">
            <label className="hook-form__row"><span>Name</span><input className="text-input" value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Website contact form" /></label>
            <label className="hook-form__row"><span>Goes to</span>
              <select className="text-input" value={form.bot ?? ''} onChange={(e) => setForm({ ...form, bot: e.target.value || null })}>
                <option value="">Nobody yet (Triage)</option>
                {team.map((b) => <option key={b.id} value={b.hermesProfile as string}>{b.name}</option>)}
              </select>
            </label>
            <div className="hook-form__row"><span>Trust</span>
              <div className="hook-form__seg" role="radiogroup" aria-label="Trust">
                <button type="button" role="radio" aria-checked={form.trust === 'approve'} className={form.trust === 'approve' ? 'is-active' : ''} onClick={() => setForm({ ...form, trust: 'approve' })}>Approve first</button>
                <button type="button" role="radio" aria-checked={form.trust === 'allow'} className={form.trust === 'allow' ? 'is-active' : ''} onClick={() => setForm({ ...form, trust: 'allow' })}>Start at once</button>
              </div>
            </div>
            <div className="hook-form__row"><span>Secret</span>
              <div className="hook-form__seg" role="radiogroup" aria-label="How calls prove who they are">
                <button type="button" role="radio" aria-checked={form.auth === 'bearer'} className={form.auth === 'bearer' ? 'is-active' : ''} onClick={() => setForm({ ...form, auth: 'bearer' })}>Bearer secret</button>
                <button type="button" role="radio" aria-checked={form.auth === 'hmac'} className={form.auth === 'hmac' ? 'is-active' : ''} onClick={() => setForm({ ...form, auth: 'hmac' })}>Signed body (HMAC)</button>
              </div>
            </div>
            <label className="hook-form__row"><span>Must have</span><input className="text-input" value={fields} onChange={(e) => setFields(e.target.value)} placeholder="email, message (leave empty for none)" /></label>
            <label className="hook-form__row is-top"><span>What to do</span><textarea className="text-input" rows={3} maxLength={4000} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="Qualify the lead and draft a reply for me to check." /></label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setForm(null)}>Cancel</button>
              <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => void create()}>Create webhook</button>
            </div>
          </div>
        )}
        {fresh && (
          <div className="cfg-card" style={{ marginTop: 10, padding: 12 }}>
            <div className="cfg-row__title">Copy the secret now: it won’t be shown again.</div>
            <div className="cfg-row__sub">Address</div>
            <pre className="cfg-skill-view" style={{ margin: '6px 0', userSelect: 'all' }}>{url(fresh.hook)}</pre>
            <div className="cfg-row__sub">Secret</div>
            <pre className="cfg-skill-view" style={{ margin: '6px 0', userSelect: 'all' }}>{fresh.secret}</pre>
            <div className="cfg-row__sub">Try it (the answer has a result address to check the card’s progress):</div>
            <pre className="cfg-skill-view" style={{ margin: '6px 0' }}>{example}</pre>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setFresh(null)}>Done</button>
          </div>
        )}
      </section>
      <section className="cfg-section">
        {!hooks ? <div className="cfg-empty">Loading…</div> : hooks.length === 0 ? <div className="cfg-empty">No webhooks yet.</div> : (
          <div className="cfg-card">
            {hooks.map((h) => (
              <div key={h.id} className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{h.name} <span className={`hook-pill${h.trust === 'allow' ? ' is-allow' : ''}`}>{h.trust === 'allow' ? 'Starts at once' : 'Approve first'}</span></div>
                  <div className="cfg-row__sub">To {who(h.bot)} · {h.auth === 'hmac' ? 'signed body' : 'bearer secret'}{h.required.length ? ` · needs ${h.required.join(', ')}` : ''} · {h.lastUsedAt ? `last call ${relativeShort(h.lastUsedAt)} ago` : 'no calls yet'}</div>
                  <div className="cfg-row__sub" style={{ userSelect: 'all' }}>{url(h)}</div>
                </div>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void setTrust(h, h.trust === 'allow' ? 'approve' : 'allow')}>{h.trust === 'allow' ? 'Approve first' : 'Start at once'}</button>
                <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Remove webhook" onConfirm={async () => { await api.deleteWebhook(h.id); load(); }}>Remove</ConfirmButton>
              </div>
            ))}
          </div>
        )}
        {msg && <div className="cfg-field__hint" role="status">{msg}</div>}
      </section>
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

interface HealthItem { key: string; title: string; status: 'ok' | 'warn' | 'bad'; line: string; detail: string[] }

/** Health, after Theo's: what HeyZubi needs to work, each with what to do when it isn't right. */
function HealthList() {
  const [items, setItems] = useState<HealthItem[] | null>(null);
  const [checked, setChecked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const run = useCallback(() => {
    setBusy(true);
    fetch('/api/status/health', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) { setItems(j.items); setChecked(j.checked); } }).catch(() => {}).finally(() => setBusy(false));
  }, []);
  useEffect(run, [run]);
  const bad = items?.filter((i) => i.status !== 'ok').length ?? 0;
  return (
    <section className="cfg-section">
      <div className="health-head">
        <div className="cfg-section__label">Health</div>
        <span className="cfg-field__hint">{!items ? 'Checking…' : bad ? `${bad} thing${bad === 1 ? '' : 's'} to look at` : 'Everything looks right'}{checked ? ` · checked ${relativeShort(checked)}` : ''}</span>
        <button type="button" className="cfg-btn" onClick={run} disabled={busy}>{busy ? 'Checking…' : 'Run checks'}</button>
        <AskZubiButton disabled={busy} />
      </div>
      <div className="health-list">
        {(items ?? []).map((i) => (
          <div key={i.key} className={`health-item is-${i.status}`}>
            <button type="button" className="health-item__row" onClick={() => setOpen(open === i.key ? null : i.key)} aria-expanded={open === i.key} disabled={!i.detail.length}>
              <i aria-hidden />
              <span className="health-item__title">{i.title}</span>
              <span className="health-item__line">{i.line}</span>
              {i.detail.length > 0 && <span className="health-item__more" aria-hidden>{open === i.key ? '−' : '+'}</span>}
            </button>
            {open === i.key && <ul className="health-item__detail">{i.detail.map((d, n) => <li key={n}>{d}</li>)}</ul>}
            {i.key === 'sessions' && i.status !== 'ok' && (
              <div className="health-item__fix"><button type="button" className="cfg-btn" disabled={busy} onClick={async () => { setBusy(true); await fetch('/api/status/tidy-sessions', { method: 'POST', credentials: 'include' }).catch(() => null); setBusy(false); run(); }}>Remove now</button></div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

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

      <HealthList />

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

interface UsageRow { botId: string; name: string; turns: number; tokens: number; usd: number }
interface UsageData {
  days: number; since: number; available: boolean; note: string;
  rows: UsageRow[]; other: { key: string; label: string; turns: number; tokens: number; usd: number }[];
  total: { turns: number; tokens: number; usd: number };
  services: { by: XaiUsage['by']; total: number; note: string };
}
const WINDOWS = [{ d: 1, label: 'Today' }, { d: 7, label: 'Last 7 days' }, { d: 30, label: 'Last 30 days' }];
const tokensShort = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

/** Usage, after Theo's: each team member's turns, tokens and Claude cost over a window, then the other services. */
export function UsageSection() {
  const [days, setDays] = useState(() => { try { return Number(localStorage.getItem('usageDays')) || 7; } catch { return 7; } });
  const [data, setData] = useState<UsageData | null>(null);
  const [failed, setFailed] = useState(false);
  const bots = useStore((s) => s.bots);
  useEffect(() => {
    let on = true;
    setFailed(false);
    fetch(`/api/usage?days=${days}`, { credentials: 'include' }).then((r) => (r.ok ? r.json() : Promise.reject())).then((j) => { if (on) setData(j); }).catch(() => { if (on) setFailed(true); });
    try { localStorage.setItem('usageDays', String(days)); } catch { /* not kept */ }
    return () => { on = false; };
  }, [days]);
  const shown = data?.days === days ? data : null;
  const max = Math.max(0.0001, ...(shown?.rows.map((r) => r.usd) ?? [0]), ...(shown?.other.map((r) => r.usd) ?? [0]));
  return (
    <>
      <PageHead title="Usage" sub="How much each team member worked, and what it cost. Read from the engine’s own records and the app’s spend log; nothing you said is read." />
      <section className="cfg-section">
        <div className="cfg-seg" role="radiogroup" aria-label="Period">
          {WINDOWS.map((w) => <button key={w.d} type="button" role="radio" aria-checked={days === w.d} className={days === w.d ? 'is-active' : ''} onClick={() => setDays(w.d)}>{w.label}</button>)}
        </div>
        {failed && <div className="st-result is-bad">Couldn’t load usage. Try again in a moment.</div>}
        {!failed && !shown && <div className="cfg-field__hint">Loading…</div>}
        {shown && !shown.available && <div className="cfg-field__hint">The engine’s records couldn’t be read, so Claude usage is missing.</div>}
        {shown && (
          <table className="usage-table">
            <thead><tr><th>Team member</th><th>Turns</th><th>Tokens</th><th>Claude cost</th></tr></thead>
            <tbody>
              {shown.rows.map((r) => {
                const bot = bots.find((b) => b.id === r.botId);
                return (
                  <tr key={r.botId} className={r.turns || r.usd ? '' : 'is-idle'}>
                    <td><span className="usage-table__bar" style={{ width: `${(r.usd / max) * 100}%` }} /><span className="usage-table__who">{bot && <BotAvatarFor bot={bot} size={22} />}{r.name}</span></td>
                    <td>{r.turns.toLocaleString()}</td>
                    <td>{tokensShort(r.tokens)}</td>
                    <td>{r.usd ? usd(r.usd) : '—'}</td>
                  </tr>
                );
              })}
              {shown.other.map((r) => (
                <tr key={r.key} className="is-channel">
                  <td><span className="usage-table__bar" style={{ width: `${(r.usd / max) * 100}%` }} /><span className="usage-table__who">{r.label}</span></td>
                  <td>{r.turns.toLocaleString()}</td>
                  <td>{tokensShort(r.tokens)}</td>
                  <td>{r.usd ? usd(r.usd) : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td>Total</td><td>{shown.total.turns.toLocaleString()}</td><td>{tokensShort(shown.total.tokens)}</td><td>{usd(shown.total.usd)}</td></tr></tfoot>
          </table>
        )}
        {shown && <div className="cfg-field__hint">{shown.note} Turns are the messages sent to a team member (by you or another bot).</div>}
      </section>
      {shown && (
        <section className="cfg-section">
          <div className="cfg-section__label">Voice, images and other services</div>
          <table className="usage-table is-services">
            <tbody>
              {USAGE_ROWS.filter((r) => shown.services.by[r.k].uses > 0).map((r) => {
                const s = shown.services.by[r.k];
                return <tr key={r.k}><td>{r.label}</td><td>{r.qty(s.qty)}</td><td>{usd(s.usd)}</td></tr>;
              })}
              {!USAGE_ROWS.some((r) => shown.services.by[r.k].uses > 0) && <tr className="is-idle"><td colSpan={3}>Nothing used in this period.</td></tr>}
            </tbody>
            <tfoot><tr><td>Total</td><td /><td>{usd(shown.services.total)}</td></tr></tfoot>
          </table>
          <div className="cfg-field__hint">{shown.services.note}</div>
        </section>
      )}
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

/** Profile: the photo and the name shown in the sidebar's account row (moved here from the account menu). */
function ProfileSection() {
  const user = useStore((s) => s.user);
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState<'photo' | 'name' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const initials = (user?.name ?? user?.email ?? '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const run = async (what: 'photo' | 'name', job: () => Promise<void>) => {
    setBusy(what); setError(null);
    try { await job(); if (what === 'name') { setName(null); setSaved(true); window.setTimeout(() => setSaved(false), 1500); } }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const shown = user?.displayName || '';
  const draft = name ?? shown;
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Profile</div>
      <div className="profile">
        <div className="profile__photo">
          {user?.avatarUrl ? <img src={user.avatarUrl} alt="Your photo" width={72} height={72} /> : <span className="account__initials profile__initials">{initials}</span>}
          <div className="profile__photo-actions">
            <button type="button" className="cfg-btn" disabled={busy === 'photo'} onClick={() => input.current?.click()}>{busy === 'photo' ? 'Saving…' : user?.avatarUrl ? 'Change photo' : 'Add a photo'}</button>
            {user?.avatarUrl && <button type="button" className="cfg-btn cfg-btn--ghost-danger" disabled={busy === 'photo'} onClick={() => void run('photo', removePhoto)}>Remove photo</button>}
            <span className="cfg-field__hint">JPEG, PNG or WebP. It’s cropped to a square.</span>
          </div>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run('photo', () => uploadPhoto(f)); }} />
        </div>
        <label className="profile__name">
          <span className="cfg-row__title">Display name</span>
          <span className="profile__name-row">
            <input className="pa-input" value={draft} maxLength={40} placeholder={user?.name ?? ''} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && name !== null && name.trim() !== shown) void run('name', () => saveDisplayName(name)); }} />
            <button type="button" className="cfg-btn" disabled={busy === 'name' || name === null || name.trim() === shown} onClick={() => void run('name', () => saveDisplayName(draft))}>{busy === 'name' ? 'Saving…' : saved ? 'Saved' : 'Save'}</button>
          </span>
          <span className="cfg-field__hint">Shown in the sidebar. Leave it empty to show your account’s name ({user?.name}); your team still calls you by that.</span>
        </label>
        {error && <div className="st-result is-bad" role="alert">{error}</div>}
      </div>
    </section>
  );
}

function AccountSection() {
  const user = useStore((s) => s.user);
  const [busy, setBusy] = useState(false);
  const initials = (user?.name ?? user?.email ?? '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <>
      <PageHead title="Account" />
      <ProfileSection />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            {user?.avatarUrl ? <img className="account__photo" src={user.avatarUrl} alt="" width={36} height={36} /> : <span className="account__initials">{initials}</span>}
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
