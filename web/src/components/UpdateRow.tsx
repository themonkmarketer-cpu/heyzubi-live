import { useEffect, useState } from 'react';

/** The build this page is running (set by vite.config.ts when the app is built). */
declare const __HZ_BUILD__: string;
const RUNNING = typeof __HZ_BUILD__ === 'string' ? __HZ_BUILD__ : 'dev';

/** How often the app asks which build the server has, besides when the window comes back into view. */
const CHECK_MS = 90_000;

/**
 * A new release is out when the server has a different build from the one this page loaded (as Vello's sidebar
 * "Updates" row). Nothing happens by itself: the row appears and the update is a reload, when you choose. Running work
 * is on the server, so a reload loses nothing.
 */
function useNewBuild(): string | null {
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    if (RUNNING === 'dev') return; // the dev server reloads by itself
    let stop = false;
    const check = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const r = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' });
        if (!r.ok) return;
        const { build } = await r.json();
        if (!stop && typeof build === 'string' && build && build !== RUNNING) setNext(build);
      } catch { /* the server is restarting: try again later */ }
    };
    void check();
    const t = setInterval(check, CHECK_MS);
    const onShow = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    window.addEventListener('online', onShow);
    return () => { stop = true; clearInterval(t); document.removeEventListener('visibilitychange', onShow); window.removeEventListener('focus', onShow); window.removeEventListener('online', onShow); };
  }, []);
  return next;
}

/** "Update ready" in the sidebar, shown only when there is one. */
export function UpdateRow({ collapsed }: { collapsed: boolean }) {
  const next = useNewBuild();
  const [updating, setUpdating] = useState(false);
  if (!next) return null;
  const update = () => { setUpdating(true); location.reload(); };
  return (
    <button type="button" className={`update-row${collapsed ? ' is-collapsed' : ''}`} onClick={update} disabled={updating}
      title="A new version of HeyZubi is out. Update reloads the app; your chats and running work carry on." aria-label="Update HeyZubi to the new version">
      <span className="update-row__icon" aria-hidden>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 4v5h-5" />
        </svg>
        <span className="update-row__dot" />
      </span>
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
