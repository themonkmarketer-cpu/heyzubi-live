import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { createSession, destroySession, isLocalRequest, isOwnerKey, peerAddress, rateLimit, requireUser, userFromCookieHeader, type AuthVars } from './lib/auth.js';
import { allLive, appendRow, clearConversation, emitBot, getBot, getBotRow, getRow, listBots, listRoutines, listRows, listTasks, toRoutine, updateRow } from './store.js';
import { enqueue, interrupt, resolveApproval } from './agent/loop.js';
import { computerState, ensureComputer, forgetBotFiles, readyScreen, refreshComputer, releaseScreen, suspendComputer } from './computer.js';
import { removeEngine, syncPersona } from './engine.js';
import { agentCount, createBot, UserError } from './team.js';
import { isPropId } from './avatar-props.js';
import { syncIdentity } from './hermes-identity.js';
import { deleteMemory, listMemories, memoryBot } from './engine-memory.js';
import { orgo } from './orgo.js';
import { catalog, connectedToolkits, deleteConnection, disconnect, googleProfile, startConnect, startGoogleLogin, toolkitInfo } from './composio.js';
import { runRoutine, scheduleRoutine, unscheduleRoutine } from './routines.js';
import { deleteEventTrigger } from './triggers.js';
import { dispatchRoomMessage } from './agent/rooms.js';
import { voiceApi } from './voice.js';
import { clickyApi } from './clicky.js';
import { whatsappApi } from './whatsapp.js';
import { generationsApi } from './generations.js';
import { panelsApi } from './panels.js';
import { statusApi } from './status.js';
import { openPanelsFor } from './panels.js';
import type { AvatarColor, AvatarShape, Toolkit } from './types.js';
import { isGeminiVoice } from './voice-gemini.js';
import { isSarvamVoice } from './sarvam.js';
import { prefsApi, getPrefs } from './prefs.js';
import { apiKeysApi, inboundApi } from './inbound.js';
import { codingApi } from './coding.js';
import { desktopApi, desktopDevicesApi } from './desktop.js';

export const api = new Hono<AuthVars>();

/** JSON that is safe to embed inside an inline <script>: `<` can't close the tag and line separators can't break the statement. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}


/**
 * Who may sign in. Every account gets agents with a shell on the shared computer, so on a public URL
 * only ALLOWED_EMAILS get in, and with an empty list nobody does: having an account already is no
 * pass, or one made while the instance was open would get in forever. `owner` (the key that only
 * exists on the server's machine) is always let in. Sessions are held to the same list afterwards
 * (userFromToken).
 */
function maySignIn(email: string, owner: boolean): boolean {
  if (owner) return true;
  if (env.allowedEmails.length) return env.allowedEmails.includes(email.toLowerCase());
  return env.localOnly;
}

function findOrCreateUser(email: string, name?: string, opts: { owner?: boolean } = {}) {
  const existing = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(email) as any;
  if (!maySignIn(email, !!opts.owner)) throw new UserError('This account is not allowed to sign in here.');
  if (existing) return { id: existing.id as string, isNew: false };
  const id = newId('usr');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, email, name ?? email.split('@')[0], now());
  createBot(id, { name: env.primaryBotName, label: env.primaryBotLabel, description: 'Your main point of contact. Checks in proactively and coordinates work with the rest of your team.', avatarShape: 'blob', avatarColor: 'black', isPrimary: true });
  return { id, isNew: true };
}

// ---------- auth ----------

api.get('/auth/me', (c) => {
  const user = userFromCookieHeader(c.req.header('cookie'));
  return c.json({ user: user ? { ...user, displayName: getPrefs(user.id).displayName } : null, devLogin: env.devLogin });
});

/** How long a Google sign-in may take from start to callback. */
const LOGIN_ATTEMPT_TTL_MS = 15 * 60_000;

// Limits on the sign-in routes, each counted per peer address (see rateLimit for what that means
// behind a proxy). Starting a sign-in costs something every time (a Composio session and a
// database row for Google, possibly a new account with an agent of its own for the dev form), so
// starts are capped. For the owner key and sign-in links it is the wrong guesses that are capped.
const TEN_MINUTES = 10 * 60_000;
const googleStarts = rateLimit(10, TEN_MINUTES);
const devSignIns = rateLimit(10, TEN_MINUTES);
const ownerFailures = rateLimit(5, TEN_MINUTES);
const linkFailures = rateLimit(5, TEN_MINUTES);
const tooMany = (c: Context, limit: ReturnType<typeof rateLimit>, peer: string) => {
  c.header('Retry-After', String(limit.retryAfter(peer)));
  return c.text('Too many sign-in attempts from this address. Try again in a few minutes.', 429);
};

