import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfigUI } from '../configStore';
import '../styles/generations.css';

/**
 * Generations: the gallery of AI-made images and videos (~/.hermes/generations on hermes-box, shared with Zubi HQ
 * and synced to the PC). Search, images or videos, generated or references, starred, sort, 2–6 columns; star,
 * download, copy the path, open large; add reference images by button or drag and drop.
 */

export interface GenItem { name: string; rel: string; type: 'gen' | 'ref' | 'inbox'; media: 'image' | 'video'; modified: number; size: number; starred: boolean }

export const genUrl = (rel: string, download = false) => `/api/generations/file/${rel.split('/').map(encodeURIComponent).join('/')}${download ? '?download=1' : ''}`;

export async function listGen(q: Record<string, string>): Promise<{ items: GenItem[]; total: number }> {
  const r = await fetch(`/api/generations/list?${new URLSearchParams(q)}`, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const readFile = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
const size = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ago = (t: number) => { const d = (Date.now() - t) / 86400000; return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? `${Math.floor(d)} days ago` : new Date(t).toLocaleDateString(); };

export function GenerationsView() {
  const [items, setItems] = useState<GenItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [media, setMedia] = useState<'' | 'image' | 'video'>('');
  const [type, setType] = useState<'' | 'gen' | 'ref' | 'inbox'>('');
  const [starred, setStarred] = useState(false);
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [cols, setCols] = useState(() => { try { return Math.max(2, Math.min(6, Number(localStorage.getItem('hz-gen-cols')) || 4)); } catch { return 4; } });
  const [open, setOpen] = useState<GenItem | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    listGen({ q, media, type, sort, starred: starred ? '1' : '', limit: '300' })
      .then((r) => { setItems(r.items); setTotal(r.total); setErr(null); })
      .catch(() => setErr('Couldn’t read the gallery.'));
  }, [q, media, type, sort, starred]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { try { localStorage.setItem('hz-gen-cols', String(cols)); } catch { /* private window */ } }, [cols]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 3500); return () => clearTimeout(t); }, [note]);

  const star = async (it: GenItem) => {
    const on = !it.starred;
    setItems((l) => l?.map((x) => (x.rel === it.rel ? { ...x, starred: on } : x)) ?? null);
    if (open?.rel === it.rel) setOpen({ ...it, starred: on });
    await fetch('/api/generations/star', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rel: it.rel, starred: on }) }).catch(() => {});
  };
  const copy = (it: GenItem) => { void navigator.clipboard?.writeText(`~/.hermes/generations/${it.rel}`).then(() => setNote('Path copied.'), () => setNote(`~/.hermes/generations/${it.rel}`)); };
  const addRefs = async (files: FileList | File[]) => {
    let added = 0;
    for (const f of Array.from(files)) {
      if (f.size > 15 * 1024 * 1024) { setNote(`${f.name}: images up to 15 MB.`); continue; }
      const r = await fetch('/api/generations/refs', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name, data: await readFile(f) }) });
      if (r.ok) added++; else setNote(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `${f.name} was not added.`);
    }
    if (added) { setNote(`${added} reference${added > 1 ? 's' : ''} added.`); load(); }
  };

  return (
    <div
      className={`gen${drag ? ' is-drag' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void addRefs(e.dataTransfer.files); }}
    >
      <header className="gen__head">
        <div>
          <h1 className="gen__title">Generations</h1>
          <p className="gen__sub">Your AI-made images and videos, shared with Zubi HQ and your PC (D:\generations). Pictures you save to L:\Zubi inbox show here as Inbox. {items ? `${total} item${total === 1 ? '' : 's'}` : ''}</p>
        </div>
        <span className="gen__head-actions">
          <button type="button" className="gen__btn is-pri" onClick={() => fileRef.current?.click()}>Add reference</button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { if (e.target.files) void addRefs(e.target.files); e.target.value = ''; }} />
          <button type="button" className="gen__btn" onClick={() => useConfigUI.getState().setView('chat')}>Back to chat</button>
        </span>
      </header>

      <div className="gen__bar" role="toolbar" aria-label="Filter the gallery">
        <input className="gen__search" type="search" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search by name" />
        <div className="gen__seg" role="group" aria-label="Kind">
          {([['', 'All'], ['image', 'Images'], ['video', 'Videos']] as const).map(([v, l]) => <button key={v} type="button" aria-pressed={media === v} onClick={() => setMedia(v)}>{l}</button>)}
        </div>
        <div className="gen__seg" role="group" aria-label="Source">
          {([['', 'Everything'], ['gen', 'Generated'], ['ref', 'References'], ['inbox', 'Inbox']] as const).map(([v, l]) => <button key={v} type="button" aria-pressed={type === v} onClick={() => setType(v)}>{l}</button>)}
        </div>
        <button type="button" className={`gen__chip${starred ? ' is-on' : ''}`} aria-pressed={starred} onClick={() => setStarred(!starred)}>★ Starred</button>
        <select className="gen__select" value={sort} onChange={(e) => setSort(e.target.value as 'newest' | 'oldest')} aria-label="Sort">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
        <label className="gen__cols">Columns <input type="range" min={2} max={6} value={cols} onChange={(e) => setCols(Number(e.target.value))} aria-label="Columns" /> {cols}</label>
      </div>

      {err && <div className="gen__empty">{err}</div>}
      {items && items.length === 0 && !err && <div className="gen__empty">{q || media || type || starred ? 'Nothing matches that.' : 'No generations yet. Images and videos Zubi makes land here.'}</div>}
      {!items && !err && <div className="gen__empty">Loading…</div>}

      {items && items.length > 0 && (
        <div className="gen__grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {items.map((it) => (
            <figure key={it.rel} className="gen__card">
              <button type="button" className="gen__thumb" onClick={() => setOpen(it)} aria-label={`Open ${it.name}`}>
                {it.media === 'video'
                  ? <video src={genUrl(it.rel)} muted playsInline preload="metadata" />
                  : <img src={genUrl(it.rel)} alt={it.name} loading="lazy" />}
                {it.media === 'video' && <span className="gen__badge">Video</span>}
                {it.type === 'ref' && <span className="gen__badge is-ref">Reference</span>}
                {it.type === 'inbox' && <span className="gen__badge is-inbox">Inbox</span>}
              </button>
              <figcaption className="gen__cap">
                <span className="gen__name" title={it.name}>{it.name}</span>
                <span className="gen__acts">
                  <button type="button" className={`gen__icon${it.starred ? ' is-star' : ''}`} onClick={() => void star(it)} aria-pressed={it.starred} aria-label={it.starred ? 'Unstar' : 'Star'} title={it.starred ? 'Unstar' : 'Star'}>★</button>
                  <a className="gen__icon" href={genUrl(it.rel, true)} aria-label={`Download ${it.name}`} title="Download">↓</a>
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {open && (
        <div className="gen__lightbox" role="dialog" aria-label={open.name} onClick={(e) => { if (e.target === e.currentTarget) setOpen(null); }}>
          <div className="gen__lb-body">
            {open.media === 'video' ? <video src={genUrl(open.rel)} controls autoPlay playsInline /> : <img src={genUrl(open.rel)} alt={open.name} />}
            <div className="gen__lb-bar">
              <span className="gen__lb-name" title={open.name}>{open.name}<small>{size(open.size)} · {ago(open.modified)}{open.type === 'ref' ? ' · reference' : ''}</small></span>
              <button type="button" className={`gen__btn${open.starred ? ' is-pri' : ''}`} onClick={() => void star(open)}>{open.starred ? '★ Starred' : '☆ Star'}</button>
              <a className="gen__btn" href={genUrl(open.rel, true)}>Download</a>
              <button type="button" className="gen__btn" onClick={() => copy(open)}>Copy path</button>
              <button type="button" className="gen__btn" onClick={() => setOpen(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {note && <div className="gen__note" role="status">{note}</div>}
      {drag && <div className="gen__drop">Drop images to add them as references</div>}
    </div>
  );
}

/** Pick an image from Generations (used by the WhatsApp window). */
export function GenPicker({ onPick }: { onPick: (it: GenItem) => void }) {
  const [items, setItems] = useState<GenItem[] | null>(null);
  useEffect(() => { listGen({ media: 'image', limit: '60' }).then((r) => setItems(r.items.filter((i) => /\.(png|jpe?g|webp|gif)$/i.test(i.name)))).catch(() => setItems([])); }, []);
  if (!items) return <p className="gen-pick__empty">Loading…</p>;
  if (!items.length) return <p className="gen-pick__empty">No images in Generations yet.</p>;
  return (
    <div className="gen-pick">
      {items.map((it) => (
        <button key={it.rel} type="button" onClick={() => onPick(it)} title={it.name} aria-label={`Use ${it.name}`}>
          <img src={genUrl(it.rel)} alt={it.name} loading="lazy" />
        </button>
      ))}
    </div>
  );
}
