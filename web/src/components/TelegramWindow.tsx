import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useResizable } from '../lib/resizable';
import { TelegramSetup } from './cards/TelegramSetup';

/**
 * The Telegram bot setup window: floats over the app (drag by its title bar, resize from the lower-right corner) and
 * plays the how-to video as it opens, with the two paste boxes under it. Opened from a team member's side panel.
 * The token and ID typed here go straight to that member's own settings (TelegramSetup), never into a chat.
 */
export const useTelegramWindow = create<{ botId: string | null; botName: string }>(() => ({ botId: null, botName: '' }));
export const openTelegramWindow = (botId: string, botName: string) => useTelegramWindow.setState({ botId, botName });

export function TelegramWindow() {
  const { botId, botName } = useTelegramWindow();
  const winRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const { size, grip, reset } = useResizable({ w: 300, h: 320 });
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const close = () => { useTelegramWindow.setState({ botId: null }); setPos(null); reset(); };
  useEffect(() => {
    if (!botId) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  if (!botId) return null;
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('button') || !winRef.current) return;
    const r = winRef.current.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || !winRef.current) return;
    const w = winRef.current.offsetWidth;
    setPos({ x: Math.max(0, Math.min(window.innerWidth - w, e.clientX - drag.current.dx)), y: Math.max(0, Math.min(window.innerHeight - 48, e.clientY - drag.current.dy)) });
  };
  const onUp = () => { drag.current = null; };
  const w = size?.w ?? Math.min(400, window.innerWidth - 24);
  const h = size?.h ?? Math.min(window.innerHeight - 48, 860);
  return (
    <div ref={winRef} className="tgw" role="dialog" aria-label={`Telegram bot setup for ${botName}`} data-resizable
      style={{ left: pos?.x ?? Math.max(8, window.innerWidth - Math.min(400, window.innerWidth - 24) - 380), top: pos?.y ?? 24, width: w, height: h }}>
      <div className="tgw__head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <b>Telegram bot setup</b>
        <span>{botName}</span>
        <button type="button" onClick={close} aria-label="Close" title="Close (Esc)">×</button>
      </div>
      <div className="tgw__body">
        <TelegramSetup key={botId} botId={botId} botName={botName} mode="window" />
      </div>
      <span className="fgrip" {...grip} />
    </div>
  );
}