api.get('/auth/google/start', async (c) => {
  const peer = peerAddress(c);
  if (googleStarts.full(peer)) return tooMany(c, googleStarts, peer);
  googleStarts.count(peer);
  // Attempts nobody finished would otherwise stay forever (anyone can open this route). Past the
  // time limit the callback refuses them anyway, so they are dropped whenever a new one begins.
  db.prepare('DELETE FROM login_attempts WHERE created_at < ?').run(now() - LOGIN_ATTEMPT_TTL_MS);
  const attemptId = newId('login');
  const provisional = newId('usr');
  const cb = `${env.serverUrl}/api/auth/google/callback?attempt=${attemptId}`;
  const { redirectUrl, connectedAccountId } = await startGoogleLogin(provisional, cb);
  db.prepare('INSERT INTO login_attempts(id,provisional_user_id,connected_account_id,created_at) VALUES (?,?,?,?)').run(attemptId, provisional, connectedAccountId ?? null, now());
  return c.redirect(redirectUrl);
});

api.get('/auth/google/callback', async (c) => {
  const attempt = db.prepare('SELECT * FROM login_attempts WHERE id=?').get(c.req.query('attempt') ?? '') as any;
  // Only the Google connection this attempt started may sign in, and only for a short while: an
  // account id taken from the URL alone could name somebody else's connection.
  const caId: string | undefined = attempt?.connected_account_id ?? undefined;
  const fresh = attempt && now() - attempt.created_at < LOGIN_ATTEMPT_TTL_MS;
  const given = c.req.query('connected_account_id');
  if (!attempt || !fresh || c.req.query('status') === 'failed' || !caId || (given && given !== caId)) {
    if (attempt) db.prepare('DELETE FROM login_attempts WHERE id=?').run(attempt.id);
    // Whatever this attempt's own connection got as far as, it is not kept (never one named only in the URL).
    if (caId) await deleteConnection(caId);
    return c.redirect(`${env.appUrl}/?login=failed`);
  }
  db.prepare('DELETE FROM login_attempts WHERE id=?').run(attempt.id);
  try {
    // The Gmail connection is only there to learn the address. It is removed as soon as that is read,
    // for new and existing accounts alike and also when reading fails, so signing in never wires a
    // mailbox to anyone's bots; Gmail is connected on purpose, under Apps. The account gets an id of
    // its own (not the attempt's), so a connection that could not be removed is left with no owner.
    let profile: { email: string; name?: string };
    try { profile = await googleProfile(caId); } finally { await deleteConnection(caId); }
    const { id } = findOrCreateUser(profile.email, profile.name);
    createSession(c, id);
    return c.redirect(`${env.appUrl}/`);
  } catch (e: any) {
    if (!(e instanceof UserError)) console.error('[auth] google callback', e);
    return c.redirect(`${env.appUrl}/?login=failed`);
  }
});

api.post('/auth/dev', async (c) => {
  // Email-only sign-in proves nothing about who is asking, so it only works for a local app and
  // only for requests made on this machine: not from the LAN when the server listens there, and not
  // passed on by a tunnel or proxy that says so (see isLocalRequest).
  if (!env.devLogin || !isLocalRequest(c)) return c.json({ error: 'disabled' }, 403);
  const peer = peerAddress(c);
  if (devSignIns.full(peer)) return tooMany(c, devSignIns, peer);
  devSignIns.count(peer);
  const { email, name } = await c.req.json<{ email: string; name?: string }>();
  if (!email?.includes('@')) return c.json({ error: 'email required' }, 400);
  try {
    const { id } = findOrCreateUser(email, name);
    createSession(c, id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e instanceof UserError ? e.message : 'could not sign in' }, 403);
  }
});

/** One-time sign-in links made by the owner endpoint. Kept in memory: a restart drops them. */
const signInLinks = new Map<string, { userId: string; expires: number }>();

