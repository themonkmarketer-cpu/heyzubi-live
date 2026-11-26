#!/usr/bin/env node
// Hardening check for HeyZubi's own endpoints. It reads server/src to list every route (following app.route mounts),
// then calls each one on a running HeyZubi WITHOUT signing in, and once more as a cross-site write, and reports what
// answered. Every route must refuse (401/403/404/405) unless it is on the PUBLIC list below, which says why it is open.
//
//   node scripts/audit-endpoints.mjs https://your-heyzubi:8443 [--json]
//
// It sends no cookies or keys, and its write requests carry a body that is not valid JSON, so a route that wrongly
// accepts them still has nothing to act on.
import fs from 'node:fs';
import path from 'node:path';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) { console.error('usage: node scripts/audit-endpoints.mjs <base-url> [--json]'); process.exit(2); }
const asJson = process.argv.includes('--json');
const SRC = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'server', 'src');

// Routes that are open on purpose, and why.
const PUBLIC = [
  [/^GET \/api\/health$/, 'liveness check, says nothing private'],
  [/^(GET|POST) \/api\/auth\//, 'signing in'],
  [/^GET \/api\/me$/, 'tells a signed-out page that it is signed out'],
  [/^GET \/api\/apps\/callback$/, 'return page after connecting an app: acts only for the signed-in owner (cookie), checks the app name'],
  [/^POST \/api\/inbound\/hooks\/:id$/, 'webhooks: each needs its own secret or signature (401 without)'],
  [/^GET \/api\/inbound\/hooks\/result\/:token$/, 'webhook result: needs the unguessable result token'],
  [/^POST \/api\/inbound\//, 'outside programs: need an API key (401 without)'],
  [/^GET \/s\/:token$/, 'share links: need the unguessable link, expire, can be turned off'],
  [/^(GET|POST) \/api\/desktop\//, 'Windows app pairing: needs a one-time pairing code or device key'],
  [/^(GET|POST|ALL) \/mcp/, 'agents\' tools: local requests only, with a per-bot token'],
];

const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ts')) files.push(p); } })(SRC);

const owner = new Map(); // exported Hono name -> its file's text
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/export const (\w+) = new Hono/g)) owner.set(m[1], t);
  if (f.endsWith(`${path.sep}index.ts`) && path.dirname(f) === SRC) owner.set('app', t);
}
function collect(name, prefix, out, seen = new Set()) {
  const t = owner.get(name);
  if (!t || seen.has(`${name}@${prefix}`)) return;
  seen.add(`${name}@${prefix}`);
  for (const m of t.matchAll(new RegExp(`\\b${name}\\.(get|post|put|patch|delete|all)\\(\\s*'([^']*)'`, 'g'))) out.push({ method: m[1].toUpperCase(), path: (prefix + (m[2] === '/' ? '' : m[2])) || '/' });
  for (const m of t.matchAll(new RegExp(`\\b${name}\\.route\\(\\s*'([^']*)'\\s*,\\s*(\\w+)\\s*\\)`, 'g'))) collect(m[2], prefix + m[1], out, seen);
}
const routes = [];
collect('app', '', routes);
const uniq = [...new Map(routes.filter((r) => r.path !== '*' && !r.path.endsWith('/*')).map((r) => [`${r.method} ${r.path}`, r])).values()];

const fill = (p) => p.replace(/:(\w+)\{[^}]*\}/g, 'x').replace(/:\w+/g, 'audit-x');
const results = [];
for (const r of uniq) {
  const key = `${r.method} ${r.path}`;
  const open = PUBLIC.find(([re]) => re.test(key));
  const url = base + fill(r.path);
  const method = r.method === 'ALL' ? 'GET' : r.method;
  const write = !['GET', 'HEAD'].includes(method);
  let status = 0, cross = null;
  try {
    status = (await fetch(url, { method, redirect: 'manual', headers: write ? { 'content-type': 'application/json' } : {}, body: write ? 'not-json' : undefined, signal: AbortSignal.timeout(15000) })).status;
    if (write && url.includes('/api/')) cross = (await fetch(url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, body: 'not-json', signal: AbortSignal.timeout(15000) })).status;
  } catch { status = -1; }
  const refused = [401, 403, 404, 405, 410].includes(status);
  const crossOk = cross === null || cross === 403;
  const verdict = status === -1 ? 'error' : open ? (crossOk ? 'open (by design)' : 'FAIL: cross-site write not refused') : refused && crossOk ? 'refused' : 'FAIL';
  results.push({ route: key, status, cross, verdict, why: open?.[1] ?? '' });
}
const fails = results.filter((r) => r.verdict.startsWith('FAIL'));
if (asJson) console.log(JSON.stringify({ checked: results.length, fails: fails.length, results }, null, 1));
else {
  for (const r of results) console.log(`${r.verdict.padEnd(34)} ${String(r.status).padEnd(4)} ${r.cross ?? '-'}\t${r.route}${r.why ? `  (${r.why})` : ''}`);
  console.log(`\n${results.length} routes checked; ${fails.length} problem(s).`);
}
process.exit(fails.length ? 1 : 0);
