import { Hono } from 'hono';
import { db, now } from './db.js';
import './db-config.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { env } from './env.js';
import { libraryRoot } from './paths.js';
import { emitBot, getBotRow, listRoutines, listTasks } from './store.js';
import { computerState, readyScreen, resetBotScreen } from './computer.js';
import { box } from './box.js';
import { orgo } from './orgo.js';
import { openTerminal } from './desk.js';
import { engineHome, engineInfo, engineKind, engineOwner, fixOwnership, forgetEngineOptions, pruneDeadPool, restartEngine, stopOwnScreen } from './engine.js';
import { cleanChanges, configureProfile, describeProfile, profileNameFor } from './hermes-profile.js';
import { syncIdentity } from './hermes-identity.js';
import { listMemories } from './engine-memory.js';
import { idleConfig, viewerCount } from './idle.js';
import type { LibraryFile, Skill } from './types.js';

/**
 * Bot settings, skills, library, computer controls and memory maintenance.
 * Mounted next to routes.ts in index.ts; every path here needs a signed-in user.
 */
export const configApi = new Hono<AuthVars>();

for (const p of ['/bots/*', '/skills/*', '/computer/*']) configApi.use(p, requireUser);

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

const toSkill = (s: any): Skill => ({ id: s.id, botId: s.bot_id, name: s.name, description: s.description ?? '', body: s.body, createdAt: s.created_at, updatedAt: s.updated_at ?? s.created_at });
const listSkills = (botId: string) => (db.prepare('SELECT * FROM skills WHERE bot_id=? ORDER BY created_at ASC').all(botId) as any[]).map(toSkill);

// ---------- settings bundle ----------

configApi.get('/bots/:id/settings', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({
    memories: listMemories(b.id),
    skills: listSkills(b.id),
    routines: listRoutines(b.id),
    tasks: listTasks(b.id),
    // The agent keeps its own memory and trims its own context; there is nothing for the app to maintain.
    memory: { lastConsolidatedAt: null, historyChars: 0, compactAtChars: 0, lastCompaction: null },
  });
});

// ---------- skills ----------

function cleanSkill(p: any, partial = false): { name?: string; description?: string; body?: string } | string {
  const out: { name?: string; description?: string; body?: string } = {};
  if (p.name !== undefined || !partial) {
    const name = String(p.name ?? '').trim();
    if (!name) return 'Give the skill a name';
    out.name = name.slice(0, 80);
  }
  if (p.body !== undefined || !partial) {
    const body = String(p.body ?? '').trim();
    if (!body) return 'Write the steps for this skill';
    out.body = body.slice(0, 20_000);
  }
  if (p.description !== undefined) out.description = String(p.description).trim().slice(0, 300);
  return out;
}

configApi.get('/bots/:id/skills', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ skills: listSkills(b.id) }) : c.json({ error: 'not found' }, 404);
});

// ---------- skills the agent wrote itself (from Theo) ----------
// Hermes lets the agent save and update step-by-step skills in its own home (skills/**/SKILL.md) as it learns.
// Shown here read-only, newest first, with a warning on any that look like they hold a secret.

const SECRET_LIKE = /(\bsk-[A-Za-z0-9_-]{20,}|\bxai-[A-Za-z0-9]{20,}|\bAIza[0-9A-Za-z_-]{30,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bAKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|\b(api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{16,})/i;
const front = (text: string, key: string) => {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  const line = m?.[1].split('\n').find((l) => l.toLowerCase().startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : '';
};

function agentSkillFiles(home: string): string[] {
  const root = path.join(home, 'skills');
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name === 'SKILL.md') out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

configApi.get('/bots/:id/agent-skills', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const home = engineHome(b.id);
  if (!home) return c.json({ skills: [] });
  const root = path.join(home, 'skills');
  const skills = agentSkillFiles(home).map((file) => {
    let text = '';
    let updated = 0;
    try { text = fs.readFileSync(file, 'utf8').slice(0, 200_000); updated = fs.statSync(file).mtimeMs; } catch { /* unreadable */ }
    const rel = path.relative(root, file).split(path.sep).join('/');
    const parts = rel.split('/');
    return {
      path: rel,
      name: front(text, 'name') || parts[parts.length - 2] || rel,
      description: front(text, 'description').slice(0, 300),
      category: parts.length > 2 ? parts[0] : '',
      updated,
      size: text.length,
      secretLike: SECRET_LIKE.test(text),
    };
  }).sort((x, y) => y.updated - x.updated);
  return c.json({ skills });
});

configApi.get('/bots/:id/agent-skills/view', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const home = engineHome(b.id);
  const rel = String(c.req.query('path') ?? '');
  if (!home || !rel.endsWith('SKILL.md')) return c.json({ error: 'not found' }, 404);
  const root = path.resolve(home, 'skills');
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return c.json({ error: 'not found' }, 404);
  try { return c.json({ path: rel, content: fs.readFileSync(file, 'utf8').slice(0, 200_000) }); } catch { return c.json({ error: 'not found' }, 404); }
});

configApi.post('/bots/:id/skills', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await c.req.json().catch(() => ({})));
  if (typeof s === 'string') return c.json({ error: s }, 400);
  const id = newId('skl');
  db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, b.id, s.name, s.body, s.description ?? '', now(), now());
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(id)) });
});

