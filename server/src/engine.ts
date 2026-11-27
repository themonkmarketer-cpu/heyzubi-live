import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { displayFor } from './box.js';
import { cdpUrlFor, screenFor } from './computer.js';
import { personaLine } from './gender.js';
import { db } from './db.js';
import { env } from './env.js';
import { libraryRoot } from './paths.js';
import type { EngineInfo, EngineProvider } from './types.js';

/**
 * Every bot is run by a Hermes agent.
 *
 * - The 'primary' engine is a Hermes gateway that already runs on the computer (HERMES_URL, home
 *   HERMES_HOME_PRIMARY). It has its own life: messaging, memory, model. We only talk to its API
 *   server; we never write its config, restart it or stop it.
 * - A 'managed' engine is a Hermes home of our own under ENGINES_DIR/<botId> with its own
 *   `hermes gateway run`, started here and left running when this server exits. Its home sits
 *   outside ~/.hermes, so Hermes treats it as a separate tenant beside the primary gateway.
 */

export type EngineKind = 'primary' | 'managed';
export interface Engine { kind: EngineKind; url: string; key: string; home: string }

const botRow = (botId: string) => db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;

// ---------- small file helpers ----------

/** KEY=value lines of a dotenv file (quotes stripped). Missing file = {}. */
function readDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function readYaml(file: string): any {
  try { return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}

function writePrivate(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// ---------- identity ----------

/** Token a bot's Hermes agent presents to this server's MCP endpoint. `primary` names the primary bot. */
export function mcpToken(botId: string): string {
  return crypto.createHmac('sha256', env.sessionSecret).update(`mcp:${botId}`).digest('hex');
}

export function primaryBotId(): string | null {
  return (db.prepare("SELECT id FROM bots WHERE engine='primary' LIMIT 1").get() as any)?.id ?? null;
}

export function engineKind(botId: string): EngineKind | null {
  const e = botRow(botId)?.engine;
  return e === 'primary' || e === 'managed' ? e : null;
}

/**
 * Where a managed bot's Hermes home is. A bot with a Hermes profile lives in ~/.hermes/profiles/<name>, where Hermes
 * itself lists and can use it (`hermes profile list`, `hermes -p <name>`). Bots made before profiles keep theirs in
 * ENGINES_DIR/<botId>.
 */
const profileHome = (name: string) => path.join(env.hermesHome, 'profiles', name);
const homeFor = (botId: string) => {
  const profile = botRow(botId)?.hermes_profile as string | null | undefined;
  return profile ? profileHome(profile) : path.join(env.enginesDir, botId);
};

// ---------- Hermes profiles: made and run as the user who owns ~/.hermes ----------

export interface Owner { uid: number; gid: number; name: string; home: string }

/**
 * The user Hermes runs as (the owner of ~/.hermes). A profile's files must stay theirs, or Hermes can't use the
 * profile any more, so its agent runs as that user too. Null when this server isn't root or Hermes's home is root's.
 */
function hermesOwner(): Owner | null {
  try {
    const st = fs.statSync(env.hermesHome);
    if (typeof process.getuid !== 'function' || process.getuid() !== 0 || st.uid === 0) return null;
    let name = String(st.uid);
    try {
      const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.split(':')[2] === String(st.uid));
      if (line) name = line.split(':')[0];
    } catch { /* no passwd */ }
    return { uid: st.uid, gid: st.gid, name, home: env.hermesHome };
  } catch { return null; }
}

/** Profiles are used when there is a Hermes to list them in: its home exists here. */
function profilesEnabled(): boolean {
  try { return fs.statSync(env.hermesHome).isDirectory(); } catch { return false; }
}

/** The user a bot's agent runs as: the Hermes user for a profile, else this server's own (null). */
export function engineOwner(botId: string): Owner | null {
  return botRow(botId)?.hermes_profile ? hermesOwner() : null;
}

/**
 * The bot's own Hermes profile, as Hermes lists it: the default profile for the main bot, profiles/<name> for a team
 * member made as a profile. Null for bots whose agent lives outside Hermes (older ones, in ENGINES_DIR).
 */
export function hermesTarget(botId: string): { dir: string; owner: Owner | null; label: string } | null {
  const b = botRow(botId);
  if (!b) return null;
  if (b.engine === 'primary') return { dir: env.hermesHome, owner: hermesOwner(), label: 'default' };
  if (b.engine === 'managed' && b.hermes_profile) return { dir: profileHome(b.hermes_profile), owner: hermesOwner(), label: b.hermes_profile };
  return null;
}

/** Hand a folder (and everything in it) to the Hermes user. Links are not followed. */
function chownTree(dir: string, o: Owner) {
  const walk = (p: string) => {
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.uid !== o.uid || st.gid !== o.gid) { try { fs.lchownSync(p, o.uid, o.gid); } catch { /* gone */ } }
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
  };
  walk(dir);
}

/** Give a folder in the main Hermes home to the Hermes user (for files HeyZubi writes there, such as Zubi's skills). */
export function giveToHermes(dir: string) {
  const o = hermesOwner();
  if (o) chownTree(dir, o);
}

/** After this server wrote into a profile (as root), give the files back to the Hermes user. */
export function fixOwnership(botId: string) {
  const o = engineOwner(botId);
  if (o) chownTree(homeFor(botId), o);
}

