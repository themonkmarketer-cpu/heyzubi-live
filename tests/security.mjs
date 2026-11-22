// Security checks against a throwaway server (no real keys, no engines, no computer).
// Usage: npm run build -w server && node tests/security.mjs
// Starts server/dist/index.js on a free port with made-up keys and a database in a temp folder,
// restarting it with different settings (local app, public URL, allowlist on and off).
// Nothing is sent off this machine: Composio is a stand-in served by this script and Hermes points
// at a closed local port. A few steps have the server listen on this machine's network address for
// a moment, to act as another device.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const ENTRY = path.join(ROOT, 'server/dist/index.js');
if (!fs.existsSync(ENTRY)) throw new Error('server/dist/index.js is missing: run `npm run build -w server` first');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'heyzubi-security-'));
const SECRET = crypto.randomBytes(32).toString('hex');
const PUBLIC_URL = 'https://hq.example.test';

const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e) {
    const why = String(e?.message ?? e).split('\n')[0];
    if (e?.skip) { results.push({ name, ok: true, skipped: true }); console.log(`SKIP ${name}: ${why}`); return; }
    results.push({ name, ok: false, error: why });
    console.log(`FAIL ${name}: ${why}`);
  }
};
const skip = (why) => { throw Object.assign(new Error(why), { skip: true }); };
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); };

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const PORT = await freePort();
const DEAD = 'http://127.0.0.1:9'; // nothing listens on the discard port
const BASE = `http://127.0.0.1:${PORT}`;
// An address of this machine that is not loopback, to stand in for "another device" (none = those steps are skipped).
const nics = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list ?? []).filter((i) => !i.internal && i.family === 'IPv4').map((i) => ({ name, address: i.address })));
const LAN_IP = (nics.find((i) => !/^(u?tun|tap)/.test(i.name)) ?? nics[0])?.address ?? null;
const LAN = LAN_IP ? `http://${LAN_IP}:${PORT}` : null;
const needLan = () => LAN ?? skip('this machine has no network address besides loopback');

// ---------- a stand-in for Composio: just enough of its API for Google sign-in ----------

const composio = { email: '', failProfile: false, failDelete: false, sessions: [], links: [], deleted: [], executed: [], other: [] };
const composioServer = http.createServer((q, res) => {
  let raw = '';
  q.on('data', (d) => { raw += d; });
  q.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const answer = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const p = q.url.split('?')[0];
    if (q.method === 'POST' && /\/tool_router\/session$/.test(p)) {
      composio.sessions.push(body.user_id);
      return answer(201, { session_id: `trs_${composio.sessions.length}`, mcp: { type: 'http', url: `${COMPOSIO}/mcp` }, tool_router_tools: [], config: { user_id: body.user_id } });
    }
    if (q.method === 'POST' && /\/tool_router\/session\/[^/]+\/link$/.test(p)) {
      const id = `ca_${composio.links.length + 1}`;
      composio.links.push({ id, toolkit: body.toolkit, callback: body.callback_url });
      return answer(201, { connected_account_id: id, redirect_url: `https://accounts.example.test/consent?ca=${id}`, link_token: 'lt' });
    }
    if (q.method === 'POST' && /\/tools\/execute\/proxy$/.test(p)) {
      return composio.failProfile ? answer(400, { error: { message: 'stand-in: profile unavailable' } }) : answer(200, { data: { emailAddress: composio.email }, status: 200, headers: {} });
    }
    if (q.method === 'DELETE' && /\/connected_accounts\/[^/]+$/.test(p)) {
      if (composio.failDelete) return answer(404, { error: { message: 'stand-in: no such connection' } });
      composio.deleted.push(p.split('/').pop());
      return answer(200, { success: true });
    }
    // A tool call that got as far as Composio (it was allowed). Nothing is done; the call is only written down.
    if (q.method === 'POST' && /\/tool_router\/session\/[^/]+\/execute$/.test(p)) {
      composio.executed.push(body.tool_slug);
      return answer(200, { data: { ok: true }, error: null, log_id: `log_${composio.executed.length}`, result_type: 'completed' });
    }
    // What a turn asks before it starts: which apps the user has connected (none).
    if (q.method === 'GET' && /\/connected_accounts$/.test(p)) return answer(200, { items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 });
    composio.other.push(`${q.method} ${p}`);
    answer(404, { error: { message: 'stand-in: not implemented' } });
  });
});
await new Promise((r) => composioServer.listen(0, '127.0.0.1', r));
const COMPOSIO = `http://127.0.0.1:${composioServer.address().port}`;
// Where bots' own gateways would listen. None ever starts here; the server only looks for one.
const ENGINE_PORT_BASE = await freePort();

// ---------- the server under test ----------

let child = null;
let log = '';
/** Hosts the server tried to reach outside this machine, over all its runs (each attempt was blocked). */
const blocked = new Set();
// A clean environment: none of the caller's keys, and HOME in the temp folder so no real Hermes home is read.
const serverEnv = (extra) => ({
  PATH: process.env.PATH ?? '', HOME: TMP, NODE_ENV: 'test', TELEMETRY_DISABLED: 'true',
  PORT: String(PORT), HOST: '127.0.0.1', SESSION_SECRET: SECRET, DB_PATH: path.join(TMP, 'hq.db'),
  XAI_API_KEY: 'test-not-a-key', COMPOSIO_API_KEY: 'test-not-a-key', COMPOSIO_BASE_URL: COMPOSIO, ORGO_API_KEY: 'test-not-a-key',
  HERMES_URL: DEAD, HERMES_HOME_PRIMARY: path.join(TMP, 'hermes'), HERMES_BIN: path.join(TMP, 'no-hermes'),
  ENGINES_DIR: path.join(TMP, 'engines'), ENGINE_PORT_BASE: String(ENGINE_PORT_BASE), MAX_BOTS: '20', HEYZUBI_NO_SCHEDULER: '1',
  ...extra,
});
// no-outbound.mjs fails any connection the server's code makes to another machine and names it on stderr.
const GUARD = ['--import', path.join(ROOT, 'tests/no-outbound.mjs')];