// Sign-in for whoever runs the server, without Google: the key only exists on the machine (see isOwnerKey),
// and the request has to come from the machine too, so nobody elsewhere gets to try keys (see isLocalRequest).
// With `link`, it answers with a link that signs one browser in, once (scripts/sign-in-link.sh).
api.post('/auth/owner', async (c) => {
  // A request from elsewhere is refused whatever key it carries, so it is not counted either: junk
  // sent through the public URL cannot use up the allowance of the script on this machine. Wrong
  // keys from this machine are counted, and past the limit no key is looked at until it has eased.
  if (!isLocalRequest(c)) return c.json({ error: 'forbidden' }, 403);
  const peer = peerAddress(c);
  if (ownerFailures.full(peer)) return tooMany(c, ownerFailures, peer);
  if (!isOwnerKey((c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''))) {
    ownerFailures.count(peer);
    return c.json({ error: 'forbidden' }, 403);
  }
  const { email, name, link } = await c.req.json<{ email: string; name?: string; link?: boolean }>();
  if (!email?.includes('@')) return c.json({ error: 'email required' }, 400);
  try {
    const { id } = findOrCreateUser(email, name, { owner: true });
    if (link) {
      const token = crypto.randomBytes(24).toString('base64url');
      signInLinks.set(token, { userId: id, expires: Date.now() + 15 * 60_000 });
      return c.json({ ok: true, url: `${env.appUrl}/api/auth/link/${token}` });
    }
    createSession(c, id, { owner: true });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e instanceof UserError ? e.message : 'could not sign in' }, 403);
  }
});

api.get('/auth/link/:token', (c) => {
  // Checked before the link is looked at, so a refused request does not use a link up.
  const peer = peerAddress(c);
  if (linkFailures.full(peer)) return tooMany(c, linkFailures, peer);
  const token = c.req.param('token');
  const l = signInLinks.get(token);
  signInLinks.delete(token);
  if (!l || l.expires < Date.now()) {
    linkFailures.count(peer);
    return c.text('This sign-in link was already used or has expired. Ask for a new one.', 410);
  }
  // Links are only made with the owner key, so the session they start counts as an owner session too.
  createSession(c, l.userId, { owner: true });
  return c.redirect('/');
});

api.post('/auth/logout', (c) => { destroySession(c); return c.json({ ok: true }); });

// Everything below requires a session, except the page a provider sends the browser back to after
// connecting an app. Only that exact GET is let through: as a prefix it also covered other routes
// that happen to start the same way (DELETE /api/apps/callback is "disconnect the app `callback`").
// Every route under /api/auth/ is defined above and is meant to work signed out.
api.use('/*', async (c, next) => {
  // /api/inbound/ checks its own API key (outside programs; see inbound.ts).
  const open = c.req.path.startsWith('/api/auth/') || (c.req.method === 'GET' && c.req.path === '/api/apps/callback') || c.req.path === '/api/health' || c.req.path.startsWith('/api/inbound/') || c.req.path.startsWith('/api/desktop/');
  return open ? next() : requireUser(c, next);
});

// ---------- the release the server has ----------

// The web build the server serves (web/dist/build.json, written by the build). The app compares it with its own to
// offer "Update ready" in the sidebar.
const WEB_BUILD_FILE = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist/build.json');
let webBuild: { at: number; data: { build: string; builtAt: string | null } } | null = null;
api.get('/version', (c) => {
  try {
    const at = fs.statSync(WEB_BUILD_FILE).mtimeMs;
    if (!webBuild || webBuild.at !== at) {
      const j = JSON.parse(fs.readFileSync(WEB_BUILD_FILE, 'utf8'));
      webBuild = { at, data: { build: String(j.build ?? ''), builtAt: j.builtAt ?? null } };
    }
    c.header('Cache-Control', 'no-store');
    return c.json(webBuild.data);
  } catch {
    return c.json({ build: '', builtAt: null });
  }
});

// ---------- events (SSE) ----------

api.get('/events', (c) => {
  const user = c.get('user');
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const unsub = hub.subscribe(user.id, (ev) => { queue.push(JSON.stringify(ev)); wake?.(); });
    stream.onAbort(() => { unsub(); wake?.(); });
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello', serverTime: now() }) });
    while (!stream.aborted) {
      if (!queue.length) {
        await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 20_000))]);
        wake = null;
        if (!queue.length) { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); continue; }
      }
      while (queue.length) await stream.writeSSE({ data: queue.shift()! });
    }
    unsub();
  });
});

// ---------- bots ----------

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

api.get('/bots', (c) => c.json({ bots: listBots(c.get('user').id), live: allLive(c.get('user').id) }));

api.post('/bots', async (c) => {
  const body = await c.req.json();
  try {
    return c.json({ bot: createBot(c.get('user').id, body) });
  } catch (e: any) {
    if (e instanceof UserError) return c.json({ error: e.message }, 409);
    throw e;
  }
});

