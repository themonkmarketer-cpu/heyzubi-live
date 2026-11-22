import type { Context, MiddlewareHandler } from 'hono';
import crypto from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { env } from '../env.js';
import { db, now } from '../db.js';
import { token } from './ids.js';
import type { User } from '../types.js';

const COOKIE = 'heyzubi_live_session';
/** The cookie's names before the project was renamed (Bot HQ, Grokbot); still read so existing sign-ins keep working. */
const LEGACY_COOKIES = ['bothq_session', 'grokbot_session'];
const TTL_MS = 30 * 24 * 3600 * 1000;

export type AuthVars = { Variables: { user: User } };

/** `owner`: the session was made with the owner key (or a sign-in link made with it), see userFromToken. */
export function createSession(c: Context, userId: string, opts: { owner?: boolean } = {}) {
  const t = token();
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,owner) VALUES (?,?,?,?,?)').run(t, userId, now(), now() + TTL_MS, opts.owner ? 1 : 0);
  setCookie(c, COOKIE, t, { httpOnly: true, sameSite: 'Lax', secure: env.appUrl.startsWith('https:'), path: '/', maxAge: TTL_MS / 1000 });
}

export function destroySession(c: Context) {
  for (const name of [COOKIE, ...LEGACY_COOKIES]) {
    const t = getCookie(c, name);
    if (t) db.prepare('DELETE FROM auth_sessions WHERE token=?').run(t);
    if (t !== undefined) deleteCookie(c, name, { path: '/' });
  }
}

/**
 * The user a session token stands for. On a public URL the allowlist is asked on every request, not
 * only at sign-in: an account made while the instance was open, or since taken off ALLOWED_EMAILS,
 * is signed out even though its cookie is still good. A session made with the owner key is kept:
 * whoever runs the server let that browser in on purpose, whatever the list says.
 */
export function userFromToken(t: string | undefined): User | null {
  if (!t) return null;
  const r = db
    .prepare('SELECT u.*, s.owner AS session_owner FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?')
    .get(t, now()) as any;
  if (!r) return null;
  if (!env.localOnly && !r.session_owner && !env.allowedEmails.includes(String(r.email).toLowerCase())) return null;
  return { id: r.id, email: r.email, name: r.name, avatarUrl: r.avatar_url };
}

export function userFromCookieHeader(cookieHeader: string | undefined): User | null {
  const parts = cookieHeader?.split(/;\s*/) ?? [];
  for (const name of [COOKIE, ...LEGACY_COOKIES]) {
    const m = parts.find((p) => p.startsWith(`${name}=`));
    const u = m ? userFromToken(decodeURIComponent(m.slice(name.length + 1))) : null;
    if (u) return u;
  }
  return null;
}

export const requireUser: MiddlewareHandler<AuthVars> = async (c, next) => {
  let u: User | null = null;
  for (const name of [COOKIE, ...LEGACY_COOKIES]) { u = userFromToken(getCookie(c, name)); if (u) break; }
  if (!u) return c.json({ error: 'unauthenticated' }, 401);
  c.set('user', u);
  await next();
};

const originOf = (u: string) => { try { return new URL(u).origin; } catch { return null; } };
/** Origins the web app is served from: APP_URL, and SERVER_URL when the server serves the built app itself. */
const appOrigins = new Set([originOf(env.appUrl), originOf(env.serverUrl)].filter((o): o is string => !!o));

/**
 * Whether a request may act with the user's cookie. Browsers say where a request comes from
 * (Sec-Fetch-Site, Origin); anything from another site is refused, so a page elsewhere (including
 * another app under the same parent domain) cannot post to the API or open the screen socket as
 * the signed-in user. Requests without those headers come from scripts, not browsers, and carry no
 * ambient cookie.
 */
export function isSameOriginRequest(origin: string | undefined, fetchSite: string | undefined): boolean {
  if (fetchSite) return fetchSite === 'same-origin' || fetchSite === 'none';
  if (origin) return appOrigins.has(origin);
  return true;
}

/** Refuses cross-site requests that could change something (anything but GET/HEAD/OPTIONS). */
export const sameOriginWrites: MiddlewareHandler = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !isSameOriginRequest(c.req.header('origin'), c.req.header('sec-fetch-site'))) {
    return c.json({ error: 'cross-site request refused' }, 403);
  }
  await next();
};

/** A socket peer on this machine (127.0.0.0/8, ::1, or an IPv4-mapped loopback). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

/** The socket peer of a request, with an IPv4-mapped address in its plain form. */
export function peerAddress(c: Context): string {
  return (getConnInfo(c).remote.address ?? 'unknown').replace(/^::ffff:/i, '');
}

/**
 * A small in-memory limit on how often something may happen per key, here per socket peer address:
 * at most `max` times in any `windowMs`. It lives in this process (a restart forgets it) and holds
 * a few timestamps per address.
 *
 * The peer address is used, never a forwarding header, which the caller could write. So behind a
 * proxy that connects from one address (a public URL forwarder) all visitors share one count and
 * the limit is a limit for everyone together: it still caps what abuse can cost, at the price that
 * a flood from one visitor can use up the allowance of the others until the window has passed.
 */
export function rateLimit(max: number, windowMs: number) {
  const seen = new Map<string, number[]>();
  const recent = (key: string) => (seen.get(key) ?? []).filter((t) => t > now() - windowMs);
  return {
    /** Whether `key` has used up its allowance (nothing is counted). */
    full: (key: string) => recent(key).length >= max,
    /** Count one more for `key`. */
    count(key: string) {
      // Addresses that have gone quiet are dropped now and then, so the map cannot grow without end.
      if (seen.size > 5000) for (const k of seen.keys()) if (!recent(k).length) seen.delete(k);
      seen.set(key, [...recent(key), now()]);
    },
    /** Seconds until `key` may try again (for Retry-After). */
    retryAfter: (key: string) => Math.max(1, Math.ceil(((recent(key)[0] ?? now()) + windowMs - now()) / 1000)),
  };
}

/** Headers a proxy adds when it passes a request on. A program calling from this machine sends none of them. */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'via'];

/**
 * Whether a request was made on this machine and not passed on from elsewhere: the socket peer is a
 * loopback address and no forwarding header is present. For the endpoints only local programs use
 * (owner sign-in, the agents' /mcp). The headers matter because a proxy on this machine (a public
 * URL forwarder, a tunnel) connects from loopback as well. One that adds none of these headers
 * cannot be told from a local caller, which is why those endpoints still ask for their key. Sending
 * such a header oneself only gets a caller refused, never let in.
 */
export function isLocalRequest(c: Context): boolean {
  if (FORWARDING_HEADERS.some((h) => c.req.header(h) !== undefined)) return false;
  return isLoopbackAddress(peerAddress(c));
}

/**
 * Key for signing in from the machine the server runs on (POST /api/auth/owner). It is derived from
 * SESSION_SECRET, so only someone who can read the server's .env can make it:
 *   printf 'owner-login' | openssl dgst -sha256 -hmac "$SESSION_SECRET" -r | cut -d' ' -f1
 */
export function isOwnerKey(given: string): boolean {
  const want = crypto.createHmac('sha256', env.sessionSecret).update('owner-login').digest();
  const got = Buffer.from(given, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
