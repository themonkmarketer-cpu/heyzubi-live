// Settings › Status › Health (after Theo's health check): what HeyZubi needs to work, checked live, each with what to
// do when it isn't right. Read-only, apart from a throwaway file that proves the data folder takes writes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { engineHome, engineInfo, engineKind, ownClaudeSignIn } from './engine.js';
import { env } from './env.js';
import { mcpLive } from './mcp.js';
import { extraSessions } from './engine-sessions.js';
import { agentSkillFiles, skillFront } from './routes-config.js';

export interface HealthItem { key: string; title: string; status: 'ok' | 'warn' | 'bad'; line: string; detail: string[] }

const MIN = 60_000;
const ago = (ms: number) => (ms < 2 * MIN ? 'just now' : ms < 120 * MIN ? `${Math.round(ms / MIN)} min ago` : ms < 48 * 3600_000 ? `${Math.round(ms / 3600_000)} h ago` : `${Math.round(ms / 86400_000)} days ago`);

export async function healthChecks(userId: string): Promise<HealthItem[]> {
  const bots = db.prepare("SELECT id, name, engine, is_primary FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at").all(userId) as { id: string; name: string; engine: string | null; is_primary: number }[];
  const items: HealthItem[] = [];

  // 1. Each team member's engine answers, and runs on its own Claude sign-in (not one borrowed from the main agent).
  const ready = new Map<string, boolean>();
  const engines = await Promise.all(bots.map(async (b) => {
    if (!engineKind(b.id)) return { b, state: 'none' as string, own: false };
    try {
      const info = await Promise.race([engineInfo(b.id), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
      const home = engineHome(b.id);
      const own = engineKind(b.id) === 'primary' || (!!home && ownClaudeSignIn(home));
      return { b, state: info.status as string, own };
    } catch { return { b, state: 'error', own: false }; }
  }));
  for (const e of engines) ready.set(e.b.id, e.state === 'ready');
  const down = engines.filter((e) => e.state !== 'ready' && e.state !== 'none');
  const borrowed = engines.filter((e) => e.state !== 'none' && !e.own);
  items.push({
    key: 'engines', title: 'Team engines',
    status: down.length ? 'bad' : borrowed.length ? 'warn' : 'ok',
    line: down.length ? `${down.map((e) => e.b.name).join(', ')} not answering`
      : borrowed.length ? `${borrowed.map((e) => e.b.name).join(', ')} borrowing the main Claude sign-in`
      : `${engines.filter((e) => e.state === 'ready').length} running, each on its own Claude sign-in`,
    detail: [
      ...engines.map((e) => `${e.b.name}: ${e.state === 'none' ? 'no engine yet' : e.state === 'ready' ? 'running' : e.state}${e.state !== 'none' ? (e.own ? ', own sign-in' : ', no sign-in of its own') : ''}`),
      ...(borrowed.length ? ['Fix: open the team member’s settings › Engine › Sign in to Claude.'] : []),
      ...(down.length ? ['Fix: open the team member’s settings › Engine › Restart.'] : []),
    ],
  });

  // 2. The HeyZubi tools Zubi uses (the hq MCP server): is her engine connected and listening for tool changes?
  const live = mcpLive();
  items.push({
    key: 'mcp', title: 'HeyZubi tools for Zubi',
    status: live.streams > 0 ? 'ok' : live.sessions > 0 ? 'warn' : 'bad',
    line: live.streams > 0 ? `Connected (${live.streams} listening)` : live.sessions > 0 ? 'Connected, but not listening for new tools' : 'Not connected since HeyZubi started',
    detail: live.streams > 0 ? ['New HeyZubi tools reach her without a restart.'] : ['Fix: restart Zubi’s engine (Status › Agent) so it reconnects to HeyZubi’s tools.'],
  });

  // 3. Routines: each switched-on routine has a team member whose engine is running.
  const routines = db.prepare('SELECT r.name, r.enabled, r.bot_id, b.name AS bot, COALESCE(b.hidden,0) AS hidden FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=?').all(userId) as { name: string; enabled: number; bot_id: string; bot: string; hidden: number }[];
  const on = routines.filter((r) => r.enabled);
  const orphan = on.filter((r) => r.hidden || !ready.get(r.bot_id));
  items.push({
    key: 'routines', title: 'Routines',
    status: orphan.length ? 'warn' : 'ok',
    line: !routines.length ? 'No routines yet' : orphan.length ? `${orphan.length} of ${on.length} switched-on routines have a team member that isn’t running` : `${on.length} switched on, every one with a running team member`,
    detail: orphan.map((r) => `“${r.name}” belongs to ${r.bot}${r.hidden ? ' (removed)' : ', whose engine isn’t running'}`),
  });

  // 4. Skills: each has a description (the agent picks a skill by it; one without is never chosen).
  const homes = new Map<string, string>();
  for (const b of bots) { const h = engineHome(b.id); if (h && !homes.has(h)) homes.set(h, b.name); }
  let skills = 0;
  const bare: string[] = [];
  for (const [home, who] of homes) {
    for (const f of agentSkillFiles(home)) {
      skills++;
      let text = '';
      try { text = fs.readFileSync(f, 'utf8').slice(0, 4000); } catch { /* unreadable */ }
      if (!skillFront(text, 'description')) bare.push(`${who}: ${path.relative(path.join(home, 'skills'), path.dirname(f)) || path.basename(path.dirname(f))}`);
    }
  }
  items.push({
    key: 'skills', title: 'Skills',
    status: bare.length ? 'warn' : 'ok',
    line: bare.length ? `${bare.length} of ${skills} have no description` : `${skills} skills, all with a description`,
    detail: bare.length ? [...bare.slice(0, 12), ...(bare.length > 12 ? [`and ${bare.length - 12} more`] : []), 'Fix: ask the team member to add a one-line description to these skills.'] : [],
  });

  // 4b. Hermes sessions: one per team member (its chat); anything more is removed every hour or with "Remove now".
  const extra = extraSessions();
  const per = new Map<string, number>();
  for (const x of extra) per.set(x.who, (per.get(x.who) ?? 0) + 1);
  items.push({
    key: 'sessions', title: 'Hermes sessions',
    status: extra.length ? 'warn' : 'ok',
    line: extra.length ? `${extra.length} extra beyond one per team member` : 'One per team member',
    detail: extra.length ? [...[...per].map(([who, n]) => `${who}: ${n} extra`), 'They’re removed every hour, or now with Remove now. Scheduled jobs, board task runs and Hermes-app chats aren’t touched.'] : [],
  });

  // 5. The owner's-words safety hook: the script is there and every engine has it switched on.
  const script = path.join(env.hermesHome, 'agent-hooks', 'hq_owner_words.py');
  const hasScript = fs.existsSync(script);
  const unapproved: string[] = [];
  if (hasScript) {
    for (const [home, who] of homes) {
      try {
        const a = JSON.parse(fs.readFileSync(path.join(home, 'shell-hooks-allowlist.json'), 'utf8'));
        if (!(a?.approvals ?? []).some((x: any) => x?.event === 'pre_tool_call' && String(x?.command ?? '').includes('hq_owner_words'))) unapproved.push(who);
      } catch { unapproved.push(who); }
    }
  }
  items.push({
    key: 'hook', title: 'Safety hook (owner’s words)',
    status: !hasScript ? 'bad' : unapproved.length ? 'warn' : 'ok',
    line: !hasScript ? 'Missing: bots could send or post without your words' : unapproved.length ? `Not switched on for ${unapproved.join(', ')}` : `On for ${homes.size} engine${homes.size === 1 ? '' : 's'}`,
    detail: !hasScript ? ['Fix: the hook script is missing from the Hermes home (agent-hooks/hq_owner_words.py); redeploy HeyZubi.'] : unapproved.length ? ['Fix: restart those engines; HeyZubi switches the hook on as it starts them.'] : [],
  });

  // 6. Storage: the database answers and checks out, and the data folder takes writes.
  const dataDir = path.dirname(env.dbPath);
  let dbOk = false, dirOk = false, note = '';
  try { dbOk = (db.prepare('PRAGMA quick_check').get() as any)?.quick_check === 'ok'; } catch (e) { note = (e as Error).message; }
  try {
    const probe = path.join(dataDir, `.health-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
    fs.unlinkSync(probe);
    dirOk = true;
  } catch (e) { note ||= (e as Error).message; }
  let freeGb: number | null = null;
  try { const s = fs.statfsSync(dataDir); freeGb = Math.round((s.bavail * s.bsize) / 1e8) / 10; } catch { /* unknown */ }
  items.push({
    key: 'storage', title: 'Database and data folder',
    status: dbOk && dirOk ? (freeGb !== null && freeGb < 2 ? 'warn' : 'ok') : 'bad',
    line: dbOk && dirOk ? `Healthy and writable${freeGb !== null ? ` · ${freeGb} GB free` : ''}` : !dbOk ? 'The database failed its check' : 'The data folder can’t be written to',
    detail: [...(note ? [note.slice(0, 160)] : []), ...(freeGb !== null && freeGb < 2 ? ['Fix: free some disk space on hermes-box.'] : [])],
  });

  // 7. The Windows app: paired, and seen lately (the app checks in every minute while it runs).
  const devices = db.prepare('SELECT name, last_used_at, info FROM desktop_devices WHERE user_id=? ORDER BY last_used_at DESC').all(userId) as { name: string; last_used_at: number | null; info: string | null }[];
  const latest = devices[0];
  let version = '';
  try { version = latest?.info ? JSON.parse(latest.info).version ?? '' : ''; } catch { /* none */ }
  const since = latest?.last_used_at ? Date.now() - latest.last_used_at : Infinity;
  items.push({
    key: 'desktop', title: 'Windows app',
    status: !latest ? 'warn' : since < 10 * MIN && version >= '0.3.0' ? 'ok' : 'warn',
    line: !latest ? 'No PC paired' : `${latest.name}${version ? ` · app ${version}` : ' · older app'} · last seen ${Number.isFinite(since) ? ago(since) : 'never'}`,
    detail: [
      ...devices.slice(1).map((d) => `${d.name} · last seen ${d.last_used_at ? ago(Date.now() - d.last_used_at) : 'never'}`),
      ...(!latest ? ['Fix: Settings › Windows app › Pair a computer.'] : version < '0.3.0' ? ['Fix: download the new app from Settings › Windows app (it can’t update itself).'] : since >= 10 * MIN ? ['The app isn’t running on that PC right now (it checks in every minute while it runs).'] : []),
    ],
  });

  return items;
}