const ownSkill = (userId: string, id: string) =>
  db.prepare('SELECT s.* FROM skills s JOIN bots b ON b.id=s.bot_id WHERE s.id=? AND b.user_id=?').get(id, userId) as any;

configApi.patch('/skills/:id', async (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await c.req.json().catch(() => ({})), true);
  if (typeof s === 'string') return c.json({ error: s }, 400);
  db.prepare('UPDATE skills SET name=?, body=?, description=?, updated_at=? WHERE id=?').run(s.name ?? cur.name, s.body ?? cur.body, s.description ?? cur.description ?? '', now(), cur.id);
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(cur.id)) });
});

configApi.delete('/skills/:id', (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  db.prepare('DELETE FROM skills WHERE id=?').run(cur.id);
  return c.json({ ok: true });
});

// ---------- memory maintenance (now the agent's own job; kept so older clients get an answer) ----------

configApi.post('/bots/:id/memories/consolidate', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ added: [], skipped: 0, considered: 0 });
});

configApi.post('/bots/:id/compact', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ itemsBefore: 0, itemsAfter: 0, compacted: false });
});

// ---------- the agent behind a bot: model, sign-in, restart ----------

// ---------- the bot's Hermes profile (what Hermes's own Edit Profile shows) ----------
// Read and saved through Hermes's own profiles.describe / profiles.configure (hermes-profile.ts), so HeyZubi and the
// Hermes app edit one profile: description, soul (SOUL.md), model, skills, toolsets and MCP servers.

configApi.get('/bots/:id/profile', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (!profileNameFor(b.id)) return c.json({ profile: null });
  try {
    const profile = await describeProfile(b.id);
    // The profile's description is the bot's description here too (a change made in Hermes comes across).
    const desc = String(profile.description ?? '').trim();
    if (desc && desc !== b.description) {
      db.prepare('UPDATE bots SET description=?, updated_at=? WHERE id=?').run(desc, now(), b.id);
      emitBot(b.id);
    }
    return c.json({ profile });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

configApi.put('/bots/:id/profile', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (!profileNameFor(b.id)) return c.json({ error: `${b.name} is not a Hermes profile.` }, 409);
  const changes = cleanChanges(await c.req.json().catch(() => null));
  if (typeof changes === 'string') return c.json({ error: changes }, 400);
  try {
    const result = await configureProfile(b.id, changes);
    // Hermes asks first before some models (cost or data policy): pass its question on; nothing was switched.
    if (result.confirm_required) return c.json({ confirmRequired: true, message: result.confirm_message ?? 'Hermes asks you to confirm this model.', applied: result.applied ?? {} });
    if (changes.description !== undefined) {
      db.prepare('UPDATE bots SET description=?, updated_at=? WHERE id=?').run(changes.description.trim(), now(), b.id);
      emitBot(b.id);
      void syncIdentity(b.id); // its character can follow the description
    }
    // What the agent runs with changed: a team member's agent starts again with it. The main agent belongs to the
    // computer's Hermes, which picks up its own profile changes.
    const runs = ['soul', 'model', 'disabled_skills', 'enabled_toolsets', 'enabled_mcp_servers'].some((k) => k in changes);
    if (runs && engineKind(b.id) === 'managed') {
      forgetEngineOptions(b.id);
      restartEngine(b.id).catch((e) => console.warn('[profile] restart after save:', e?.message ?? e));
    }
    const failed = Object.entries(result.applied ?? {}).filter(([k, v]) => v === false && !k.endsWith('_conflicts')).map(([k]) => k);
    return c.json({ ok: failed.length === 0, failed, profile: await describeProfile(b.id) });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

configApi.get('/bots/:id/engine', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ engine: await engineInfo(b.id) });
});

/** Which model this bot's turns ask for. Empty values go back to the agent's own default. */
configApi.patch('/bots/:id/engine', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const p = await c.req.json<{ provider?: string | null; model?: string | null }>().catch(() => ({} as { provider?: string | null; model?: string | null }));
  const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
  if (p.provider !== undefined) db.prepare('UPDATE bots SET provider=?, updated_at=? WHERE id=?').run(clean(p.provider), now(), b.id);
  if (p.model !== undefined) db.prepare('UPDATE bots SET model=?, updated_at=? WHERE id=?').run(clean(p.model), now(), b.id);
  emitBot(b.id);
  return c.json({ engine: await engineInfo(b.id) });
});

