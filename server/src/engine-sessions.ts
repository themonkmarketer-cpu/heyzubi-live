// One Hermes session per team member (Murtaza, 25 Nov 2026: "1 session reserved per agent on hermes… no multiple
// session"). Each team member keeps exactly one session in its engine: its HeyZubi chat (conversation
// "hq-<botId>-g<generation>"). Everything else HeyZubi asks an engine (the Status test, the Pointer Assistant's
// Claude brain, coding runs) deletes its session as soon as it's done, starting a fresh chat deletes the old one, and
// an hourly tidy removes any extra HeyZubi left behind. Deleting goes through Hermes's own API
// (DELETE /api/sessions/{id}), so Hermes also clears the transcript and its routing; its database is only read here.
import path from 'node:path';
import Database from 'better-sqlite3';
import { db } from './db.js';
import { engineFor, engineHome, engineKind } from './engine.js';
import { env } from './env.js';

type EngineRef = { url: string; key: string };

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
  if (!sid) return;
  void deleteEngineSession(engine, sid).then((ok) => {
    if (!ok) setTimeout(() => void deleteEngineSession(engine, sid), 30_000);
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

/** A fresh chat (the generation went up): the old chat's session goes, so the team member keeps one. */
export async function retireChatSession(botId: string, oldGeneration: number) {
  try {
    if (!engineKind(botId)) return;
    const home = engineHome(botId);
    const sid = home ? hqConversations(home).get(`hq-${botId}-g${oldGeneration}`) : undefined;
    if (!sid) return;
    const engine = await engineFor(botId);
    if (!(await deleteEngineSession(engine, sid))) setTimeout(() => void deleteEngineSession(engine, sid), 30_000);
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
  const reserved = new Set<string>();
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

/** Deletes the extra sessions (see extraSessions). Returns how many went. */
export async function tidyEngineSessions(): Promise<number> {
  if (tidying) return 0;
  tidying = true;
  let gone = 0;
  try {
    const extras = extraSessions();
    if (!extras.length) return 0;
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