api.patch('/bots/:id', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const p = await c.req.json();
  // The avatar's prop: a known prop, 'none', or 'auto' / null (picked from the role).
  if (p.avatarProp !== undefined) {
    if (p.avatarProp === null || p.avatarProp === 'auto') p.avatarProp = null;
    else if (p.avatarProp !== 'none' && !isPropId(p.avatarProp)) return c.json({ error: 'unknown prop' }, 400);
  }
  const cols: Record<string, string> = { name: 'name', label: 'label', description: 'description', instructions: 'instructions', avatarShape: 'avatar_shape', avatarColor: 'avatar_color', avatarProp: 'avatar_prop', mode: 'mode', effort: 'effort', pinned: 'pinned', voice: 'voice', voiceSpeed: 'voice_speed', voiceLanguage: 'voice_language', voiceEngine: 'voice_engine', geminiVoice: 'gemini_voice', voiceMsgEngine: 'voice_msg_engine', sarvamVoice: 'sarvam_voice' };
  if (p.team !== undefined || p.isManager !== undefined) {
    if (b.is_primary) return c.json({ error: `${b.name} is the CEO, above every team.` }, 400);
    const team = p.team !== undefined ? (String(p.team ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || null) : b.team;
    const manager = team ? (p.isManager !== undefined ? p.isManager === true : !!b.is_manager) : false;
    // One manager per team: making this bot the manager hands the role over.
    if (manager) db.prepare('UPDATE bots SET is_manager=0 WHERE user_id=? AND team=? AND id<>?').run(b.user_id, team, b.id);
    db.prepare('UPDATE bots SET team=?, is_manager=?, updated_at=? WHERE id=?').run(team, manager ? 1 : 0, now(), b.id);
    hub.emit(b.user_id, { type: 'roster' });
  }
  if (p.voiceMsgEngine !== undefined && p.voiceMsgEngine !== 'xai' && p.voiceMsgEngine !== 'sarvam') return c.json({ error: 'voiceMsgEngine must be xai or sarvam' }, 400);
  if (p.sarvamVoice !== undefined && !isSarvamVoice(p.sarvamVoice)) return c.json({ error: 'unknown Sarvam voice' }, 400);
  if (p.voiceEngine !== undefined && p.voiceEngine !== 'xai' && p.voiceEngine !== 'gemini') return c.json({ error: 'voiceEngine must be xai or gemini' }, 400);
  if (p.geminiVoice !== undefined && !isGeminiVoice(p.geminiVoice)) return c.json({ error: 'unknown Gemini voice' }, 400);
  for (const [k, col] of Object.entries(cols)) {
    if (p[k] !== undefined) db.prepare(`UPDATE bots SET ${col}=?, updated_at=? WHERE id=?`).run(typeof p[k] === 'boolean' ? (p[k] ? 1 : 0) : p[k], now(), b.id);
  }
  if (b.kind !== 'room') {
    if (['name', 'label', 'description'].some((k) => p[k] !== undefined)) syncPersona(b.id);
    // Its desktop carries its name and colour: dress the screen again, if it has one.
    // The prop can follow the role or description, so those redress the screen too.
    const looks = ['name', 'label', 'description', 'avatarShape', 'avatarColor', 'avatarProp'].some((k) => p[k] !== undefined);
    // Hermes shows the same name and mascot (for bots that are Hermes profiles).
    if (looks) void syncIdentity(b.id);
    if (looks && db.prepare('SELECT 1 FROM screens WHERE bot_id=?').get(b.id)) {
      readyScreen(b.user_id, b.id, { redress: true }).catch((e) => console.warn('[computer] redress failed', e?.message ?? e));
    }
  }
  emitBot(b.id);
  return c.json({ bot: getBot(b.id) });
});

api.delete('/bots/:id', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  for (const r of listRoutines(b.id)) {
    unscheduleRoutine(r.id);
    await deleteEventTrigger(r.id).catch(() => {});
  }
  if (b.kind !== 'room') {
    await removeEngine(b.id).catch((e) => console.warn('[engine] remove failed', e?.message ?? e));
    await releaseScreen(b.id).catch((e) => console.warn('[computer] release failed', e?.message ?? e));
    await forgetBotFiles(b.id).catch((e) => console.warn('[computer] cleanup failed', e?.message ?? e));
  }
  db.prepare('DELETE FROM screens WHERE bot_id=?').run(b.id);
  db.prepare('DELETE FROM bots WHERE id=?').run(b.id);
  hub.emit(c.get('user').id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/primary', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET is_primary = (id = ?) WHERE user_id=?').run(b.id, user.id);
  // The main bot's screen shows Zubi: dress the screens again so the old and new main bot swap looks.
  for (const s of db.prepare('SELECT bot_id FROM screens WHERE user_id=?').all(user.id) as any[]) {
    readyScreen(user.id, s.bot_id, { redress: true }).catch((e) => console.warn('[computer] redress failed', e?.message ?? e));
  }
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/read', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET unread=0 WHERE id=?').run(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

// ---------- conversation ----------

api.get('/bots/:id/rows', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const beforeSeq = c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined;
  return c.json({ generation: b.generation, rows: listRows(b.id, { beforeSeq, limit: Number(c.req.query('limit') ?? 200) }) });
});