/** The folders above `dir` must be passable for the Hermes user (only the search bit is added, never listing). */
function letThrough(dir: string, o: Owner) {
  for (let d = path.dirname(dir); d !== path.dirname(d); d = path.dirname(d)) {
    try {
      const st = fs.statSync(d);
      const passable = st.uid === o.uid ? st.mode & 0o100 : st.gid === o.gid ? st.mode & 0o010 : st.mode & 0o001;
      if (!passable) {
        fs.chmodSync(d, (st.mode & 0o7777) | 0o001);
        console.log(`[engine] ${d}: others may now pass through it (not list it), so Hermes profiles reach their files`);
      }
    } catch { /* gone */ }
  }
}

/** The environment a Hermes command gets: no secrets of this server. */
function hermesEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    ...Object.fromEntries(HERMES_RUNTIME_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k] as string])),
    ...extra,
  };
}

/** The environment and user for running Hermes's own code against the main Hermes home (hermes-profile.ts). */
export function hermesEnvFor(): { env: NodeJS.ProcessEnv; owner: Owner | null } {
  const o = hermesOwner();
  return { env: hermesEnv({ HOME: o?.home ?? process.env.HOME ?? '/root', USER: o?.name ?? process.env.USER ?? 'root', HERMES_HOME: env.hermesHome }), owner: o };
}

/** Run a `hermes profile …` command against the main Hermes home, as the Hermes user. */
function hermesCli(args: string[], o: Owner | null): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(env.hermesBin, args, {
      env: hermesEnv({ HOME: o?.home ?? process.env.HOME ?? '/root', USER: o?.name ?? process.env.USER ?? 'root', HERMES_HOME: env.hermesHome }),
      timeout: 180_000,
      maxBuffer: 4 << 20,
      ...(o ? { uid: o.uid, gid: o.gid } : {}),
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`hermes ${args.slice(0, 2).join(' ')}: ${(String(stderr).trim().split('\n').pop() || err.message).slice(0, 300)}`));
      else resolve(String(stdout));
    });
  });
}

/** A profile name from the bot's name: lowercase letters, digits and dashes, not taken by Hermes or another bot. */
function profileName(botName: string): string {
  const base = String(botName).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'agent';
  const taken = (n: string) => n === 'default' || fs.existsSync(profileHome(n)) || !!db.prepare('SELECT 1 FROM bots WHERE hermes_profile=?').get(n);
  let name = base;
  for (let i = 2; taken(name); i++) name = `${base}-${i}`;
  return name;
}

let cachedPrimaryKey: string | null = null;
function primaryKey(): string {
  if (env.hermesKey) return env.hermesKey;
  if (cachedPrimaryKey === null) cachedPrimaryKey = readDotenv(path.join(env.hermesHome, '.env')).API_SERVER_KEY ?? '';
  return cachedPrimaryKey;
}

// ---------- assignment ----------

function freePort(): number {
  const used = new Set((db.prepare('SELECT engine_port FROM bots WHERE engine_port IS NOT NULL').all() as any[]).map((r) => r.engine_port as number));
  let p = env.enginePortBase;
  while (used.has(p)) p++;
  return p;
}

/**
 * Whether this account's bots may be bound to the primary engine. That agent is the owner's own:
 * its memory, its messaging accounts and the computer's main screen come with it, so it goes to
 * OWNER_EMAIL only. Without OWNER_EMAIL any account qualifies while the app is local (development,
 * where whoever signs in is the developer) and none does on a public URL. How somebody signed in
 * does not count: the owner key also lets guests in.
 */
export function mayUsePrimary(userId: string): boolean {
  const email = String((db.prepare('SELECT email FROM users WHERE id=?').get(userId) as any)?.email ?? '').toLowerCase();
  return env.ownerEmail ? email === env.ownerEmail : env.localOnly;
}

/**
 * Give a new agent bot its engine: the existing agent if nobody has it and the bot belongs to the
 * owner, otherwise one of our own. A free primary engine (never bound, or its bot was deleted) so
 * waits for the owner's next bot instead of going to whoever creates one first.
 */
export function assignEngine(botId: string): EngineKind {
  const b = botRow(botId);
  if (!b) throw new Error('bot not found');
  if (b.engine === 'primary' || b.engine === 'managed') return b.engine;
  if (!primaryBotId() && mayUsePrimary(b.user_id)) {
    db.prepare("UPDATE bots SET engine='primary', engine_port=NULL WHERE id=?").run(botId);
    return 'primary';
  }
  // A team member of its own is a Hermes profile, so Hermes lists it too (made in writeHome, on its first start).
  db.prepare("UPDATE bots SET engine='managed', engine_port=?, hermes_profile=? WHERE id=?").run(freePort(), profilesEnabled() ? profileName(b.name) : null, botId);
  return 'managed';
}

// ---------- the owner's-words hook (see deploy/hermes-box/agent-hooks/hq_owner_words.py) ----------

const OWNER_HOOK_SCRIPT = () => path.join(env.hermesHome, 'agent-hooks', 'hq_owner_words.py');
/** Only tool names that could act outward reach the script (Composio covers app actions named in a batch). */
const OWNER_HOOK_MATCHER = '(?i).*(send|delete|remove|trash|share|post|publish|reply|forward|tweet|upload|invite|transfer|pay|comment|broadcast|composio|workbench|proxy|_dm).*';

function ownerWordsHook(): { matcher: string; command: string; timeout: number } | null {
  const script = OWNER_HOOK_SCRIPT();
  return fs.existsSync(script) ? { matcher: OWNER_HOOK_MATCHER, command: `python3 ${script}`, timeout: 5 } : null;
}

