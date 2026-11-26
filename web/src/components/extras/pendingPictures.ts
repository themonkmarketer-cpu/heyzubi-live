import { create } from 'zustand';

/**
 * Pictures waiting to be attached to the next message (a camera snapshot, a screenshot). The open chat's Composer
 * takes them and uploads them like a dropped picture.
 */
interface PendingPictures { queue: File[]; push(files: File[]): void; take(): File[] }

export const usePendingPictures = create<PendingPictures>((set, get) => ({
  queue: [],
  push: (files) => set((s) => ({ queue: [...s.queue, ...files] })),
  take: () => { const q = get().queue; if (q.length) set({ queue: [] }); return q; },
}));

/** Draws the video's current frame into a canvas (null when it has no picture yet). */
export function grabFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  return c;
}

export function canvasToFile(canvas: HTMLCanvasElement, type: 'image/jpeg' | 'image/png', name: string): Promise<File | null> {
  return new Promise((res) => canvas.toBlob((b) => res(b ? new File([b], name, { type }) : null), type, type === 'image/jpeg' ? 0.9 : undefined));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One frame of the screen, window or tab the person picks. Null when they cancel or the browser refuses; throws when
 * sharing started but no picture could be taken (so the caller can say so). Waits on timers, not animation frames:
 * Chrome pauses those while the tab is hidden or covered by its own share picker.
 */
export async function screenshotOnce(name: string): Promise<File | null> {
  if (!navigator.mediaDevices?.getDisplayMedia) return null;
  let stream: MediaStream | null = null;
  try {
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true }); } catch { return null; } // refused or cancelled
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.srcObject = stream;
    await Promise.race([v.play().catch(() => {}), sleep(2000)]);
    for (let i = 0; i < 60 && !v.videoWidth; i++) await sleep(50);
    await sleep(150); // let a real frame arrive
    const c = grabFrame(v);
    v.srcObject = null;
    if (!c) throw new Error('The shared screen sent no picture. Try again, or pick a different screen or window.');
    const f = await canvasToFile(c, 'image/png', name);
    if (!f) throw new Error('The screenshot couldn’t be saved. Try again.');
    return f;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}

/** The browser can share a screen, window or tab (needs https or localhost). */
export const canShareScreen = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