api.post('/bots/:id/messages', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { text, voice } = await c.req.json<{ text: string; voice?: boolean }>();
  if (!text?.trim()) return c.json({ error: 'empty' }, 400);
  // A voice message (held mic, transcribed) shows as the owner's message, marked as spoken.
  const row = appendRow(b.id, 'message', { type: 'message', role: 'user', text: text.trim(), ...(voice ? { from: { kind: 'voice' as const, id: 'voice-message', name: 'Voice message' } } : {}) });
  // Group chats dispatch to their member Bots instead of running their own loop.
  if (b.kind === 'room') dispatchRoomMessage(b.id, text.trim(), enqueue);
  // Any pending question card is answered by a free-text message. A voice message's reply may be read aloud.
  else enqueue(b.id, { type: 'user', text: voice ? `[Voice message: the owner said this out loud in the app (you get it as a transcript) and short replies are played back to them in your voice, so this works like talking. Don't mention transcripts or that you can't hear. Lead with the answer in a few plain sentences; skip markdown, tables and links unless asked.]\n${text.trim()}` : text.trim() });
  // Asking about the calendar or the inbox opens that window right away (like WhatsApp).
  openPanelsFor(c.get('user').id, text.replace(/\[Attached picture:[^\]]*\]/g, ''));
  return c.json({ row });
});

api.post('/bots/:id/interrupt', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  return c.json({ ok: true });
});

api.post('/bots/:id/fresh', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  clearConversation(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

api.post('/approvals/:id', async (c) => {
  const { decision } = await c.req.json<{ decision: 'allow' | 'always' | 'deny' }>();
  try { resolveApproval(c.get('user').id, c.req.param('id'), decision); } catch { return c.json({ error: 'not found' }, 404); }
  return c.json({ ok: true });
});

api.post('/bots/:id/cards/:seq/answer', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  const { answer } = await c.req.json<{ answer: string }>();
  if (!row || row.body.type !== 'card' || row.body.card !== 'question') return c.json({ error: 'not a question' }, 400);
  updateRow(b.id, row.seq, { ...row.body, status: 'answered', answer });
  appendRow(b.id, 'message', { type: 'message', role: 'user', text: answer });
  enqueue(b.id, { type: 'user', text: `[Answer to "${row.body.question}"] ${answer}` });
  return c.json({ ok: true });
});

api.post('/bots/:id/cards/:seq/dismiss', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  if (!row || row.body.type !== 'card') return c.json({ error: 'not a card' }, 400);
  const body: any = { ...row.body, status: row.body.card === 'connect' || row.body.card === 'teammate' ? 'skipped' : 'dismissed' };
  updateRow(b.id, row.seq, body);
  if (row.body.card === 'connect') enqueue(b.id, { type: 'system', owner: true, text: `The user skipped connecting ${row.body.toolkitName}. Continue without it.` });
  if (row.body.card === 'teammate') enqueue(b.id, { type: 'system', owner: true, text: `The owner chose to sign ${row.body.name} in to Claude later. Say in one line that ${row.body.name} is in the sidebar and can be signed in from its settings (Engine) any time; don't push.` });
  return c.json({ ok: true });
});

// ---------- routines / tasks / memories ----------

api.get('/bots/:id/routines', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ routines: listRoutines(b.id) }) : c.json({ error: 'not found' }, 404);
});

/** Every routine on the user's team, for the Routines view (each names its bot). */
api.get('/routines', (c) => {
  const rows = db.prepare("SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND COALESCE(b.kind,'agent')<>'room' ORDER BY r.created_at").all(c.get('user').id) as any[];
  return c.json({ routines: rows.map(toRoutine) });
});

api.patch('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  db.prepare('UPDATE routines SET enabled=? WHERE id=?').run(enabled ? 1 : 0, r.id);
  const next = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(r.id));
  enabled ? scheduleRoutine(next) : unscheduleRoutine(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ routine: next });
});