/** Record consent for the hook in this home's allowlist (Hermes's own format), so its gateway runs it. */
function approveHook(home: string, command: string) {
  const file = path.join(home, 'shell-hooks-allowlist.json');
  let data: any = { approvals: [] };
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const approvals = (Array.isArray(data?.approvals) ? data.approvals : []).filter((e: any) => !(e?.event === 'pre_tool_call' && e?.command === command));
  let mtime: string | null = null;
  try { mtime = new Date(fs.statSync(OWNER_HOOK_SCRIPT()).mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z'); } catch { /* script gone */ }
  approvals.push({ event: 'pre_tool_call', command, approved_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), script_mtime_at_approval: mtime });
  writePrivate(file, JSON.stringify({ ...data, approvals }, null, 2));
}

// ---------- a managed bot's Hermes home ----------

/** Model credentials a managed agent may inherit from the primary agent. Never messaging tokens. */
const SHARED_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'NOUS_API_KEY',
  'FIRECRAWL_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'PARALLEL_API_KEY',
];

/**
 * What a packaged Hermes (the official Docker image) reads from its environment: where its bundled
 * tools live, and HERMES_ALLOW_ROOT_GATEWAY, without which it refuses to run a gateway as root (the
 * extra bots run as root here, as they do on an Orgo computer, each in a home of its own).
 */
const HERMES_RUNTIME_ENV = ['HERMES_RUNTIME_DIR', 'HERMES_PYTHON', 'HERMES_TUI_DIR', 'HERMES_WEB_DIST', 'HERMES_ALLOW_ROOT_GATEWAY'];

/** Parts of the primary agent's config a managed agent starts from, so it reaches the same models. */
const SHARED_CONFIG = ['model', 'providers', 'custom_providers', 'auxiliary', 'fallback_model', 'fallback_providers'];

function soul(b: any): string {
  const owner = (db.prepare('SELECT name FROM users WHERE id=?').get(b.user_id) as any)?.name ?? 'the user';
  const role = b.label ? `, ${b.label}` : '';
  return [
    `You are ${b.name}${role}. You work for ${owner} as one of a small team of AI agents, each with its own screen on a shared computer.`,
    b.gender ? `\n${personaLine(b.gender)}` : '',
    b.description ? `\n${b.description}` : '',
    '\nYou are direct, warm and brief. You do the work rather than describe it, and you say plainly what you did and what you could not do.',
    '',
  ].join('\n');
}

/** A soul in the shape soul() writes (so HeyZubi may rewrite it), not one written for the profile by hand. */
const isGeneratedSoul = (text: string) => /^You are [^\n]+\. You work for [^\n]+ as one of a small team of AI agents, each with its own screen on a shared computer\./.test(text);

/** Rewrite the persona file after a rename or a new description. The primary agent keeps its own. */
export function syncPersona(botId: string) {
  const b = botRow(botId);
  if (!b || b.engine !== 'managed') return;
  const home = homeFor(botId);
  if (!fs.existsSync(home)) return;
  // Only a soul HeyZubi wrote is rewritten. A profile's own (Developer's is pages long, written by hand) is the bot's
  // soul in both apps and stays as it is.
  const soulFile = path.join(home, 'SOUL.md');
  let current = '';
  try { current = fs.readFileSync(soulFile, 'utf8'); } catch { /* none yet */ }
  if (!current.trim() || isGeneratedSoul(current)) fs.writeFileSync(soulFile, soul(b));
  if (b.hermes_profile) {
    fixOwnership(botId);
    // What Hermes shows for the profile (and routes Kanban work by).
    if (b.description) hermesCli(['profile', 'describe', b.hermes_profile, '--text', String(b.description).slice(0, 500)], hermesOwner()).catch((e) => console.warn(`[engine] ${e.message}`));
  }
}

function extraMcpServers(): Record<string, any> {
  if (!env.extraMcpServers) return {};
  try {
    const v = JSON.parse(env.extraMcpServers);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    console.warn('[engine] EXTRA_MCP_SERVERS is not valid JSON; ignored');
    return {};
  }
}

