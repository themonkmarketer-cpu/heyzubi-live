// One Hermes session per team member (Murtaza, 25 Nov 2026: "1 session reserved per agent on hermes… no multiple
// session"). Each team member keeps exactly one session in its engine: its HeyZubi chat (conversation
// "hq-<botId>-g<generation>"). Everything else HeyZubi asks an engine (the Status test, the Pointer Assistant's
// Claude brain, coding runs) deletes its session as soon as it's done, starting a fresh chat deletes the old one, and
// an hourly tidy removes any extra HeyZubi left behind. Deleting goes through Hermes's own API
// (DELETE /api/sessions/{id}), so Hermes also clears the transcript and its routing; its database is only read here.
import path from 'node:path';
import Database from 'better-sqlite3';
import { db } from './db.js';
import { engineFor, engineHome, engineKind, primaryBotId } from './engine.js';
import { env } from './env.js';

type EngineRef = { url: string; key: string };

/**
 * Everything said with the main team member in HeyZubi (the chat, the Zubi window of Reels Factory, the Pointer Assistant,
 * the Status test) is one Hermes session of this name (Murtaza, 26 Nov 2026: "only 1 chat session under hermes by the
 * name hermes-heyzubi … no new session"). The header makes Hermes run the turn in it; Hermes does one turn at a time.
 * What the model remembers is still each window's own (the stored conversation, or what HeyZubi sends with the turn).
 */
export const CHAT_SESSION = 'hermes-heyzubi';
db.exec("CREATE TABLE IF NOT EXISTS engine_sessions (session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, bot_id TEXT NOT NULL, at INTEGER NOT NULL)");
export const chatHeaders = (botId: string, engine: EngineRef): Record<string, string> => (botId === primaryBotId() && engine.key ? { 'X-Hermes-Session-Key': CHAT_SESSION } : {});
/** That session's id, once a turn has run in it. */
export const chatSessionId = (botId: string): string | null => (db.prepare("SELECT session_id AS s FROM engine_sessions WHERE kind='chat' AND bot_id=?").get(botId) as any)?.s ?? null;