api.post('/routines/:id/run', (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  runRoutine(r.id);
  return c.json({ ok: true });
});

api.delete('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  unscheduleRoutine(r.id);
  await deleteEventTrigger(r.id);
  db.prepare('DELETE FROM routines WHERE id=?').run(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ ok: true });
});

api.get('/bots/:id/tasks', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ tasks: listTasks(b.id) }) : c.json({ error: 'not found' }, 404);
});

api.get('/tasks', (c) => {
  const rows = db.prepare('SELECT t.* FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=? ORDER BY t.updated_at DESC LIMIT 200').all(c.get('user').id) as any[];
  return c.json({ tasks: rows.map((r) => ({ id: r.id, botId: r.bot_id, title: r.title, state: r.state, note: r.note, updatedAt: r.updated_at })) });
});

api.get('/bots/:id/memories', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ memories: listMemories(b.id) });
});

api.delete('/memories/:id', (c) => {
  const botId = memoryBot(c.req.param('id'));
  if (!botId || !ownBot(c.get('user').id, botId)) return c.json({ error: 'not found' }, 404);
  deleteMemory(c.req.param('id'));
  return c.json({ ok: true });
});

// ---------- computer ----------

api.get('/computer', async (c) => c.json({ computer: await refreshComputer(c.get('user').id) }));

api.post('/computer/ensure', (c) => {
  const userId = c.get('user').id;
  ensureComputer(userId).catch((e) => console.warn('[computer] ensure failed', e.message));
  return c.json({ computer: computerState(userId) });
});

api.post('/computer/suspend', async (c) => {
  await suspendComputer(c.get('user').id);
  return c.json({ computer: computerState(c.get('user').id) });
});

api.get('/bots/:id/screenshot', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const scr = db.prepare('SELECT screen_id FROM screens WHERE bot_id=?').get(b.id) as any;
  if (!env.orgoComputerId || computerState(user.id).status !== 'running' || !scr) return c.body(null, 204);
  try {
    const s = await orgo.screenshot(env.orgoComputerId, scr.screen_id);
    const b64 = s.image.replace(/^data:[^,]+,/, '');
    return c.body(Buffer.from(b64, 'base64'), 200, { 'Content-Type': s.mime_type ?? 'image/jpeg', 'Cache-Control': 'no-store' });
  } catch {
    return c.body(null, 204);
  }
});

// ---------- apps (Composio marketplace) ----------

api.get('/apps', async (c) => {
  const user = c.get('user');
  const search = (c.req.query('search') ?? '').toLowerCase();
  const category = c.req.query('category') ?? '';
  const [all, connected] = await Promise.all([catalog(), connectedToolkits(user.id).catch(() => new Set<string>())]);
  let items: Toolkit[] = all.map((t) => ({ ...t, connected: connected.has(t.slug) }));
  if (search) items = items.filter((t) => t.name.toLowerCase().includes(search) || t.slug.includes(search) || t.description?.toLowerCase().includes(search));
  if (category) items = items.filter((t) => t.categories.some((x) => x.toLowerCase() === category.toLowerCase()));
  const categories = [...new Set(all.flatMap((t) => t.categories))].sort();
  const connectedApps = all.filter((t) => connected.has(t.slug)).map((t) => ({ ...t, connected: true }));
  return c.json({ apps: items.slice(0, Number(c.req.query('limit') ?? 120)), connected: [...connected], connectedApps, categories, total: items.length });
});

api.post('/apps/:slug/connect', async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const { botId, seq } = await c.req.json<{ botId?: string; seq?: number }>().catch(() => ({} as any));
  const cb = new URL(`${env.serverUrl}/api/apps/callback`);
  cb.searchParams.set('slug', slug);
  if (botId) cb.searchParams.set('bot', botId);
  if (seq) cb.searchParams.set('seq', String(seq));
  const r = await startConnect(user.id, slug, cb.toString());
  return c.json(r);
});

