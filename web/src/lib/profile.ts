import { useStore } from '../store';

/**
 * Your profile (Settings › Account): the photo in the sidebar's account row and the name shown there. The photo is
 * shrunk in the browser and kept on the server (/api/prefs/photo); the display name is a label only (prefs), the
 * account's own name, which the bots use, stays as it is.
 */

/** A picture shrunk and cropped to a 256 px square JPEG in the browser. */
async function squarePhoto(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  canvas.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Couldn’t read that picture.'))), 'image/jpeg', 0.9));
}

const patchUser = (p: { avatarUrl?: string | null; displayName?: string | null }) => {
  const u = useStore.getState().user;
  if (u) useStore.getState().set({ user: { ...u, ...p } });
};

/** Saves a new photo; throws with a message to show. */
export async function uploadPhoto(file: File): Promise<void> {
  const res = await fetch('/api/prefs/photo', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'image/jpeg' }, body: await squarePhoto(file) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'The photo wasn’t saved.');
  patchUser({ avatarUrl: j.avatarUrl });
}

export async function removePhoto(): Promise<void> {
  const res = await fetch('/api/prefs/photo', { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw new Error('The photo wasn’t removed.');
  patchUser({ avatarUrl: null });
}

/** Saves the name shown in the sidebar ('' goes back to your account's name). */
export async function saveDisplayName(name: string): Promise<void> {
  const res = await fetch('/api/prefs', { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name }) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) throw new Error(j?.error || 'The name wasn’t saved.');
  patchUser({ displayName: j.displayName ?? null });
}
