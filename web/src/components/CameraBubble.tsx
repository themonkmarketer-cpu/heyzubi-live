import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { create } from 'zustand';
import { Send } from 'lucide-react';
import { canvasToFile, grabFrame, usePendingPictures } from './extras/pendingPictures';
import { stamp } from './extras/http';
import '../styles/camera.css';

/**
 * Zubi HQ's camera, in HeyZubi: a round floating preview of your own camera, turned on from the button next to
 * the mic. Local only: nothing is recorded, saved or sent anywhere, and the team member does not see it, until you
 * press the snapshot button: that one frame is attached to your next message in the open chat.
 * Drag it anywhere; zoom with + / −, the mouse wheel or a pinch (double-click resets); flip mirrors it.
 * It stops when turned off, when the camera is unplugged, or when the page closes.
 * Ported from Zubi HQ (video-wiki-tools/console.js, the "camera" block).
 */

export const useCamera = create<{ on: boolean }>(() => ({ on: false }));
export const toggleCamera = () => useCamera.setState((s) => ({ on: !s.on }));

const K_POS = 'hz-cam-pos', K_ZOOM = 'hz-cam-zoom', K_FLIP = 'hz-cam-flip';
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

function errorText(e: unknown): string {
  const n = (e as { name?: string })?.name ?? '';
  if (!navigator.mediaDevices?.getUserMedia) return 'The camera needs a secure page: open HeyZubi over https or on localhost.';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera is blocked. Allow it in the browser address bar, then tap the camera again.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera found.';
  if (n === 'NotReadableError') return 'Another app is using the camera.';
  return 'Could not start the camera.';
}

export function CameraBubble() {
  const on = useCamera((s) => s.on);
  return on ? <CameraWindow /> : null;
}

