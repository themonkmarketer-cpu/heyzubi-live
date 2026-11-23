import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { env } from './env.js';
import type { AuthVars } from './lib/auth.js';
import { hub } from './lib/hub.js';
import type { PanelName } from './types.js';

/**
 * Zubi Live's Gmail and Calendar panels: the latest emails and today's events, read live through Zubi's own Composio
 * connection (the one her Gmail and Calendar tools use, and the one Zubi HQ's panels read): Hermes keeps its sign-in
 * token in ~/.hermes/mcp-tokens/composio.json and renews it whenever Zubi uses an app. The token is read on the
 * server only, never shown or copied. Both Google accounts' calendars are merged; Gmail uses the default account.
 * The web shows a panel only while (and shortly after) Zubi uses that capability. Nothing is stored.
 */
export const panelsApi = new Hono<AuthVars>();

/**
 * Asking about the calendar or the inbox opens that window at once, like asking for WhatsApp opens WhatsApp:
 * checked on the owner's own words (a chat message, a voice message, or a request handed off from a live call).
 */
const ASKS: [PanelName, RegExp][] = [
  ['calendar', /\b(calendar|schedule|agenda|meetings?|appointments?|events? (today|tomorrow|this week)|my day)\b/i],
  ['gmail', /\b(inbox|e-?mails?|gmail|mails?|unread)\b/i],
  ['youtube', /\byou ?tube\b/i],
  ['instagram', /\b(instagram|insta)\b/i],
  ['linkedin', /\blinked ?in\b/i],
  ['sheets', /\b(google ?sheets?|g ?sheets?|spreadsheets?)\b/i],
];
export function openPanelsFor(userId: string, words: string) {
  const t = String(words ?? '');
  for (const [panel, re] of ASKS) if (re.test(t)) hub.emit(userId, { type: 'panel', panel, open: true });
}

export const PANEL_NAMES: Record<PanelName, string> = { gmail: 'Gmail', calendar: 'Calendar', youtube: 'YouTube', instagram: 'Instagram', linkedin: 'LinkedIn', sheets: 'Google Sheets' };
/** The window a tool argument names (Calendar when it names none we know). */
export const panelArg = (v: unknown): PanelName => (typeof v === 'string' && v in PANEL_NAMES ? (v as PanelName) : 'calendar');

/** Open or close a Calendar / Gmail / YouTube / Instagram / LinkedIn / Sheets window in the owner's app (a team member's tool, or a voice call). */
export function showPanel(userId: string, panel: PanelName, open = true): { output: string; summary: string } {
  hub.emit(userId, { type: 'panel', panel, open });
  const name = PANEL_NAMES[panel];
  return open
    ? { output: `The ${name} window is open in the app${hub.isOnline(userId) ? '' : ' (it shows when the owner opens the app)'}. Still answer the question in words.`, summary: `Opened the ${name} window` }
    : { output: `The ${name} window is closed.`, summary: `Closed the ${name} window` };
}

const COMPOSIO_URL = process.env.HQ_ZUBI_COMPOSIO_URL ?? 'https://connect.composio.dev/mcp';
const TOKEN = path.join(env.hermesHome, 'mcp-tokens', 'composio.json');

class TokenExpired extends Error {}

