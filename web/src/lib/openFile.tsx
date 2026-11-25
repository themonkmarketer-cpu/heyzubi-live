import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { configApi } from './configApi';
import { Icon } from '../components/Icon';

/**
 * Opening a file a team member saved in its Library (server/src/library-open.ts shows it sealed: no scripts, forms or
 * outside loading). A browser gets a new tab; the Windows app has no tabs, so there it opens in a panel in HeyZubi.
 */
const OPENABLE = /\.(html?|svg|png|jpe?g|gif|webp|pdf|txt|md|csv|tsv|json|log|xml|ya?ml|css|m?js|tsx?|py|sh|sql|toml|ini|srt|vtt)$/i;
export const canOpen = (name: string) => OPENABLE.test(name);

const inWindowsApp = () => navigator.userAgent.includes('HeyZubiDesktop');
const openUrl = (botId: string, path: string) => `/api/bots/${encodeURIComponent(botId)}/files/open?path=${encodeURIComponent(path)}`;

interface Shown { botId: string; path: string; name: string }
const useViewer = create<{ shown: Shown | null }>(() => ({ shown: null }));

export function openFile(botId: string, path: string) {
  if (inWindowsApp()) useViewer.setState({ shown: { botId, path, name: path.split('/').pop() ?? path } });
  else window.open(openUrl(botId, path), '_blank', 'noopener,noreferrer');
}

export async function downloadFile(botId: string, path: string) {
  const { url } = await configApi.downloadFile(botId, path);
  const a = document.createElement('a');
  a.href = url; a.download = path.split('/').pop() ?? 'file'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}

/** The panel the Windows app shows a file in. */
export function FileViewer() {
  const shown = useViewer((s) => s.shown);
  const close = () => useViewer.setState({ shown: null });
  useEffect(() => {
    if (!shown) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [shown]);
  if (!shown) return null;
  const pdf = /\.pdf$/i.test(shown.name);
  return createPortal(
    <div className="modal-root file-viewer" role="dialog" aria-modal="true" aria-label={shown.name} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal file-viewer__box">
        <div className="file-viewer__bar">
          <span className="file-viewer__name">{shown.name}</span>
          <button type="button" className="cfg-btn" onClick={() => void downloadFile(shown.botId, shown.path).catch(() => {})}>Download</button>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close" title="Close (Esc)"><Icon name="close" opacity={0.8} /></button>
        </div>
        {/* The page is sealed by its own headers too; the PDF viewer doesn't run in a sandboxed frame. */}
        <iframe className="file-viewer__frame" title={shown.name} src={openUrl(shown.botId, shown.path)} referrerPolicy="no-referrer"
          {...(pdf ? {} : { sandbox: 'allow-popups allow-popups-to-escape-sandbox' })} />
      </div>
    </div>,
    document.body,
  );
}
