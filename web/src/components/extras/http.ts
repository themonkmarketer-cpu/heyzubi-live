/** Small JSON helpers for the extras (search, clients, workers, announcements, debates). Errors carry the server's message. */
export async function jsonFetch<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    signal,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  let j: any = null;
  try { j = await res.json(); } catch { /* not json */ }
  if (!res.ok || (j && typeof j.error === 'string' && j.error)) throw new Error((j && j.error) || res.statusText || `HTTP ${res.status}`);
  return j as T;
}

/** A local date-time stamp for file names: 20261126-153012. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
