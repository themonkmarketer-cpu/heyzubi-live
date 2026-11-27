import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useOpeningFrame } from '../lib/floatFrame';
import { useResizable } from '../lib/resizable';
import type { WaDraft } from '@shared/types';
import { useStore } from '../store';
import { GenPicker, genUrl } from './GenerationsView';
import '../styles/whatsapp.css';

/**
 * The floating WhatsApp window (everything Zubi HQ's WhatsApp page does): connect a number by QR or disconnect it,
 * send text or an image with a caption (upload one, or pick from Generations), preview, and only "Confirm and send"
 * sends, once; plus the whole sent history. It opens when a team member drafts a message, or from the orb.
 * Send-only, 20 a day shared with Zubi HQ.
 */

interface Status { state: string; paired: boolean; phone: string; sentToday: number; cap: number; pair: { state: string; svg: string; error: string } }
interface Group { id: string; name: string; size: number }
interface Preview { token: string; recipient: string; text: string; hasImage: boolean; imageName: string; remaining: number }
interface Hist { ts: string; to: string; text: string; result: string; via: string; type: string; image: string; error: string }
type Img = { kind: 'upload'; id: string; name: string; url: string } | { kind: 'gen'; rel: string; name: string; url: string };

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
const readFile = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });

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
  const [img, setImg] = useState<Img | null>(null);
  // An attached image makes the message its caption.
  const mode: 'text' | 'image' = img ? 'image' : 'text';
  const [showGen, setShowGen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [imgPrompt, setImgPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ k: 'ok' | 'bad' | 'warn'; t: string } | null>(null);
  const [hist, setHist] = useState<{ items: Hist[]; total: number } | null>(null);
  const [tab, setTab] = useState<'send' | 'history'>('send');
  const [askDisconnect, setAskDisconnect] = useState(false);
  const [min, setMin] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Opens in the chat area at the shared floating-window size (lib/floatFrame.ts); a drag moves it from there.
  const frame = useOpeningFrame();
  const applied = useRef<string | null>(null);
  const winRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(() => {
    wa<Status>('/status').then(setStatus).catch(() => setStatus({ state: 'offline', paired: false, phone: '', sentToday: 0, cap: 20, pair: { state: 'idle', svg: '', error: '' } }));
  }, []);
  const loadGroups = useCallback((force = false) => {
    if (groups && !force) return;
    wa<{ groups: Group[] }>('/groups').then((r) => { setGroups(r.groups); setGroupsErr(null); }).catch((e: Error) => setGroupsErr(e.message));
  }, [groups]);
  useEffect(loadStatus, [loadStatus]);
  // Re-check while connecting (opening can start the bridge) and while a QR code is up (it changes every ~20 s).
  useEffect(() => {
    if (!status || status.state === 'connected' || status.state === 'not_paired') return;
    const t = setTimeout(loadStatus, status.pair.state === 'qr' || status.pair.state === 'starting' ? 2000 : 3000);
    return () => clearTimeout(t);
  }, [status, loadStatus]);

  // Fill the form from a team member's draft (once per draft). Opened by hand: pick up a waiting draft, if any.
  const apply = useCallback((d: WaDraft) => {
    if (applied.current === d.id) return;
    applied.current = d.id;
    setPreview(null); setNote(null); setTab('send');
    setText(d.text);
    if (d.to.kind === 'group') { setKind('group'); setGq(d.to.name); setGroup(null); }
    else { setKind('person'); setNumber(d.to.number || COUNTRY); }
    if (d.image) { setImg({ kind: 'gen', rel: d.image, name: d.image.split('/').pop() ?? d.image, url: genUrl(d.image) }); }
    setMin(false);
  }, []);
  useEffect(() => { if (draft) apply(draft); }, [draft, apply]);
  useEffect(() => {
    if (draft) return;
    wa<{ draft: WaDraft | null }>('/draft').then((r) => { if (r.draft) set({ waDraft: r.draft }); }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (kind === 'group' && status?.state === 'connected') loadGroups(); }, [kind, status?.state, loadGroups]);
  // A group named in the draft is picked when exactly one group has that name; anything else is left to the owner.
  useEffect(() => {
    if (kind !== 'group' || group || !groups || !gq.trim()) return;
    const m = groups.filter((g) => g.name.trim().toLowerCase() === gq.trim().toLowerCase());
    if (m.length === 1) setGroup(m[0]);
  }, [kind, group, groups, gq]);
  useEffect(() => {
    if (tab !== 'history' || hist) return;
    wa<{ history: Hist[]; total: number }>('/history?limit=300').then((r) => setHist({ items: r.history, total: r.total })).catch(() => setHist({ items: [], total: 0 }));
  }, [tab, hist]);

  const connected = status?.state === 'connected';
  const digits = number.replace(/\D/g, '');
  const hasBody = mode === 'image' ? !!img : !!text.trim();
  const ready = connected && hasBody && (kind === 'group' ? !!group : digits.length >= 10) && !(mode === 'image' && text.length > 1000);

  const upload = async (f: File) => {
    setNote(null);
    if (f.size > 15 * 1024 * 1024) { setNote({ k: 'bad', t: 'Images up to 15 MB.' }); return; }
    try {
      const data = await readFile(f);
      const r = await wa<{ id: string; name: string }>('/upload', { name: f.name, data });
      setImg({ kind: 'upload', id: r.id, name: r.name, url: data }); setShowGen(false); setPreview(null);
    } catch (e) { setNote({ k: 'bad', t: (e as Error).message }); }
  };
  const createPicture = async () => {
    setCreating(true); setNote(null);
    try {
      const r = await fetch('/api/generations/create', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: imgPrompt }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Couldn’t create the picture.');
      setImg({ kind: 'gen', rel: j.rel, name: j.name, url: genUrl(j.rel) }); setShowCreate(false); setImgPrompt(''); setPreview(null);
    } catch (e) { setNote({ k: 'bad', t: (e as Error).message }); }
    finally { setCreating(false); }
  };
  const doPreview = async () => {
    setBusy(true); setNote(null);
    try {
      const image = mode === 'image' && img ? (img.kind === 'upload' ? { upload: img.id } : { gen: img.rel }) : null;
      setPreview(await wa<Preview>('/preview', { kind, group: group?.id, number: digits, text, image }));
    } catch (e) { setNote({ k: 'bad', t: (e as Error).message }); }
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
      setText(''); setGroup(null); setGq(''); setNumber(COUNTRY); setImg(null);
      if (draft) set({ waDraft: null });
      applied.current = null;
    } else {
      setNote({ k: r.result === 'unknown' ? 'warn' : 'bad', t: `${r.result === 'unknown' ? 'Not sure it was sent. Check the chat before sending again.' : 'Not sent.'} ${r.error ?? ''}` });
    }
    loadStatus(); setHist(null);
  };
  const startPair = async () => { setNote(null); try { await wa('/pair/start', {}); } catch (e) { setNote({ k: 'bad', t: (e as Error).message }); } loadStatus(); };
  const cancelPair = async () => { await wa('/pair/cancel', {}).catch(() => {}); loadStatus(); };
  const disconnect = async () => {
    setAskDisconnect(false);
    try { await wa('/disconnect', { confirm: true }); setNote({ k: 'ok', t: 'WhatsApp is disconnected. The sent history is kept.' }); setGroups(null); }
    catch (e) { setNote({ k: 'bad', t: (e as Error).message }); }
    loadStatus();
  };

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

  const { size, grip } = useResizable({ w: 320, h: 300 });
  const style: CSSProperties = {
    left: pos?.x ?? frame.left, top: pos?.y ?? frame.top, right: 'auto', bottom: 'auto', width: size?.w ?? frame.width,
    ...(min ? {} : { height: size?.h ?? frame.height, maxHeight: 'none' }),
  };
  const q = gq.trim().toLowerCase();
  const list = groups ? groups.filter((g) => !q || g.name.toLowerCase().includes(q)) : [];
  const pairing = status && !status.paired;

  return (
    <div ref={winRef} className={`waw${min ? ' is-min' : ''}`} style={style} role="dialog" aria-label="WhatsApp" data-resizable>
      {!min && <span className="fgrip" {...grip} />}
      <div className="waw__head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <WaIcon />
        <b>WhatsApp</b>
        {status && (
          <span className={`waw__pill${connected ? ' is-ok' : ''}`}>
            <i />{connected ? `${status.phone || 'Connected'} · ${status.sentToday}/${status.cap} today` : pairing ? 'Not connected' : 'Reconnecting'}
          </span>
        )}
        <button type="button" onClick={() => setMin(!min)} aria-label={min ? 'Restore' : 'Minimise'} title={min ? 'Restore' : 'Minimise'}>{min ? '▢' : '–'}</button>
        <button type="button" onClick={close} aria-label="Close (the draft is kept)" title="Close (the draft is kept)">×</button>
      </div>

      {!min && (
        <div className="waw__body">
          {/* ---- connect by QR ---- */}
          {pairing ? (
            <div className="waw__pair">
              {status.pair.state === 'qr' && status.pair.svg ? (
                <>
                  <div className="waw__lab">Scan with WhatsApp</div>
                  <div className="waw__qr" dangerouslySetInnerHTML={{ __html: status.pair.svg }} />
                  <p className="waw__mut">On your phone: WhatsApp → Settings → Linked devices → Link a device. The code refreshes by itself; it stops after 3 minutes.</p>
                  <button type="button" className="waw__btn" onClick={cancelPair}>Cancel</button>
                </>
              ) : status.pair.state === 'starting' ? (
                <p className="waw__mut">Getting a QR code…</p>
              ) : (
                <>
                  <div className="waw__lab">Connect WhatsApp</div>
                  <p className="waw__mut">Link your number once to send messages from here (send-only: nothing comes back into the app). It’s the same connection Zubi HQ uses.</p>
                  {status.pair.state === 'error' && <div className="waw__note is-bad">{status.pair.error || 'That didn’t work.'} Try again.</div>}
                  <button type="button" className="waw__btn is-pri" onClick={startPair}>Show QR code</button>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="waw__tabs" role="tablist">
                <button type="button" role="tab" aria-selected={tab === 'send'} onClick={() => setTab('send')}>Send</button>
                <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>Sent history</button>
                <span className="waw__tabs-sp" />
                {connected && !askDisconnect && <button type="button" className="waw__link is-danger" onClick={() => setAskDisconnect(true)}>Disconnect</button>}
                {askDisconnect && (
                  <span className="waw__confirm">Unlink {status?.phone}?
                    <button type="button" className="waw__btn is-sm is-danger" onClick={disconnect}>Disconnect</button>
                    <button type="button" className="waw__btn is-sm" onClick={() => setAskDisconnect(false)}>Keep</button>
                  </span>
                )}
              </div>

              {status && !connected && <div className="waw__note is-warn">WhatsApp is reconnecting. You can write now and preview in a moment.</div>}

              {tab === 'history' ? (
                hist === null ? <p className="waw__mut">Loading…</p> : hist.items.length === 0 ? <p className="waw__mut">Nothing sent yet.</p> : (
                  <>
                    <p className="waw__mut">{hist.total} sent in all · {status?.sentToday ?? 0} of {status?.cap ?? 20} today (shared with Zubi HQ)</p>
                    <ul className="waw__hist">
                      {hist.items.map((h, i) => (
                        <li key={i}>
                          <span className="waw__mut">{h.ts.slice(0, 16)}</span> <b>{h.to}</b> <span className={`waw__res is-${h.result}`}>{h.result}</span>
                          {h.via === 'heyzubi' && <span className="waw__via">HeyZubi</span>}
                          <br /><span className="waw__htext">{h.type === 'image' ? `🖼 ${h.image}${h.text ? ` · ${h.text}` : ''}` : h.text}</span>
                          {h.error && <><br /><span className="waw__herr">{h.error}</span></>}
                        </li>
                      ))}
                    </ul>
                  </>
                )
              ) : (
                <>
                  {draft && !preview && <div className="waw__by">Drafted by {draft.botName}. Nothing is sent until you press Confirm.</div>}

                  {preview ? (
                    <div className="waw__prev">
                      <div><span className="waw__mut">To</span><br /><b>{preview.recipient}</b></div>
                      <div className="waw__bubble">
                        {preview.hasImage && img && <img src={img.url} alt={preview.imageName} />}
                        {preview.text || (preview.hasImage ? <span className="waw__mut">(image only)</span> : null)}
                      </div>
                      <div className="waw__mut">{preview.hasImage ? 'Image + caption' : 'Text message'} · {preview.remaining} sends left today · this preview lasts 10 minutes</div>
                      <div className="waw__row">
                        <button type="button" className="waw__btn is-pri" onClick={doSend} disabled={sending}>{sending ? 'Sending…' : 'Confirm and send'}</button>
                        <button type="button" className="waw__btn" onClick={() => setPreview(null)} disabled={sending}>Edit</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="waw__lab">1 · Who gets it</div>
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
                      ) : group ? (
                        <p className="waw__picked">✓ <b>{group.name}</b> <span className="waw__mut">{group.size} members</span> <button type="button" className="waw__btn is-sm" onClick={() => setGroup(null)}>Change</button></p>
                      ) : (
                        <>
                          <div className="waw__row is-tight">
                            <input className="waw__in" type="search" aria-label="Search your groups" placeholder="Search your groups" value={gq} onChange={(e) => setGq(e.target.value)} />
                            <button type="button" className="waw__btn is-sm" onClick={() => { setGroups(null); loadGroups(true); }} title="Reload your groups">Refresh</button>
                          </div>
                          {groupsErr ? <div className="waw__note is-bad">{groupsErr}</div>
                            : !groups ? <p className="waw__mut">Loading your groups…</p>
                            : list.length ? (
                              <div className="waw__list">
                                {list.slice(0, 60).map((g) => (
                                  <button type="button" key={g.id} onClick={() => setGroup(g)}><span>{g.name || '(no name)'}</span><span className="waw__mut">{g.size}</span></button>
                                ))}
                              </div>
                            ) : <p className="waw__mut">No group matches that.</p>}
                        </>
                      )}

                      <div className="waw__lab">2 · What to send</div>
                      {/* The image choice is always here: adding one makes the message its caption (no mode to switch). */}
                      {img ? (
                        <div className="waw__pick">
                          <img src={img.url} alt={img.name} />
                          <div><b>{img.name}</b><br /><button type="button" className="waw__btn is-sm" onClick={() => { setImg(null); setPreview(null); }}>Remove image</button></div>
                        </div>
                      ) : (
                        <div className="waw__row is-wrap">
                          <button type="button" className="waw__btn" onClick={() => fileRef.current?.click()}>🖼 Upload an image</button>
                          <button type="button" className="waw__btn" onClick={() => { setShowGen(!showGen); setShowCreate(false); }} aria-expanded={showGen}>{showGen ? 'Hide Generations' : 'From Generations'}</button>
                          <button type="button" className="waw__btn" onClick={() => { setShowCreate(!showCreate); setShowGen(false); }} aria-expanded={showCreate}>✨ Create an image</button>
                          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
                        </div>
                      )}
                      {showGen && !img && <GenPicker onPick={(it) => { setImg({ kind: 'gen', rel: it.rel, name: it.name, url: genUrl(it.rel) }); setShowGen(false); setPreview(null); }} />}
                      {showCreate && !img && (
                        <div className="waw__create">
                          <textarea className="waw__in" rows={2} maxLength={1500} placeholder="Describe the picture, e.g. “A sunny good-morning card with chai and marigolds, the words Good morning!”" value={imgPrompt} onChange={(e) => setImgPrompt(e.target.value)} aria-label="Describe the picture" />
                          <div className="waw__row">
                            <button type="button" className="waw__btn is-pri" disabled={!imgPrompt.trim() || creating} onClick={() => void createPicture()}>{creating ? 'Creating…' : 'Create'}</button>
                            <span className="waw__mut">About $0.04 at xAI. Saved into Generations too.</span>
                          </div>
                        </div>
                      )}
                      <div className="waw__row is-split">
                        <span className="waw__lab is-inline">{mode === 'image' ? 'Caption (optional)' : 'Message'}</span>
                        <span className={`waw__mut${mode === 'image' && text.length > 1000 ? ' is-over' : ''}`}>{text.length} / {mode === 'image' ? 1000 : 4000}</span>
                      </div>
                      <textarea className="waw__in waw__ta" aria-label={mode === 'image' ? 'Caption' : 'Message'} placeholder={mode === 'image' ? 'Write a caption' : 'Write your message'} maxLength={4000} value={text} onChange={(e) => { setText(e.target.value); setNote(null); }} />

                      <div className="waw__lab">3 · Check it, then confirm</div>
                      <div className="waw__row">
                        <button type="button" className="waw__btn is-pri" onClick={doPreview} disabled={!ready || busy}>{busy ? 'Checking…' : 'Preview'}</button>
                        <span className="waw__mut">Nothing is sent by previewing.</span>
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          )}

          {note && <div className={`waw__note is-${note.k}`} role="status">{note.t}</div>}
        </div>
      )}
    </div>
  );
}
