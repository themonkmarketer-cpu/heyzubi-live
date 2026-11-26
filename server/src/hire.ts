import { Hono } from 'hono';
import { db, now } from './db.js';
import { engineFor, engineKind, forgetEngineOptions, restartEngine } from './engine.js';
import { configureProfile, describeProfile, profileNameFor, type ProfileChanges } from './hermes-profile.js';
import { isGender } from './gender.js';
import { isPropId } from './avatar-props.js';
import { newId } from './lib/ids.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { SECRET_LIKE } from './routes-config.js';
import { appendRow, emitBot, getBotRow } from './store.js';
import { createBot, UserError } from './team.js';

/**
 * The "Hire" file: one portable JSON file holds an AI Employee: its role, character and instructions, its model, its
 * skills and the tools it may use. Export one from a team member's settings; import it (or start from a role bundle)
 * to hire the same employee again, here or on another HeyZubi. The import shows a review first.
 *
 * Every tool group carries one of three labels, and a file or bundle takes the highest of its tools':
 *  - "read only": it can look things up (the web, images, past chats) but change nothing;
 *  - "writes": it can change things on its computer (files, the terminal, code, the browser, its memory, schedules);
 *  - "holds a key": it uses a connected account or an API key (apps through an MCP server, messaging, paid services).
 *
 * A hire file never holds keys, sign-ins or connected accounts: those stay with the HeyZubi that has them. Text that
 * looks like a secret is cut out on export and again on import.
 */

export type Access = 'read' | 'writes' | 'key';
export const ACCESS_LABEL: Record<Access, string> = { read: 'Read only', writes: 'Writes', key: 'Holds a key' };
const RANK: Record<Access, number> = { read: 0, writes: 1, key: 2 };

const READ = new Set(['web', 'search', 'x_search', 'vision', 'session_search', 'clarify']);
const KEY = new Set(['connections', 'send_message', 'messaging', 'homeassistant', 'discord', 'spotify', 'x', 'twitter', 'image_gen', 'tts', 'moa', 'rl']);
/** What a tool group can do. Anything not known to be read-only or keyed counts as "writes". MCP servers hold keys. */
export const toolsetAccess = (name: string): Access => (READ.has(name) ? 'read' : KEY.has(name) ? 'key' : 'writes');
const highest = (xs: Access[]): Access => xs.reduce<Access>((a, b) => (RANK[b] > RANK[a] ? b : a), 'read');

export interface HireFile {
  format: 'heyzubi.hire';
  version: 1;
  exportedAt?: number;
  employee: { name: string; role: string; description: string; instructions: string; gender: string | null; effort: string | null; avatar: { shape: string | null; color: string | null; prop: string | null } };
  engine: { provider: string | null; model: string | null };
  soul: string;
  skills: { name: string; description: string; body: string }[];
  agentSkillsOff: string[];
  toolsets: string[];
  mcpServers: string[];
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const NAME = /^[\w.:@/+-]{1,120}$/;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : '');
const names = (v: unknown, max = 200) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && NAME.test(x)))].slice(0, max) : []);

/** Cut anything that looks like a key or password out of a text; say whether anything was cut. */
function scrub(text: string): [string, boolean] {
  const all = new RegExp(SECRET_LIKE.source, 'gi');
  const out = text.replace(all, '[removed: looked like a secret]');
  return [out, out !== text];
}

