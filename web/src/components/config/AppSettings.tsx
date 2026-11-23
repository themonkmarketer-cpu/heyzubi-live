import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Toolkit } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type ComputerDetails } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
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
  { id: 'computer', label: 'Computer' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'apps', label: 'Connected apps' },
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
          {section === 'computer' && <ComputerSection />}
          {section === 'permissions' && <PermissionsSection />}
          {section === 'apps' && <AppsSection />}
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
          <ThemeTile value="light" label="White" current={theme} onPick={setTheme} />
          <ThemeTile value="dark" label="Dark (HeyZubi)" current={theme} onPick={setTheme} />
          <ThemeTile value="navy" label="Navy" current={theme} onPick={setTheme} />
        </div>
        <div className="cfg-field__hint">System follows your device’s light or dark setting. White, Dark and Navy match Zubi HQ’s themes.</div>
      </section>
    </>
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
