import { useEffect, useState } from 'react';

/**
 * Where a floating window opens (the WhatsApp window, the Gmail and Calendar windows): inside the chat area, about
 * half its width, towards its right with a gap before the side panel, from just under the chat's header to just above
 * the message box. The proportions are the ones Murtaza drew on 24 Nov 2026 (about 495 × 755 in a 970 × 979 chat).
 * It follows the chat area when the window resizes or the side panel opens or closes; a window the person has dragged
 * keeps its own place.
 */
export interface Frame { left: number; top: number; width: number; height: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** `cascade` shifts a second window down and left, so two open at once don't hide each other. */
export function openingFrame(cascade = 0): Frame {
  const el = document.querySelector('main.chat');
  const r = el?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight };
  const width = Math.round(clamp(r.width * 0.51, 360, 560));
  const rightGap = clamp(r.width * 0.124, 16, 140);
  const top = r.top + clamp(r.height * 0.138, 64, 150);
  const bottom = r.bottom - clamp(r.height * 0.09, 72, 100);
  const left = Math.max(r.left + 12, r.right - rightGap - width) - cascade * 28;
  const t = top + cascade * 28;
  return { left: Math.max(8, Math.round(left)), top: Math.round(t), width: Math.min(width, Math.round(window.innerWidth - 16)), height: Math.max(300, Math.round(bottom - t)) };
}

/** The opening frame, kept up to date while the chat area changes size. */
export function useOpeningFrame(cascade = 0): Frame {
  const [frame, setFrame] = useState<Frame>(() => openingFrame(cascade));
  useEffect(() => {
    // The chat area is replaced when the side panel opens or closes, so its size is checked twice a second (only while
    // a floating window is open) and on window resizes, and the frame follows when it changed.
    let last = '';
    const update = () => {
      const next = openingFrame(cascade);
      const key = `${next.left},${next.top},${next.width},${next.height}`;
      if (key !== last) { last = key; setFrame(next); }
    };
    update();
    const t = setInterval(update, 500);
    window.addEventListener('resize', update);
    return () => { clearInterval(t); window.removeEventListener('resize', update); };
  }, [cascade]);
  return frame;
}