const auth = (engine: EngineRef) => ({ 'content-type': 'application/json', ...(engine.key ? { authorization: `Bearer ${engine.key}` } : {}) });
const patchSession = (engine: EngineRef, sid: string, body: object) => fetch(`${engine.url}/api/sessions/${encodeURIComponent(sid)}`, { method: 'PATCH', headers: auth(engine), body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
/** The session's row appears a moment after its turn starts: tried for half a minute. */
async function patchWhenThere(engine: EngineRef, sid: string, body: object): Promise<Response | null> {
  for (const wait of [100, 200, 300, 400, 500, 500, 1000, 2000, 4000, 8000, 15_000]) {
    await new Promise((r) => setTimeout(r, wait));
    const r = await patchSession(engine, sid, body).catch(() => null);
    if (r && r.status !== 404) return r;
  }
  return null;
}
const named = new Set<string>();
/** After a turn of one of the main team member's conversations started: remember its session and keep its name. */
export function noteChat(botId: string, engine: EngineRef & { home?: string }, res: Response | null | undefined) {
  const sid = res?.headers.get('x-hermes-session-id') ?? '';
  if (!sid || !res?.ok || !Object.keys(chatHeaders(botId, engine)).length) return;
  if (chatSessionId(botId) !== sid) db.transaction(() => {
    db.prepare("DELETE FROM engine_sessions WHERE kind='chat' AND bot_id=?").run(botId);
    db.prepare("INSERT OR REPLACE INTO engine_sessions(session_id,kind,bot_id,at) VALUES (?,'chat',?,?)").run(sid, botId, Date.now());
  })();
  if (named.has(sid)) return;
  named.add(sid);
  void (async () => {
    let r = await patchWhenThere(engine, sid, { title: CHAT_SESSION });
    if (r?.status === 400 && engine.home) {
      // An older session holds the name (Hermes started another by itself): it is put away, never deleted.
      const s = openRO(path.join(engine.home, 'state.db'));
      const old = s?.prepare('SELECT id FROM sessions WHERE title=? AND id<>?').get(CHAT_SESSION, sid) as { id: string } | undefined;
      s?.close();
      if (old) { await patchSession(engine, old.id, { title: `${CHAT_SESSION} until ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, archived: true }).catch(() => null); r = await patchWhenThere(engine, sid, { title: CHAT_SESSION }); }
    }
    if (!r?.ok) { named.delete(sid); console.warn('[sessions] the chat session kept its old name:', r?.status ?? 'no answer'); }
  })().catch(() => named.delete(sid));
}
/** A piece of background work (writing, checking, a coding run) gets a session of its own: hidden at once, deleted when done. */
export function hideOneOff(botId: string, engine: EngineRef, res: Response | null | undefined) {
  const sid = res?.headers.get('x-hermes-session-id') ?? '';
  if (!sid || sid === chatSessionId(botId)) return;
  db.prepare("INSERT OR IGNORE INTO engine_sessions(session_id,kind,bot_id,at) VALUES (?,'work',?,?)").run(sid, botId, Date.now());
  void patchWhenThere(engine, sid, { hidden: true }).catch(() => null);
}

/** Deletes one session from an engine. True when it's gone (or was never there). */
export async function deleteEngineSession(engine: EngineRef, sessionId: string): Promise<boolean> {
  if (!sessionId) return true;
  try {
    const r = await fetch(`${engine.url}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(15_000),
      headers: engine.key ? { authorization: `Bearer ${engine.key}` } : {},
    });
    if (r.ok || r.status === 404) return true;
    console.warn('[sessions] delete refused', r.status, sessionId);
    return false;
  } catch (e) {
    console.warn('[sessions] delete failed', sessionId, (e as Error).message);
    return false;
  }
}

/**
 * Deletes the responses Hermes stored for these sessions (each holds a copy of the conversation's history, and a named
 * conversation resumes from its latest one), so a deleted session's history really goes.
 */
export async function deleteStoredResponses(engine: EngineRef, home: string, sessionIds: Set<string>): Promise<number> {
  if (!sessionIds.size) return 0;
  const r = openRO(path.join(home, 'response_store.db'));
  if (!r) return 0;
  let ids: string[] = [];
  try {
    ids = (r.prepare("SELECT response_id AS id, json_extract(data, '$.session_id') AS sid FROM responses").all() as { id: string; sid: string | null }[])
      .filter((x) => x.sid && sessionIds.has(x.sid)).map((x) => x.id);
  } catch { /* an older engine without the response store */ } finally { r.close(); }
  let gone = 0;
  for (const id of ids) {
    const res = await fetch(`${engine.url}/v1/responses/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(15_000), headers: engine.key ? { authorization: `Bearer ${engine.key}` } : {} }).catch(() => null);
    if (res && (res.ok || res.status === 404)) gone++;
  }
  return gone;
}

/** After a one-off call (its response carries X-Hermes-Session-Id): delete that session, retrying once if still busy. */
export function dropOneOff(engine: EngineRef & { home?: string }, res: Response | null | undefined) {
  const sid = res?.headers.get('x-hermes-session-id') ?? '';
  if (!sid || db.prepare("SELECT 1 FROM engine_sessions WHERE session_id=? AND kind='chat'").get(sid)) return; // never the chat itself
  const forget = (ok: boolean) => { if (ok) db.prepare("DELETE FROM engine_sessions WHERE session_id=? AND kind='work'").run(sid); };
  void deleteEngineSession(engine, sid).then((ok) => {
    forget(ok);
    if (!ok) setTimeout(() => void deleteEngineSession(engine, sid).then(forget), 30_000);
    // A stored run (coding) also leaves its history in the response store.
    if (engine.home) void deleteStoredResponses(engine, engine.home, new Set([sid]));
  });
}

function openRO(file: string): Database.Database | null {
  try { return new Database(file, { readonly: true, fileMustExist: true }); } catch { return null; }
}

/** Conversation name → its current Hermes session, for every conversation HeyZubi named ("hq-…"). */
function hqConversations(home: string): Map<string, string> {
  const out = new Map<string, string>();
  const r = openRO(path.join(home, 'response_store.db'));
  if (!r) return out;
  try {
    for (const { name, sid } of r.prepare("SELECT c.name AS name, json_extract(x.data, '$.session_id') AS sid FROM conversations c JOIN responses x ON x.response_id = c.response_id WHERE c.name LIKE 'hq-%'").all() as { name: string; sid: string | null }[]) {
      if (sid) out.set(name, sid);
    }
  } catch { /* an older engine without the response store */ } finally { r.close(); }
  return out;
}

/**
 * A fresh chat (the generation went up): the old chat's session goes, so the team member keeps one. The main team
 * member's session stays (see CHAT_SESSION) and only what it remembers of the old chat goes.
 */
export async function retireChatSession(botId: string, oldGeneration: number) {
  try {
    if (!engineKind(botId)) return;
    const home = engineHome(botId);
    const sid = home ? hqConversations(home).get(`hq-${botId}-g${oldGeneration}`) : undefined;
    if (!sid) return;
    const engine = await engineFor(botId);
    if (!Object.keys(chatHeaders(botId, engine)).length && !(await deleteEngineSession(engine, sid))) setTimeout(() => void deleteEngineSession(engine, sid), 30_000);
    await deleteStoredResponses(engine, home!, new Set([sid]));
  } catch (e) { console.warn('[sessions] old chat not removed:', (e as Error).message); }
}

export interface ExtraSession { home: string; who: string; id: string; title: string }

/**
 * The sessions HeyZubi made beyond each team member's one: in a team member's own engine, every session that came in
 * through its API (only HeyZubi uses it); in the main engine, which other apps share, only the ones HeyZubi named.
 * Sessions the agents make themselves (scheduled jobs, the board's task runs, Telegram, the Hermes app) aren't touched.
 */
export function extraSessions(): ExtraSession[] {
  const bots = db.prepare("SELECT id, name, generation, engine FROM bots WHERE engine IN ('primary','managed')").all() as { id: string; name: string; generation: number; engine: string }[];
  const reserved = new Set<string>((db.prepare("SELECT session_id AS s FROM engine_sessions WHERE kind='chat'").all() as { s: string }[]).map((x) => x.s));
  const byHome = new Map<string, { who: string; managed: boolean }>();
  for (const b of bots) {
    const home = engineHome(b.id);
    if (!home) continue;
    const sid = hqConversations(home).get(`hq-${b.id}-g${b.generation}`);
    if (sid) reserved.add(sid);
    const key = path.resolve(home);
    if (!byHome.has(key)) byHome.set(key, { who: b.name, managed: b.engine === 'managed' && key !== path.resolve(env.hermesHome) });
  }
  const out: ExtraSession[] = [];
  for (const [home, { who, managed }] of byHome) {
    const s = openRO(path.join(home, 'state.db'));
    if (!s) continue;
    try {
      const rows = s.prepare("SELECT id, COALESCE(title,'') AS title FROM sessions WHERE source='api_server' AND parent_session_id IS NULL").all() as { id: string; title: string }[];
      const ours = managed ? null : new Set(hqConversations(home).values());
      for (const r of rows) {
        if (reserved.has(r.id)) continue;
        if (managed || ours!.has(r.id) || r.title === 'HeyZubi connection test') out.push({ home, who, id: r.id, title: r.title });
      }
    } catch { /* an engine without sessions yet */ } finally { s.close(); }
  }
  return out;
}

let tidying = false;
const BOOT = Date.now();

/** Deletes the extra sessions (see extraSessions). Returns how many went. */
export async function tidyEngineSessions(): Promise<number> {
  if (tidying) return 0;
  tidying = true;
  let gone = 0;
  try {
    // Background work whose session outlived it (a restart, a kill): nothing runs longer than an hour.
    for (const w of db.prepare("SELECT session_id AS id, bot_id AS bot, at FROM engine_sessions WHERE kind='work'").all() as { id: string; bot: string; at: number }[]) {
      if (w.at > BOOT && Date.now() - w.at < 60 * 60_000) continue;
      try { if (await deleteEngineSession(await engineFor(w.bot), w.id)) { db.prepare("DELETE FROM engine_sessions WHERE session_id=? AND kind='work'").run(w.id); gone++; } } catch { /* engine down: next time */ }
    }
    const extras = extraSessions();
    if (!extras.length) return gone;
    const bots = db.prepare("SELECT id FROM bots WHERE engine IN ('primary','managed')").all() as { id: string }[];
    const engineOf = new Map<string, EngineRef>();
    for (const b of bots) {
      const home = engineHome(b.id);
      if (!home) continue;
      const key = path.resolve(home);
      if (engineOf.has(key) || !extras.some((x) => x.home === key)) continue;
      try { engineOf.set(key, await engineFor(b.id)); } catch { /* engine down: next time */ }
    }
    const done = new Map<string, Set<string>>();
    for (const x of extras) {
      const engine = engineOf.get(x.home);
      if (engine && (await deleteEngineSession(engine, x.id))) {
        gone++;
        if (!done.has(x.home)) done.set(x.home, new Set());
        done.get(x.home)!.add(x.id);
      }
    }
    for (const [home, ids] of done) await deleteStoredResponses(engineOf.get(home)!, home, ids);
    if (gone) console.log(`[sessions] removed ${gone} extra Hermes session${gone === 1 ? '' : 's'} (one per team member kept)`);
  } finally { tidying = false; }
  return gone;
}

/** Tidy shortly after start (engines are up by then) and every hour. */
export function initSessionTidy() {
  setTimeout(() => void tidyEngineSessions(), 2 * 60_000).unref();
  setInterval(() => void tidyEngineSessions(), 60 * 60_000).unref();
}