/** One tool call on Zubi's Composio MCP (JSON-RPC over HTTP, answered as an event stream). */
async function zubiComposio(name: string, args: Record<string, unknown>): Promise<any> {
  let tok: { access_token?: string; expires_at?: number };
  try { tok = JSON.parse(fs.readFileSync(TOKEN, 'utf8')); } catch { throw new Error('Zubi’s Composio connection was not found on hermes-box.'); }
  if (!tok.access_token || Number(tok.expires_at ?? 0) < Date.now() / 1000 + 20) throw new TokenExpired();
  const r = await fetch(COMPOSIO_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(25_000),
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (r.status === 401 || r.status === 403) throw new TokenExpired();
  const text = await r.text();
  for (const ln of text.split('\n')) {
    if (!ln.startsWith('data:')) continue;
    const res = JSON.parse(ln.slice(5)).result ?? {};
    return JSON.parse(res.content?.[0]?.text ?? '{}');
  }
  try { const j = JSON.parse(text); return JSON.parse(j.result?.content?.[0]?.text ?? '{}'); } catch { /* not JSON */ }
  throw new Error('No answer from Composio.');
}

/** A read-only app action through Zubi's Composio, on one connected account (as Zubi HQ's _wtool). */
async function wtool(slug: string, args: Record<string, unknown>, account?: string): Promise<any> {
  const item: Record<string, unknown> = { tool_slug: slug, arguments: args };
  if (account) item.account = account;
  const r = await zubiComposio('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [item], sync_response_to_workbench: false, thought: 'Read-only data for the HeyZubi Gmail and Calendar panels.' });
  const res = r?.data?.results?.[0]?.response ?? {};
  if (res.successful === false) throw new Error(String(res.error ?? 'tool failed').slice(0, 160));
  return res.data ?? {};
}

export interface GoogleAccount { toolkit: 'gmail' | 'googlecalendar' | 'instagram' | 'linkedin' | 'googlesheets'; id: string; status: string; isDefault: boolean; label: string }
let acctCache: { at: number; list: GoogleAccount[] } | null = null;
/** Zubi's connected accounts for the windows (Gmail, Calendar, Instagram, LinkedIn and Sheets), read-only. */
async function zubiAccounts(fresh = false): Promise<GoogleAccount[]> {
  if (!fresh && acctCache && Date.now() - acctCache.at < 5 * 60_000) return acctCache.list;
  const r = await zubiComposio('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: [{ name: 'gmail', action: 'list' }, { name: 'googlecalendar', action: 'list' }, { name: 'instagram', action: 'list' }, { name: 'linkedin', action: 'list' }, { name: 'googlesheets', action: 'list' }] });
  const list: GoogleAccount[] = [];
  for (const [tk, v] of Object.entries<any>(r?.data?.results ?? {})) {
    for (const a of v?.accounts ?? []) {
      const ui = a.user_info ?? {};
      list.push({ toolkit: tk as GoogleAccount['toolkit'], id: String(a.id), status: String(a.status ?? ''), isDefault: !!a.is_default, label: String(ui.email ?? ui.username ?? ui.summary ?? '').slice(0, 80) });
    }
  }
  acctCache = { at: Date.now(), list };
  return list;
}
/** Zubi's connected Google accounts (Gmail and Calendar), read-only. */
export async function zubiGoogleAccounts(fresh = false): Promise<GoogleAccount[]> {
  return (await zubiAccounts(fresh)).filter((a) => a.toolkit === 'gmail' || a.toolkit === 'googlecalendar');
}
const active = (l: GoogleAccount[], tk: GoogleAccount['toolkit']) => l.filter((a) => a.toolkit === tk && /^active$/i.test(a.status));

const cache = new Map<string, { at: number; body: unknown }>();
const TTL = 45_000;
async function cached<T>(key: string, fresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.body as T;
  const body = await load();
  cache.set(key, { at: Date.now(), body });
  return body;
}
const why = (e: unknown) => (e instanceof TokenExpired
  ? 'Zubi’s Google sign-in is renewing. It refreshes the next time Zubi uses an app; try ↻ in a moment.'
  : `Couldn’t read it just now (${String((e as Error)?.message ?? e).slice(0, 100)}).`);

const str = (v: unknown) => (v == null ? '' : String(v));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
/** "Name <a@b.com>" → "Name". */
const who = (s: string) => s.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || s;

panelsApi.get('/gmail', async (c) => {
  const fresh = c.req.query('fresh') === '1';
  try {
    const body = await cached('gmail', fresh, async () => {
      const accts = active(await zubiGoogleAccounts(fresh), 'gmail');
      if (!accts.length) return { connected: false, emails: [] };
      const a = accts.find((x) => x.isDefault) ?? accts[0];
      const d = await wtool('GMAIL_FETCH_EMAILS', { query: 'in:inbox', max_results: 5, verbose: false, include_payload: false }, a.id);
      const seen = new Set<string>();
      const emails = (d.messages ?? []).filter((m: any) => !seen.has(m.messageId) && seen.add(m.messageId)).slice(0, 5).map((m: any) => {
        const pv = m.preview;
        return {
          id: str(m.messageId),
          from: clip(who(str(m.sender)), 60),
          subject: clip(unescape(str(m.subject) || '(no subject)'), 120),
          snippet: clip(unescape(str((typeof pv === 'object' ? pv?.body : pv) ?? m.messageText)).replace(/\s+/g, ' ').trim(), 160),
          at: Date.parse(str(m.messageTimestamp)) || 0,
          unread: Array.isArray(m.labelIds) ? m.labelIds.includes('UNREAD') : undefined,
        };
      });
      return { connected: true, account: a.label, accounts: accts.map((x) => x.label), emails };
    });
    return c.json(body);
  } catch (e) {
    console.warn('[panels] gmail failed:', (e as Error)?.message ?? e);
    return c.json({ connected: true, emails: [], error: why(e) }, 502);
  }
});

panelsApi.get('/calendar', async (c) => {
  const fresh = c.req.query('fresh') === '1';
  try {
    const body = await cached('cal', fresh, async () => {
      const accts = active(await zubiGoogleAccounts(fresh), 'googlecalendar');
      if (!accts.length) return { connected: false, events: [] };
      // Today in the server's time zone (the app runs on Asia/Kolkata).
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(start); end.setDate(end.getDate() + 1);
      const per = await Promise.allSettled(accts.map((a) => wtool('GOOGLECALENDAR_EVENTS_LIST', {
        calendarId: 'primary', timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 50,
      }, a.id).then((d) => ({ a, items: (d.items ?? d.events ?? []) as any[] }))));
      // An event on both calendars (same iCalUID and start) is shown once, as Zubi HQ does.
      const seen = new Map<string, any>();
      for (const p of per) {
        if (p.status !== 'fulfilled') continue;
        for (const e of p.value.items) {
          const startAt = str(e.start?.dateTime ?? e.start?.date);
          const key = `${str(e.iCalUID || e.id)}|${startAt}`;
          if (seen.has(key)) continue;
          seen.set(key, {
            id: key,
            title: clip(str(e.summary) || '(no title)', 100),
            start: startAt,
            end: str(e.end?.dateTime ?? e.end?.date),
            allDay: !e.start?.dateTime,
            where: clip(str(e.location), 80),
            link: /^https:\/\/(www\.)?google\.com\/calendar\//.test(str(e.htmlLink)) ? str(e.htmlLink) : '',
            account: p.value.a.label,
          });
        }
      }
      const failed = per.filter((p) => p.status === 'rejected').length;
      const events = [...seen.values()].sort((x, y) => Date.parse(x.start) - Date.parse(y.start)).slice(0, 20);
      return { connected: true, accounts: accts.map((a) => a.label), events, ...(failed ? { note: `${failed} of ${accts.length} calendars didn’t answer.` } : {}) };
    });
    return c.json(body);
  } catch (e) {
    console.warn('[panels] calendar failed:', (e as Error)?.message ?? e);
    return c.json({ connected: true, events: [], error: why(e) }, 502);
  }
});

/** Only Instagram's own picture and post links are passed on to the page. */
const IG_IMG = /^https:\/\/[a-z0-9.-]+\.(cdninstagram\.com|fbcdn\.net)\//i;
const IG_LINK = /^https:\/\/www\.instagram\.com\//i;

panelsApi.get('/instagram', async (c) => {
  const fresh = c.req.query('fresh') === '1';
  try {
    const body = await cached('ig', fresh, async () => {
      const accts = active(await zubiAccounts(fresh), 'instagram');
      if (!accts.length) return { connected: false, posts: [] };
      const a = accts.find((x) => x.isDefault) ?? accts[0];
      const [p, m] = await Promise.all([
        wtool('INSTAGRAM_GET_USER_INFO', { ig_user_id: 'me', fields: 'username,name,followers_count,media_count,profile_picture_url' }, a.id),
        wtool('INSTAGRAM_GET_IG_USER_MEDIA', { ig_user_id: 'me', limit: 6, fields: 'id,caption,media_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count' }, a.id),
      ]);
      const pic = str(p.profile_picture_url);
      const posts = ((m.data ?? []) as any[]).slice(0, 6).map((x) => {
        const thumb = str(x.media_type === 'VIDEO' ? x.thumbnail_url : x.media_url || x.thumbnail_url);
        return {
          id: str(x.id),
          caption: clip(str(x.caption).replace(/\s+/g, ' ').trim(), 110),
          type: str(x.media_type),
          link: IG_LINK.test(str(x.permalink)) ? str(x.permalink) : '',
          thumb: IG_IMG.test(thumb) ? thumb : '',
          at: Date.parse(str(x.timestamp)) || 0,
          likes: Number(x.like_count ?? 0) || 0,
          comments: Number(x.comments_count ?? 0) || 0,
        };
      });
      return {
        connected: true,
        profile: {
          username: clip(str(p.username) || a.label, 40),
          name: clip(str(p.name), 60),
          followers: Number(p.followers_count ?? 0) || 0,
          posts: Number(p.media_count ?? 0) || 0,
          picture: IG_IMG.test(pic) ? pic : '',
        },
        posts,
      };
    });
    return c.json(body);
  } catch (e) {
    console.warn('[panels] instagram failed:', (e as Error)?.message ?? e);
    return c.json({ connected: true, posts: [], error: why(e) }, 502);
  }
});

/**
 * The owner's YouTube channel (HQ_YOUTUBE_CHANNEL in hq.env, a UC… channel id): its latest public videos, from
 * YouTube's own public feed (no sign-in, no API key). Private and unlisted videos never appear in it.
 */
panelsApi.get('/youtube', async (c) => {
  const fresh = c.req.query('fresh') === '1';
  const channel = String(process.env.HQ_YOUTUBE_CHANNEL ?? '').trim();
  if (!/^UC[\w-]{22}$/.test(channel)) return c.json({ configured: false, videos: [] });
  try {
    const body = await cached('yt', fresh, async () => {
      const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`YouTube answered ${r.status}`);
      const xml = await r.text();
      const tag = (s: string, t: string) => unescape(s.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`))?.[1] ?? '');
      const name = tag(xml.split('<entry>')[0], 'title');
      const videos = xml.split('<entry>').slice(1, 7).map((e) => {
        const id = tag(e, 'yt:videoId');
        return {
          id,
          title: clip(tag(e, 'title'), 110),
          at: Date.parse(tag(e, 'published')) || 0,
          views: Number(e.match(/<media:statistics views="(\d+)"/)?.[1] ?? 0) || 0,
          thumb: /^[\w-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '',
          link: /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : '',
        };
      }).filter((v) => v.link);
      return { configured: true, channel: clip(name, 80), studio: `https://studio.youtube.com/channel/${channel}`, videos };
    });
    return c.json(body);
  } catch (e) {
    console.warn('[panels] youtube failed:', (e as Error)?.message ?? e);
    return c.json({ configured: true, videos: [], error: why(e) }, 502);
  }
});

/**
 * The owner's LinkedIn profile (name, headline, photo). LinkedIn's API lets apps read only the member's own profile,
 * not their posts or feed, so that is all the window shows; Zubi can still write and publish a post after a yes.
 */
const LI_IMG = /^https:\/\/media\.licdn\.com\//i;
const LI_LINK = /^https:\/\/www\.linkedin\.com\/in\/[\w%-]+\/?$/i;
panelsApi.get('/linkedin', async (c) => {
  const fresh = c.req.query('fresh') === '1';
  try {
    const body = await cached('li', fresh, async () => {
      const accts = active(await zubiAccounts(fresh), 'linkedin');
      if (!accts.length) return { connected: false };
      const a = accts.find((x) => x.isDefault) ?? accts[0];
      const d = await wtool('LINKEDIN_GET_MY_INFO', {}, a.id);
      const pic = str(d.profilePicture?.displayImage);
      const url = str(d.profileUrl) || (d.vanityName ? `https://www.linkedin.com/in/${encodeURIComponent(str(d.vanityName))}/` : '');
      return {
        connected: true,
        profile: {
          name: clip(`${str(d.localizedFirstName)} ${str(d.localizedLastName)}`.trim(), 80),
          headline: clip(str(d.localizedHeadline), 220),
          picture: LI_IMG.test(pic) ? pic : '',
          url: LI_LINK.test(url) ? url : '',
        },
      };
    });
    return c.json(body);
  } catch (e) {
    console.warn('[panels] linkedin failed:', (e as Error)?.message ?? e);
    return c.json({ connected: true, error: why(e) }, 502);
  }
});

/** The owner's most recently changed Google Sheets (names and links only; no cell data is read). */
panelsApi.get('/sheets', async (c) => {
  const fresh = c.req.query('fresh') === '1';
  try {
    const body = await cached('gs', fresh, async () => {
      const accts = active(await zubiAccounts(fresh), 'googlesheets');
      if (!accts.length) return { connected: false, sheets: [] };
      const a = accts.find((x) => x.isDefault) ?? accts[0];
      const d = await wtool('GOOGLESHEETS_SEARCH_SPREADSHEETS', { max_results: 6, order_by: 'modifiedTime desc' }, a.id);
      const sheets = ((d.spreadsheets ?? []) as any[]).slice(0, 6).map((x) => {
        const id = str(x.id);
        return {
          id,
          name: clip(str(x.name) || '(untitled)', 100),
          at: Date.parse(str(x.modifiedTime)) || 0,
          by: clip(str(x.lastModifyingUser?.me ? 'you' : x.lastModifyingUser?.displayName), 40),
          link: /^[\w-]{20,}$/.test(id) ? `https://docs.google.com/spreadsheets/d/${id}/edit` : '',
        };
      }).filter((x) => x.link);
      return { connected: true, account: a.label, sheets };
    });
    return c.json(body);
  } catch (e) {
    console.warn('[panels] sheets failed:', (e as Error)?.message ?? e);
    return c.json({ connected: true, sheets: [], error: why(e) }, 502);
  }
});
