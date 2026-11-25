// Opening a Library file in the browser (the Library's Open button and the chat's file card). A bot wrote the file, so
// it is treated as untrusted: a web page is shown in a sandbox with no scripts, no forms and nothing loaded from
// outside, as an origin of its own, so it can't read HeyZubi's cookies or call its API, or send anything anywhere by
// being opened. The full page, scripts and all, is the download.
import path from 'node:path';

const IMAGES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const TEXT = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'log', 'xml', 'yaml', 'yml', 'css', 'js', 'mjs', 'ts', 'tsx', 'py', 'sh', 'sql', 'toml', 'ini', 'srt', 'vtt']);

const SEALED = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
/** Links may open in a new tab (as ordinary pages); nothing else is allowed. */
const SANDBOX = 'sandbox allow-popups allow-popups-to-escape-sandbox';

/** How a file is shown, or null when it can only be downloaded. */
export function openAs(name: string): { type: string; csp: string } | null {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (ext === 'html' || ext === 'htm') return { type: 'text/html; charset=utf-8', csp: `${SANDBOX}; ${SEALED}` };
  if (ext === 'svg') return { type: 'image/svg+xml', csp: `${SANDBOX}; ${SEALED}` };
  if (IMAGES[ext]) return { type: IMAGES[ext], csp: `${SANDBOX}; ${SEALED}` };
  // The browser's own PDF viewer doesn't run inside a sandbox; a PDF's content can't reach the site anyway.
  if (ext === 'pdf') return { type: 'application/pdf', csp: "frame-ancestors 'self'" };
  if (TEXT.has(ext)) return { type: 'text/plain; charset=utf-8', csp: `${SANDBOX}; ${SEALED}` };
  return null;
}

/** The response headers for showing it (the caller has already checked whose file it is). */
export const openHeaders = (name: string, as: { type: string; csp: string }, size: number): Record<string, string> => ({
  'content-type': as.type,
  'content-length': String(size),
  'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
  'content-security-policy': as.csp,
  'x-frame-options': 'SAMEORIGIN', // HeyZubi's own panel (Windows app) shows it; no other site may
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'private, no-store',
});
