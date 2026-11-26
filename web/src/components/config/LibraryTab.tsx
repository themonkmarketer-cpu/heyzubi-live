import { useCallback, useEffect, useState } from 'react';
import type { Bot, LibraryFile } from '@shared/types';
import { configApi, type LibraryListing } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { canOpen, downloadFile, openFile } from '../../lib/openFile';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Glyph } from './glyphs';
import { formatBytes } from './ui';
import { SharePanel } from './ExtrasShare';

/** Files the bot saved in its Library folder on its computer (server/src/paths.ts). */
export function LibraryTab({ bot }: { bot: Bot }) {
  const awake = useStore((s) => s.computer?.status === 'running');
  const [path, setPath] = useState('');
  const [list, setList] = useState<LibraryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);

  const load = useCallback(async (wake = false) => {
    setLoading(true); setError(null);
    try { setList(await configApi.files(bot.id, path, wake)); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [bot.id, path]);

  useEffect(() => { setPath(''); setList(null); setSharing(null); }, [bot.id]);
  useEffect(() => { setSharing(null); }, [path]);
  useEffect(() => { load(); }, [load, awake]);

  const download = async (f: LibraryFile) => {
    const rel = path ? `${path}/${f.name}` : f.name;
    setBusyFile(f.name); setError(null);
    try {
      await downloadFile(bot.id, rel);
    } catch (e) { setError(`Couldn’t download ${f.name}: ${(e as Error).message}`); }
    finally { setBusyFile(null); }
  };

  const opens = (f: LibraryFile) => !f.isDir && !!list?.canOpen && canOpen(f.name);
  const crumbs = path ? path.split('/') : [];

  return (
    <div className="details__sections">
      <section>
        <div className="section-label section-label--row">
          <span className="lib-crumbs">
            {crumbs.length ? (
              <>
                <button type="button" className="link-btn link-btn--small" onClick={() => setPath('')}>Files</button>
                {crumbs.map((c, i) => (
                  <span key={i} className="lib-crumbs__part">
                    <Icon name="chev_right" size={8} opacity={0.5} />
                    <button type="button" className="link-btn link-btn--small" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
                  </span>
                ))}
              </>
            ) : 'Files'}
          </span>
          <button type="button" className="link-btn link-btn--small" onClick={() => load()} disabled={loading} aria-label="Refresh files" title="Refresh">
            <Icon name="refresh" size={12} opacity={0.7} style={loading ? { animation: 'cfg-spin 0.8s linear infinite' } : undefined} />
          </button>
        </div>
        <div className="panel-card">
          {list?.status === 'asleep' ? (
            <div className="lib-empty">
              <div>{bot.name}’s computer is asleep. Wake it to see saved files.</div>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => load(true)} disabled={loading}>{loading ? 'Waking…' : 'Wake and show files'}</button>
            </div>
          ) : !list && loading ? (
            <div className="panel-empty">Looking for files…</div>
          ) : list?.status === 'error' ? (
            <div className="panel-empty">Couldn’t reach the computer. {list.error ? <span className="lib-err">{list.error}</span> : null}</div>
          ) : !list?.files.length ? (
            <div className="panel-empty panel-empty--center">{path ? 'This folder is empty.' : `Files that ${bot.name} creates, like reports and notes, are kept here.`}</div>
          ) : (
            list.files.map((f) => (
              <div key={f.name} className="lib-row-wrap">
              <div className={`lib-row${f.isDir ? ' is-dir' : ''}`}>
                <button type="button" className="lib-row__main" onClick={() => { const rel = path ? `${path}/${f.name}` : f.name; if (f.isDir) setPath(rel); else if (opens(f)) openFile(bot.id, rel); else void download(f); }} title={f.isDir || opens(f) ? `Open ${f.name}` : `Download ${f.name}`}>
                  <span className="lib-row__icon"><Glyph name={f.isDir ? 'folder' : 'doc'} size={16} opacity={0.6} /></span>
                  <span className="panel-row__text">
                    <span className="panel-row__title">{f.name}</span>
                    <span className="panel-row__meta">{f.isDir ? 'Folder' : formatBytes(f.size)} · {relativeShort(f.modifiedAt) === 'now' ? 'just now' : relativeShort(f.modifiedAt)}</span>
                  </span>
                </button>
                {f.isDir ? <Icon name="chev_right" size={12} opacity={0.5} /> : (
                  <>
                  {opens(f) && <button type="button" className="cfg-btn lib-open" onClick={() => openFile(bot.id, path ? `${path}/${f.name}` : f.name)}>Open</button>}
                  <button type="button" className="cfg-btn lib-open" onClick={() => setSharing(sharing === f.name ? null : f.name)} aria-expanded={sharing === f.name} title={`Share ${f.name} with a link`}>Share</button>
                  <button type="button" className="cfg-icon-btn" onClick={() => download(f)} disabled={busyFile === f.name} aria-label={`Download ${f.name}`} title="Download">
                    {busyFile === f.name ? <span className="cfg-spinner" /> : <Glyph name="download" size={14} />}
                  </button>
                  </>
                )}
              </div>
              {!f.isDir && sharing === f.name && <SharePanel botId={bot.id} file={path ? `${path}/${f.name}` : f.name} name={f.name} onClose={() => setSharing(null)} />}
              </div>
            ))
          )}
        </div>
        {error && <div className="cfg-error cfg-error--small">{error}</div>}
      </section>
    </div>
  );
}