/** Read a hire file from what was uploaded: anything unknown is dropped, lengths are capped, secrets are cut out. */
export function readHire(raw: unknown): { file: HireFile; warnings: string[] } | string {
  const p = raw as any;
  if (!p || typeof p !== 'object' || p.format !== 'heyzubi.hire') return 'This isn’t a HeyZubi hire file.';
  if (p.version !== 1) return `This hire file is version ${String(p.version).slice(0, 10)}; this HeyZubi reads version 1.`;
  const warnings: string[] = [];
  const e = p.employee ?? {};
  const cut = (what: string, text: string) => { const [t, hit] = scrub(text); if (hit) warnings.push(`Something that looked like a key or password was removed from ${what}.`); return t; };
  const file: HireFile = {
    format: 'heyzubi.hire', version: 1, exportedAt: typeof p.exportedAt === 'number' ? p.exportedAt : undefined,
    employee: {
      name: str(e.name, 60).trim() || 'New team member',
      role: str(e.role, 80).trim(),
      description: cut('the description', str(e.description, 4000)),
      instructions: cut('the instructions', str(e.instructions, 20_000)),
      gender: isGender(e.gender) ? e.gender : null,
      effort: EFFORTS.includes(e.effort) ? e.effort : null,
      avatar: { shape: str(e.avatar?.shape, 20) || null, color: str(e.avatar?.color, 20) || null, prop: isPropId(e.avatar?.prop) ? e.avatar.prop : null },
    },
    engine: { provider: NAME.test(String(p.engine?.provider ?? '')) ? String(p.engine.provider) : null, model: NAME.test(String(p.engine?.model ?? '')) ? String(p.engine.model) : null },
    soul: cut('its character (SOUL)', str(p.soul, 200_000)),
    skills: (Array.isArray(p.skills) ? p.skills : []).slice(0, 100).map((s: any) => ({ name: str(s?.name, 80).trim(), description: str(s?.description, 300), body: str(s?.body, 20_000).trim() }))
      .filter((s: { name: string; body: string }) => s.name && s.body).map((s: { name: string; description: string; body: string }) => ({ ...s, body: cut(`the skill “${s.name}”`, s.body) })),
    agentSkillsOff: names(p.agentSkillsOff, 500),
    toolsets: names(p.toolsets, 100),
    mcpServers: names(p.mcpServers, 50),
  };
  if (!file.engine.provider !== !file.engine.model) file.engine = { provider: null, model: null };
  return { file, warnings: [...new Set(warnings)] };
}

/** What a hire file gives the employee, for the review screen and the bundle list. */
export function accessOf(f: HireFile) {
  const tools = [
    ...f.toolsets.map((name) => ({ name, kind: 'toolset' as const, access: toolsetAccess(name) })),
    // HeyZubi's own tools (the "hq" server) change things in the app; any other MCP server is a connected account.
    ...f.mcpServers.map((name) => (name === 'hq' ? { name, kind: 'heyzubi' as const, access: 'writes' as Access } : { name, kind: 'app' as const, access: 'key' as Access })),
  ];
  const level = highest(tools.map((t) => t.access));
  return { level, label: ACCESS_LABEL[level], tools: tools.map((t) => ({ ...t, label: ACCESS_LABEL[t.access] })) };
}

// ---------- role bundles: ready-made hire files ----------

const bundle = (id: string, name: string, role: string, description: string, instructions: string, toolsets: string[], mcpServers: string[] = []) =>
  ({ id, file: { format: 'heyzubi.hire', version: 1, employee: { name, role, description, instructions, gender: null, effort: null, avatar: { shape: null, color: null, prop: null } }, engine: { provider: null, model: null }, soul: '', skills: [], agentSkillsOff: [], toolsets, mcpServers } as HireFile });

export const BUNDLES = [
  bundle('researcher', 'Researcher', 'Researcher', 'Finds facts, competitors and sources on the web and reports back with links.',
    'Research what you are asked on the web. Give short findings with the source link for each. Say how sure you are. You change nothing: you only look things up and report.',
    ['web', 'vision', 'session_search', 'clarify']),
  bundle('writer', 'Writer', 'Content writer', 'Drafts posts, emails, scripts and pages, and keeps them as files for review.',
    'Write drafts in the owner’s voice and save them as files for review. Keep notes of what the owner likes. Never publish or send: leave drafts for the owner.',
    ['web', 'vision', 'file', 'memory', 'todo', 'skills', 'session_search', 'clarify']),
  bundle('builder', 'Builder', 'Developer', 'Builds and fixes code, scripts and small tools on its own computer.',
    'Build and fix code on your computer. Test what you change and say what you tested. Ask before anything that deletes data or touches a live system.',
    ['web', 'browser', 'terminal', 'file', 'code_execution', 'memory', 'todo', 'skills', 'session_search', 'clarify']),
  bundle('assistant', 'Assistant', 'Operations assistant', 'Works in your connected apps (email, calendar, sheets): sorts, prepares and drafts.',
    'Work in the owner’s connected apps: sort, look up, prepare and draft. Anything that sends, posts, pays or deletes waits for the owner’s OK.',
    ['web', 'file', 'memory', 'todo', 'cronjob', 'session_search', 'clarify'], ['composio']),
];

// ---------- routes ----------

export const hireApi = new Hono<AuthVars>();
hireApi.use('*', requireUser);

const ownBot = (userId: string, id: string) => { const b = getBotRow(id); return b && b.user_id === userId && b.kind !== 'room' ? b : null; };
const fileName = (n: string) => `${n.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'employee'}.hire.json`;

