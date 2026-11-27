import { useRef, useState } from 'react';

/**
 * A floating window the person can resize by dragging its lower-right corner (a double-click on the corner puts it
 * back to its opening size). The window keeps its top-left where it is; it never grows past the browser window.
 * The window carries `data-resizable`; spread `grip` on a small element inside it with the `fgrip` class (float.css).
 */
export function useResizable(min = { w: 300, h: 220 }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const start = useRef<{ x: number; y: number; w: number; h: number; left: number; top: number } | null>(null);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const grip = {
    onPointerDown(e: React.PointerEvent<HTMLElement>) {
      if (e.button !== 0) return;
      const box = (e.currentTarget.closest('[data-resizable]') as HTMLElement | null)?.getBoundingClientRect();
      if (!box) return;
      e.preventDefault();
      e.stopPropagation();
      start.current = { x: e.clientX, y: e.clientY, w: box.width, h: box.height, left: box.left, top: box.top };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e: React.PointerEvent<HTMLElement>) {
      const s = start.current;
      if (!s) return;
      e.stopPropagation();
      setSize({
        w: Math.round(clamp(s.w + e.clientX - s.x, min.w, window.innerWidth - s.left - 8)),
        h: Math.round(clamp(s.h + e.clientY - s.y, min.h, window.innerHeight - s.top - 8)),
      });
    },
    onPointerUp() { start.current = null; },
    onPointerCancel() { start.current = null; },
    onDoubleClick() { setSize(null); },
    title: 'Drag to resize · double-click to reset',
  };
  return { size, grip, reset: () => setSize(null) };
}
