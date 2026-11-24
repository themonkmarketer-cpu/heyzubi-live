// Settings › Usage (after Theo's Usage page): per team member, how much they worked in a window (turns), the tokens
// and the Claude cost Hermes estimated, plus the other services' spend (xAI, Gemini, Sarvam) from our own log.
import { Hono } from 'hono';
import { claudeUsageSince, type UsageLine } from './claude-spend.js';
import { db } from './db.js';
import { engineHome } from './engine.js';
import { env } from './env.js';
import type { AuthVars } from './lib/auth.js';
import { usageFrom } from './usage.js';

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAYS = [1, 7, 30];
type Sums = { turns: number; tokens: number; usd: number };

export const usageApi = new Hono<AuthVars>();

usageApi.get('/', (c) => {
  const user = c.get('user');
  const days = DAYS.includes(Number(c.req.query('days'))) ? Number(c.req.query('days')) : 7;
  // The window starts at local midnight: today only, or today and the days before it.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const since = start.getTime();

  const bots = db.prepare("SELECT id, name, engine FROM bots WHERE user_id=? AND COALESCE(kind, 'agent') != 'room' AND COALESCE(hidden, 0) = 0 ORDER BY is_primary DESC, created_at").all(user.id) as { id: string; name: string; engine: string | null }[];
  const ownsPrimary = bots.some((b) => b.engine === 'primary');
  const mine = new Set(bots.map((b) => b.id));
  const lines: UsageLine[] = [];
  let available = false;
  // The main engine holds the chats of every bot that runs on it, plus the agent's other channels (shown to its owner).
  if (ownsPrimary) {
    const got = claudeUsageSince(env.hermesHome, since, null);
    if (got) { available = true; lines.push(...got.filter((l) => !l.botId || mine.has(l.botId))); }
  }
  // A team member with an engine of its own: everything in it is theirs.
  for (const b of bots) {
    if (b.engine !== 'managed') continue;
    const home = engineHome(b.id);
    const got = home ? claudeUsageSince(home, since, b.id) : null;
    if (got) { available = true; lines.push(...got.map((l) => ({ ...l, botId: b.id, key: `bot:${b.id}` }))); }
  }
  const per = new Map<string, Sums>();
  const channels = new Map<string, Sums & { label: string }>();
  for (const l of lines) {
    const r = l.botId ? (per.get(l.botId) ?? { turns: 0, tokens: 0, usd: 0 }) : (channels.get(l.key) ?? { label: l.label, turns: 0, tokens: 0, usd: 0 });
    r.turns += l.turns; r.tokens += l.tokens; r.usd += l.usd;
    if (l.botId) per.set(l.botId, r); else channels.set(l.key, r as Sums & { label: string });
  }
  // One row per team member (idle ones too), then the agent's other channels.
  const rows = bots.map((b) => ({ botId: b.id, name: b.name, ...(per.get(b.id) ?? { turns: 0, tokens: 0, usd: 0 }) }));
  const other = [...channels.entries()].map(([key, r]) => ({ key, ...r })).sort((a, b) => b.usd - a.usd);
  const sum = (xs: Sums[]) => xs.reduce((a, r) => ({ turns: a.turns + r.turns, tokens: a.tokens + r.tokens, usd: a.usd + r.usd }), { turns: 0, tokens: 0, usd: 0 });
  const services = usageFrom(user.id, dayOf(start));
  return c.json({
    days, since, available, rows, other,
    total: sum([...rows, ...other]),
    services: { by: services.by, total: services.total, sarvamInr: services.sarvamInr, note: services.note },
    note: 'Claude cost is Hermes’s own estimate at Anthropic’s API prices, cache included. A chat’s tokens and cost are split across days by when its replies came. With a Claude subscription sign-in these are likely not real charges.',
  });
});
