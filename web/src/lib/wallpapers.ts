// Chat wallpaper: 10 built-in backgrounds (pure CSS: gradients, plus small SVGs for patterns and grain, so nothing to
// download), or a picture of the owner's own. The choice is saved with the owner's preferences on the server
// (/api/prefs), so it follows them across restarts, browsers and the Windows app; a local copy paints it straight away.
import { create } from 'zustand';
import { lsGet, lsSet } from './storage';

export interface Wallpaper { id: string; name: string; kind: 'Gradient' | 'Abstract' | 'Dark' | 'Pattern' | 'Texture'; bg: string; dim: number }

const svg = (s: string) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;

const GRAIN = (opacity: number) => svg(`<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)' opacity='${opacity}'/></svg>`);

const STARS = svg(`<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'>${[
  [18, 30, 0.9, 0.8], [70, 12, 0.6, 0.5], [120, 48, 1.1, 0.9], [190, 22, 0.7, 0.6], [40, 96, 0.6, 0.45], [150, 110, 0.9, 0.7],
  [205, 140, 0.6, 0.5], [92, 150, 1.2, 0.85], [20, 180, 0.7, 0.55], [130, 196, 0.6, 0.45], [178, 186, 1, 0.75], [60, 210, 0.5, 0.4],
].map(([x, y, r, o]) => `<circle cx='${x}' cy='${y}' r='${r}' fill='white' opacity='${o}'/>`).join('')}</svg>`);

const WAVES = svg(`<svg xmlns='http://www.w3.org/2000/svg' width='480' height='120'><g fill='none' stroke='rgb(140,100,255)' stroke-width='1.4'>${
  [20, 60, 100].map((y, i) => `<path opacity='${0.16 + i * 0.04}' d='M0 ${y} Q 60 ${y - 26} 120 ${y} T 240 ${y} T 360 ${y} T 480 ${y}'/>`).join('')}</g></svg>`);

/** In the order the picker shows them. `dim` is the starting readability layer for each. */
export const WALLPAPERS: Wallpaper[] = [
  { id: 'aurora', name: 'Aurora', kind: 'Gradient', dim: 0.15, bg: 'radial-gradient(70% 55% at 10% 0%, rgba(124,92,255,0.55), transparent 70%), radial-gradient(60% 50% at 95% 25%, rgba(0,200,180,0.40), transparent 70%), radial-gradient(70% 60% at 50% 110%, rgba(255,105,180,0.38), transparent 70%), linear-gradient(180deg, #15112b, #0b1022)' },
  { id: 'sunset', name: 'Sunset', kind: 'Gradient', dim: 0.2, bg: 'linear-gradient(160deg, #ffb199 0%, #ff7a9a 40%, #c86dd7 75%, #6a5af9 100%)' },
  { id: 'ocean', name: 'Ocean', kind: 'Gradient', dim: 0.15, bg: 'radial-gradient(80% 60% at 80% 0%, rgba(90,200,250,0.35), transparent 70%), linear-gradient(180deg, #0f2027 0%, #203a43 55%, #2c5364 100%)' },
  { id: 'mesh', name: 'Mesh', kind: 'Abstract', dim: 0.25, bg: 'radial-gradient(at 18% 22%, #a78bfa 0, transparent 55%), radial-gradient(at 82% 12%, #60a5fa 0, transparent 50%), radial-gradient(at 72% 82%, #f472b6 0, transparent 50%), radial-gradient(at 8% 92%, #34d399 0, transparent 50%), #ede9fe' },
  { id: 'midnight', name: 'Midnight', kind: 'Dark', dim: 0, bg: `${STARS}, radial-gradient(90% 70% at 50% 0%, #1d2747 0%, #070a16 70%)` },
  { id: 'graphite', name: 'Graphite', kind: 'Dark', dim: 0, bg: `${GRAIN(0.09)}, linear-gradient(180deg, #23242b, #16171c)` },
  { id: 'zubi', name: 'Zubi', kind: 'Abstract', dim: 0.1, bg: 'radial-gradient(45% 40% at 88% 14%, rgba(255,122,26,0.32), transparent 70%), radial-gradient(70% 60% at 12% 88%, rgba(150,110,255,0.55), transparent 70%), radial-gradient(40% 35% at 55% 45%, rgba(110,70,230,0.25), transparent 70%), linear-gradient(135deg, #1a1033, #2a1650)' },
  { id: 'dots', name: 'Dots', kind: 'Pattern', dim: 0, bg: 'radial-gradient(rgba(140,120,200,0.28) 1.2px, transparent 1.5px) 0 0 / 22px 22px, var(--color-bg-chrome)' },
  { id: 'waves', name: 'Waves', kind: 'Pattern', dim: 0, bg: `${WAVES} 0 0 / 480px 120px, var(--color-bg-chrome)` },
  { id: 'paper', name: 'Paper', kind: 'Texture', dim: 0, bg: `${GRAIN(0.07)}, linear-gradient(180deg, #f6f1e7, #ede5d6)` },
];

