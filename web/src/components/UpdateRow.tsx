import { useCallback, useEffect, useRef, useState } from 'react';

/** The build this page is running (set by vite.config.ts when the app is built: UTC yyyymmddhhmmss-xxxx). */
declare const __HZ_BUILD__: string;
const RUNNING = typeof __HZ_BUILD__ === 'string' ? __HZ_BUILD__ : 'dev';

/** How often the app asks which build the server has, besides when the window comes back into view. */
const CHECK_MS = 90_000;

type State = 'checking' | 'current' | 'ready' | 'offline';

/** When a build was made, from its stamp ("24 Nov, 16:10"), or '' when it can't be read. */
function builtLabel(build: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(build);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * The release this page runs against the one the server has, as Vello's sidebar "Updates" row: it says "Up to date"
 * with the release time, checks again when clicked, and turns into "Update ready" when a new release is out. Nothing
 * happens by itself: the update is a reload, when you choose. Running work is on the server, so a reload loses nothing.
 */
function useRelease() {
  const [state, setState] = useState<State>('checking');
  const busy = useRef(false);
  const check = useCallback(async (manual = false) => {
    if (RUNNING === 'dev' || busy.current) return;
    if (!manual && document.visibilityState === 'hidden') return;
    busy.current = true;
    if (manual) setState((s) => (s === 'ready' ? s : 'checking'));
    try {
      const r = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) throw new Error(String(r.status));
      const { build } = await r.json();
      setState(typeof build === 'string' && build && build !== RUNNING ? 'ready' : 'current');
    } catch {
      setState((s) => (s === 'ready' ? s : 'offline')); // the server is restarting: the next check will tell
    } finally {
      // A manual check shows "Checking…" for a moment, so the click is seen to do something.
      if (manual) await new Promise((r) => setTimeout(r, 400));
      busy.current = false;
    }
  }, []);
  useEffect(() => {
    if (RUNNING === 'dev') return;
    void check();
    const t = setInterval(() => void check(), CHECK_MS);
    const onShow = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    window.addEventListener('online', onShow);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onShow); window.removeEventListener('focus', onShow); window.removeEventListener('online', onShow); };
  }, [check]);
  return { state, check };
}

const RefreshIcon = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 4v5h-5" />
  </svg>
);

/** The sidebar's Updates line: always there (quiet when up to date), "Update ready" when a new release is out. */
export function UpdateRow({ collapsed }: { collapsed: boolean }) {
  const { state, check } = useRelease();
  const [updating, setUpdating] = useState(false);
  if (RUNNING === 'dev') return null;
  const built = builtLabel(RUNNING);

  if (state === 'ready' || updating) {
    const update = () => { setUpdating(true); location.reload(); };
    return (
      <button type="button" className={`update-row${collapsed ? ' is-collapsed' : ''}`} onClick={update} disabled={updating}
        title="A new version of HeyZubi is out. Update reloads the app; your chats and running work carry on." aria-label="Update HeyZubi to the new version">
        <span className="update-row__icon"><RefreshIcon /><span className="update-row__dot" /></span>
        {!collapsed && (
          <span className="update-row__text">
            <span className="update-row__title">{updating ? 'Updating…' : 'Update ready'}</span>
            <span className="update-row__sub">A new version of HeyZubi is out</span>
          </span>
        )}
        {!collapsed && !updating && <span className="update-row__go">Update</span>}
      </button>
    );
  }

  // Up to date, checking or not reachable: a quiet line, like Vello's. In the narrow sidebar it stays out of the way.
  if (collapsed) return null;
  const text = state === 'checking' ? 'Checking for updates…' : state === 'offline' ? "Couldn't check for updates" : 'Up to date';
  return (
    <button type="button" className={`update-line${state === 'checking' ? ' is-checking' : ''}`} onClick={() => void check(true)}
      title={`HeyZubi ${built ? `released ${built}` : RUNNING}. Click to check for a new version.`}>
      <RefreshIcon size={13} />
      <span className="update-line__text">{text}</span>
      {built && state !== 'checking' && <span className="update-line__when">{built}</span>}
    </button>
  );
}