api.get('/apps/callback', async (c) => {
  const userId = userFromCookieHeader(c.req.header('cookie'))?.id ?? '';
  const slug = c.req.query('slug') ?? '';
  // This route is unauthenticated and reflects `slug` into the page, so accept only toolkit-slug shapes.
  if (!/^[a-z0-9_-]{1,64}$/i.test(slug)) return c.text('Invalid app.', 400);
  const botId = c.req.query('bot');
  const seq = Number(c.req.query('seq') ?? 0);
  const ok = c.req.query('status') !== 'failed';
  const userExists = db.prepare('SELECT 1 FROM users WHERE id=?').get(userId);
  if (userExists && ok) {
    const connected = await connectedToolkits(userId).catch(() => new Set<string>());
    if (connected.has(slug)) {
      hub.emit(userId, { type: 'connections' });
      if (botId && ownBot(userId, botId)) {
        const info = await toolkitInfo(slug);
        if (seq) {
          const row = getRow(botId, seq);
          if (row?.body.type === 'card' && row.body.card === 'connect') updateRow(botId, seq, { ...row.body, status: 'connected' });
        }
        enqueue(botId, { type: 'system', owner: true, text: `The user connected ${info?.name ?? slug}. Continue with what you were doing.` });
      }
    }
  }
  // Data embedded in an inline <script> must not be able to close the tag, so escape `<` (and U+2028/2029).
  const payload = jsonForScript({ type: 'heyzubi-connected', slug, ok });
  const target = jsonForScript(new URL(env.appUrl).origin);
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.html(`<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font-family:system-ui;padding:40px;text-align:center">${ok ? 'Connected. You can close this window.' : 'Connection failed.'}<script>try{window.opener&&window.opener.postMessage(${payload},${target})}catch(e){};setTimeout(()=>window.close(),800)</script></body>`);
});

api.delete('/apps/:slug', async (c) => {
  await disconnect(c.get('user').id, c.req.param('slug'));
  hub.emit(c.get('user').id, { type: 'connections' });
  return c.json({ ok: true });
});

api.get('/policies', (c) => c.json({ policies: db.prepare('SELECT tool, mode FROM policies WHERE user_id=?').all(c.get('user').id) }));
api.delete('/policies/:tool', (c) => {
  db.prepare('DELETE FROM policies WHERE user_id=? AND tool=?').run(c.get('user').id, c.req.param('tool'));
  return c.json({ ok: true });
});

api.route('/voice', voiceApi);
api.route('/clicky', clickyApi);
api.route('/whatsapp', whatsappApi);
api.route('/generations', generationsApi);
api.route('/panels', panelsApi);
api.route('/status', statusApi);
api.route('/prefs', prefsApi);
api.route('/keys', apiKeysApi);
api.route('/inbound', inboundApi);
api.route('/coding-runs', codingApi);
api.route('/desktop-devices', desktopDevicesApi);
api.route('/desktop', desktopApi);

// ---------- teams (from Theo) ----------
// A team is a name on its bots, with at most one manager. The primary bot is the CEO above every team.

const READY_TEAMS: Record<string, { team: string; blurb: string; bots: { name: string; label: string; description: string; instructions: string; isManager?: boolean }[] }> = {
  finance: {
    team: 'Finance', blurb: 'Tracks spending, budgets and invoices.',
    bots: [
      { name: 'Finance Lead', label: 'Finance manager', isManager: true, description: 'Tracks spending, budgets and invoices.', instructions: 'You manage the Finance team. Keep track of spending, budgets and invoices. Roll your team\'s reports up into one short report for the CEO when asked or on your routine. Never pay, send or delete anything yourself.' },
      { name: 'Budget Watcher', label: 'Budget analyst', description: 'Compares spending with the budget and flags overruns.', instructions: 'Compare spending with the budget and flag overruns, with the numbers. Report to your manager. Never pay, send or delete anything yourself.' },
    ],
  },
  sales: {
    team: 'Sales', blurb: 'Keeps the pipeline moving and says what needs you.',
    bots: [
      { name: 'Sales Lead', label: 'Sales manager', isManager: true, description: 'Reports the pipeline: new leads, conversations going, and what needs the owner.', instructions: 'You manage the Sales team. Report the pipeline in a few lines: new leads, conversations going, and what needs the owner. Roll your team\'s reports up for the CEO. Never send messages yourself; prepare drafts.' },
      { name: 'Lead Researcher', label: 'Lead research', description: 'Finds and qualifies new leads.', instructions: 'Find and qualify new leads, with why each fits and how to reach them. Report to your manager. Never send messages yourself; prepare drafts.' },
    ],
  },
  support: {
    team: 'Support', blurb: 'Watches what customers ask and what keeps coming up.',
    bots: [
      { name: 'Support Lead', label: 'Support manager', isManager: true, description: 'Reports what\'s urgent, what\'s answered and any problem that keeps coming up.', instructions: 'You manage the Support team. Report what\'s urgent, what\'s answered and any problem that keeps coming up. Roll your team\'s reports up for the CEO. Never send replies yourself; prepare drafts.' },
      { name: 'Inbox Triage', label: 'Support inbox', description: 'Sorts incoming questions and drafts replies.', instructions: 'Sort incoming customer questions by urgency and draft replies for the owner to send. Report to your manager. Never send replies yourself.' },
    ],
  },
};