export const byId = (id: string | null | undefined) => WALLPAPERS.find((w) => w.id === id) ?? null;

export interface WallpaperPref { wallpaper: string | null; wallpaperDim: number; wallpaperFile: string | null }
const PLAIN: WallpaperPref = { wallpaper: null, wallpaperDim: 0.2, wallpaperFile: null };

/** What the chat shows: the saved choice, or the picker's preview while it is open. `custom` may be a local picture. */
export interface Shown { wallpaper: string | null; dim: number; custom: string | null }

/** The CSS background for a wallpaper, or null for the plain one. */
export function backgroundOf(wallpaper: string | null, custom: string | null): string | null {
  if (wallpaper === 'custom') return custom ? `url("${custom}") center / cover no-repeat` : null;
  return byId(wallpaper)?.bg ?? null;
}

export const customUrl = (file: string | null) => (file ? `/api/prefs/wallpaper/${encodeURIComponent(file)}` : null);

const LS = 'chatWallpaper';
const cached = (): WallpaperPref => {
  try { const v = JSON.parse(lsGet(LS) ?? 'null'); return v && typeof v === 'object' ? { ...PLAIN, ...v } : PLAIN; } catch { return PLAIN; }
};

interface WallpaperState {
  pref: WallpaperPref;
  preview: Shown | null;
  pickerOpen: boolean;
  loaded: boolean;
  load(): Promise<void>;
  saved(p: Partial<WallpaperPref>): void;
  setPreview(s: Shown | null): void;
  openPicker(): void;
  closePicker(): void;
}

export const useWallpaper = create<WallpaperState>((set, get) => ({
  pref: cached(),
  preview: null,
  pickerOpen: false,
  loaded: false,
  async load() {
    try {
      const r = await fetch('/api/prefs', { credentials: 'include' });
      if (r.ok) get().saved(await r.json());
    } catch { /* keep the local copy */ }
    set({ loaded: true });
  },
  saved(p) {
    const pref = { wallpaper: p.wallpaper ?? null, wallpaperDim: typeof p.wallpaperDim === 'number' ? p.wallpaperDim : PLAIN.wallpaperDim, wallpaperFile: p.wallpaperFile ?? null };
    lsSet(LS, JSON.stringify(pref));
    set({ pref });
  },
  setPreview: (preview) => set({ preview }),
  openPicker: () => set({ pickerOpen: true }),
  closePicker: () => set({ pickerOpen: false, preview: null }),
}));

/** The wallpaper the chat should show right now. */
export function useShownWallpaper(): Shown {
  const pref = useWallpaper((s) => s.pref);
  const preview = useWallpaper((s) => s.preview);
  return preview ?? { wallpaper: pref.wallpaper, dim: pref.wallpaperDim, custom: customUrl(pref.wallpaperFile) };
}

// ---------- your own picture ----------

const MAX_SIDE = 2560;
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Checks and shrinks a picture before it is uploaded: at most 2560 px on its longest side, as WebP (JPEG where the
 * browser can't make WebP), under 5 MB. Throws an Error with a message fit to show.
 */
export async function preparePicture(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') throw new Error('Pick a picture file (JPEG, PNG, WebP, HEIC…).');
  if (file.size > 30 * 1024 * 1024) throw new Error('That picture is over 30 MB. Pick a smaller one.');
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('Couldn’t read that picture. Try a JPEG or PNG.'); }
  try {
    if (Math.min(bmp.width, bmp.height) < 300) throw new Error('That picture is too small to fill the chat (at least 300 px on each side).');
    for (const [side, quality] of [[MAX_SIDE, 0.86], [1920, 0.78], [1440, 0.7]] as const) {
      const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * k);
      canvas.height = Math.round(bmp.height * k);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('This browser can’t prepare pictures.');
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      let blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', quality));
      if (!blob || blob.type !== 'image/webp') blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality));
      if (blob && blob.size <= MAX_BYTES) return blob;
    }
    throw new Error('Couldn’t make that picture small enough. Try another one.');
  } finally { bmp.close(); }
}

async function answer(r: Response): Promise<WallpaperPref> {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `HeyZubi answered ${r.status}.`);
  return j;
}

export const wallpaperApi = {
  save: (p: { wallpaper?: string | null; wallpaperDim?: number }) =>
    fetch('/api/prefs', { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(answer),
  upload: (blob: Blob) =>
    fetch('/api/prefs/wallpaper', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob }).then(answer),
  remove: () => fetch('/api/prefs/wallpaper', { method: 'DELETE', credentials: 'include' }).then(answer),
};