/** A team member as a hire file (downloaded). */
hireApi.get('/export/:id', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  let profile: Awaited<ReturnType<typeof describeProfile>> | null = null;
  if (profileNameFor(b.id)) profile = await describeProfile(b.id).catch(() => null);
  const skills = db.prepare('SELECT name, description, body FROM skills WHERE bot_id=? ORDER BY created_at ASC').all(b.id) as { name: string; description: string | null; body: string }[];
  const raw = {
    format: 'heyzubi.hire', version: 1, exportedAt: now(),
    employee: { name: b.name, role: b.label ?? '', description: b.description ?? '', instructions: b.instructions ?? '', gender: b.gender ?? null, effort: b.effort ?? null, avatar: { shape: b.avatar_shape ?? null, color: b.avatar_color ?? null, prop: b.avatar_prop ?? null } },
    engine: { provider: b.provider ?? profile?.model?.provider ?? null, model: b.model ?? profile?.model?.default ?? null },
    soul: profile?.soul ?? '',
    skills: skills.map((s) => ({ name: s.name, description: s.description ?? '', body: s.body })),
    agentSkillsOff: (profile?.skills ?? []).filter((s) => !s.enabled).map((s) => s.name),
    toolsets: (profile?.toolsets ?? []).filter((t) => t.enabled).map((t) => t.name),
    mcpServers: (profile?.mcp_servers ?? []).filter((m) => m.enabled).map((m) => m.name),
  };
  const read = readHire(raw);
  if (typeof read === 'string') return c.json({ error: read }, 500);
  return new Response(JSON.stringify(read.file, null, 2), { headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName(b.name)}"`,
    'Cache-Control': 'no-store',
    ...(read.warnings.length ? { 'X-Hire-Warnings': String(read.warnings.length) } : {}),
  } });
});

hireApi.get('/bundles', (c) => c.json({ bundles: BUNDLES.map((x) => ({ id: x.id, file: x.file, access: accessOf(x.file) })) }));

/** What importing this file would do: shown to the owner before anything is made. */
hireApi.post('/review', async (c) => {
  const text = await c.req.text();
  if (text.length > 1_000_000) return c.json({ error: 'That file is over 1 MB.' }, 413);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return c.json({ error: 'That file isn’t JSON.' }, 400); }
  const read = readHire((raw as any)?.file ?? raw);
  if (typeof read === 'string') return c.json({ error: read }, 400);
  return c.json({ file: read.file, warnings: read.warnings, access: accessOf(read.file) });
});

const uniqueName = (userId: string, name: string) => {
  let n = name.slice(0, 60);
  for (let i = 2; db.prepare('SELECT 1 FROM bots WHERE user_id=? AND lower(name)=lower(?)').get(userId, n); i++) n = `${name.slice(0, 56)} ${i}`;
  return n;
};

/** Hire: make the team member from a reviewed file, then set up its Hermes profile in the background. */
hireApi.post('/', async (c) => {
  const user = c.get('user').id;
  const p = await c.req.json().catch(() => null) as any;
  const read = readHire(p?.file);
  if (typeof read === 'string') return c.json({ error: read }, 400);
  const f = read.file;
  const useModel = p?.useModel !== false;
  let bot;
  try {
    bot = createBot(user, {
      name: uniqueName(user, str(p?.name, 60).trim() || f.employee.name), label: f.employee.role, description: f.employee.description, instructions: f.employee.instructions,
      avatarShape: f.employee.avatar.shape ?? undefined, avatarColor: f.employee.avatar.color ?? undefined, avatarProp: f.employee.avatar.prop, gender: isGender(f.employee.gender) ? f.employee.gender : null,
    });
  } catch (e: any) {
    if (e instanceof UserError) return c.json({ error: e.message }, 409);
    throw e;
  }
  if (f.employee.effort) db.prepare('UPDATE bots SET effort=? WHERE id=?').run(f.employee.effort, bot.id);
  const ins = db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
  for (const s of f.skills) ins.run(newId('skl'), bot.id, s.name, s.body, s.description, now(), now());
  void setUpProfile(bot.id, f, useModel);
  emitBot(bot.id);
  return c.json({ bot: { id: bot.id, name: bot.name } });
});

