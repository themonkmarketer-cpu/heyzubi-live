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

/** One frame of the screen, window or tab the person picks. Null when they cancel or the browser refuses. */
export async function screenshotOnce(name: string): Promise<File | null> {
  if (!navigator.mediaDevices?.getDisplayMedia) return null;
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.srcObject = stream;
    await v.play();
    for (let i = 0; i < 40 && !v.videoWidth; i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const c = grabFrame(v);
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    v.srcObject = null;
    return c ? await canvasToFile(c, 'image/png', name) : null;
  } catch {
    return null; // refused or cancelled: nothing to say
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}

/** The browser can share a screen, window or tab (needs https or localhost). */
export const canShareScreen = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
