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
  ['facebook', /\b(facebook|fb)\b/i],
  ['linkedin', /\blinked ?in\b/i],
  ['sheets', /\b(google ?sheets?|g ?sheets?|spreadsheets?)\b/i],
];
export function openPanelsFor(userId: string, words: string) {
  const t = String(words ?? '');
  for (const [panel, re] of ASKS) if (re.test(t)) hub.emit(userId, { type: 'panel', panel, open: true });
}

export const PANEL_NAMES: Record<PanelName, string> = { gmail: 'Gmail', calendar: 'Calendar', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', sheets: 'Google Sheets' };
/** The window a tool argument names (Calendar when it names none we know). */
export const panelArg = (v: unknown): PanelName => (typeof v === 'string' && v in PANEL_NAMES ? (v as PanelName) : 'calendar');

/** Open or close a Calendar / Gmail / YouTube / Instagram / Facebook / LinkedIn / Sheets window in the owner's app (a team member's tool, or a voice call). */
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

/**
 * A list through Zubi's Composio. When the answer is too big, Composio hands back an empty one marked successful, which
 * must not read as "nothing there": it is asked again for fewer, and an error if even a few are too many.
 */
async function wlist(slug: string, args: Record<string, unknown> & { limit: number }, account?: string): Promise<{ data: any[]; paging?: any }> {
  for (const limit of [...new Set([args.limit, 12, 6])].filter((n) => n <= args.limit)) {
    const d = await wtool(slug, { ...args, limit }, account);
    if (Array.isArray(d.data)) return d;
  }
  throw new Error('the answer was too big');
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
  ? 'Zubi’s app sign-in is renewing. It refreshes the next time Zubi uses an app; try ↻ in a moment.'
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

/** One post or video in the Instagram, YouTube and Facebook windows. Counts are null when the app doesn't give them. */
interface SocialPost {
  id: string; title: string; kind: 'video' | 'picture' | 'album' | 'text';
  link: string; thumb: string; at: number;
  views: number | null; likes: number | null; comments: number | null; shares: number | null;
}
const count = (v: unknown): number | null => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const oneLine = (v: unknown, n: number) => clip(str(v).replace(/\s+/g, ' ').trim(), n);

/** Only Instagram's and Facebook's own picture and post links are passed on to the page. */
const IG_IMG = /^https:\/\/[a-z0-9.-]+\.(cdninstagram\.com|fbcdn\.net)\//i;
const IG_LINK = /^https:\/\/www\.instagram\.com\//i;
const FB_IMG = /^https:\/\/[a-z0-9.-]+\.(fbcdn\.net|fbsbx\.com)\//i;
const FB_LINK = /^https:\/\/(www\.|m\.)?facebook\.com\//i;

panelsApi.get('/instagram', async (c) => {
  const fresh = c.req.query('fresh') === '1';
  try {
    const body = await cached('ig', fresh, async () => {
      const accts = active(await zubiAccounts(fresh), 'instagram');
      if (!accts.length) return { connected: false, posts: [] };
      const a = accts.find((x) => x.isDefault) ?? accts[0];
      const base = 'id,caption,media_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count';
      const media = (fields: string) => wlist('INSTAGRAM_GET_IG_USER_MEDIA', { ig_user_id: 'me', limit: 24, fields }, a.id);
      const [p, m] = await Promise.all([
        wtool('INSTAGRAM_GET_USER_INFO', { ig_user_id: 'me', fields: 'username,name,followers_count,media_count,profile_picture_url' }, a.id),
        // Views and shares come as insights; an account whose insights can't be read still gets its posts.
        media(`${base},insights.metric(views,shares)`).catch(() => media(`${base},insights.metric(views)`)).catch(() => media(base)),
      ]);
      const pic = str(p.profile_picture_url);
      const posts: SocialPost[] = ((m.data ?? []) as any[]).slice(0, 24).map((x) => {
        const thumb = str(x.media_type === 'VIDEO' ? x.thumbnail_url : x.media_url || x.thumbnail_url);
        const insight = (n: string) => count(((x.insights?.data ?? []) as any[]).find((i) => i?.name === n)?.values?.[0]?.value);
        return {
          id: str(x.id),
          title: oneLine(x.caption, 140),
          kind: x.media_type === 'VIDEO' ? 'video' : x.media_type === 'CAROUSEL_ALBUM' ? 'album' : 'picture',
          link: IG_LINK.test(str(x.permalink)) ? str(x.permalink) : '',
          thumb: IG_IMG.test(thumb) ? thumb : '',
          at: Date.parse(str(x.timestamp)) || 0,
          views: insight('views'), likes: count(x.like_count), comments: count(x.comments_count), shares: insight('shares'),
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

const socialAccts = new Map<string, { at: number; id: string | null }>();
/** Zubi's connected Facebook or YouTube account, looked up only for its window (and kept for 5 minutes). */
async function socialAccount(toolkit: 'facebook' | 'youtube', fresh = false): Promise<string | null> {
  const hit = socialAccts.get(toolkit);
  if (hit && (hit.id || !fresh) && Date.now() - hit.at < 5 * 60_000) return hit.id;
  const r = await zubiComposio('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: [{ name: toolkit, action: 'list' }] });
  const l = ((r?.data?.results?.[toolkit]?.accounts ?? []) as any[]).filter((x) => /^active$/i.test(str(x.status)));
  const a = l.find((x) => x.is_default) ?? l[0];
  const id = a ? str(a.id) : null;
  socialAccts.set(toolkit, { at: Date.now(), id });
  return id;
}

/**
 * Adds the likes, comments and shares the public feed doesn't have, through Zubi's connected YouTube account (the feed
 * alone still works without it). Shares come from YouTube Analytics, which is a day or two behind: a video it doesn't
 * list yet keeps null, not 0.
 */
async function youtubeCounts(videos: SocialPost[]): Promise<void> {
  const ids = videos.map((v) => v.id);
  if (!ids.length) return;
  const acct = await socialAccount('youtube');
  if (!acct) return;
  const [s, a] = await Promise.allSettled([
    wtool('YOUTUBE_GET_VIDEO_DETAILS_BATCH', { id: ids, parts: ['statistics'] }, acct),
    wtool('YOUTUBE_QUERY_ANALYTICS', { ids: 'channel==MINE', startDate: '2015-01-01', endDate: new Date().toISOString().slice(0, 10), metrics: 'shares', dimensions: 'video', filters: `video==${ids.join(',')}` }, acct),
  ]);
  const stats = new Map<string, any>(s.status === 'fulfilled' ? ((s.value.items ?? []) as any[]).map((x) => [str(x.id), x.statistics ?? {}]) : []);
  const shares = new Map<string, unknown>(a.status === 'fulfilled' ? ((a.value.rows ?? []) as any[]).map((r) => [str(r?.[0]), r?.[1]]) : []);
  for (const v of videos) {
    const x = stats.get(v.id);
    if (x) { v.views = count(x.viewCount) ?? v.views; v.likes = count(x.likeCount) ?? v.likes; v.comments = count(x.commentCount); }
    v.shares = count(shares.get(v.id));
  }
}

/** The Pages the owner manages (names and links only: page access tokens are never asked for), kept for 10 minutes. */
let fbPages: { at: number; acct: string; list: any[] } | null = null;
async function facebookPages(acct: string, fresh: boolean): Promise<any[]> {
  if (!fresh && fbPages?.acct === acct && Date.now() - fbPages.at < 10 * 60_000) return fbPages.list;
  const list: any[] = [];
  for (let after = '', n = 0; n < 4; n++) {
    // Fields by name: the tool's default ones include each Page's access token.
    const d = await wlist('FACEBOOK_LIST_MANAGED_PAGES', { user_id: 'me', limit: 50, fields: 'id,name,username,link,followers_count', ...(after ? { after } : {}) }, acct);
    list.push(...d.data.filter((x) => /^\d+$/.test(str(x?.id))));
    after = d.paging?.next ? str(d.paging?.cursors?.after) : '';
    if (!after) break;
  }
  fbPages = { at: Date.now(), acct, list };
  return list;
}

/** A Facebook Page's latest reels and posts: the Page asked for, else the one with the same handle as the Instagram account. */
panelsApi.get('/facebook', async (c) => {
  const fresh = c.req.query('fresh') === '1';
  try {
    const want = /^\d{1,25}$/.test(c.req.query('page') ?? '') ? c.req.query('page')! : '';
    const body = await cached(`fb:${want}`, fresh, async () => {
      const acct = await socialAccount('facebook', fresh);
      if (!acct) return { connected: false, posts: [] };
      const pages = await facebookPages(acct, false);
      const ig = active(await zubiAccounts().catch(() => []), 'instagram').find((x) => x.label)?.label.toLowerCase();
      // Only a Page on the owner's own list is ever read.
      const page = pages.find((x) => str(x.id) === want) ?? pages.find((x) => ig && str(x.username).toLowerCase() === ig) ?? pages[0];
      if (!page) return { connected: true, posts: [], note: 'This Facebook account manages no Page, and Facebook only lets apps read Pages.' };
      const id = str(page.id);
      const link = (v: unknown) => { const u = str(v).startsWith('/') ? `https://www.facebook.com${str(v)}` : str(v); return FB_LINK.test(u) ? u : ''; };
      const img = (v: unknown) => (FB_IMG.test(str(v)) ? str(v) : '');
      const reelFields = 'id,description,permalink_url,created_time,picture';
      const postFields = 'id,message,permalink_url,created_time,full_picture';
      const reels = (fields: string) => wlist('FACEBOOK_LIST_PAGE_REELS', { page_id: id, limit: 24, fields }, acct);
      const posts = (fields: string) => wlist('FACEBOOK_LIST_PUBLISHED_PAGE_POSTS', { page_id: id, limit: 24, fields }, acct);
      const [r, p] = await Promise.allSettled([
        reels(`${reelFields},views,likes.limit(0).summary(true),comments.limit(0).summary(true)`).catch(() => reels(`${reelFields},views`)).catch(() => reels(reelFields)),
        // Facebook leaves `shares` out when there are none, so it only means 0 when it was asked for.
        posts(`${postFields},shares,reactions.limit(0).summary(true),comments.limit(0).summary(true)`).then((d) => ({ ...d, counted: true })).catch(() => posts(postFields).then((d) => ({ ...d, counted: false }))),
      ]);
      if (r.status === 'rejected' && p.status === 'rejected') throw p.reason;
      const list: SocialPost[] = [];
      if (r.status === 'fulfilled') {
        for (const x of (r.value.data ?? []) as any[]) {
          list.push({ id: str(x.id), title: oneLine(x.description, 140), kind: 'video', link: link(x.permalink_url), thumb: img(x.picture), at: Date.parse(str(x.created_time)) || 0, views: count(x.views), likes: count(x.likes?.summary?.total_count), comments: count(x.comments?.summary?.total_count), shares: null });
        }
      }
      if (p.status === 'fulfilled') {
        for (const x of (p.value.data ?? []) as any[]) {
          const url = link(x.permalink_url);
          // A reel is also a post on the Page: keep the reel (it has the views) and add the post's counts to it.
          const same = list.find((y) => y.kind === 'video' && y.id && url.includes(y.id));
          const likes = count(x.reactions?.summary?.total_count), comments = count(x.comments?.summary?.total_count);
          const shares = p.value.counted ? count(x.shares?.count) ?? 0 : null;
          if (same) { same.likes = likes ?? same.likes; same.comments = comments ?? same.comments; same.shares = shares; same.thumb ||= img(x.full_picture); continue; }
          list.push({ id: str(x.id), title: oneLine(x.message, 140), kind: /\/(reel|videos?)\//.test(url) ? 'video' : x.full_picture ? 'picture' : 'text', link: url, thumb: img(x.full_picture), at: Date.parse(str(x.created_time)) || 0, views: null, likes, comments, shares });
        }
      }
      list.sort((x, y) => y.at - x.at);
      return {
        connected: true,
        page: id,
        pages: pages.map((x) => ({ id: str(x.id), name: clip(str(x.name), 60), username: clip(str(x.username), 40) })).sort((x, y) => x.name.localeCompare(y.name)),
        profile: { name: clip(str(page.name), 60), followers: count(page.followers_count), link: link(page.link) },
        posts: list.slice(0, 24),
        ...(r.status === 'rejected' || p.status === 'rejected' ? { note: `Facebook didn’t answer for ${r.status === 'rejected' ? 'reels' : 'posts'}.` } : {}),
      };
    });
    return c.json(body);
  } catch (e) {
    console.warn('[panels] facebook failed:', (e as Error)?.message ?? e);
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
  if (!/^UC[\w-]{22}$/.test(channel)) return c.json({ configured: false, posts: [] });
  try {
    const body = await cached('yt', fresh, async () => {
      const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`YouTube answered ${r.status}`);
      const xml = await r.text();
      const tag = (s: string, t: string) => unescape(s.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`))?.[1] ?? '');
      const name = tag(xml.split('<entry>')[0], 'title');
      const videos: SocialPost[] = xml.split('<entry>').slice(1, 25).map((e) => {
        const id = tag(e, 'yt:videoId');
        const ok = /^[\w-]{11}$/.test(id);
        const short = e.includes(`href="https://www.youtube.com/shorts/${id}"`);
        return {
          id,
          title: clip(tag(e, 'title'), 140),
          kind: 'video' as const,
          at: Date.parse(tag(e, 'published')) || 0,
          views: count(e.match(/<media:statistics views="(\d+)"/)?.[1]),
          likes: count(e.match(/<media:starRating count="(\d+)"/)?.[1]),
          comments: null,
          shares: null,
          thumb: ok ? `https://i.ytimg.com/vi/${id}/hq720.jpg` : '',
          link: ok ? (short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`) : '',
        };
      }).filter((v) => v.link);
      await youtubeCounts(videos).catch((e) => console.warn('[panels] youtube counts:', (e as Error)?.message ?? e));
      return { configured: true, channel: clip(name, 80), studio: `https://studio.youtube.com/channel/${channel}`, posts: videos };
    });
    return c.json(body);
  } catch (e) {
    console.warn('[panels] youtube failed:', (e as Error)?.message ?? e);
    return c.json({ configured: true, posts: [], error: why(e) }, 502);
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