/** Create or refresh the home. config.yaml is created once; after that only the keys we own are patched. */
async function writeHome(botId: string): Promise<{ home: string; key: string; display: string | null }> {
  const b = botRow(botId);
  const home = homeFor(botId);
  const profile = (b.hermes_profile as string | null) ?? null;
  const owner = profile ? hermesOwner() : null;
  // A new profile is made by Hermes itself (its bundled skills, template config and SOUL), then given our settings below.
  let created = false;
  if (profile && !fs.existsSync(home)) {
    const desc = String(b.description || b.label || '').trim().slice(0, 500);
    await hermesCli(['profile', 'create', profile, '--no-alias', ...(desc ? ['--description', desc] : [])], owner);
    if (!fs.existsSync(home)) throw new Error(`Hermes did not make the profile "${profile}".`);
    created = true;
    console.log(`[engine] ${b.name}: Hermes profile "${profile}" created`);
  }
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'locks'), { recursive: true });
  fs.chmodSync(home, 0o700);

  // Its screen decides which display and which Chrome it drives. Only meaningful on the computer itself.
  let display: string | null = null;
  let cdp = '';
  if (env.localBox) {
    try {
      const s = await screenFor(b.user_id, botId);
      display = displayFor(s.screenId);
      cdp = cdpUrlFor(botId, s.screenId);
    } catch (e: any) {
      console.warn(`[engine] no screen for ${b.name} yet: ${e?.message ?? e}`);
    }
  }

  const cwd = env.localBox ? `${libraryRoot()}/${botId}` : path.join(home, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  if (owner) {
    letThrough(cwd, owner);
    chownTree(cwd, owner);
  }

  const cfgFile = path.join(home, 'config.yaml');
  const fresh = created || !fs.existsSync(cfgFile);
  const cfg = fs.existsSync(cfgFile) ? readYaml(cfgFile) : {};
  if (fresh) {
    const primary = readYaml(path.join(env.hermesHome, 'config.yaml'));
    for (const k of SHARED_CONFIG) if (primary[k] !== undefined) cfg[k] = primary[k];
    cfg.agent = { ...(cfg.agent ?? {}), reasoning_effort: 'medium' };
  }
  // Hermes serves its profiles from one host gateway, which runs beside the main agent and can't reach this bot's
  // screen, browser or files. Hermes's own setting for that keeps a gateway of the profile's own here.
  if (profile) cfg.gateway = { ...(cfg.gateway ?? {}), standalone: true };
  cfg.platform_toolsets = { ...(cfg.platform_toolsets ?? {}), api_server: ['hermes-api-server', ...(display ? ['computer_use'] : [])] };
  cfg.terminal = { ...(cfg.terminal ?? {}), cwd };
  if (cdp) cfg.browser = { ...(cfg.browser ?? {}), cdp_url: cdp };
  cfg.mcp_servers = {
    ...(cfg.mcp_servers ?? {}),
    ...extraMcpServers(),
    hq: { url: `${env.mcpBaseUrl}/mcp/${botId}`, headers: { Authorization: `Bearer ${mcpToken(botId)}` }, timeout: 1800, connect_timeout: 30 },
  };
  // The owner's rule, as on the primary agent: a run that isn't the owner's own words can't send, share,
  // post or delete (deploy/hermes-box/agent-hooks/hq_owner_words.py, installed in the primary agent's home).
  const hook = ownerWordsHook();
  if (hook) {
    const others = (Array.isArray(cfg.hooks?.pre_tool_call) ? cfg.hooks.pre_tool_call : []).filter((h: any) => h?.command !== hook.command);
    cfg.hooks = { ...(cfg.hooks ?? {}), pre_tool_call: [...others, hook] };
    approveHook(home, hook.command);
  }
  writePrivate(cfgFile, YAML.stringify(cfg));

  if (created || !fs.existsSync(path.join(home, 'SOUL.md'))) fs.writeFileSync(path.join(home, 'SOUL.md'), soul(b));

  // Subscription sign-ins live in auth.json and are NOT copied from the primary agent: they rotate, so a copy dies the
  // first time the primary renews its own (and could kill the primary's if this agent renewed first). Each agent signs
  // in for itself (bot settings › Engine › Sign in to Claude); API keys are inherited through .env below.

  // .env is ours entirely: the API server plus inherited model keys. Keys the user added by hand are kept.
  const envFile = path.join(home, '.env');
  const mine = readDotenv(envFile);
  const key = mine.API_SERVER_KEY || crypto.randomBytes(24).toString('hex');
  const primaryEnv = readDotenv(path.join(env.hermesHome, '.env'));
  const vars: Record<string, string> = { ...mine };
  for (const k of SHARED_ENV) {
    const v = primaryEnv[k] ?? process.env[k];
    if (v && !vars[k]) vars[k] = v;
  }
  Object.assign(vars, { API_SERVER_ENABLED: 'true', API_SERVER_KEY: key, API_SERVER_PORT: String(b.engine_port), API_SERVER_HOST: '127.0.0.1' });
  if (cdp) vars.BROWSER_CDP_URL = cdp; else delete vars.BROWSER_CDP_URL;
  writePrivate(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

  if (owner) chownTree(home, owner);
  return { home, key, display };
}

/**
 * Read keys from a managed bot's own .env (messaging settings such as Telegram's). Null for the primary agent, whose
 * .env belongs to Hermes and is never written from here.
 */
export function readEngineEnv(botId: string, keys: string[]): Record<string, string> | null {
  if (engineKind(botId) !== 'managed') return null;
  const all = readDotenv(path.join(homeFor(botId), '.env'));
  return Object.fromEntries(keys.filter((k) => all[k]).map((k) => [k, all[k]]));
}

/** Every managed bot's value of one .env key, with whose it is (to keep a messaging token on one bot only). */
export function engineEnvValues(key: string): { botId: string; value: string }[] {
  const ids = (db.prepare("SELECT id FROM bots WHERE engine='managed'").all() as { id: string }[]).map((r) => r.id);
  const out: { botId: string; value: string }[] = [];
  for (const id of ids) {
    const v = readDotenv(path.join(homeFor(id), '.env'))[key];
    if (v) out.push({ botId: id, value: v });
  }
  return out;
}

/** The primary agent's value of one .env key (read only). */
export function primaryEnvValue(key: string): string | undefined {
  return readDotenv(path.join(env.hermesHome, '.env'))[key];
}

/**
 * Set or remove (null) keys in a managed bot's .env; every other line stays. Takes effect when its gateway restarts.
 * The file stays private to the agent's user.
 */
export function setEngineEnv(botId: string, changes: Record<string, string | null>) {
  if (engineKind(botId) !== 'managed') throw new Error('Only a team member with its own agent has its own settings file.');
  const file = path.join(homeFor(botId), '.env');
  if (!fs.existsSync(file)) throw new Error('Its agent has not started yet. Wait for “Engine running”, then try again.');
  const vars = readDotenv(file);
  for (const [k, v] of Object.entries(changes)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error('bad key');
    if (v === null) delete vars[k];
    else {
      if (/[\r\n]/.test(v)) throw new Error('bad value');
      vars[k] = v;
    }
  }
  writePrivate(file, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  const owner = engineOwner(botId);
  if (owner) { try { fs.chownSync(file, owner.uid, owner.gid); } catch { /* not root */ } }
}

/** Restart a managed bot's gateway and wait until it answers again. */
export async function restartEngineAndWait(botId: string): Promise<void> {
  await restartEngine(botId);
  await engineFor(botId);
}

// ---------- a managed bot's gateway ----------

async function healthy(url: string, timeoutMs = 2500): Promise<any | null> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function keyAccepted(url: string, key: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/v1/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

/** The gateway's pid, but only if the pid file belongs to this home and the process is alive. */
function gatewayPid(home: string): number | null {
  let raw = '';
  try { raw = fs.readFileSync(path.join(home, 'gateway.pid'), 'utf8').trim(); } catch { return null; }
  let pid = NaN;
  try {
    const j = JSON.parse(raw);
    if (typeof j === 'number') pid = j;
    else {
      if (j?.hermes_home && path.resolve(j.hermes_home) !== path.resolve(home)) return null;
      pid = Number(j?.pid);
    }
  } catch { pid = Number(raw); }
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { process.kill(pid, 0); } catch { return null; }
  try {
    if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('gateway')) return null;
  } catch { /* no /proc: trust the pid file */ }
  return pid;
}

/**
 * Stop the bot's gateway. A start still in progress is waited for first: otherwise a stop that comes while the agent is
 * starting (a delete right after this server boots) finds no process yet, and the agent comes up after it.
 */
export async function stopGateway(botId: string) {
  await starting.get(botId)?.catch(() => {});
  await killGateway(botId);
}

/** Stop the running gateway process, if any (used inside a start, so it never waits for one). */
async function killGateway(botId: string) {
  const home = homeFor(botId);
  const pid = gatewayPid(home);
  if (!pid) return;
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } }
  };
  signal('SIGTERM');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { process.kill(pid, 0); } catch { return; }
  }
  signal('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
}

