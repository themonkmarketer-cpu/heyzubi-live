import { resumeReels } from './reels/stages.js';
import { resumeChats } from './reels/agent.js';
import { editorFetch, isEditorHost } from './reels/studio-proxy.js';
import { kanbanApi } from './routes-kanban.js';
import { syncAllIdentities } from './hermes-identity.js';
import { installZubiSkills } from './zubi-skills.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { compatEnv, env } from './env.js';
import { api } from './routes.js';
import { attachVncRelay } from './vnc.js';
import { initRoutines } from './routines.js';
import { initTriggers } from './triggers.js';
import { initProactive } from './proactive.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms } from './agent/rooms.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { enqueue, expireStaleApprovals, resumeInterrupted } from './agent/loop.js';
import { desSelfTest } from './lib/des.js';
import { configApi } from './routes-config.js';
import { hireApi } from './hire.js';
import { startIdleWatcher } from './idle.js';
import { mcpApi } from './mcp.js';
import { initEngines } from './engine.js';
import { initSessionTidy } from './engine-sessions.js';
import { sameOriginWrites } from './lib/auth.js';
import { resolveBoxData } from './paths.js';

if (!desSelfTest()) throw new Error('DES self-test failed');
initSubagents();
initRooms();
// Approvals wait in memory; whatever was still open when the last process stopped can no longer be answered.
expireStaleApprovals();
// A message the owner sent just before a restart would otherwise never get its reply.
setTimeout(resumeInterrupted, 3000);
// One Hermes session per team member: extras HeyZubi left behind go shortly after start and every hour.
initSessionTidy();
resumeReels();
void import('./reels/flow.js').then((f) => f.initStatusPosts());
void import('./reels/jobs.js').then((j) => j.initJobs());
void import('./reels/handoff.js').then((h) => h.initHandoffs()); // finished episodes go to the PC for their landing page
void import('./kanban-watch.js').then((k) => k.initKanbanWatch()); // reminders for cards waiting on the owner; Zubi re-engages stuck work
// A message in an episode's session that was being answered when the last process stopped still gets its answer.
setTimeout(resumeChats, 8000);

const app = new Hono();
// Nothing the server sends is meant to be shown inside another site's frame (clickjacking), so every
// response says so, in both the current form and the one older browsers know. A route that sets a
// Content-Security-Policy of its own keeps it: frame-ancestors is added to it unless it names one
// (no route does yet; the app-connection callback page sets none and its inline script is unaffected).
// One exception, by setting only: HQ_FRAME_ANCESTORS lists exact https origins allowed to show the app in a frame
// (Zubi HQ shows HeyZubi as its Live tab). X-Frame-Options can't name a site, so it is left out then; browsers use
// frame-ancestors. Anything that isn't a plain https origin is ignored, and with none set nothing changes.
const frameOrigins = String(process.env.HQ_FRAME_ANCESTORS ?? '').split(/[\s,]+/).filter((o) => /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(o));
const frameAncestors = frameOrigins.length ? `frame-ancestors 'self' ${frameOrigins.join(' ')}` : "frame-ancestors 'none'";
app.use('*', async (c, next) => {
  await next();
  const csp = c.res.headers.get('Content-Security-Policy');
  if (!csp) c.res.headers.set('Content-Security-Policy', frameAncestors);
  else if (!/(^|;)\s*frame-ancestors(\s|;|$)/i.test(csp)) c.res.headers.set('Content-Security-Policy', `${csp.replace(/[;\s]+$/, '')}; ${frameAncestors}`);
  if (!frameOrigins.length && !c.res.headers.has('X-Frame-Options')) c.res.headers.set('X-Frame-Options', 'DENY');
});
// Cookie-authenticated writes must come from the app's own pages (CSRF; see sameOriginWrites).
app.use('/api/*', sameOriginWrites);
app.get('/api/health', (c) => c.json({ ok: true, engine: 'hermes' }));
// The app's tools for the agent engines (MCP).
app.route('/mcp', mcpApi);
app.route('/api/checkins', checkinsApi);
app.route('/api/rooms', roomsApi);
// The Board view: Hermes's own Kanban (routes-kanban.ts).
app.route('/api/kanban', kanbanApi);
// Hire files: a team member as one portable file, and role bundles (hire.ts).
app.route('/api/hire', hireApi);
app.route('/api', api);
app.route('/api', configApi);

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  // The page itself is never cached, so a reload (the sidebar's "Update") always gets the new release; the bundles
  // it points at have content hashes in their names and are kept for good.
  app.use('/*', async (c, next) => {
    await next();
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/mcp')) return;
    c.res.headers.set('Cache-Control', c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  });
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
}

// The HyperFrames editor answers on an address of its own (studio-proxy.ts): nothing of the app is there, and nothing of it here.
const answer: typeof app.fetch = (req, ...rest) => (isEditorHost(req.headers.get('host')) ? editorFetch(req) : app.fetch(req, ...rest));
const server = serve({ fetch: answer, port: env.port, hostname: env.host }, (info) => console.log(`[heyzubi] server on http://localhost:${info.port} (listening on ${env.host ?? 'every interface'})`));
attachVncRelay(server as unknown as Server);
// HEYZUBI_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines and triggers don't fire twice.
if (compatEnv('NO_SCHEDULER') !== '1') {
  initRoutines(enqueue);
  void initTriggers(enqueue);
initProactive(enqueue);
} else console.log('[heyzubi] scheduler disabled (HEYZUBI_NO_SCHEDULER=1)');
startIdleWatcher();
resolveBoxData().catch((e) => console.warn('[heyzubi] could not check the computer for its data folder:', e?.message ?? e));
initEngines();
// Bots that are Hermes profiles show the same name and mascot in Hermes (hermes-identity.ts).
syncAllIdentities();
// Zubi's skills for what the app can do (adding a team member inside HeyZubi).
installZubiSkills();
