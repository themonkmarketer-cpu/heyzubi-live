import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getConnInfo } from '@hono/node-server/conninfo';
import { isLocalRequest } from './lib/auth.js';
import { getBotRow } from './store.js';
import { composioTools } from './composio.js';
import { mcpToken, primaryBotId } from './engine.js';
import { claimToolRow, enqueueBotMessage, markSilent, noteToolOutcome, requestApproval, turnDepth } from './agent/loop.js';
import { policyFor, runComposioTool, toolMap, TOOLS, type ToolCtx } from './agent/tools.js';

/**
 * The app's tools, served to the Hermes engines over MCP (streamable HTTP, JSON answers only).
 *
 *   POST /mcp/<botId>     one bot's engine; the bearer token is derived from the bot id
 *   POST /mcp/primary     the primary engine, whichever bot it is bound to (so that agent's config
 *                         can be written before the bot exists)
 *
 *   GET  /mcp/<bot>       a stream for messages the app sends on its own: today only "the tool list changed",
 *                         so an engine picks up the app's new tools after an update without a restart
 *
 * Calls are stateless: the URL says which bot is calling. initialize hands out a session id only so the engine
 * opens that stream (MCP clients open it only with a session); any id is accepted afterwards, so an app restart
 * never logs an engine out. Besides the app's own tools the list
 * carries the user's Composio tools, so connected apps (and the approvals around them) work the
 * same for every engine.
 *
 * The engines run on this machine and reach the endpoint on a loopback address (MCP_BASE_URL), so
 * calls from anywhere else are refused before the token is looked at (see isLocalRequest).
 */

const DECLINED = 'The user declined this action. Do not retry it. Find another way, or tell the user what you could not do.';
const SKIPPED = 'Skipped: the user did not approve this (they sent a new message or did not answer in time). Do not retry unless they ask.';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface CallResult { content: { type: 'text'; text: string }[]; isError?: boolean }
const text = (t: string, isError = false): CallResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function sameToken(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Which bot a request is for, or null when the token does not fit the URL. `botId` is null for /mcp/primary before a bot is bound to it. */
function caller(slug: string, auth: string | undefined): { botId: string | null } | null {
  const given = (auth ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !sameToken(given, mcpToken(slug))) return null;
  if (slug === 'primary') return { botId: primaryBotId() };
  return getBotRow(slug) ? { botId: slug } : null;
}

async function listTools(botId: string | null) {
  const own = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
  const bot = botId ? getBotRow(botId) : null;
  if (!bot) return own;
  const apps = (await composioTools(bot.user_id))
    .filter((t: any) => t?.type === 'function' && typeof t.name === 'string' && !toolMap.has(t.name))
    .map((t: any) => ({ name: t.name as string, description: String(t.description ?? ''), inputSchema: t.parameters ?? { type: 'object', properties: {} } }));
  return [...own, ...apps];
}

async function callTool(botId: string | null, rawName: string, args: any): Promise<CallResult> {
  const bot = botId ? getBotRow(botId) : null;
  if (!botId || !bot) return text('The team app has no bot for this agent yet. Ask the user to open the app once, then try again.', true);
  const userId: string = bot.user_id;
  // The app's own tools by their exact name; everything else goes to Composio, whose names are upper
  // case. One spelling for the approval check and for the call keeps the two from disagreeing.
  const name = [...toolMap.keys()].find((k) => k.toLowerCase() === rawName.toLowerCase()) ?? rawName.toUpperCase();
  const rowSeq = await claimToolRow(botId, name);
  const ctx: ToolCtx = { userId, botId, enqueueBotMessage, depth: turnDepth(botId) };
  try {
    const own = toolMap.get(name);
    if (own) {
      const r = await own.impl(args, ctx);
      if (r.endTurn) markSilent(botId);
      noteToolOutcome(botId, rowSeq, { status: 'done', summary: r.summary });
      return text(r.output);
    }

    const pol = policyFor(userId, name, args);
    if (pol.decision === 'block') {
      noteToolOutcome(botId, rowSeq, { status: 'denied', summary: 'Not allowed' });
      return text(DECLINED);
    }
    if (pol.decision === 'ask') {
      const answer = await requestApproval({ userId, botId }, pol, args, rowSeq);
      if (answer !== 'allow') return text(answer === 'deny' ? DECLINED : SKIPPED);
    }
    const r = await runComposioTool(ctx, name, args);
    noteToolOutcome(botId, rowSeq, { status: r.summary === 'failed' ? 'error' : 'done', summary: r.summary === 'failed' ? 'Failed' : undefined });
    return text(r.output);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    noteToolOutcome(botId, rowSeq, { status: 'error', summary: msg.slice(0, 200) });
    return text(`Tool error: ${msg}`, true);
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Answer one JSON-RPC message; null for notifications (they get no answer). */
async function handle(msg: any, botId: string | null): Promise<object | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // A response to something we never asked; nothing to do with it.
    if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return null;
    return rpcError(msg?.id, -32600, 'Invalid request');
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null;
  switch (method) {
    case 'initialize': {
      const asked = String(params?.protocolVersion ?? '');
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'hq', title: 'Team app', version: '1.0.0' },
          instructions: 'Tools of the team app: connected apps, files for the user, tasks, routines, other agents on the team.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: await listTools(botId) } };
    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string' || !name) return rpcError(id, -32602, 'Missing tool name');
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      return { jsonrpc: '2.0', id, result: await callTool(botId, name, args) };
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export const mcpApi = new Hono();

let warnedRemote = false;

mcpApi.post('/:bot', async (c) => {
  if (!isLocalRequest(c)) {
    // Said once: an agent set up to call from elsewhere would otherwise just seem to have lost its tools.
    if (!warnedRemote) console.warn(`[mcp] refused a call that did not come straight from this machine (peer ${getConnInfo(c).remote.address ?? 'unknown'}). Agents must reach /mcp on a loopback address; check MCP_BASE_URL.`);
    warnedRemote = true;
    return c.json(rpcError(null, -32001, 'Forbidden: /mcp only answers calls made on the machine the app runs on'), 403);
  }
  const who = caller(c.req.param('bot'), c.req.header('authorization'));
  if (!who) return c.json(rpcError(null, -32001, 'Unauthorized'), 401);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json(rpcError(null, -32700, 'Parse error'), 400); }
  // A keep-alive ping from a session an earlier run of the app handed out, whose stream did not come back (its client
  // gives up after two tries): "session not found" (MCP's 404) makes the engine start a new session, re-list the
  // tools and open the stream again. Its tool calls keep working meanwhile; a ping without a session is answered.
  const sid = c.req.header('mcp-session-id');
  if (!Array.isArray(body) && body?.method === 'ping' && sid && !sessions.has(sid)) {
    return c.json(rpcError(body?.id, -32001, 'Session not found: initialize again'), 404);
  }
  // A session id with initialize, so the engine opens the GET stream (see above).
  if ((Array.isArray(body) ? body : [body]).some((m: any) => m?.method === 'initialize')) {
    const sid = crypto.randomUUID();
    sessions.add(sid);
    c.header('Mcp-Session-Id', sid);
  }
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map((m) => handle(m, who.botId)))).filter(Boolean);
    return answers.length ? c.json(answers) : c.body(null, 202);
  }
  const answer = await handle(body, who.botId);
  return answer ? c.json(answer) : c.body(null, 202);
});