const starting = new Map<string, Promise<void>>();
const failures = new Map<string, string>();
const keys = new Map<string, string>();

function managedUrl(botId: string): string {
  return `http://127.0.0.1:${botRow(botId).engine_port}`;
}

function managedKey(botId: string): string {
  let k = keys.get(botId);
  if (!k) {
    k = readDotenv(path.join(homeFor(botId), '.env')).API_SERVER_KEY ?? '';
    if (k) keys.set(botId, k);
  }
  return k;
}

/** The profile's last start was refused because Hermes's host gateway still serves it. */
function heldByHost(home: string): boolean {
  try { return fs.readFileSync(path.join(home, 'logs', 'errors.log'), 'utf8').slice(-3000).includes('already owns profile'); } catch { return false; }
}

async function startGateway(botId: string): Promise<void> {
  const b = botRow(botId);
  if (!b || b.engine !== 'managed') throw new Error('not a managed engine');
  if (b.deleted_at) throw new Error(`${b.name} was deleted, so its agent stays off.`);
  if (!b.engine_port) db.prepare('UPDATE bots SET engine_port=? WHERE id=?').run(freePort(), botId);
  let url = managedUrl(botId);

  // A gateway from an earlier run of this server is still good: use it as it is.
  if ((await healthy(url)) && managedKey(botId) && (await keyAccepted(url, managedKey(botId)))) return;
  if (await healthy(url)) {
    if (gatewayPid(homeFor(botId))) await killGateway(botId);
    else {
      // Something this server doesn't know answers there (a gateway Hermes runs for a profile with no bot here):
      // move to the next port nobody answers on.
      const used = new Set((db.prepare('SELECT engine_port FROM bots WHERE engine_port IS NOT NULL').all() as any[]).map((r) => r.engine_port as number));
      let p = env.enginePortBase;
      for (let n = 0; n < 200 && (used.has(p) || (await healthy(`http://127.0.0.1:${p}`, 800))); n++) p++;
      if (used.has(p) || (await healthy(`http://127.0.0.1:${p}`, 800))) throw new Error(`Port ${botRow(botId).engine_port} is taken by something else, and no free port was found.`);
      db.prepare('UPDATE bots SET engine_port=? WHERE id=?').run(p, botId);
      url = managedUrl(botId);
    }
  }

  const { home, key, display } = await writeHome(botId);
  keys.set(botId, key);
  if (gatewayPid(home)) await killGateway(botId);

  attempts: for (let attempt = 0; attempt < 2; attempt++) {
    const owner = engineOwner(botId);
    const log = fs.openSync(path.join(home, 'logs', 'gateway.out.log'), 'a');
    if (owner) fs.fchownSync(log, owner.uid, owner.gid);
    // A profile's agent runs as the Hermes user, with the profile's own home folder, as `hermes -p <name>` would.
    const ownHome = path.join(home, 'home');
    const child = spawn(env.hermesBin, ['gateway', 'run', '--no-supervise'], {
      cwd: home,
      detached: true,
      stdio: ['ignore', log, log],
      ...(owner ? { uid: owner.uid, gid: owner.gid } : {}),
      // Only what the agent needs. None of this server's secrets, and nothing of the primary agent's messaging.
      env: {
        PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: owner ? (fs.existsSync(ownHome) ? ownHome : home) : process.env.HOME ?? '/root',
        USER: owner ? owner.name : process.env.USER ?? 'root',
        LANG: process.env.LANG ?? 'C.UTF-8',
        HERMES_HOME: home,
        HERMES_GATEWAY_LOCK_DIR: path.join(home, 'locks'),
        // Hermes' browser tool talks to a helper process it finds under this folder. With the default
        // (one folder per HOME) every agent on the computer would end up driving the same browser.
        BH_HOME: path.join(home, 'browser-harness'),
        ...(display ? { DISPLAY: display } : {}),
        // What a packaged Hermes (the official Docker image) needs from its environment. No secrets.
        ...Object.fromEntries(HERMES_RUNTIME_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k] as string])),
      },
    });
    fs.closeSync(log);
    let exited: string | null = null;
    child.once('error', (e) => { exited = `could not run ${env.hermesBin}: ${e.message}`; });
    child.once('exit', (code) => { exited = `the agent stopped while starting (exit ${code}). See ${path.join(home, 'logs', 'gateway.out.log')}`; });
    child.unref();

    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (exited) {
        // Hermes's host gateway (beside the main agent) may hold a new profile until its next rescan sees that the
        // profile has a gateway of its own (at most 30 s). Wait for that once.
        if (owner && attempt === 0 && heldByHost(home)) {
          console.log(`[engine] ${b.name}: Hermes's host gateway still holds the profile; trying again after its rescan`);
          await new Promise((r) => setTimeout(r, 35_000));
          continue attempts;
        }
        throw new Error(exited);
      }
      if (await healthy(url, 1500)) {
        // Deleted while it was starting: stop it again rather than leave it running (and on its messaging apps).
        if (botRow(botId)?.deleted_at) { await killGateway(botId); throw new Error(`${b.name} was deleted while its agent was starting; it was stopped.`); }
        console.log(`[engine] ${b.name}: gateway up on ${url}`);
        // Its Hermes profile shows the same name and mascot as here (loaded late: that module imports this one).
        if (b.hermes_profile) void import('./hermes-identity.js').then((m) => m.syncIdentity(botId)).catch(() => {});
        return;
      }
    }
  }
  throw new Error('The agent did not come up within 90 seconds.');
}

