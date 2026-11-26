/** Small JSON helpers for the Extras panels (pins, skill reviews, access map, recently deleted, share links). */

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error('Couldn’t reach HeyZubi. Try again.'); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && typeof j.error === 'string' && j.error) || `Something went wrong (${r.status}).`);
  return j as T;
}

export const jget = <T,>(url: string) => call<T>('GET', url);
export const jpost = <T,>(url: string, body: unknown = {}) => call<T>('POST', url, body);
export const jpatch = <T,>(url: string, body: unknown) => call<T>('PATCH', url, body);
export const jdel = <T,>(url: string) => call<T>('DELETE', url);

/** "in 3 days", "in 5 hours", "in 20 minutes" for a time still ahead. */
export function inTime(ts: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((ts - now) / 60000));
  if (m < 60) return `in ${m || 1} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `in ${d} days`;
}

/** Days left (at least 0), rounded up. */
export const daysLeft = (ts: number, now = Date.now()) => Math.max(0, Math.ceil((ts - now) / 86_400_000));