function listTeams(userId: string) {
  const rows = db.prepare("SELECT id, name, team, is_manager FROM bots WHERE user_id=? AND team IS NOT NULL AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0 ORDER BY created_at").all(userId) as any[];
  const by = new Map<string, { name: string; managerId: string | null; memberIds: string[] }>();
  for (const r of rows) {
    const t = by.get(r.team) ?? { name: r.team as string, managerId: null as string | null, memberIds: [] as string[] };
    if (r.is_manager) t.managerId = r.id; else t.memberIds.push(r.id);
    by.set(r.team, t);
  }
  return [...by.values()];
}

const uniqueName = (userId: string, name: string) => {
  let n = name.slice(0, 60);
  for (let i = 2; db.prepare('SELECT 1 FROM bots WHERE user_id=? AND lower(name)=lower(?)').get(userId, n); i++) n = `${name.slice(0, 56)} ${i}`;
  return n;
};

function addTeam(userId: string, team: string, bots: { name: string; label?: string; description?: string; instructions?: string; isManager?: boolean; avatarShape?: string; avatarColor?: string }[]) {
  const free = env.maxBots - agentCount();
  if (bots.length > free) throw new UserError(`That team has ${bots.length} bots but there's room for ${Math.max(0, free)} more (the computer holds ${env.maxBots}). Remove a bot or raise MAX_BOTS first.`);
  let name = team.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Team';
  for (let i = 2; db.prepare('SELECT 1 FROM bots WHERE user_id=? AND team=?').get(userId, name); i++) name = `${team.slice(0, 36)} ${i}`;
  const hasManager = bots.some((x) => x.isManager);
  return bots.map((x, i) => createBot(userId, { ...x, name: uniqueName(userId, x.name || 'Team member'), team: name, isManager: hasManager ? !!x.isManager : i === 0 }));
}

api.get('/teams', (c) => c.json({
  teams: listTeams(c.get('user').id),
  ready: Object.entries(READY_TEAMS).map(([key, t]) => ({ key, team: t.team, blurb: t.blurb, size: t.bots.length })),
  room: Math.max(0, env.maxBots - agentCount()),
}));

api.post('/teams/ready', async (c) => {
  const { key } = await c.req.json<{ key: string }>().catch(() => ({ key: '' }));
  const t = READY_TEAMS[key];
  if (!t) return c.json({ error: 'No such ready-made team.' }, 404);
  try { return c.json({ bots: addTeam(c.get('user').id, t.team, t.bots) }); }
  catch (e: any) { if (e instanceof UserError) return c.json({ error: e.message }, 409); throw e; }
});

/** A team file: its bots' names, roles and instructions (no chats, memories or keys). */
api.get('/teams/:name/export', (c) => {
  const user = c.get('user');
  const team = decodeURIComponent(c.req.param('name'));
  const bots = (db.prepare("SELECT * FROM bots WHERE user_id=? AND team=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0 ORDER BY is_manager DESC, created_at").all(user.id, team) as any[])
    .map((b) => ({ name: b.name, label: b.label, description: b.description, instructions: b.instructions, isManager: !!b.is_manager, avatarShape: b.avatar_shape, avatarColor: b.avatar_color }));
  if (!bots.length) return c.json({ error: 'not found' }, 404);
  return c.json({ format: 'heyzubi-team', version: 1, team, bots });
});

api.post('/teams/import', async (c) => {
  const f = await c.req.json().catch(() => null) as any;
  if (!f || f.format !== 'heyzubi-team' || !Array.isArray(f.bots) || !f.bots.length) return c.json({ error: 'That file has no team HeyZubi can read. A team file comes from Export.' }, 400);
  const str = (v: unknown, n: number) => String(v ?? '').slice(0, n);
  const bots = f.bots.slice(0, 8).map((b: any) => ({ name: str(b.name, 60), label: str(b.label, 80), description: str(b.description, 500), instructions: str(b.instructions, 8000), isManager: b.isManager === true, avatarShape: str(b.avatarShape, 20), avatarColor: str(b.avatarColor, 20) }));
  try { return c.json({ bots: addTeam(c.get('user').id, str(f.team, 40) || 'Team', bots) }); }
  catch (e: any) { if (e instanceof UserError) return c.json({ error: e.message }, 409); throw e; }
});