/**
 * Sign in to a model provider (a Claude, ChatGPT or Grok subscription, or an API key). Hermes does
 * the sign-in itself; we open its command in a terminal on the bot's screen, where the user
 * finishes it through the live view.
 */
configApi.post('/bots/:id/engine/login', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const home = engineHome(b.id);
  if (!home) return c.json({ error: 'This team member has no agent.' }, 409);
  // The agent's files are on the machine this server runs on; a terminal on another machine cannot reach them.
  if (!box.local) return c.json({ error: 'Sign-in opens a terminal on the computer. It works once the app runs on that computer.' }, 409);
  const { provider } = await c.req.json<{ provider?: string }>().catch(() => ({} as { provider?: string }));
  if (provider !== undefined && !/^[a-z0-9][a-z0-9._-]{0,40}$/.test(provider)) return c.json({ error: 'bad provider' }, 400);
  // A fresh sign-in replaces the refused ones (for a team member, usually a dead copy of Zubi's).
  if (provider && engineKind(b.id) === 'managed') pruneDeadPool(home, provider);
  // The sign-in opens its page in a browser on this bot's screen. The screens run as root, where Chromium only starts
  // with --no-sandbox, so Python's webbrowser (which Hermes uses) gets a small launcher through BROWSER: it starts
  // Chromium in the background with a throwaway profile (apart from the bot's own browser) and returns at once.
  const launcher = '/tmp/heyzubi-open-browser';
  try {
    fs.writeFileSync(launcher, [
      '#!/bin/sh',
      '# HeyZubi: open a sign-in link in Chromium on this screen (root needs --no-sandbox).',
      `chromium --no-sandbox --no-first-run --no-default-browser-check --user-data-dir="\${HEYZUBI_SIGNIN_PROFILE:-/tmp/heyzubi-signin}" "$@" >/dev/null 2>&1 &`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.chmodSync(launcher, 0o755);
  } catch (e) { console.warn('[engine] sign-in browser launcher not written:', (e as Error).message); }
  const browser = `BROWSER=${box.quote(`${launcher} %s`)} HEYZUBI_SIGNIN_PROFILE=${box.quote(`/tmp/heyzubi-signin-${b.id}`)}`;
  // A Hermes profile's sign-in is saved as the Hermes user, who owns the profile's files.
  const owner = engineOwner(b.id);
  const asOwner = owner ? `setpriv --reuid=${owner.uid} --regid=${owner.gid} --clear-groups env HOME=${box.quote(home)} ` : '';
  const hermes = `${browser} ${asOwner}HERMES_HOME=${box.quote(home)} ${box.quote(env.hermesBin)}`;
  // Claude subscriptions sign in with OAuth; without the flag Hermes asks for an API key.
  const cmd = !provider ? `${hermes} model` : `${hermes} auth add ${provider}${provider === 'anthropic' ? ' --type oauth' : ''}`;
  try {
    const s = await readyScreen(user.id, b.id);
    await openTerminal(s.screenId, cmd, provider ? `Sign in: ${provider}` : 'Choose a model');
    forgetEngineOptions(b.id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

// ---------- Claude sign-in in the owner's own browser (team members) ----------
// Hermes' Claude sign-in prints a link, then waits for the code Claude shows after "Authorize". HeyZubi runs it in the
// background and hands the link to the owner's own browser (already signed in to Claude), and the code the owner
// pastes back in the app goes to Hermes' prompt. No screen needed. Only for team members (managed agents): the
// primary agent's sign-in belongs to the computer's own Hermes. The code is never logged or stored.
interface SignIn { proc: import('node:child_process').ChildProcess; out: string; url: string | null; timer: NodeJS.Timeout }
const signIns = new Map<string, SignIn>();
const CLAUDE_URL = /https:\/\/claude\.ai\/oauth\/authorize\?[^\s'"<>]+/;
// Anything that looks like a token is cut from what goes back to the page.
const scrub = (s: string) => s.replace(/sk-ant-[\w-]+/g, '[hidden]').replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[hidden]');

function endSignIn(botId: string) {
  const s = signIns.get(botId);
  if (!s) return;
  clearTimeout(s.timer);
  if (s.proc.exitCode === null) s.proc.kill();
  signIns.delete(botId);
}

configApi.post('/bots/:id/engine/signin/start', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const home = engineHome(b.id);
  if (!home || engineKind(b.id) !== 'managed') return c.json({ error: `${b.name} uses the computer's own agent; sign it in there.` }, 409);
  endSignIn(b.id);
  pruneDeadPool(home, 'anthropic'); // the fresh sign-in replaces refused ones (usually a dead copy of Zubi's)
  const { spawn } = await import('node:child_process');
  fixOwnership(b.id);
  // A Hermes profile's sign-in is saved as the Hermes user, who owns the profile's files.
  const owner = engineOwner(b.id);
  const proc = spawn(env.hermesBin, ['auth', 'add', 'anthropic', '--type', 'oauth'], {
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: owner ? home : process.env.HOME ?? '/root', LANG: process.env.LANG ?? 'C.UTF-8',
      HERMES_HOME: home, PYTHONUNBUFFERED: '1', BROWSER: '/bin/true', // no screen: the owner opens the link
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(owner ? { uid: owner.uid, gid: owner.gid } : {}),
  });
  const s: SignIn = { proc, out: '', url: null, timer: setTimeout(() => endSignIn(b.id), 10 * 60_000) };
  signIns.set(b.id, s);
  const take = (d: Buffer) => { s.out = (s.out + d.toString()).slice(-20_000); s.url ??= CLAUDE_URL.exec(s.out)?.[0] ?? null; };
  proc.stdout?.on('data', take);
  proc.stderr?.on('data', take);
  proc.on('error', (e) => { s.out += `\n${e.message}`; });
  for (const until = Date.now() + 20_000; !s.url && proc.exitCode === null && Date.now() < until;) await new Promise((r) => setTimeout(r, 200));
  if (!s.url) {
    const tail = scrub(s.out.trim().split('\n').slice(-4).join(' ')).slice(0, 300);
    endSignIn(b.id);
    return c.json({ error: `Hermes didn't give a sign-in link${tail ? `: ${tail}` : '.'}` }, 502);
  }
  return c.json({ url: s.url });
});

configApi.post('/bots/:id/engine/signin/finish', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const s = signIns.get(b.id);
  if (!s || s.proc.exitCode !== null) return c.json({ error: 'That sign-in has ended. Start it again.' }, 409);
  const { code } = await c.req.json<{ code?: string }>().catch(() => ({ code: '' }));
  const clean = String(code ?? '').trim();
  if (clean.length < 10 || clean.length > 2000 || /[\r\n]/.test(clean)) return c.json({ error: 'Paste the whole code Claude showed after Authorize.' }, 400);
  const before = s.out.length;
  s.proc.stdin?.end(`${clean}\n`);
  const exit = await new Promise<number | null>((resolve) => {
    if (s.proc.exitCode !== null) return resolve(s.proc.exitCode);
    const t = setTimeout(() => resolve(null), 45_000);
    s.proc.once('exit', (code) => { clearTimeout(t); resolve(code); });
  });
  const said = scrub(s.out.slice(before).trim()).split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ').slice(0, 300);
  endSignIn(b.id);
  const home = engineHome(b.id)!;
  let ok = false;
  try {
    const pool = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'))?.credential_pool?.anthropic;
    ok = exit === 0 && Array.isArray(pool) && pool.some((p: any) => p?.last_status !== 'dead');
  } catch { /* no pool */ }
  if (!ok) return c.json({ error: `The sign-in didn't go through${said ? `: ${said}` : '.'} Start it again and paste the newest code.` }, 502);
  forgetEngineOptions(b.id);
  try { await restartEngine(b.id); } catch (e) { console.warn('[engine] restart after sign-in:', (e as Error).message); }
  return c.json({ ok: true, engine: await engineInfo(b.id) });
});

configApi.post('/bots/:id/engine/signin/cancel', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  endSignIn(b.id);
  return c.json({ ok: true });
});

configApi.post('/bots/:id/engine/restart', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  // The primary agent serves more than this app (its messaging runs through the same process), so it is never restarted from here.
  if (engineKind(b.id) !== 'managed') return c.json({ error: `${b.name} runs on the computer's own agent, which this app does not restart.` }, 409);
  try {
    await restartEngine(b.id);
    forgetEngineOptions(b.id);
    return c.json({ engine: await engineInfo(b.id) });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

/** Stop the private screen Hermes runs for this agent, so its computer work comes back to the screen shown here. */
configApi.post('/bots/:id/engine/screen/stop', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    await stopOwnScreen(b.id);
    return c.json({ engine: await engineInfo(b.id) });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 409);
  }
});

/** The user gives the screen back after taking control; the bot is told on its next turn. */
configApi.post('/bots/:id/handback', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET handback_at=? WHERE id=?').run(now(), b.id);
  return c.json({ ok: true });
});

// ---------- library: files under <libraryRoot>/<botId> on the bot's computer (see paths.ts) ----------

function safeRel(p: string | undefined): string | null {
  const rel = (p ?? '').replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  if (rel.split('/').some((s) => !s || s === '.' || s === '..') || /[\0\n\r]/.test(rel)) return null;
  return rel;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Parse `ls -la --time-style=+%s` output. */
export function parseLs(out: string): LibraryFile[] {
  const files: LibraryFile[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^([-dlcbps])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    let name = m[4];
    if (m[1] === 'l') name = name.replace(/ -> .*$/, '');
    if (name === '.' || name === '..') continue;
    files.push({ name, size: Number(m[2]), modifiedAt: Number(m[3]) * 1000, isDir: m[1] === 'd' });
  }
  return files.sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.modifiedAt - a.modifiedAt);
}

configApi.get('/bots/:id/files', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (rel === null) return c.json({ error: 'bad path' }, 400);
  try {
    if (!box.local && computerState(user.id).status !== 'running') return c.json({ status: 'asleep', path: rel, files: [] });
    const dir = `${libraryRoot()}/${b.id}${rel ? `/${rel}` : ''}`;
    const r = await box.bash(`mkdir -p ${shq(`${libraryRoot()}/${b.id}`)} && ls -la --time-style=+%s ${shq(dir)} 2>&1`, 30);
    if (r.exit_code !== 0) return c.json({ status: 'error', path: rel, files: [], error: (r.output ?? '').slice(0, 300) });
    return c.json({ status: 'ok', path: rel, files: parseLs(r.output ?? '') });
  } catch (e: any) {
    return c.json({ status: 'error', path: rel, files: [], error: String(e?.message ?? e).slice(0, 300) });
  }
});

