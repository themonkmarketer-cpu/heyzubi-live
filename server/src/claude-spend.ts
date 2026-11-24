// Claude spend per bot per day (from Theo's per-bot usage). Hermes already estimates every session's cost at
// Anthropic's prices, with cache reads and writes counted properly (sessions.estimated_cost_usd in its
// state.db). This module reads that, read-only, and works out today's share: each session's cost now, minus
// what it had cost when the day began (a small baseline file of our own). HeyZubi's chats map to their Hermes
// sessions through the engine's response store, so a bot's own spend is known; the rest of the agent's spend
// is shown by channel (scheduled jobs, Telegram, Slack, the desktop app…). No message content is read.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from './env.js';

const FILE = path.join(path.dirname(env.dbPath), 'claude-baseline.json');
const pad = (n: number) => String(n).padStart(2, '0');
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

interface Baseline { day: string; takenAt: number; costs: Record<string, number> }
interface SessionRow { id: string; parent: string | null; source: string; started: number; cost: number }

const SOURCE_NAMES: Record<string, string> = {
  api_server: 'Other apps (Zubi HQ, tools)', cron: 'Scheduled jobs', telegram: 'Telegram', slack: 'Slack', whatsapp: 'WhatsApp',
  desktop: 'Desktop app', cli: 'Terminal', oneshot: 'One-off runs', discord: 'Discord', email: 'Email',
};

function openRO(file: string): Database.Database | null {
  try { return new Database(file, { readonly: true, fileMustExist: true }); } catch { return null; }
}

function readSessions(home: string): SessionRow[] | null {
  const s = openRO(path.join(home, 'state.db'));
  if (!s) return null;
  try {
    return s.prepare('SELECT id, parent_session_id AS parent, COALESCE(source, \'\') AS source, COALESCE(started_at, 0) AS started, COALESCE(estimated_cost_usd, 0) AS cost FROM sessions').all() as SessionRow[];
  } catch { return null; } finally { s.close(); }
}

/** HeyZubi chat sessions: conversation "hq-<botId>-g<n>" → its latest Hermes session. */
function botSessions(home: string): Map<string, string> {
  const out = new Map<string, string>();
  const r = openRO(path.join(home, 'response_store.db'));
  if (!r) return out;
  try {
    const rows = r.prepare("SELECT c.name AS name, json_extract(x.data, '$.session_id') AS sid FROM conversations c JOIN responses x ON x.response_id = c.response_id WHERE c.name LIKE 'hq-%'").all() as { name: string; sid: string | null }[];
    for (const { name, sid } of rows) {
      const m = /^hq-(.+)-g\d+$/.exec(name);
      if (m && sid) out.set(sid, m[1]);
    }
  } catch { /* an older engine without the response store */ } finally { r.close(); }
  return out;
}

function readBaseline(): Baseline | null {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) as Baseline; } catch { return null; }
}
function writeBaseline(b: Baseline) {
  try { fs.writeFileSync(FILE, JSON.stringify(b), { mode: 0o600 }); } catch (e) { console.warn('[claude] baseline not saved:', (e as Error).message); }
}

/** Today's starting point: every session's cost the first time we look on a new day. */
function baseline(rows: SessionRow[]): Baseline {
  const day = today();
  const b = readBaseline();
  if (b?.day === day) return b;
  const fresh = { day, takenAt: Date.now(), costs: Object.fromEntries(rows.map((r) => [r.id, r.cost])) };
  writeBaseline(fresh);
  return fresh;
}

export interface ClaudeSpend {
  available: boolean;
  day: string;
  /** When today's baseline was taken (spend before it isn't counted). */
  since: number;
  total: number;
  byBot: Record<string, number>;
  bySource: { key: string; label: string; usd: number }[];
  note: string;
}

export function claudeSpendToday(home = env.hermesHome): ClaudeSpend {
  const rows = readSessions(home);
  const empty: ClaudeSpend = { available: false, day: today(), since: Date.now(), total: 0, byBot: {}, bySource: [], note: 'Claude spend is unavailable: the engine’s records couldn’t be read.' };
  if (!rows) return empty;
  const base = baseline(rows);
  const bots = botSessions(home);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const botOf = (r: SessionRow): string | undefined => {
    // A helper the agent started inside a chat counts toward that chat's bot.
    for (let x: SessionRow | undefined = r, hops = 0; x && hops < 4; x = x.parent ? byId.get(x.parent) : undefined, hops++) {
      const b = bots.get(x.id);
      if (b) return b;
    }
    return undefined;
  };
  let total = 0;
  let changed = false;
  const byBot: Record<string, number> = {};
  const src: Record<string, number> = {};
  for (const r of rows) {
    let start = base.costs[r.id];
    if (start === undefined) {
      // New since the baseline: all of it is today's. Older but unseen (rare): start counting from now.
      if (r.started * 1000 >= base.takenAt - 60_000) start = 0;
      else { base.costs[r.id] = r.cost; changed = true; continue; }
    }
    const d = r.cost - start;
    if (!(d > 0.00001)) continue;
    total += d;
    const bot = botOf(r);
    if (bot) byBot[bot] = (byBot[bot] ?? 0) + d;
    else src[r.source || 'other'] = (src[r.source || 'other'] ?? 0) + d;
  }
  if (changed) writeBaseline(base);
  const bySource = Object.entries(src).sort((a, b) => b[1] - a[1]).map(([key, usd]) => ({ key, label: SOURCE_NAMES[key] ?? key, usd }));
  return {
    available: true, day: base.day, since: base.takenAt, total, byBot, bySource,
    note: 'Hermes’s own estimates at Anthropic’s prices, cache included; the exact bill is at console.anthropic.com.',
  };
}

// Take the day's baseline soon after midnight even when nobody opens the app.
setInterval(() => { try { const rows = readSessions(env.hermesHome); if (rows) baseline(rows); } catch { /* next time */ } }, 5 * 60_000).unref();
