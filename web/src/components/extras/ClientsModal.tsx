import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Modal } from '../modals/Modal';
import { closeClients, useClientsWindow } from './clientsWindow';
import { jsonFetch } from './http';

interface Client { id: string; name: string; company: string; email: string; phone: string; tags: string[]; notes: string; createdAt: number; updatedAt: number }
interface Draft { name: string; company: string; email: string; phone: string; tags: string; notes: string }
const EMPTY: Draft = { name: '', company: '', email: '', phone: '', tags: '', notes: '' };
const toDraft = (c: Client): Draft => ({ name: c.name, company: c.company, email: c.email, phone: c.phone, tags: c.tags.join(', '), notes: c.notes });

/** Rendered once in the app; shows the Clients window while it is open. */
export function ClientsWindow() {
  const open = useClientsWindow((s) => s.open);
  return open ? <ClientsModal /> : null;
}

/** The client address book: search, add, edit, delete, and "Catch me up" (Zubi gathers everything about one client). */
export function ClientsModal() {
  const focus = useClientsWindow((s) => s.focus);
  const [q, setQ] = useState('');
  const [clients, setClients] = useState<Client[] | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const close = useCallback(() => closeClients(), []);

  const load = useCallback(async (text: string) => {
    const mine = ++asked.current;
    try {
      const r = await jsonFetch<{ clients: Client[] }>(`/api/clients?q=${encodeURIComponent(text.trim())}`);
      if (mine === asked.current) { setClients(r.clients); setError(null); }
    } catch (e) { if (mine === asked.current) setError((e as Error).message); }
  }, []);
  useEffect(() => { const t = setTimeout(() => void load(q), q ? 200 : 0); return () => clearTimeout(t); }, [q, load]);

  // From a search hit: open that client's form.
  useEffect(() => {
    if (!focus || !clients) return;
    const c = clients.find((x) => x.id === focus);
    if (c) { setEditing(c.id); setDraft(toDraft(c)); useClientsWindow.setState({ focus: null }); }
  }, [focus, clients]);

  const edit = (c: Client) => { setEditing(c.id); setDraft(toDraft(c)); setError(null); };
  const startNew = () => { setEditing('new'); setDraft(EMPTY); setError(null); };
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  const save = async () => {
    if (!draft.name.trim() || busy) return;
    setBusy('save'); setError(null);
    const body = { name: draft.name.trim(), company: draft.company.trim(), email: draft.email.trim(), phone: draft.phone.trim(), tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean), notes: draft.notes };
    try {
      if (editing === 'new') await jsonFetch<{ client: Client }>('/api/clients', 'POST', body);
      else await jsonFetch<{ client: Client }>(`/api/clients/${encodeURIComponent(String(editing))}`, 'PATCH', body);
      setEditing(null);
      await load(q);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const remove = async (c: Client) => {
    if (busy || !window.confirm(`Delete ${c.name} from your clients? This can’t be undone.`)) return;
    setBusy(`del:${c.id}`); setError(null);
    try {
      await jsonFetch(`/api/clients/${encodeURIComponent(c.id)}`, 'DELETE');
      if (editing === c.id) setEditing(null);
      await load(q);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const catchUp = async (c: Client) => {
    if (busy) return;
    const zubi = useStore.getState().bots.find((b) => b.isPrimary);
    if (!zubi) { setError('There is no main team member to ask.'); return; }
    setBusy(`cu:${c.id}`); setError(null);
    try {
      const { prompt } = await jsonFetch<{ prompt: string }>(`/api/clients/${encodeURIComponent(c.id)}/catch-up`);
      await api.send(zubi.id, prompt);
      useConfigUI.getState().setView('chat');
      useStore.getState().selectBot(zubi.id);
      close();
    } catch (e) { setError((e as Error).message); setBusy(null); }
  };

  return (
    <Modal onClose={close} className="clients-modal" label="Clients">
      <div className="modal__header">
        <div className="modal__title">Clients</div>
        <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
      </div>
      <div className="clients-modal__body">
        <div className="clients-modal__bar">
          <input className="text-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, company, email, tag or note" aria-label="Search clients" />
          <button type="button" className="btn btn--primary btn--sm" onClick={startNew}>Add a client</button>
        </div>
        {error && <div className="card__error clients-modal__err" role="alert">{error}</div>}
        {editing && (
          <form className="clients-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="clients-form__grid">
              <label><span>Name</span><input className="text-input" value={draft.name} onChange={set('name')} maxLength={100} autoFocus required /></label>
              <label><span>Company</span><input className="text-input" value={draft.company} onChange={set('company')} maxLength={100} /></label>
              <label><span>Email</span><input className="text-input" type="email" value={draft.email} onChange={set('email')} maxLength={200} /></label>
              <label><span>Phone</span><input className="text-input" type="tel" value={draft.phone} onChange={set('phone')} maxLength={40} /></label>
              <label className="is-wide"><span>Tags (separated by commas)</span><input className="text-input" value={draft.tags} onChange={set('tags')} placeholder="lead, retainer" /></label>
              <label className="is-wide"><span>Notes</span><textarea className="text-input" rows={4} value={draft.notes} onChange={set('notes')} maxLength={8000} /></label>
            </div>
            <div className="clients-form__acts">
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setEditing(null)} disabled={busy === 'save'}>Cancel</button>
              <button type="submit" className="btn btn--primary btn--sm" disabled={!draft.name.trim() || busy === 'save'}>{busy === 'save' ? 'Saving…' : editing === 'new' ? 'Add client' : 'Save'}</button>
            </div>
          </form>
        )}
        <div className="clients-list" role="list">
          {!clients ? <div className="search-modal__empty">Loading your clients…</div>
            : !clients.length ? <div className="search-modal__empty">{q.trim() ? `No client matches “${q.trim()}”.` : 'No clients yet. Add your first one.'}</div>
            : clients.map((c) => (
              <div key={c.id} role="listitem" className={`clients-row${editing === c.id ? ' is-active' : ''}`}>
                <button type="button" className="clients-row__main" onClick={() => edit(c)} title="Edit">
                  <span className="search-row__name">{c.name}{c.company ? ` · ${c.company}` : ''}</span>
                  <span className="search-row__sub">{[c.email, c.phone].filter(Boolean).join(' · ') || 'No contact details'}</span>
                  {c.tags.length > 0 && <span className="clients-row__tags">{c.tags.map((t) => <span key={t} className="clients-tag">{t}</span>)}</span>}
                </button>
                <div className="clients-row__acts">
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => void catchUp(c)} disabled={!!busy} title="Zubi looks through Gmail, your calendar, the Kanban and your notes, then sends you a short brief">
                    {busy === `cu:${c.id}` ? 'Asking…' : 'Catch me up'}
                  </button>
                  <button type="button" className="link-btn" onClick={() => void remove(c)} disabled={!!busy}>{busy === `del:${c.id}` ? 'Deleting…' : 'Delete'}</button>
                </div>
              </div>
            ))}
        </div>
      </div>
    </Modal>
  );
}
