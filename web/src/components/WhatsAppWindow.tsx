import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { WaDraft } from '@shared/types';
import { useStore } from '../store';
import '../styles/whatsapp.css';

/**
 * The floating WhatsApp window. It opens when a team member drafts a message (or from the sidebar button).
 * The owner picks or checks who gets it, writes or edits the text, previews, and only "Confirm and send"
 * sends, once. Send-only, through the account connected in Zubi HQ, 20 a day shared with Zubi HQ.
 */

interface Status { state: string; phone: string; sentToday: number; cap: number }
interface Group { id: string; name: string; size: number }
interface Preview { token: string; recipient: string; text: string; remaining: number }
interface Hist { ts: string; to: string; text: string; result: string; via: string }

async function wa<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/whatsapp${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok && !(j && 'result' in j)) throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
  return j as T;
}

export const WaIcon = ({ size = 20 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
    <path d="M12 2.2A9.8 9.8 0 0 0 3.6 17L2.2 21.8l4.9-1.3A9.8 9.8 0 1 0 12 2.2z" fill="#25D366" />
    <path d="M8.3 7.3c.3-.5.8-.4 1 0l.9 1.8c.1.3 0 .6-.2.8l-.5.6c.8 1.5 1.9 2.5 3.4 3.2l.6-.7c.2-.2.5-.3.8-.1l1.8.9c.4.2.4.7.1 1.1-.5.8-1.4 1.2-2.4 1-3.1-.7-5.4-3-6-6-.1-.9.1-1.8.5-2.6z" fill="#FFFFFF" />
  </svg>
);

const COUNTRY = '91';

export function WhatsAppWindow() {
  const draft = useStore((s) => s.waDraft);
  const set = useStore((s) => s.set);

  const [status, setStatus] = useState<Status | null>(null);
  const [kind, setKind] = useState<'group' | 'person'>('person');
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [groupsErr, setGroupsErr] = useState<string | null>(null);
  const [gq, setGq] = useState('');
  const [group, setGroup] = useState<Group | null>(null);
  const [number, setNumber] = useState(COUNTRY);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ k: 'ok' | 'bad' | 'warn'; t: string } | null>(null);
  const [hist, setHist] = useState<Hist[] | null>(null);
  const [showHist, setShowHist] = useState(false);
  const [min, setMin] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const applied = useRef<string | null>(null);
  const winRef = useRef<HTMLDivElement>(null);

  const loadStatus = useCallback(() => { wa<Status>('/status').then(setStatus).catch(() => setStatus({ state: 'offline', phone: '', sentToday: 0, cap: 20 })); }, []);
  const loadGroups = useCallback(() => {
    if (groups) return;
    wa<{ groups: Group[] }>('/groups').then((r) => { setGroups(r.groups); setGroupsErr(null); }).catch((e: Error) => setGroupsErr(e.message));
  }, [groups]);
  useEffect(loadStatus, [loadStatus]);
  // Opening the window can start the WhatsApp bridge; it takes a few seconds to connect, so check again until it has.
  useEffect(() => {
    if (!status || status.state === 'connected' || status.state === 'not_paired') return;
    const t = setTimeout(loadStatus, 3000);
    return () => clearTimeout(t);
  }, [status, loadStatus]);

  // Fill the form from a team member's draft (once per draft). Opened by hand: pick up a waiting draft, if any.
  const apply = useCallback((d: WaDraft) => {
    if (applied.current === d.id) return;
    applied.current = d.id;
    setPreview(null); setNote(null);
    setText(d.text);
    if (d.to.kind === 'group') { setKind('group'); setGq(d.to.name); setGroup(null); }
    else { setKind('person'); setNumber(d.to.number || COUNTRY); }
    setMin(false);
  }, []);
  useEffect(() => { if (draft) apply(draft); }, [draft, apply]);
  useEffect(() => {
    if (draft) return;
    wa<{ draft: WaDraft | null }>('/draft').then((r) => { if (r.draft) set({ waDraft: r.draft }); }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (kind === 'group') loadGroups(); }, [kind, loadGroups]);
  // A group named in the draft is picked when exactly one group has that name; anything else is left to the owner.
  useEffect(() => {
    if (kind !== 'group' || group || !groups || !gq.trim()) return;
    const m = groups.filter((g) => g.name.trim().toLowerCase() === gq.trim().toLowerCase());
    if (m.length === 1) setGroup(m[0]);
  }, [kind, group, groups, gq]);

  const digits = number.replace(/\D/g, '');
  const ready = !!text.trim() && (kind === 'group' ? !!group : digits.length >= 10) && status?.state === 'connected';

  const doPreview = async () => {
    setBusy(true); setNote(null);
    try { setPreview(await wa<Preview>('/preview', { kind, group: group?.id, number: digits, text })); }
    catch (e) { setNote({ k: 'bad', t: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const doSend = async () => {
    if (!preview || sending) return;
    setSending(true);
    let r: { ok: boolean; result: string; error: string | null; to?: string; left?: number };
    try { r = await wa('/send', { token: preview.token, confirm: true }); }
    catch (e) { r = { ok: false, result: 'failed', error: (e as Error).message }; }
    setSending(false); setPreview(null); // the preview is spent either way: nothing is retried
    if (r.ok) {
      setNote({ k: 'ok', t: `Sent to ${r.to}. ${r.left} left today.` });
      setText(''); setGroup(null); setGq(''); setNumber(COUNTRY);
      if (draft) set({ waDraft: null });
      applied.current = null;
    } else {
      setNote({ k: r.result === 'unknown' ? 'warn' : 'bad', t: `${r.result === 'unknown' ? 'Not sure it was sent. Check the chat before sending again.' : 'Not sent.'} ${r.error ?? ''}` });
    }
    loadStatus(); setHist(null);
  };

  useEffect(() => {
    if (!showHist || hist) return;
    wa<{ history: Hist[] }>('/history').then((r) => setHist(r.history)).catch(() => setHist([]));
  }, [showHist, hist]);

  // Drag by the title bar; stays inside the window.
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    const r = winRef.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || !winRef.current) return;
    const w = winRef.current.offsetWidth;
    setPos({ x: Math.max(0, Math.min(window.innerWidth - w, e.clientX - drag.current.dx)), y: Math.max(0, Math.min(window.innerHeight - 48, e.clientY - drag.current.dy)) });
  };
  const onUp = () => { drag.current = null; };

  const close = () => set({ waOpen: false });
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !min && winRef.current?.contains(document.activeElement)) close(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const connected = status?.state === 'connected';
  const style: CSSProperties | undefined = pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined;
  const q = gq.trim().toLowerCase();
  const list = groups ? groups.filter((g) => !q || g.name.toLowerCase().includes(q)) : [];

  return (
    <div ref={winRef} className={`waw${min ? ' is-min' : ''}`} style={style} role="dialog" aria-label="WhatsApp">
      <div className="waw__head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <WaIcon />
        <b>WhatsApp</b>
        {status && (
          <span className={`waw__pill${connected ? ' is-ok' : ''}`}>
            <i />{connected ? `${status.phone || 'Connected'} · ${status.sentToday}/${status.cap} today` : status.state === 'not_paired' ? 'Not connected' : 'Reconnecting'}
          </span>
        )}
        <button type="button" onClick={() => setMin(!min)} aria-label={min ? 'Restore' : 'Minimise'} title={min ? 'Restore' : 'Minimise'}>{min ? '▢' : '–'}</button>
        <button type="button" onClick={close} aria-label="Close (the draft is kept)" title="Close (the draft is kept)">×</button>
      </div>

      {!min && (
        <div className="waw__body">
          {status && !connected && (
            <div className="waw__note is-warn">
              {status.state === 'not_paired' ? 'WhatsApp isn’t connected. Connect it once in Zubi HQ (Zubi Live, WhatsApp), then come back.' : 'WhatsApp is reconnecting. You can write now and preview in a moment.'}
            </div>
          )}
          {draft && !preview && <div className="waw__by">Drafted by {draft.botName}. Nothing is sent until you press Confirm.</div>}

          {preview ? (
            <div className="waw__prev">
              <div><span className="waw__mut">To</span><br /><b>{preview.recipient}</b></div>
              <div className="waw__bubble">{preview.text}</div>
              <div className="waw__mut">Text message · {preview.remaining} sends left today · this preview lasts 10 minutes</div>
              <div className="waw__row">
                <button type="button" className="waw__btn is-pri" onClick={doSend} disabled={sending}>{sending ? 'Sending…' : 'Confirm and send'}</button>
                <button type="button" className="waw__btn" onClick={() => setPreview(null)} disabled={sending}>Edit</button>
              </div>
            </div>
          ) : (
            <>
              <div className="waw__lab">Who gets it</div>
              <div className="waw__seg" role="group" aria-label="Who gets it">
                <button type="button" aria-pressed={kind === 'person'} onClick={() => { setKind('person'); setNote(null); }}>One person</button>
                <button type="button" aria-pressed={kind === 'group'} onClick={() => { setKind('group'); setNote(null); }}>A group</button>
              </div>

              {kind === 'person' ? (
                <>
                  <input
                    className="waw__in" type="tel" inputMode="numeric" autoComplete="off" aria-label="WhatsApp number"
                    placeholder="919783555153" value={number} onChange={(e) => { setNumber(e.target.value.replace(/\D/g, '')); setNote(null); }}
                  />
                  <p className="waw__mut">Starts with 91 (India): add the 10 digits. For another country, replace 91 with its code.</p>
                </>
              ) : (
                <>
                  {group ? (
                    <p className="waw__picked">✓ <b>{group.name}</b> <span className="waw__mut">{group.size} members</span> <button type="button" className="waw__btn is-sm" onClick={() => setGroup(null)}>Change</button></p>
                  ) : (
                    <>
                      <input className="waw__in" type="search" aria-label="Search your groups" placeholder="Search your groups" value={gq} onChange={(e) => setGq(e.target.value)} />
                      {groupsErr ? <div className="waw__note is-bad">{groupsErr}</div>
                        : !groups ? <p className="waw__mut">Loading your groups…</p>
                        : list.length ? (
                          <div className="waw__list">
                            {list.slice(0, 50).map((g) => (
                              <button type="button" key={g.id} onClick={() => setGroup(g)}><span>{g.name || '(no name)'}</span><span className="waw__mut">{g.size}</span></button>
                            ))}
                          </div>
                        ) : <p className="waw__mut">No group matches that.</p>}
                    </>
                  )}
                </>
              )}

              <div className="waw__row is-split"><span className="waw__lab">Message</span><span className="waw__mut">{text.length} / 4000</span></div>
              <textarea className="waw__in waw__ta" aria-label="Message" placeholder="Write your message" maxLength={4000} value={text} onChange={(e) => { setText(e.target.value); setNote(null); }} />
              <div className="waw__row">
                <button type="button" className="waw__btn is-pri" onClick={doPreview} disabled={!ready || busy}>{busy ? 'Checking…' : 'Preview'}</button>
                <span className="waw__mut">Nothing is sent by previewing.</span>
              </div>
            </>
          )}

          {note && <div className={`waw__note is-${note.k}`} role="status">{note.t}</div>}

          <button type="button" className="waw__histbtn" onClick={() => setShowHist(!showHist)} aria-expanded={showHist}>{showHist ? '▾' : '▸'} Recently sent</button>
          {showHist && (
            hist === null ? <p className="waw__mut">Loading…</p> : hist.length === 0 ? <p className="waw__mut">Nothing sent yet.</p> : (
              <ul className="waw__hist">
                {hist.map((h, i) => (
                  <li key={i}><span className="waw__mut">{h.ts.slice(5, 16)}</span> <b>{h.to}</b> <span className={`waw__res is-${h.result}`}>{h.result}</span><br /><span className="waw__htext">{h.text}</span></li>
                ))}
              </ul>
            )
          )}
        </div>
      )}
    </div>
  );
}