// ---------- the engines' stream: "the tool list changed" ----------

/** Session ids handed out by this run of the app. An engine coming back with any other id had its tools listed by an
 *  earlier run (before an update), so it is told to list them again. */
const sessions = new Set<string>();
const streams = new Set<(msg: object) => void>();
const LIST_CHANGED = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };

/** Tell every connected engine to list the tools again (after the tools on offer changed). */
/** For Settings › Status › Health: engines connected now, and how many hold the stream open for tool changes. */
export const mcpLive = () => ({ sessions: sessions.size, streams: streams.size });

export function notifyToolsChanged() {
  for (const send of streams) send(LIST_CHANGED);
}

function gate(c: Context) {
  if (!isLocalRequest(c)) return c.json(rpcError(null, -32001, 'Forbidden: /mcp only answers calls made on the machine the app runs on'), 403);
  if (!caller(c.req.param('bot') ?? '', c.req.header('authorization'))) return c.json(rpcError(null, -32001, 'Unauthorized'), 401);
  return null;
}

mcpApi.get('/:bot', (c) => {
  const refused = gate(c);
  if (refused) return refused;
  if (!(c.req.header('accept') ?? '').includes('text/event-stream')) return c.body(null, 405, { Allow: 'GET, POST, DELETE' });
  const sid = c.req.header('mcp-session-id') ?? '';
  const stale = !!sid && !sessions.has(sid);
  if (sid) sessions.add(sid);
  return streamSSE(c, async (stream) => {
    let open = true;
    const send = (msg: object) => { if (open) void stream.writeSSE({ event: 'message', data: JSON.stringify(msg) }).catch(() => { open = false; }); };
    streams.add(send);
    stream.onAbort(() => { open = false; streams.delete(send); });
    // A long reconnect wait, so an engine rides out the app's restart (its client gives up after two tries).
    await stream.write('retry: 15000\n\n');
    console.log(`[mcp] ${c.req.param('bot') === 'primary' ? 'main agent' : 'engine'} listening for tool changes${stale ? ' (told to list them again)' : ''}`);
    // A new session too: an engine that reconnects keeps the tools it registered before and only looks again when told.
    if (!stale) await stream.sleep(5_000); // its first listing is still going on
    send(LIST_CHANGED);
    while (open) {
      await stream.sleep(25_000);
      if (open) await stream.write(': keep-alive\n\n').catch(() => { open = false; });
    }
    streams.delete(send);
  });
});

// Ending a session: nothing is kept per session beyond its id.
mcpApi.delete('/:bot', (c) => {
  const refused = gate(c);
  if (refused) return refused;
  sessions.delete(c.req.header('mcp-session-id') ?? '');
  return c.body(null, 200);
});

mcpApi.all('/:bot', (c) => c.body(null, 405, { Allow: 'GET, POST, DELETE' }));