/** Start (or adopt) the bot's gateway. Safe to call often; concurrent calls share one start. */
function ensureManaged(botId: string): Promise<void> {
  let p = starting.get(botId);
  if (!p) {
    p = startGateway(botId)
      .then(() => { failures.delete(botId); })
      .catch((e: any) => {
        const msg = String(e?.message ?? e);
        failures.set(botId, msg);
        console.warn(`[engine] ${botId}: ${msg}`);
        throw e;
      })
      .finally(() => starting.delete(botId));
    starting.set(botId, p);
  }
  return p;
}

/** Where to send this bot's turns. Starts its gateway if it is not running. */
export async function engineFor(botId: string): Promise<Engine> {
  let kind = engineKind(botId);
  if (!kind) {
    const b = botRow(botId);
    if (!b) throw new Error('bot not found');
    if (b.kind === 'room') throw new Error('A group chat has no agent of its own.');
    kind = assignEngine(botId);
  }
  if (kind === 'primary') return { kind, url: env.hermesUrl, key: primaryKey(), home: env.hermesHome };
  const url = managedUrl(botId);
  if (!(await healthy(url, 1500)) || !managedKey(botId)) await ensureManaged(botId);
  return { kind, url, key: managedKey(botId), home: homeFor(botId) };
}

/** The bot's Hermes home, without starting anything (memory files, sign-in commands). */
export function engineHome(botId: string): string | null {
  const kind = engineKind(botId);
  return kind === 'primary' ? env.hermesHome : kind === 'managed' ? homeFor(botId) : null;
}

/**
 * Hermes can run a private screen of its own for a profile (its "Bot Desktop": an Xvnc display with
 * state in <home>/bot-desktop). While that screen is up, the agent's computer-use tool acts there and
 * not on the screen this app shows (so does its browser tool, unless the config pins it to a Chrome
 * with `browser.cdp_url`), so the user could be watching an idle desktop.
 */