function CameraWindow() {
  const win = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoomState] = useState(() => Math.max(1, Math.min(4, parseFloat(read(K_ZOOM) ?? '') || 1)));
  const [flip, setFlip] = useState(() => read(K_FLIP) !== '0');
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const off = useCallback(() => useCamera.setState({ on: false }), []);

  const setZoom = useCallback((z: number) => {
    const v = Math.round(Math.max(1, Math.min(4, z)) * 100) / 100;
    setZoomState(v); write(K_ZOOM, String(v));
  }, []);
  useEffect(() => { write(K_FLIP, flip ? '1' : '0'); }, [flip]);

  // Keep it on screen (same margins as Zubi HQ).
  const clamp = useCallback((x: number, y: number) => {
    const sw = win.current?.offsetWidth || 252, sh = win.current?.offsetHeight || 200;
    return { x: Math.max(36, Math.min(innerWidth - sw - 8, x)), y: Math.max(36, Math.min(innerHeight - sh - 36, y)) };
  }, []);
  const place = useCallback(() => {
    let p: { x: number; y: number } | null = null;
    try { p = JSON.parse(read(K_POS) ?? 'null'); } catch { /* none */ }
    const sw = win.current?.offsetWidth || 252, sh = win.current?.offsetHeight || 200;
    setPos(clamp(p ? p.x : innerWidth - sw - 28, p ? p.y : innerHeight - sh - 120));
  }, [clamp]);
  useEffect(() => { place(); addEventListener('resize', place); return () => removeEventListener('resize', place); }, [place, err]);

  // The camera itself: on while this window exists, off when it goes.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let gone = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('insecure');
        const st = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
        if (gone) { st.getTracks().forEach((t) => t.stop()); return; }
        stream = st;
        st.getVideoTracks()[0]?.addEventListener('ended', off);
        if (video.current) { video.current.srcObject = st; video.current.play().catch(() => {}); }
      } catch (e) {
        if (!gone) setErr(errorText(e));
      }
    })();
    addEventListener('pagehide', off);
    const v = video.current;
    return () => {
      gone = true;
      removeEventListener('pagehide', off);
      stream?.getTracks().forEach((t) => t.stop());
      if (v) v.srcObject = null;
    };
  }, [off]);

  // Wheel zoom needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const el = win.current;
    if (!el) return;
    const w = (e: WheelEvent) => { e.preventDefault(); setZoom(zoom + (e.deltaY < 0 ? 0.25 : -0.25)); };
    el.addEventListener('wheel', w, { passive: false });
    return () => el.removeEventListener('wheel', w);
  }, [zoom, setZoom]);

  // Drag with one pointer, pinch-zoom with two.
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const pinch = useRef<{ d: number; z: number } | null>(null);
  const dist = () => { const [a, b] = [...pts.current.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('.ccam__b, .ccam__close')) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    win.current?.setPointerCapture(e.pointerId);
    if (pts.current.size === 2) { drag.current = null; setDragging(false); pinch.current = { d: dist(), z: zoom }; }
    else if (win.current) { drag.current = { dx: e.clientX - win.current.offsetLeft, dy: e.clientY - win.current.offsetTop }; setDragging(true); }
  };
  const onMove = (e: React.PointerEvent) => {
    if (pts.current.has(e.pointerId)) pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pts.current.size === 2) { setZoom((pinch.current.z * dist()) / pinch.current.d); return; }
    if (!drag.current) return;
    setPos(clamp(e.clientX - drag.current.dx, e.clientY - drag.current.dy));
  };
  const onUp = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId);
    if (pts.current.size < 2) pinch.current = null;
    if (!drag.current) return;
    drag.current = null; setDragging(false);
    if (win.current) write(K_POS, JSON.stringify({ x: win.current.offsetLeft, y: win.current.offsetTop }));
  };

  // A snapshot of what the camera shows now, attached to the next message in the open chat.
  const [snapped, setSnapped] = useState(false);
  useEffect(() => { if (!snapped) return; const t = setTimeout(() => setSnapped(false), 1600); return () => clearTimeout(t); }, [snapped]);
  const snapshot = async () => {
    const v = video.current;
    const c = v ? grabFrame(v) : null;
    const f = c ? await canvasToFile(c, 'image/jpeg', `camera-${stamp()}.jpg`) : null;
    if (f) { usePendingPictures.getState().push([f]); setSnapped(true); }
  };

  const fz = `${zoom.toFixed(2).replace(/0$/, '')}×`;
  const style = { left: pos?.x, top: pos?.y, visibility: pos ? 'visible' : 'hidden', ['--z' as string]: zoom, ['--m' as string]: flip ? -1 : 1 } as CSSProperties;

  return (
    <div
      ref={win} className={`ccam${dragging ? ' is-drag' : ''}${err ? ' is-err' : ''}`} style={style}
      role="group" aria-label="Your camera preview"
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onDoubleClick={(e) => { if (!(e.target as Element).closest('.ccam__b, .ccam__close')) setZoom(1); }}
    >
      <div className="ccam__w">
        <div className="ccam__r" />
        <div className="ccam__r is-r2" />
        <div className="ccam__c">
          <video ref={video} autoPlay muted playsInline />
          {err && (
            <div className="ccam__m" role="alert">
              <span>{err}</span>
              <button type="button" className="ccam__close" onClick={off}>Close</button>
            </div>
          )}
        </div>
      </div>
      {!err && (
        <div className="ccam__v" role="group" aria-label="Camera controls">
          <button type="button" className="ccam__b" onClick={() => setZoom(zoom + 0.25)} disabled={zoom >= 4} title={`Zoom in (now ${fz})`} aria-label={`Zoom in (now ${fz})`}>+</button>
          <button type="button" className="ccam__b" onClick={() => setZoom(zoom - 0.25)} disabled={zoom <= 1} title={`Zoom out (now ${fz})`} aria-label={`Zoom out (now ${fz})`}>−</button>
          <button
            type="button" className="ccam__b ccam__flip" aria-pressed={flip} onClick={() => setFlip(!flip)}
            title={flip ? 'Mirrored: tap to flip back' : 'Not mirrored: tap to mirror'} aria-label={flip ? 'Mirrored: tap to flip back' : 'Not mirrored: tap to mirror'}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M7 4L3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7" /></svg>
          </button>
          <button type="button" className={`ccam__b${snapped ? ' is-snapped' : ''}`} onClick={() => void snapshot()}
            title={snapped ? 'Snapshot added to your message' : 'Send a snapshot to the bot (it is attached to your next message)'} aria-label="Send a snapshot to the bot">
            <Send size={14} strokeWidth={2} aria-hidden />
          </button>
          <button type="button" className="ccam__b" onClick={off} title="Turn camera off" aria-label="Turn camera off">×</button>
        </div>
      )}
    </div>
  );
}
