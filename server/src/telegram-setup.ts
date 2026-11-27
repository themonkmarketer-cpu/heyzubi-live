import { Hono } from 'hono';
import { db } from './db.js';
import { requireUser, rateLimit, type AuthVars } from './lib/auth.js';
import { engineEnvValues, engineKind, primaryBotId, primaryEnvValue, readEngineEnv, restartEngineAndWait, setEngineEnv } from './engine.js';
import { getBotRow, updateRow } from './store.js';
import type { TelegramState } from './types.js';

/**
 * A team member's own Telegram bot, set up in HeyZubi: the owner pastes the token BotFather gave them and their own
 * Telegram user ID, and this writes them into the member's Hermes settings (.env) and restarts its agent. Hermes turns
 * Telegram on from those settings (TELEGRAM_BOT_TOKEN; only TELEGRAM_ALLOWED_USERS may talk to it; replies and
 * reminders go to TELEGRAM_HOME_CHANNEL, the owner's private chat with the bot).
 *
 * The token and the ID travel only in this request. They are never put in a chat message or a card, never sent to
 * the model and never logged or sent back: a card shows only the bot's @username.
 */

const KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'TELEGRAM_HOME_CHANNEL'] as const;
const TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const USER_ID = /^\d{4,15}$/;


const tries = rateLimit(10, 10 * 60_000);
const usernames = new Map<string, string>();

/** Call Telegram's Bot API. The token goes only to Telegram; errors never repeat it. */
async function tg(token: string, method: string, body?: Record<string, unknown>): Promise<any> {
  let r: Response;
  try {
    r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Telegram could not be reached. Try again in a minute.');
  }
  return r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
}

async function botUsername(token: string): Promise<string | null> {
  const me = await tg(token, 'getMe').catch(() => null);
  return me?.ok && me.result?.is_bot ? String(me.result.username ?? '') || null : null;
}

export async function telegramState(botId: string): Promise<TelegramState> {
  if (engineKind(botId) !== 'managed' || botId === primaryBotId()) {
    return { available: false, connected: false, username: null, reason: 'This team member uses the computer’s own agent, whose Telegram is set up in Hermes itself.' };
  }
  const vars = readEngineEnv(botId, [...KEYS]) ?? {};
  const token = vars.TELEGRAM_BOT_TOKEN;
  if (!token) return { available: true, connected: false, username: null };
  let username = usernames.get(botId) ?? null;
  if (!username) {
    username = await botUsername(token).catch(() => null);
    if (username) usernames.set(botId, username);
  }
  return { available: true, connected: true, username };
}

/** The teammate card(s) in Zubi's chat for this member: record the Telegram step (only the @username). */
function markCards(botId: string, telegram: { status: 'connected' | 'skipped'; username?: string }) {
  const zubi = primaryBotId();
  if (!zubi || zubi === botId) return;
  const rows = db.prepare("SELECT seq, body FROM rows WHERE bot_id=? AND generation=(SELECT generation FROM bots WHERE id=?) AND kind='card' AND body LIKE ? ORDER BY seq DESC LIMIT 5")
    .all(zubi, zubi, `%"teammateId":"${botId}"%`) as { seq: number; body: string }[];
  for (const r of rows) {
    let body: any;
    try { body = JSON.parse(r.body); } catch { continue; }
    if (body?.card !== 'teammate' || body.teammateId !== botId) continue;
    updateRow(zubi, r.seq, { ...body, telegram });
  }
}

export const telegramApi = new Hono<AuthVars>();
telegramApi.use('*', requireUser);

const own = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId && b.kind !== 'room' ? b : null;
};

telegramApi.get('/:id', async (c) => {
  const b = own(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ telegram: await telegramState(b.id) });
});

/** Connect: { token, userId }. Checked with Telegram, saved in the member's own settings, its agent restarted. */
telegramApi.post('/:id', async (c) => {
  const b = own(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const state = await telegramState(b.id);
  if (!state.available) return c.json({ error: state.reason }, 409);
  if (tries.full(b.id)) return c.json({ error: 'Too many tries. Wait a few minutes, then try again.' }, 429);
  tries.count(b.id);

  const p = await c.req.json().catch(() => ({})) as { token?: unknown; userId?: unknown };
  const token = String(p.token ?? '').trim();
  const userId = String(p.userId ?? '').trim();
  if (!TOKEN.test(token)) return c.json({ error: 'That doesn’t look like a bot token. Copy the whole line under “Use this token to access the HTTP API”, for example 123456789:AAH…' }, 400);
  if (!USER_ID.test(userId)) return c.json({ error: 'Your user ID is a number only, like 123456789. Copy “Your user ID” from @GetMyID_bot.' }, 400);

  // One Telegram bot can be run by one agent only: two would take each other's messages.
  const taken = primaryEnvValue('TELEGRAM_BOT_TOKEN') === token ? primaryBotId() : engineEnvValues('TELEGRAM_BOT_TOKEN').find((x) => x.value === token && x.botId !== b.id)?.botId;
  if (taken) {
    const who = getBotRow(taken);
    return c.json({ error: `That bot is already connected to ${who?.name ?? 'another team member'}. Make a new bot with /newbot for ${b.name}.` }, 409);
  }

  const me = await tg(token, 'getMe').catch((e) => ({ ok: false, description: (e as Error).message }));
  if (!me?.ok || !me.result?.is_bot) return c.json({ error: 'Telegram didn’t accept that token. Copy it again from BotFather (the whole line), or send /revoke there for a new one.' }, 400);
  const username = String(me.result.username ?? '');

  try {
    setEngineEnv(b.id, { TELEGRAM_BOT_TOKEN: token, TELEGRAM_ALLOWED_USERS: userId, TELEGRAM_HOME_CHANNEL: userId });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 409);
  }
  usernames.set(b.id, username);
  try { await restartEngineAndWait(b.id); }
  catch (e) { console.warn(`[telegram] ${b.name}: agent restart failed: ${(e as Error).message}`); return c.json({ error: `Saved, but ${b.name}’s agent did not come back up. Restart it from its settings.` }, 502); }

  // Say hello from the new bot, so the owner sees it works. Telegram lets a bot write first only after the person has
  // opened it and pressed Start, so this can fail; that is not an error.
  const hello = await tg(token, 'sendMessage', { chat_id: userId, text: `Hi, I’m ${b.name}. I’m connected. Message me here any time, the same as in HeyZubi.` }).catch(() => null);
  const greeted = !!hello?.ok;
  markCards(b.id, { status: 'connected', username });
  console.log(`[telegram] ${b.name}: connected as @${username}`);
  return c.json({ telegram: { available: true, connected: true, username } satisfies TelegramState, greeted });
});

/** The owner chose not to set up Telegram now (the card's Skip). */
telegramApi.post('/:id/skip', (c) => {
  const b = own(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  markCards(b.id, { status: 'skipped' });
  return c.json({ ok: true });
});

/** Disconnect: take the Telegram settings out and restart the agent. */
telegramApi.delete('/:id', async (c) => {
  const b = own(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const state = await telegramState(b.id);
  if (!state.available) return c.json({ error: state.reason }, 409);
  setEngineEnv(b.id, Object.fromEntries(KEYS.map((k) => [k, null])));
  usernames.delete(b.id);
  try { await restartEngineAndWait(b.id); } catch (e) { console.warn(`[telegram] ${b.name}: restart after disconnect failed: ${(e as Error).message}`); }
  return c.json({ telegram: { available: true, connected: false, username: null } satisfies TelegramState });
});