/** Give the new profile the file's character, model, tools and skills; tell the owner in its chat what was set. */
async function setUpProfile(botId: string, f: HireFile, useModel: boolean) {
  const say = (tone: 'info' | 'error', text: string) => { appendRow(botId, 'notice', { type: 'notice', tone, text }); emitBot(botId); };
  const wants = f.soul || f.toolsets.length || f.mcpServers.length || f.agentSkillsOff.length || (useModel && f.engine.model);
  if (!wants) return say('info', 'Hired from a hire file. It uses this HeyZubi’s usual tools and model.');
  try {
    await engineFor(botId); // its Hermes profile is made on its first start
    if (!profileNameFor(botId)) return say('info', 'Hired from a hire file. This team member isn’t a Hermes profile, so its tools and model stay as they are here.');
    const snap = await describeProfile(botId);
    const has = { tool: new Set(snap.toolsets.map((t) => t.name)), mcp: new Set(snap.mcp_servers.map((m) => m.name)), skill: new Set(snap.skills.map((s) => s.name)) };
    const changes: ProfileChanges = {};
    const missing: string[] = [];
    if (f.soul.trim()) changes.soul = f.soul;
    if (f.toolsets.length) { changes.enabled_toolsets = f.toolsets.filter((t) => has.tool.has(t)); missing.push(...f.toolsets.filter((t) => !has.tool.has(t))); }
    if (f.mcpServers.length) { changes.enabled_mcp_servers = f.mcpServers.filter((m) => has.mcp.has(m)); missing.push(...f.mcpServers.filter((m) => !has.mcp.has(m)).map((m) => `${m} (app)`)); }
    if (f.agentSkillsOff.length) changes.disabled_skills = f.agentSkillsOff.filter((s) => has.skill.has(s));
    if (useModel && f.engine.model && f.engine.provider) { changes.model = f.engine.model; changes.provider = f.engine.provider; }
    const notes: string[] = [];
    if (Object.keys(changes).length) {
      let r = await configureProfile(botId, changes);
      if (r.confirm_required && changes.model) {
        notes.push(`Its model (${f.engine.model}) wasn’t switched: Hermes asks you to confirm it first (${String(r.confirm_message ?? 'cost').slice(0, 160)}). Pick it in its settings if you want it.`);
        delete changes.model; delete changes.provider;
        r = Object.keys(changes).length ? await configureProfile(botId, changes) : r;
      }
      const failed = Object.entries(r.applied ?? {}).filter(([k, v]) => v === false && !k.endsWith('_conflicts')).map(([k]) => k);
      if (failed.length) notes.push(`These didn’t take: ${failed.join(', ')}.`);
      if (engineKind(botId) === 'managed') { forgetEngineOptions(botId); await restartEngine(botId).catch(() => {}); }
    }
    if (missing.length) notes.push(`This HeyZubi doesn’t have ${missing.join(', ')}, so those were left out.`);
    const level = accessOf({ ...f, toolsets: changes.enabled_toolsets ?? f.toolsets, mcpServers: changes.enabled_mcp_servers ?? f.mcpServers });
    say('info', `Hired from a hire file: ${level.label.toLowerCase()} (${level.tools.map((t) => t.name).join(', ') || 'usual tools'})${changes.model ? `, on ${changes.model}` : ''}.${notes.length ? ` ${notes.join(' ')}` : ''}`);
  } catch (e: any) {
    say('error', `Hired, but its tools and model couldn’t be set from the file: ${String(e?.message ?? e).slice(0, 200)}. Set them in its settings.`);
  }
}

/**
 * The access map: for every team member, each tool group it has (with its read only / writes / holds a key label), its
 * MCP servers, and which connected apps it can reach through HeyZubi's own tools ("hq": the owner's Composio apps).
 */
hireApi.get('/access-map', async (c) => {
  const user = c.get('user').id;
  const bots = db.prepare("SELECT id, name, label FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at ASC").all(user) as any[];
  let apps: string[] = [];
  try { const { connectedToolkits } = await import('./composio.js'); apps = [...await connectedToolkits(user)].sort(); } catch { /* Composio unreachable */ }
  const rows = await Promise.all(bots.map(async (b) => {
    if (!profileNameFor(b.id)) return { id: b.id, name: b.name, role: b.label ?? '', profile: null, error: 'Not a Hermes profile', level: null, tools: [], apps: [] };
    try {
      const p = await describeProfile(b.id);
      const f = { toolsets: p.toolsets.filter((t) => t.enabled).map((t) => t.name), mcpServers: p.mcp_servers.filter((m) => m.enabled).map((m) => m.name) } as HireFile;
      const a = accessOf(f);
      return { id: b.id, name: b.name, role: b.label ?? '', profile: p.name, level: a.level, label: a.label, tools: a.tools, apps: f.mcpServers.includes('hq') ? apps : [] };
    } catch (e: any) {
      return { id: b.id, name: b.name, role: b.label ?? '', profile: profileNameFor(b.id), error: String(e?.message ?? e).slice(0, 160), level: null, tools: [], apps: [] };
    }
  }));
  return c.json({ bots: rows, apps });
});