export function ownScreenOn(botId: string): boolean {
  const home = engineHome(botId);
  if (!home) return false;
  const dir = path.join(home, 'bot-desktop');
  try {
    // launcher.pid holds "<pid> <create time>"; the env file appears once the screen is usable.
    const pid = Number(fs.readFileSync(path.join(dir, 'launcher.pid'), 'utf8').trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 1 || !fs.existsSync(path.join(dir, 'env'))) return false;
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Ask Hermes to stop that private screen. Hermes refuses while a person is using it; the refusal is passed on. */
export function stopOwnScreen(botId: string): Promise<void> {
  const home = engineHome(botId);
  if (!home) return Promise.reject(new Error('This team member has no agent.'));
  return new Promise((resolve, reject) => {
    execFile(env.hermesBin, ['computer-use', 'screen', 'stop'], { env: { ...process.env, HERMES_HOME: home }, timeout: 60_000 }, (err, stdout, stderr) => {
      if (!ownScreenOn(botId)) return resolve();
      const said = `${stderr || ''}\n${stdout || ''}`.trim().split('\n').filter(Boolean).pop();
      reject(new Error(said || (err ? String(err.message) : 'The screen is still running.')));
    });
  });
}

/** Start the gateway in the background (after creating a bot, or on server start). */
export function provisionEngine(botId: string) {
  if (engineKind(botId) === 'managed') ensureManaged(botId).catch(() => {});
}

export async function restartEngine(botId: string): Promise<void> {
  if (engineKind(botId) !== 'managed') return;
  await starting.get(botId)?.catch(() => {});
  await stopGateway(botId);
  optionsCache.delete(botId);
  provisionEngine(botId);
}

/**
 * The bot is gone: stop its gateway and take its home away. A Hermes profile is first exported to
 * ~/.hermes/backups/heyzubi-profiles (`hermes profile import <file>` brings it back), then deleted through Hermes.
 * If the export fails the profile is kept. The primary agent is left alone.
 */
export async function removeEngine(botId: string): Promise<void> {
  const home = homeFor(botId);
  if (!fs.existsSync(home)) return;
  await starting.get(botId)?.catch(() => {});
  await stopGateway(botId);
  keys.delete(botId);
  failures.delete(botId);
  optionsCache.delete(botId);
  const profile = botRow(botId)?.hermes_profile as string | null;
  if (profile) {
    const owner = hermesOwner();
    const dir = path.join(env.hermesHome, 'backups', 'heyzubi-profiles');
    fs.mkdirSync(dir, { recursive: true });
    if (owner) chownTree(dir, owner);
    const file = path.join(dir, `${profile}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.tar.gz`);
    await hermesCli(['profile', 'export', profile, '-o', file], owner);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`The profile "${profile}" could not be archived, so it was kept.`);
    // Deleting also purges the profile's identity; Hermes reports that step failing once the folder is already gone,
    // so the delete counts as done when the folder is.
    await hermesCli(['profile', 'delete', profile, '-y'], owner).catch((e) => {
      if (fs.existsSync(home)) throw e;
      console.warn(`[engine] ${e.message}`);
    });
    console.log(`[engine] Hermes profile "${profile}" archived to ${file} and removed`);
    return;
  }
  if (path.resolve(home).startsWith(path.resolve(env.enginesDir) + path.sep)) fs.rmSync(home, { recursive: true, force: true });
}

/** On server start: give older bots an engine, then bring the managed gateways up. */
export function initEngines() {
  fs.mkdirSync(env.enginesDir, { recursive: true });
  // A binding made before the owner rule existed is left alone (moving it would hand one account's
  // conversation to another agent, or take a bot away). It is only pointed out.
  const held = db.prepare("SELECT b.name, b.user_id, u.email FROM bots b JOIN users u ON u.id=b.user_id WHERE b.engine='primary'").get() as any;
  if (held && !mayUsePrimary(held.user_id)) {
    console.warn(`[engine] The computer's own agent (its memory, messaging and main screen) is bound to "${held.name}", a bot of ${held.email}, ${env.ownerEmail ? `which is not OWNER_EMAIL (${env.ownerEmail})` : 'and OWNER_EMAIL is not set'}. Nothing was changed. To take it back, that bot has to be deleted in the app by its account (scripts/sign-in-link.sh signs you in as it); the owner's next new bot then gets the agent.`);
  }
  const bots = db.prepare("SELECT id, is_primary FROM bots WHERE engine IS NULL AND COALESCE(kind,'agent') <> 'room' AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at ASC").all() as any[];
  for (const b of bots) assignEngine(b.id);
  for (const b of db.prepare("SELECT id FROM bots WHERE engine='managed' AND deleted_at IS NULL").all() as any[]) provisionEngine(b.id);
}

// ---------- what the settings panel shows ----------

/** Providers worth showing even when not signed in. */
const WELL_KNOWN = ['anthropic', 'openai-codex', 'xai-oauth', 'xai', 'openrouter', 'nous', 'gemini', 'openai-api'];

const optionsCache = new Map<string, { at: number; data: any }>();

async function modelOptions(botId: string, e: { url: string; key: string }): Promise<any | null> {
  const hit = optionsCache.get(botId);
  if (hit && Date.now() - hit.at < 15_000) return hit.data;
  try {
    const r = await fetch(`${e.url}/api/model/options`, { headers: e.key ? { Authorization: `Bearer ${e.key}` } : {}, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = await r.json();
    optionsCache.set(botId, { at: Date.now(), data });
    return data;
  } catch { return null; }
}

/** Hermes signs in to some providers with OAuth (a subscription) even when it lists them as API-key providers: read its credential pool. */
function oauthOnly(home: string | null, provider: string): boolean {
  if (!home) return false;
  try {
    const pool = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'))?.credential_pool?.[provider];
    return Array.isArray(pool) && pool.length > 0 && pool.every((c: any) => String(c?.auth_type ?? '').includes('oauth'));
  } catch { return false; }
}

/** Every saved sign-in for this provider was refused (Hermes marks them "dead"): it needs signing in again. */
function poolDead(home: string | null, provider: string): boolean {
  if (!home) return false;
  try {
    const pool = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'))?.credential_pool?.[provider];
    return Array.isArray(pool) && pool.length > 0 && pool.every((c: any) => c?.last_status === 'dead');
  } catch { return false; }
}

/**
 * Drops a provider's dead sign-ins from a managed agent's auth.json before a fresh sign-in, so the new one is the
 * only one tried. Claude subscription sign-ins rotate, so a copy of another agent's sign-in dies as soon as that
 * agent renews its own; each agent needs a sign-in of its own.
 */
export function pruneDeadPool(home: string, provider: string): number {
  const file = path.join(home, 'auth.json');
  try {
    const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pool = auth?.credential_pool?.[provider];
    if (!Array.isArray(pool)) return 0;
    const alive = pool.filter((c: any) => c?.last_status !== 'dead');
    if (alive.length === pool.length) return 0;
    auth.credential_pool[provider] = alive;
    writePrivate(file, JSON.stringify(auth, null, 2));
    return pool.length - alive.length;
  } catch { return 0; }
}

/**
 * A team member's own Claude sign-in: a live one in its profile's auth.json, or a Claude key or token in its own .env.
 * Hermes also counts the main agent's sign-in for a profile that has none of its own, so Hermes's "authenticated"
 * alone would let a team member quietly run on Zubi's subscription. Those sign-ins rotate (whichever agent renews
 * first logs the other out), and the person meant each agent to have its own.
 */
export function ownClaudeSignIn(home: string): boolean {
  try {
    const pool = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'))?.credential_pool?.anthropic;
    if (Array.isArray(pool) && pool.some((c: any) => c?.last_status !== 'dead')) return true;
  } catch { /* no auth.json of its own */ }
  const own = readDotenv(path.join(home, '.env'));
  return !!(own.ANTHROPIC_API_KEY || own.ANTHROPIC_TOKEN || own.CLAUDE_CODE_OAUTH_TOKEN);
}

function toProviders(data: any, home: string | null = null): EngineProvider[] {
  // A team member's profile (not the main agent's home) counts Claude as connected only with its own sign-in.
  const borrowed = (slug: string) => slug === 'anthropic' && !!home && path.resolve(home) !== path.resolve(env.hermesHome) && !ownClaudeSignIn(home);
  const list: any[] = Array.isArray(data?.providers) ? data.providers : [];
  const out = list
    .filter((p) => p?.slug && (p.authenticated || WELL_KNOWN.includes(p.slug)))
    .map((p): EngineProvider => {
      const featured = Array.isArray(p.featured_models) && p.featured_models.length ? p.featured_models : Array.isArray(p.models) ? p.models : [];
      return {
        id: String(p.slug),
        name: p.slug === 'anthropic' ? 'Claude (Anthropic)' : String(p.name ?? p.slug),
        // Hermes lists Anthropic as an API-key provider, yet it can also sign in to a Claude subscription. Offer that until a key is in place.
        kind: String(p.auth_type ?? '').includes('oauth') || (p.slug === 'anthropic' && (!p.authenticated || borrowed(String(p.slug)))) || (p.authenticated && oauthOnly(home, String(p.slug))) ? 'subscription' : 'api_key',
        // Saved but refused sign-ins (Hermes still counts them) are not a connection: offer to sign in again.
        connected: !!p.authenticated && !poolDead(home, String(p.slug)) && !borrowed(String(p.slug)),
        models: featured.filter((m: unknown) => typeof m === 'string').slice(0, 12),
      };
    });
  const rank = (p: EngineProvider) => (p.connected ? 0 : 1) * 100 + (WELL_KNOWN.indexOf(p.id) < 0 ? 50 : WELL_KNOWN.indexOf(p.id));
  return out.sort((a, b) => rank(a) - rank(b));
}

export async function engineInfo(botId: string): Promise<EngineInfo> {
  const b = botRow(botId);
  if (!b) throw new Error('bot not found');
  const kind = engineKind(botId);
  const base: EngineInfo = { botId, profile: kind === 'primary' ? 'default' : b.hermes_profile ?? botId, status: 'stopped', error: null, model: b.model ?? null, provider: b.provider ?? null, version: null, providers: [], ownScreen: kind ? ownScreenOn(botId) : false };
  if (!kind) return { ...base, status: 'error', error: 'This team member has no agent.' };

  let e: { url: string; key: string };
  if (kind === 'primary') e = { url: env.hermesUrl, key: primaryKey() };
  else {
    if (!b.engine_port) return { ...base, status: 'error', error: 'No port assigned.' };
    e = { url: managedUrl(botId), key: managedKey(botId) };
  }

  const health = await healthy(e.url);
  if (!health) {
    if (kind === 'primary') return { ...base, status: 'error', error: `The agent at ${env.hermesUrl} is not answering.` };
    if (starting.has(botId)) return { ...base, status: 'starting' };
    const failed = failures.get(botId);
    if (failed) return { ...base, status: 'error', error: failed };
    provisionEngine(botId);
    return { ...base, status: 'starting' };
  }
  if (kind === 'managed' && starting.has(botId)) return { ...base, status: 'starting' };

  const data = await modelOptions(botId, e);
  return {
    ...base,
    status: 'ready',
    version: typeof health.version === 'string' && health.version !== 'unknown' ? health.version : null,
    model: b.model ?? data?.model ?? null,
    provider: b.provider ?? data?.provider ?? null,
    providers: toProviders(data, engineHome(botId)),
  };
}

/** After a sign-in the provider list changes; drop what we remembered. */
export function forgetEngineOptions(botId: string) { optionsCache.delete(botId); }
