import { useEffect, useRef, useState, type DragEvent } from 'react';
import { kanbanApi, KANBAN_ATTACHMENT_MAX, type KanbanAttachment } from '../../lib/kanbanApi';
import { Icon } from '../Icon';
import { ConfirmDialog } from './BoardDialogs';
import { ago } from './boardModel';

/**
 * A task's files, stored by Hermes (its attachments folder, its 25 MB cap and name cleaning), so an agent working
 * the task reads the same files. Add with the button or by dropping files here; plain images show a preview.
 */

const PREVIEW = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function size(n?: number | null) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE');

export function Attachments({ board, taskId, initial, onChanged }: { board: string; taskId: string; initial: KanbanAttachment[]; onChanged: () => void }) {
  const [list, setList] = useState<KanbanAttachment[]>(initial);
  const [uploading, setUploading] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const [remove, setRemove] = useState<KanbanAttachment | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { setList(initial); }, [initial]);

  const refresh = async () => {
    try { setList((await kanbanApi.attachments(board, taskId)).attachments); } catch { /* keep what we have */ }
  };

  const add = async (files: File[]) => {
    if (!files.length) return;
    const errs: string[] = [];
    const ok = files.filter((f) => {
      if (f.size > KANBAN_ATTACHMENT_MAX) { errs.push(`${f.name}: over Hermes’s 25 MB limit.`); return false; }
      if (!f.size) { errs.push(`${f.name}: the file is empty.`); return false; }
      return true;
    });
    setErrors(errs);
    setUploading((u) => [...u, ...ok.map((f) => f.name)]);
    for (const f of ok) {
      try { await kanbanApi.attach(board, taskId, f); }
      catch (e) { errs.push(`${f.name}: ${(e as Error).message}`); setErrors([...errs]); }
      finally { setUploading((u) => { const i = u.indexOf(f.name); return i < 0 ? u : [...u.slice(0, i), ...u.slice(i + 1)]; }); }
    }
    await refresh();
    onChanged();
  };

  const isFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  return (
    <section className={`kb-files${over ? ' is-over' : ''}`} aria-label="Attachments"
      onDragOver={(e) => { if (!isFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => { if (!isFiles(e)) return; e.preventDefault(); setOver(false); void add(Array.from(e.dataTransfer.files)); }}>
      <div className="kb-files__head">
        <span className="cfg-field__label">Attachments{list.length ? ` · ${list.length}` : ''}</span>
        <button type="button" className="cfg-btn cfg-btn--secondary kb-files__add" onClick={() => input.current?.click()}>
          <Icon name="paperclip" size={12} /> Add files
        </button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; void add(f); }} />
      </div>

      {list.map((a) => {
        const url = kanbanApi.attachmentUrl(board, a.id);
        const img = PREVIEW.has(a.content_type ?? '');
        return (
          <div key={a.id} className="kb-file">
            <a className="kb-file__thumb" href={url} download={a.filename} aria-hidden tabIndex={-1}>
              {img ? <img src={kanbanApi.attachmentUrl(board, a.id, true)} alt="" loading="lazy" /> : <span>{ext(a.filename)}</span>}
            </a>
            <span className="kb-file__text">
              <a className="kb-file__name" href={url} download={a.filename} title={`Download ${a.filename}`}>{a.filename}</a>
              <span className="kb-file__meta">{[size(a.size), a.uploaded_by && a.uploaded_by !== 'dashboard' ? a.uploaded_by : null, ago(a.created_at)].filter(Boolean).join(' · ')}</span>
            </span>
            <button type="button" className="icon-btn icon-btn--plain" aria-label={`Remove ${a.filename}`} title="Remove" onClick={() => setRemove(a)}><Icon name="close" size={12} /></button>
          </div>
        );
      })}
      {uploading.map((n, i) => (
        <div key={`${n}-${i}`} className="kb-file is-busy">
          <span className="kb-file__thumb"><span>…</span></span>
          <span className="kb-file__text"><span className="kb-file__name">{n}</span><span className="kb-file__meta">Uploading to Hermes…</span></span>
        </div>
      ))}
      {!list.length && !uploading.length && <div className="kb-files__drop">Drop files here, or use Add files. Up to 25 MB each.</div>}
      {errors.length > 0 && <div className="kb-files__err" role="alert">{errors.map((e) => <div key={e}>{e}</div>)}</div>}
      {over && <div className="kb-files__overlay" aria-hidden>Drop to attach</div>}

      {remove && (
        <ConfirmDialog title={`Remove ${remove.filename}?`} action="Remove"
          lines={['Hermes deletes the file from this task. Agents working on it won’t see it any more, and it can’t be undone.']}
          onCancel={() => setRemove(null)}
          onConfirm={() => {
            const a = remove;
            setRemove(null);
            kanbanApi.detach(board, a.id)
              .then(() => { setList((l) => l.filter((x) => x.id !== a.id)); onChanged(); })
              .catch((e: Error) => setErrors([`${a.filename}: ${e.message}`]));
          }} />
      )}
    </section>
  );
}