/** (Re)start the server with these settings on top of the throwaway defaults. `reach` is where to wait for it. */
async function start(extra, reach = BASE) {
  await stop();
  log = '';
  child = spawn(process.execPath, [...GUARD, ENTRY], { cwd: path.join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'], env: serverEnv(extra) });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; for (const m of String(d).matchAll(/\[no-outbound\] blocked a connection to (\S+)/g)) blocked.add(m[1]); });
  const mine = child;
  for (let i = 0; i < 100; i++) {
    if (mine.exitCode !== null) break;
    try { if ((await fetch(`${reach}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log}`);
}
async function stop() {
  if (!child) return;
  const c = child;
  child = null;
  if (c.exitCode === null) { c.kill('SIGTERM'); await new Promise((r) => c.once('exit', r)); }
}
const LOCAL = { APP_URL: 'http://localhost:5173', SERVER_URL: BASE, DEV_LOGIN: '1' };
const PUBLIC = { APP_URL: PUBLIC_URL, SERVER_URL: PUBLIC_URL, DEV_LOGIN: '0' };

// ---------- requests ----------

const req = (p, { cookie, headers, body, method, base = BASE } = {}) => fetch(`${base}${p}`, {
  method: method ?? (body === undefined ? 'GET' : 'POST'),
  redirect: 'manual',
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie: `heyzubi_live_session=${cookie}` } : {}), ...(headers ?? {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
/** Passes when nothing listens at `url`. */
async function refused(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(3000) }); } catch (e) {
    if (e?.cause?.code === 'ECONNREFUSED') return;
    throw new Error(`expected ${url} to refuse the connection, got ${e?.cause?.code ?? e}`);
  }
  throw new Error(`${url} answered`);
}
const sessionOf = (res) => (res.headers.get('set-cookie') ?? '').match(/heyzubi_live_session=([^;]+)/)?.[1];
const me = async (cookie) => (await (await req('/api/auth/me', { cookie })).json()).user?.email ?? null;
const hmac = (what) => crypto.createHmac('sha256', SECRET).update(what).digest('hex');
const asOwner = { authorization: `Bearer ${hmac('owner-login')}` };
/** What a bot's agent presents to /mcp/<slug> (see mcpToken in engine.ts). */
const asAgent = (slug) => ({ authorization: `Bearer ${hmac(`mcp:${slug}`)}` });
const mcp = (slug, message, opts = {}) => req(`/mcp/${slug}`, { ...opts, headers: { ...asAgent(slug), ...(opts.headers ?? {}) }, body: message });

/**
 * Google sign-in as `email`, the way a browser goes through it: start, then the provider's redirect
 * back to the callback. Answers with the callback's response and the connection the attempt made.
 */
async function googleSignIn(email, query = 'status=success') {
  composio.email = email;
  const started = await req('/api/auth/google/start');
  eq(started.status, 302, 'start');
  const link = composio.links.at(-1);
  const res = await req(`${new URL(link.callback).pathname}${new URL(link.callback).search}&${query}`);
  return { res, cookie: sessionOf(res), connection: link.id, provisionalUserId: composio.sessions.at(-1), failed: (res.headers.get('location') ?? '').includes('login=failed') };
}

/** Call one of the app's tools as a bot's agent would; answers with the text the agent gets back. */
async function tool(botId, name, args) {
  const res = await mcp(botId, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  eq(res.status, 200, `tools/call ${name}`);
  return (await res.json()).result.content[0].text;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until `fn` answers something truthy. */
async function until(fn, what, ms = 6000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200)) { const v = await fn(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * What the server's policyFor decides for each `[toolName, args]`, asked of the built code itself
 * (tests/policy-probe.mjs) for the account `email`, with `policies` ([tool, mode]) stored meanwhile.
 */
function decide(email, cases, policies = []) {
  const run = spawnSync(process.execPath, [...GUARD, path.join(ROOT, 'tests/policy-probe.mjs'), JSON.stringify({ email, cases, policies })], { cwd: path.join(ROOT, 'server'), env: serverEnv(LOCAL), encoding: 'utf8' });
  const line = run.stdout.split('\n').find((l) => l.startsWith('ANSWERS '));
  if (!line) throw new Error(`policy probe failed: ${run.stderr.trim().split('\n').pop()}`);
  return JSON.parse(line.slice(8));
}
/** "ask GMAIL_SEND_EMAIL" style summary of one decision: what was decided and what the card would list. */
const said = (p) => [p.decision, ...(p.decision === 'block' ? [p.key] : p.asks)].join(' ');

async function devLogin(email) {
  const res = await req('/api/auth/dev', { body: { email } });
  const cookie = sessionOf(res);
  if (!cookie) throw new Error(`dev login failed for ${email}: ${res.status}`);
  return cookie;
}

// ---------- A: the allowlist holds for accounts and sessions that already exist ----------

const STALE = 'stale@example.test';   // signed up while the app was open, never on the list
const LISTED = 'listed@example.test'; // on the list
const GUEST = 'guest@example.test';   // let in with the owner key, never on the list
const cookies = {};

try {
  await start(LOCAL);
  await step('local app: anyone signs in and stays signed in (empty list)', async () => {
    cookies.stale = await devLogin(STALE);
    cookies.listed = await devLogin(LISTED);
    eq(await me(cookies.stale), STALE, 'stale session');
    eq(await me(cookies.listed), LISTED, 'listed session');
  });

  await start({ ...PUBLIC, ALLOWED_EMAILS: `Listed@Example.test` });
  await step('public URL: a session whose address is not on the list is signed out', async () => {
    eq(await me(cookies.stale), null, '/api/auth/me');
    eq((await req('/api/bots', { cookie: cookies.stale })).status, 401, '/api/bots');
  });
  await step('public URL: a session whose address is on the list keeps working', async () => {
    eq(await me(cookies.listed), LISTED, '/api/auth/me');
    eq((await req('/api/bots', { cookie: cookies.listed })).status, 200, '/api/bots');
  });
  await step('public URL: the owner key signs in an address that is not on the list', async () => {
    const res = await req('/api/auth/owner', { headers: asOwner, body: { email: GUEST } });
    eq(res.status, 200, 'owner sign-in');
    cookies.guest = sessionOf(res);
    eq(await me(cookies.guest), GUEST, 'guest session');
    eq((await req('/api/bots', { cookie: cookies.guest })).status, 200, '/api/bots');
  });
  await step('public URL: an owner sign-in link works the same, once', async () => {
    const made = await (await req('/api/auth/owner', { headers: asOwner, body: { email: STALE, link: true } })).json();
    const linkPath = new URL(made.url).pathname;
    const res = await req(linkPath);
    cookies.staleByOwner = sessionOf(res);
    eq(await me(cookies.staleByOwner), STALE, 'session from the link');
    eq((await req(linkPath)).status, 410, 'second use of the link');
    // The owner vouched for that browser only: the old cookie stays refused.
    eq(await me(cookies.stale), null, 'the earlier session');
  });

  await start({ ...PUBLIC, ALLOWED_EMAILS: '' });
  await step('public URL, empty list: earlier accounts are signed out, owner sessions are kept', async () => {
    eq(await me(cookies.stale), null, 'stale session');
    eq(await me(cookies.listed), null, 'listed session');
    eq(await me(cookies.guest), GUEST, 'owner session');
    eq(await me(cookies.staleByOwner), STALE, 'owner link session');
    eq((await req('/api/auth/dev', { body: { email: LISTED } })).status, 403, 'dev login on a public URL');
  });

  await start(LOCAL);
  await step('local app again: every session works as before', async () => {
    eq(await me(cookies.stale), STALE, 'stale session');
    eq(await me(cookies.listed), LISTED, 'listed session');
  });

  // ---------- B: a local app listens on this machine only ----------

  await start({ ...LOCAL, HOST: undefined });
  await step('local app, HOST unset: listens on 127.0.0.1 and answers as localhost', async () => {
    eq((await fetch(`http://localhost:${PORT}/api/health`)).status, 200, 'http://localhost');
    if (!log.includes('listening on 127.0.0.1')) throw new Error(`start-up line does not name 127.0.0.1: ${log.split('\n').find((l) => l.includes('[heyzubi] server')) ?? '(none)'}`);
  });
  await step('local app, HOST unset: not offered on the network address', async () => refused(`${needLan()}/api/health`));
  if (LAN) await start({ ...LOCAL, HOST: LAN_IP }, LAN);
  await step('HOST set: the server listens there instead', async () => {
    eq((await fetch(`${needLan()}/api/health`)).status, 200, 'network address');
    await refused(`${BASE}/api/health`);
  });
  if (LAN) await start({ ...PUBLIC, ALLOWED_EMAILS: LISTED, HOST: undefined });
  await step('public URL, HOST unset: still every interface', async () => {
    eq((await fetch(`${needLan()}/api/health`)).status, 200, 'network address');
    eq((await fetch(`${BASE}/api/health`)).status, 200, 'loopback');
  });

  // ---------- C: the Gmail connection made for sign-in is never kept ----------

  await start(LOCAL);
  await step('Google sign-in, new account: signed in, connection deleted, account id is not the attempt\'s', async () => {
    const g = await googleSignIn('new.person@example.test');
    eq(await me(g.cookie), 'new.person@example.test', 'signed in as');
    eq(composio.deleted.includes(g.connection), true, 'connection deleted');
    const id = (await (await req('/api/auth/me', { cookie: g.cookie })).json()).user.id;
    if (id === g.provisionalUserId) throw new Error('the account took the id the connection was made under');
  });
  await step('Google sign-in, existing account: signed in, connection deleted', async () => {
    const g = await googleSignIn(STALE);
    eq(await me(g.cookie), STALE, 'signed in as');
    eq(composio.deleted.includes(g.connection), true, 'connection deleted');
  });
  await step('Google sign-in goes on when the connection cannot be deleted, and says so in the log', async () => {
    composio.failDelete = true;
    try {
      const g = await googleSignIn('undeletable@example.test');
      eq(await me(g.cookie), 'undeletable@example.test', 'signed in as');
      if (!log.includes(`could not delete connection ${g.connection}`)) throw new Error('nothing logged about the failed delete');
    } finally { composio.failDelete = false; }
  });
  await step('Google sign-in that cannot read the address: not signed in, connection deleted', async () => {
    composio.failProfile = true;
    try {
      const g = await googleSignIn('unread@example.test');
      eq(g.failed && !g.cookie, true, 'refused');
      eq(composio.deleted.includes(g.connection), true, 'connection deleted');
    } finally { composio.failProfile = false; }
  });
  await step('Google sign-in the provider reports as failed: not signed in, connection deleted', async () => {
    const g = await googleSignIn('gave.up@example.test', 'status=failed');
    eq(g.failed && !g.cookie, true, 'refused');
    eq(composio.deleted.includes(g.connection), true, 'connection deleted');
  });

  await start({ ...PUBLIC, ALLOWED_EMAILS: LISTED });
  await step('public URL: Google sign-in for an address off the list is refused, connection deleted', async () => {
    const g = await googleSignIn(STALE);
    eq(g.failed && !g.cookie, true, 'refused');
    eq(composio.deleted.includes(g.connection), true, 'connection deleted');
  });
  await step('public URL: Google sign-in for an address on the list works', async () => {
    const g = await googleSignIn(LISTED);
    eq(await me(g.cookie), LISTED, 'signed in as');
    eq(composio.deleted.includes(g.connection), true, 'connection deleted');
  });
  await start({ ...PUBLIC, ALLOWED_EMAILS: '' });
  await step('public URL, empty list: Google sign-in is refused even for an account that exists', async () => {
    const g = await googleSignIn(LISTED);
    eq(g.failed && !g.cookie, true, 'refused');
    eq(composio.deleted.includes(g.connection), true, 'connection deleted');
  });
  await step('only Gmail sign-in connections were made, and every one was deleted', async () => {
    eq(composio.links.every((l) => l.toolkit === 'gmail'), true, 'toolkit');
    // One is missing on purpose: the step where deleting fails.
    eq(composio.deleted.length, composio.links.length - 1, 'deleted connections');
    eq(composio.other.join(', '), '', 'unexpected Composio calls');
  });

  // ---------- D: only the exact app-connection callback skips the session check ----------

  await start({ ...PUBLIC, ALLOWED_EMAILS: LISTED });
  await step('signed out: routes that merely start like the callback need a session', async () => {
    eq((await req('/api/apps/callback', { method: 'DELETE' })).status, 401, 'DELETE /api/apps/callback');
    eq((await req('/api/apps/callback', { body: {} })).status, 401, 'POST /api/apps/callback');
    eq((await req('/api/apps/callback/connect', { body: {} })).status, 401, 'POST /api/apps/callback/connect');
    eq((await req('/api/apps/callbackx?slug=gmail')).status, 401, 'GET /api/apps/callbackx');
    eq((await req('/api/apps/callback/x?slug=gmail')).status, 401, 'GET /api/apps/callback/x');
  });
  await step('signed out: the callback itself and the sign-in routes still answer', async () => {
    const page = await req('/api/apps/callback?slug=gmail');
    eq(page.status, 200, 'GET /api/apps/callback');
    if (!(await page.text()).includes('heyzubi-connected')) throw new Error('the callback page lost its script');
    eq((await req('/api/auth/me')).status, 200, 'GET /api/auth/me');
    eq((await req('/api/auth/logout', { body: {} })).status, 200, 'POST /api/auth/logout');
    eq((await req('/api/health')).status, 200, 'GET /api/health');
  });

  // ---------- E: the owner sign-in and /mcp answer only calls made on this machine ----------

  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  await start({ ...PUBLIC, ALLOWED_EMAILS: LISTED });
  await step('from this machine: the owner key and an agent token work', async () => {
    eq((await req('/api/auth/owner', { headers: asOwner, body: { email: GUEST } })).status, 200, 'owner sign-in');
    const res = await mcp('primary', ping);
    eq(res.status, 200, '/mcp/primary');
    eq(JSON.stringify((await res.json()).result), '{}', 'ping');
  });
  await step('from this machine with a wrong key: refused', async () => {
    eq((await req('/api/auth/owner', { headers: { authorization: `Bearer ${hmac('something-else')}` }, body: { email: GUEST } })).status, 403, 'owner sign-in');
    eq((await req('/mcp/primary', { headers: asAgent('other'), body: ping })).status, 401, '/mcp/primary');
  });
  await step('passed on by a proxy (forwarding headers): refused even with the right key', async () => {
    for (const h of [{ 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { 'x-real-ip': '203.0.113.9' }, { 'x-forwarded-host': 'hq.example.test' }, { 'x-forwarded-proto': 'https' }, { via: '1.1 proxy' }]) {
      const name = Object.keys(h)[0];
      eq((await req('/api/auth/owner', { headers: { ...asOwner, ...h }, body: { email: GUEST } })).status, 403, `owner sign-in with ${name}`);
      eq((await mcp('primary', ping, { headers: h })).status, 403, `/mcp/primary with ${name}`);
    }
  });
  if (LAN) await start({ ...PUBLIC, ALLOWED_EMAILS: LISTED, HOST: LAN_IP }, LAN);
  await step('from another address: refused even with the right key', async () => {
    const base = needLan();
    eq((await req('/api/health', { base })).status, 200, 'reachable at all');
    eq((await req('/api/auth/owner', { base, headers: asOwner, body: { email: GUEST } })).status, 403, 'owner sign-in');
    eq((await mcp('primary', ping, { base })).status, 403, '/mcp/primary');
    if (!log.includes('[mcp] refused a call')) throw new Error('nothing logged about the refused /mcp call');
  });

  // ---------- F: nothing the server sends may be framed by another site ----------

  await start({ ...PUBLIC, ALLOWED_EMAILS: LISTED });
  await step('every kind of response forbids framing', async () => {
    const answers = {
      'GET /api/health (json)': await req('/api/health'),
      'GET /api/bots (401)': await req('/api/bots'),
      'GET /api/apps/callback (page)': await req('/api/apps/callback?slug=gmail'),
      'GET / (the app, or 404 when it is not built)': await req('/'),
      'GET /favicon.svg (a file of the app, or 404)': await req('/favicon.svg'),
      'GET /no/such/page': await req('/no/such/page'),
      'GET /mcp/primary (405)': await req('/mcp/primary'),
      'GET /api/auth/link/x (410)': await req('/api/auth/link/x'),
    };
    // The event stream answers before it has anything to send; its headers are enough here.
    const gone = new AbortController();
    answers['GET /api/events (stream)'] = await fetch(`${BASE}/api/events`, { headers: { cookie: `heyzubi_live_session=${cookies.listed}` }, signal: gone.signal });
    eq(answers['GET /api/events (stream)'].status, 200, 'event stream');
    for (const [what, res] of Object.entries(answers)) {
      eq(res.headers.get('x-frame-options'), 'DENY', `${what}: X-Frame-Options`);
      eq(res.headers.get('content-security-policy'), "frame-ancestors 'none'", `${what}: Content-Security-Policy`);
    }
    gone.abort();
  });

  // ---------- G: a bot can delete only its own routines ----------

  // With the scheduler on, so a routine that runs every second shows whether its schedule is alive.
  // Each run starts a turn that fails at once (no engine listens), which is all it needs to do here.
  await start({ ...LOCAL, HEYZUBI_NO_SCHEDULER: undefined });
  const mainBot = async (cookie) => (await (await req('/api/bots', { cookie })).json()).bots.find((b) => b.isPrimary).id;
  const routineOf = async (cookie, botId, id) => (await (await req(`/api/bots/${botId}/routines`, { cookie })).json()).routines.find((r) => r.id === id);
  let owner, other, routineId;
  await step('a bot makes a routine and it runs', async () => {
    owner = await mainBot(cookies.stale);
    other = await mainBot(cookies.listed);
    routineId = JSON.parse(await tool(owner, 'create_routine', { name: 'tick', prompt: 'tick', schedule: '* * * * * *' })).routine.id;
    await until(async () => (await routineOf(cookies.stale, owner, routineId))?.lastRunAt, 'the first run');
  });
  await step('another user\'s bot cannot delete it: "No such routine.", and it keeps running', async () => {
    eq(await tool(other, 'delete_routine', { routine_id: routineId }), 'No such routine.', 'answer to the other bot');
    const seen = (await routineOf(cookies.stale, owner, routineId))?.lastRunAt;
    if (!seen) throw new Error('the routine is gone');
    // Its schedule was not stopped on the way to that answer.
    await until(async () => (await routineOf(cookies.stale, owner, routineId))?.lastRunAt > seen, 'a run after the refused delete');
  });
  await step('its own bot deletes it; a routine that does not exist is "No such routine."', async () => {
    eq(await tool(owner, 'delete_routine', { routine_id: routineId }), 'Deleted.', 'answer to the owner');
    eq(await routineOf(cookies.stale, owner, routineId), undefined, 'routine after delete');
    eq(await tool(owner, 'delete_routine', { routine_id: routineId }), 'No such routine.', 'answer the second time');
  });

  // ---------- H: sign-in attempts nobody finished do not pile up ----------

  await step('starting a Google sign-in drops attempts older than 15 minutes, and only those', async () => {
    const db = new Database(path.join(TMP, 'hq.db'));
    try {
      const add = db.prepare('INSERT INTO login_attempts(id,provisional_user_id,connected_account_id,created_at) VALUES (?,?,?,?)');
      add.run('login_old', 'usr_old', 'ca_old', Date.now() - 16 * 60_000);
      add.run('login_recent', 'usr_recent', 'ca_recent', Date.now() - 5 * 60_000);
      eq((await req('/api/auth/google/start')).status, 302, 'start');
      const left = db.prepare('SELECT id FROM login_attempts ORDER BY created_at').all().map((r) => r.id);
      eq(left.includes('login_old'), false, 'the old attempt is still there');
      eq(left.includes('login_recent'), true, 'the recent attempt is kept');
      eq(left.length, 2, 'attempts left (the recent one and the one just started)');
    } finally { db.close(); }
  });

  // ---------- I: app actions ask first; only a named few lookup tools run on their own ----------

  const batch = (...slugs) => ({ tools: slugs.map((tool_slug) => ({ tool_slug, arguments: { id: '1' } })) });
  await step('a slug that merely sounds read-only asks (GMAIL_GET_PROFILE, and inside a batch)', async () => {
    const [direct, inBatch, lower] = decide(STALE, [['GMAIL_GET_PROFILE', {}], ['COMPOSIO_MULTI_EXECUTE_TOOL', batch('GMAIL_FETCH_EMAILS', 'GITHUB_LIST_REPOS')], ['gmail_get_profile', {}]]);
    eq(said(direct), 'ask GMAIL_GET_PROFILE', 'direct call');
    eq(said(inBatch), 'ask GMAIL_FETCH_EMAILS GITHUB_LIST_REPOS', 'batch');
    eq(said(lower), 'ask GMAIL_GET_PROFILE', 'lower-case spelling');
  });
  await step('a COMPOSIO_ tool nobody listed asks; the two lookup tools run', async () => {
    const [unknown, proxy, search, schemas, searchLower] = decide(STALE, [['COMPOSIO_FOO', {}], ['COMPOSIO_PROXY_EXECUTE', { endpoint: '/x' }], ['COMPOSIO_SEARCH_TOOLS', {}], ['COMPOSIO_GET_TOOL_SCHEMAS', {}], ['composio_search_tools', {}]]);
    eq(said(unknown), 'ask COMPOSIO_FOO', 'COMPOSIO_FOO');
    eq(said(proxy), 'ask COMPOSIO_PROXY_EXECUTE', 'COMPOSIO_PROXY_EXECUTE');
    eq(said(search), 'allow', 'COMPOSIO_SEARCH_TOOLS');
    eq(said(schemas), 'allow', 'COMPOSIO_GET_TOOL_SCHEMAS');
    eq(said(searchLower), 'allow', 'composio_search_tools');
  });
  await step('sandbox code asks whatever it looks like (the word composio hidden by joining strings, or plain ls)', async () => {
    const hidden = { code_to_execute: "f = globals()['run_' + 'comp' + 'osio_tool']\nf('GMAIL_SEND_EMAIL', {'to': 'x@example.test'})" };
    const [workbench, bash] = decide(STALE, [['COMPOSIO_REMOTE_WORKBENCH', hidden], ['COMPOSIO_REMOTE_BASH_TOOL', { command: 'ls' }]]);
    eq(said(workbench), 'ask COMPOSIO_REMOTE_WORKBENCH', 'workbench');
    eq(said(bash), 'ask COMPOSIO_REMOTE_BASH_TOOL', 'bash');
    // The user's own stored choice for the tool still decides.
    const [allowed, refused] = decide(STALE, [['COMPOSIO_REMOTE_WORKBENCH', hidden], ['COMPOSIO_REMOTE_BASH_TOOL', { command: 'ls' }]], [['COMPOSIO_REMOTE_WORKBENCH', 'always_allow'], ['COMPOSIO_REMOTE_BASH_TOOL', 'blocked']]);
    eq(said(allowed), 'allow', 'workbench with always_allow stored');
    eq(said(refused), 'block COMPOSIO_REMOTE_BASH_TOOL', 'bash with blocked stored');
  });
  await step('a batch asks about every action that needs it: a draft and a delete are both listed', async () => {
    const [both] = decide(STALE, [['COMPOSIO_MULTI_EXECUTE_TOOL', batch('GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_DELETE_MESSAGE')]]);
    eq(said(both), 'ask GMAIL_CREATE_EMAIL_DRAFT GMAIL_DELETE_MESSAGE', 'draft + delete');
    eq(both.title, 'Apps: run 2 actions', 'title');
  });
  await step('stored policies still decide: always_allow is honoured, one blocked action blocks the batch', async () => {
    const stored = [['GMAIL_FETCH_EMAILS', 'always_allow'], ['GMAIL_DELETE_MESSAGE', 'blocked']];
    const [alone, withMore, withBlocked] = decide(STALE, [
      ['COMPOSIO_MULTI_EXECUTE_TOOL', batch('GMAIL_FETCH_EMAILS')],
      ['COMPOSIO_MULTI_EXECUTE_TOOL', batch('GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL')],
      ['COMPOSIO_MULTI_EXECUTE_TOOL', batch('GMAIL_FETCH_EMAILS', 'GMAIL_DELETE_MESSAGE')],
    ], stored);
    eq(said(alone), 'allow', 'only the allowed action');
    eq(said(withMore), 'ask GMAIL_SEND_EMAIL', 'allowed action plus another');
    eq(said(withBlocked), 'block GMAIL_DELETE_MESSAGE', 'allowed action plus a blocked one');
  });
  await step('a batch that cannot be read in full asks as a whole and offers nothing to remember', async () => {
    const answers = decide(STALE, [
      ['COMPOSIO_MULTI_EXECUTE_TOOL', {}],
      ['COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [] }],
      ['COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }, { toolSlug: 'GMAIL_SEND_EMAIL' }] }],
      ['COMPOSIO_MULTI_EXECUTE_TOOL', batch('COMPOSIO_MULTI_EXECUTE_TOOL')],
      ['Composio_Multi_Execute_Tool', batch('COMPOSIO_MULTI_EXECUTE_TOOL')],
    ], [['COMPOSIO_MULTI_EXECUTE_TOOL', 'always_allow'], ['GMAIL_FETCH_EMAILS', 'always_allow']]);
    eq(answers.map(said).join(' | '), 'ask | ask | ask | ask | ask', 'no list, empty list, unreadable entry, batch in a batch, other spelling');
  });

  // The same through the door the agents use, with the card the user sees and what "Always allow" stores.
  await start(LOCAL);
  const agentBot = async (cookie) => (await (await req('/api/bots', { cookie })).json()).bots.find((b) => b.isPrimary).id;
  const pendingCard = async (cookie, botId) => (await (await req(`/api/bots/${botId}/rows`, { cookie })).json()).rows.map((r) => r.body).find((b) => b.card === 'approval' && b.status === 'pending');
  const policiesOf = async (cookie) => (await (await req('/api/policies', { cookie })).json()).policies.map((p) => `${p.tool}=${p.mode}`).sort().join(' ');
  const answerCard = (cookie, card, decision) => req(`/api/approvals/${card.approvalId}`, { cookie, body: { decision } });
  await step('batch card lists both actions; "Always allow" stores exactly those; then the batch runs unasked', async () => {
    const bot = await agentBot(cookies.listed);
    const call = tool(bot, 'COMPOSIO_MULTI_EXECUTE_TOOL', batch('GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_DELETE_MESSAGE'));
    const card = await until(() => pendingCard(cookies.listed, bot), 'the approval card');
    eq(card.tools.join(' '), 'GMAIL_CREATE_EMAIL_DRAFT GMAIL_DELETE_MESSAGE', 'actions on the card');
    if (!/run 2 actions\?$/.test(card.title)) throw new Error(`card title: ${card.title}`);
    if (!card.detail.includes('Gmail: create email draft') || !card.detail.includes('Gmail: delete message')) throw new Error(`card detail does not name both actions: ${card.detail}`);
    eq(composio.executed.length, 0, 'calls that reached Composio while the card was open');
    eq((await answerCard(cookies.listed, card, 'always')).status, 200, 'answering the card');
    await call;
    eq(composio.executed.join(' '), 'COMPOSIO_MULTI_EXECUTE_TOOL', 'calls that reached Composio');
    eq(await policiesOf(cookies.listed), 'GMAIL_CREATE_EMAIL_DRAFT=always_allow GMAIL_DELETE_MESSAGE=always_allow', 'stored policies');
    await tool(bot, 'COMPOSIO_MULTI_EXECUTE_TOOL', batch('GMAIL_DELETE_MESSAGE', 'GMAIL_CREATE_EMAIL_DRAFT'));
    eq(composio.executed.length, 2, 'calls that reached Composio after the second, unasked batch');
  });
  await step('a new action in the batch asks for that one only; "Don\'t allow" runs nothing and stores nothing', async () => {
    const bot = await agentBot(cookies.listed);
    const call = tool(bot, 'COMPOSIO_MULTI_EXECUTE_TOOL', batch('GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_SEND_EMAIL'));
    const card = await until(() => pendingCard(cookies.listed, bot), 'the approval card');
    eq(card.tools.join(' '), 'GMAIL_SEND_EMAIL', 'actions on the card');
    await answerCard(cookies.listed, card, 'deny');
    if (!(await call).startsWith('The user declined')) throw new Error('the agent was not told the action was declined');
    eq(composio.executed.length, 2, 'calls that reached Composio');
    eq(await policiesOf(cookies.listed), 'GMAIL_CREATE_EMAIL_DRAFT=always_allow GMAIL_DELETE_MESSAGE=always_allow', 'stored policies');
  });
  await step('sandbox code waits for a card; a lookup tool goes straight through', async () => {
    const bot = await agentBot(cookies.listed);
    const call = tool(bot, 'composio_remote_workbench', { code_to_execute: "print('hi')" });
    const card = await until(() => pendingCard(cookies.listed, bot), 'the approval card');
    eq(card.tools.join(' '), 'COMPOSIO_REMOTE_WORKBENCH', 'tool on the card');
    await answerCard(cookies.listed, card, 'deny');
    await call;
    eq(composio.executed.length, 2, 'calls that reached Composio');
    await tool(bot, 'COMPOSIO_SEARCH_TOOLS', { queries: [{ use_case: 'send an email' }] });
    eq(composio.executed.at(-1), 'COMPOSIO_SEARCH_TOOLS', 'last call that reached Composio');
  });

  // ---------- J: the computer's own agent (the primary engine) goes to the owner's account only ----------

  const BOSS = 'boss@example.test';
  const EARLY = 'early@example.test';
  // The engine panel names the agent a bot runs on: 'default' is the one that already lives on the computer.
  const engineOf = async (cookie, botId) => ((await (await req(`/api/bots/${botId}/engine`, { cookie })).json()).engine.profile === 'default' ? 'primary' : 'own');
  const ownerSignIn = async (email) => sessionOf(await req('/api/auth/owner', { headers: asOwner, body: { email } }));
  const newBot = async (cookie, name) => (await (await req('/api/bots', { cookie, body: { name } })).json()).bot.id;
  const ownerDb = path.join(TMP, 'owner.db');
  await start({ ...PUBLIC, ALLOWED_EMAILS: `${BOSS},${EARLY}`, OWNER_EMAIL: 'Boss@Example.test', DB_PATH: ownerDb });
  let boss, early, bossBot;
  await step('the first account to arrive is not the owner: its bot gets an agent of its own', async () => {
    early = await ownerSignIn(EARLY);
    eq(await engineOf(early, await agentBot(early)), 'own', 'first bot on the instance');
  });
  await step('the owner arrives later and its bot is the computer\'s own agent', async () => {
    boss = await ownerSignIn(BOSS);
    bossBot = await agentBot(boss);
    eq(await engineOf(boss, bossBot), 'primary', 'owner\'s bot');
    eq(await engineOf(boss, await newBot(boss, 'Second')), 'own', 'owner\'s second bot');
  });
  await step('with that bot gone, the next bot of someone else does not inherit the agent; the owner\'s next one does', async () => {
    // Removed in the database, which is all the delete route does to the binding; the route itself
    // would also reach for the computer to clean up the bot's files.
    const db = new Database(ownerDb);
    try { db.prepare('DELETE FROM bots WHERE id=?').run(bossBot); } finally { db.close(); }
    eq(await engineOf(early, await newBot(early, 'Hopeful')), 'own', 'next bot of another account');
    eq(await engineOf(boss, await newBot(boss, 'Again')), 'primary', 'next bot of the owner');
  });
  await start({ ...PUBLIC, ALLOWED_EMAILS: EARLY, DB_PATH: path.join(TMP, 'no-owner.db') });
  await step('public URL without OWNER_EMAIL: nobody gets the computer\'s own agent, and the start-up log says so', async () => {
    const c = await ownerSignIn(EARLY);
    eq(await engineOf(c, await agentBot(c)), 'own', 'first bot on the instance');
    if (!log.includes('[env] OWNER_EMAIL is not set')) throw new Error('no start-up warning about OWNER_EMAIL');
  });
  // The main database of this run: made as a local app, where the first account (not an owner) got the agent.
  await start({ ...PUBLIC, ALLOWED_EMAILS: LISTED, OWNER_EMAIL: LISTED });
  await step('upgrade with the agent already bound to another account: left as it is, with a warning at start', async () => {
    eq(await engineOf(cookies.staleByOwner, await agentBot(cookies.staleByOwner)), 'primary', `${STALE}'s bot`);
    const warning = log.split('\n').find((l) => l.startsWith('[engine] The computer\'s own agent')) ?? '';
    if (!warning.includes(STALE) || !warning.includes('Nothing was changed')) throw new Error(`start-up warning: ${warning || '(none)'}`);
    // And the owner does not get a second binding while that one stands.
    eq(await engineOf(cookies.listed, await newBot(cookies.listed, 'Mine')), 'own', 'a new bot of the owner');
  });
  await start(LOCAL);
  await step('local app without OWNER_EMAIL: as before, no warning', async () => {
    eq(await engineOf(cookies.stale, await agentBot(cookies.stale)), 'primary', 'the first account\'s bot');
    if (log.includes('[engine] The computer\'s own agent') || log.includes('OWNER_EMAIL is not set')) throw new Error('a warning was logged for a local app');
  });

  // ---------- K: sign-in attempts are limited per address ----------

  // On every interface where there is a second address, so a request can also arrive from "somewhere else".
  await start({ ...LOCAL, HOST: LAN ? '0.0.0.0' : '127.0.0.1' });
  const wrongKey = { authorization: `Bearer ${hmac('not-the-owner-key')}` };
  await step('Google sign-in: ten starts from one address, then 429; another address is counted on its own', async () => {
    for (let i = 1; i <= 10; i++) eq((await req('/api/auth/google/start')).status, 302, `start ${i}`);
    const over = await req('/api/auth/google/start');
    eq(over.status, 429, 'start 11');
    if (!(Number(over.headers.get('retry-after')) > 0)) throw new Error(`Retry-After: ${over.headers.get('retry-after')}`);
    if (LAN) eq((await req('/api/auth/google/start', { base: LAN })).status, 302, 'a start from the other address');
  });
  await step('dev sign-in: refused when passed on by a proxy, limited to ten from one address', async () => {
    eq((await req('/api/auth/dev', { headers: { 'x-forwarded-for': '203.0.113.9' }, body: { email: STALE } })).status, 403, 'with X-Forwarded-For');
    if (LAN) eq((await req('/api/auth/dev', { base: LAN, body: { email: STALE } })).status, 403, 'from the other address');
    for (let i = 1; i <= 10; i++) eq((await req('/api/auth/dev', { body: { email: STALE } })).status, 200, `sign-in ${i}`);
    eq((await req('/api/auth/dev', { body: { email: STALE } })).status, 429, 'sign-in 11');
  });
  let goodLink;
  await step('sign-in links: five bad links from one address, then 429, and a good link is not used up by that', async () => {
    goodLink = new URL((await (await req('/api/auth/owner', { headers: asOwner, body: { email: GUEST, link: true } })).json()).url).pathname;
    for (let i = 1; i <= 5; i++) eq((await req(`/api/auth/link/no-such-link-${i}`)).status, 410, `bad link ${i}`);
    eq((await req('/api/auth/link/no-such-link-6')).status, 429, 'bad link 6');
    eq((await req(goodLink)).status, 429, 'the good link from the same address');
    if (LAN) eq(await me(sessionOf(await req(goodLink, { base: LAN }))), GUEST, 'the good link from the other address');
  });
  await step('owner key: wrong keys from elsewhere are not counted; five from this machine close it for a while', async () => {
    for (let i = 1; i <= 8; i++) eq((await req('/api/auth/owner', { headers: { ...wrongKey, 'x-forwarded-for': '203.0.113.9' }, body: { email: GUEST } })).status, 403, `forwarded wrong key ${i}`);
    eq((await req('/api/auth/owner', { headers: asOwner, body: { email: GUEST } })).status, 200, 'right key after those');
    for (let i = 1; i <= 5; i++) eq((await req('/api/auth/owner', { headers: wrongKey, body: { email: GUEST } })).status, 403, `wrong key ${i}`);
    eq((await req('/api/auth/owner', { headers: asOwner, body: { email: GUEST } })).status, 429, 'right key after five wrong ones');
  });
} finally {
  await stop();
  composioServer.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

// Two things the server reaches for on its own, both blocked here: the Composio SDK's version check
// at start, and Composio's app catalog for the name and logo on an approval card.
const EXPECTED_BLOCKED = ['registry.npmjs.org', 'backend.composio.dev'];
await step('the server reached for nothing outside this machine but the Composio version check and app catalog', async () => {
  eq([...blocked].filter((h) => !EXPECTED_BLOCKED.includes(h)).join(', '), '', 'other hosts it tried (all blocked)');
});
console.log(`   blocked outbound connections: ${[...blocked].join(', ') || 'none'}`);

const failed = results.filter((r) => !r.ok).length;
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped.`);
if (failed && log) console.log(`--- last server log ---\n${log}`);
process.exit(failed ? 1 : 0);