configApi.post('/bots/:id/files/download', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { path } = await c.req.json<{ path: string }>().catch(() => ({ path: '' }));
  const rel = safeRel(path);
  if (!rel) return c.json({ error: 'bad path' }, 400);
  // On the computer itself the file is on our own disk: serve it directly.
  if (box.local) return c.json({ url: `/api/bots/${b.id}/files/raw?path=${encodeURIComponent(rel)}` });
  try {
    if (!env.orgoComputerId) return c.json({ error: 'computer unavailable' }, 409);
    const r: any = await orgo.exportFile(env.orgoComputerId, `${libraryRoot()}/${b.id}/${rel}`);
    const url = r?.url ?? r?.file?.url ?? r?.download_url;
    if (!url) return c.json({ error: 'export returned no link' }, 502);
    return c.json({ url });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

configApi.get('/bots/:id/files/raw', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || !box.local) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (!rel) return c.json({ error: 'bad path' }, 400);
  const root = `${libraryRoot()}/${b.id}`;
  let file: string;
  try {
    // Follow links before checking, so a link inside the library cannot point outside it.
    file = fs.realpathSync(`${root}/${rel}`);
    if (!file.startsWith(fs.realpathSync(root) + '/') || !fs.statSync(file).isFile()) throw new Error('outside');
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
  const name = rel.split('/').pop()!;
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(fs.statSync(file).size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
    },
  });
});

// ---------- computer: screens, reset, hibernation ----------

configApi.get('/computer/details', (c) => {
  const userId = c.get('user').id;
  const leases = db.prepare('SELECT bot_id, screen_id, last_used_at FROM screens WHERE user_id=? ORDER BY last_used_at DESC').all(userId) as any[];
  return c.json({
    computer: computerState(userId),
    screens: leases.map((l) => ({ botId: l.bot_id, screenId: l.screen_id, lastUsedAt: l.last_used_at })),
    hibernation: { idleMinutes: idleConfig.idleMin, viewers: viewerCount(userId), dryRun: idleConfig.dryRun },
  });
});

/** Give a bot a clean screen: close what is open and bring its browser back to its home screen. Logins stay. */
configApi.post('/bots/:id/screen/reset', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    await resetBotScreen(user.id, b.id);
    hub.emit(user.id, { type: 'computer', state: computerState(user.id) });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});
