import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { box } from '../box.js';
import { env } from '../env.js';
import { libraryRoot } from '../paths.js';
import { openAs } from '../library-open.js';
import { appendRow, getBotRow, listRoutines, toRoutine, describeCron } from '../store.js';
import { batchActions, executeComposio, LOOKUP_META_TOOLS, MULTI_EXECUTE, SANDBOX_META_TOOLS, toolkitInfo } from '../composio.js';
import { scheduleRoutine, unscheduleRoutine } from '../routines.js';
import { createEventRoutine, deleteEventTrigger, describeEvent, listTriggerTypes } from '../triggers.js';
import { setCheckins } from '../proactive.js';
import { createRoom, postToRoom } from './rooms.js';
import { whatsappClose, whatsappDraft } from '../whatsapp.js';
import { usage } from '../usage.js';
import { createImage } from '../generations.js';
import { panelArg, showPanel } from '../panels.js';
import type { ActivityKind } from '../types.js';
import { Cron } from 'croner';
import { runResearch } from '../research.js';
import { listCodingRuns, startCodingRun } from '../coding.js';
import { turnIsOwner } from './loop.js';
import { addPrompt, deletePrompt, listPrompts, PromptError, updatePrompt } from '../prompts.js';
import fs from 'node:fs';
import path from 'node:path';
import { createBot, COLORS, UserError } from '../team.js';
import { GENDERS, isGender, personaLine } from '../gender.js';
import { engineHome, engineInfo, mayUsePrimary, ownClaudeSignIn, primaryBotId } from '../engine.js';
import { configureProfile } from '../hermes-profile.js';
import { PROP_IDS, PROPS, propFor } from '../avatar-props.js';

export interface ToolCtx {
  userId: string;
  botId: string;
  enqueueBotMessage: (fromBotId: string, toBotId: string, text: string, depth: number) => void;
  depth: number;
}

export interface ToolResult {
  /** Text handed back to the agent. */
  output: string;
  summary?: string;
  /** End the turn after this tool (e.g. a question was asked). */
  endTurn?: boolean;
}

type Impl = (args: any, ctx: ToolCtx) => Promise<ToolResult>;

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  impl: Impl;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** Changing saved prompts is for turns from the owner's own words; every change shows in the chat. */
function promptChange(ctx: ToolCtx, fn: () => { title: string; id: string }, done: string): ToolResult {
  if (!turnIsOwner(ctx.botId)) return { output: 'Not changed: saved prompts change only when the owner asks you in their own message in HeyZubi.' };
  try {
    const p = fn();
    appendRow(ctx.botId, 'event', { type: 'event', event: 'bot-message', text: `Prompt ${done}: ${p.title}` });
    return { output: JSON.stringify({ ok: true, prompt_id: p.id, title: p.title }), summary: `Prompt ${done}` };
  } catch (e) { if (e instanceof PromptError) return { output: e.message }; throw e; }
}

function botByName(userId: string, name: string) {
  return db.prepare('SELECT * FROM bots WHERE user_id=? AND lower(name)=lower(?)').get(userId, name.trim()) as any;
}

/** Live X research through xAI's search tool. Returns the answer text followed by the posts it cites. */
async function xSearch(a: any, userId: string): Promise<string> {
  const clean = (v: unknown) => (Array.isArray(v) ? v.map((h) => String(h).replace(/^@/, '').trim()).filter(Boolean).slice(0, 10) : []);
  const tool: Record<string, unknown> = { type: 'x_search' };
  const only = clean(a.handles);
  const not = clean(a.exclude_handles);
  if (only.length) tool.allowed_x_handles = only;
  else if (not.length) tool.excluded_x_handles = not;
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (day.test(String(a.from_date ?? ''))) tool.from_date = a.from_date;
  if (day.test(String(a.to_date ?? ''))) tool.to_date = a.to_date;
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.xaiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(240_000),
    body: JSON.stringify({
      model: env.xaiModel,
      store: false,
      tools: [tool],
      input: [
        { role: 'system', content: 'You are a research tool used by another AI agent. Search X and answer the question precisely. For each post you rely on give the author handle, the date, engagement numbers when you can see them, and the link. No preamble and no advice.' },
        { role: 'user', content: String(a.query ?? '') },
      ],
    }),
  });
  if (!res.ok) throw new Error(`X search failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  usage.grok(userId, data.usage, 'X search');
  const parts: string[] = [];
  const links = new Set<string>();
  for (const item of data.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const c of item.content ?? []) {
      if (typeof c?.text === 'string') parts.push(c.text);
      for (const an of c?.annotations ?? []) if (an?.url) links.add(String(an.url));
    }
  }
  for (const u of data.citations ?? []) if (typeof u === 'string') links.add(u);
  const text = parts.join('\n\n').trim() || 'No answer came back.';
  const sources = [...links].slice(0, 40);
  return (sources.length ? `${text}\n\nSources:\n${sources.map((u) => `- ${u}`).join('\n')}` : text).slice(0, 60000);
}


/** The mascots a new team member can have: each is a character holding an element of its work. */
const MASCOTS = PROP_IDS.map((id) => `${id} (${PROPS[id].means})`).join(', ');

/** Wait for a new team member's Hermes profile to exist (it is made on its engine's first start). */
async function profileReady(botId: string, ms: number): Promise<string | null> {
  for (const until = Date.now() + ms; Date.now() < until; await new Promise((r) => setTimeout(r, 1000))) {
    const home = engineHome(botId);
    if (home && getBotRow(botId)?.hermes_profile && fs.existsSync(path.join(home, 'SOUL.md'))) return home;
  }
  return null;
}

/** Where a team member stands, for Zubi to guide the owner one step at a time. */
export async function memberStatus(bot: any) {
  const home = engineHome(bot.id);
  const engine = await engineInfo(bot.id).catch(() => null);
  const claude = engine?.providers?.find((p: any) => p.id === 'anthropic');
  const skillsDir = home ? path.join(home, 'skills') : null;
  let skills: string[] = [];
  try { if (skillsDir) skills = fs.readdirSync(skillsDir).filter((n) => !n.startsWith('.')); } catch { /* none yet */ }
  const signedIn = !!(home && ownClaudeSignIn(home));
  const status = !engine || engine.status !== 'ready' ? 'starting' : !signedIn && engine.provider === 'anthropic' ? 'needs_sign_in' : 'ready';
  return {
    name: bot.name, role: bot.label || null, hermes_profile: bot.hermes_profile ?? null,
    engine: engine?.status ?? 'unknown', model: engine?.model ?? null, provider: engine?.provider ?? null,
    own_claude_sign_in: signedIn, claude_connected: !!claude?.connected,
    skills_folder: skillsDir, skills, status,
    next_step: status === 'starting' ? `Wait: ${bot.name}'s engine is starting (about a minute). Check again shortly.`
      : status === 'needs_sign_in' ? `The owner signs ${bot.name} in to Claude with the card in your chat (Sign in to Claude, Authorize in the browser tab, paste the code, Finish). Point them to the card; don't send them anywhere else.`
      : `${bot.name} is ready. Say hello with send_to_bot to check it answers, then suggest a first task.`,
  };
}

/** Shows a file just saved to a bot's Library as a card in its chat (Open and Download). */
function fileCard(botId: string, name: string, content: string) {
  appendRow(botId, 'card', { type: 'card', card: 'file', ownerId: botId, name, path: name, size: Buffer.byteLength(content), canOpen: box.local && !!openAs(name), status: 'saved' });
}

export const TOOLS: ToolDef[] = [
  {
    name: 'save_file',
    description: "Save a finished deliverable (report, notes, CSV, code, markdown) to your Library so the user can open and download it. It lands in your Library folder on your computer (the path is in your instructions); files you write into that folder yourself show up in the Library too.",
    parameters: obj({ filename: { type: 'string', description: 'e.g. briefing-2026-11-09.md' }, content: { type: 'string' } }, ['filename', 'content']),
    activity: 'drafting_file',
    label: 'Saving a file',
    impl: async (a, ctx) => {
      const name = String(a.filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file.txt';
      const file = `${libraryRoot()}/${ctx.botId}/${name}`;
      const content = String(a.content ?? '');
      await box.writeFile(file, content);
      fileCard(ctx.botId, name, content);
      return { output: JSON.stringify({ ok: true, library_file: name, path: file, shown_to_owner: 'A card with Open and Download is now in your chat. Point the owner to it; the path is on the server and means nothing on their computer.' }), summary: `Saved ${name}` };
    },
  },
  {
    name: 'x_search',
    description: "Research X (Twitter) live: what people are posting about a topic, what is going viral, reactions to news, or one account's recent posts. Returns a written answer with links to the posts. Ask one focused question per call and say what you want back, e.g. \"the 10 most-engaged posts about AI agents from the last 48 hours, with author, likes and link\".",
    parameters: obj({
      query: { type: 'string', description: 'What to find out, in plain words.' },
      handles: { type: 'array', items: { type: 'string' }, description: 'Only search posts from these accounts (without @). Up to 10.' },
      exclude_handles: { type: 'array', items: { type: 'string' }, description: 'Leave out posts from these accounts.' },
      from_date: { type: 'string', description: 'Earliest post date, YYYY-MM-DD.' },
      to_date: { type: 'string', description: 'Latest post date, YYYY-MM-DD.' },
    }, ['query']),
    activity: 'searching_web',
    label: 'Searching X',
    impl: async (a, ctx) => {
      const r = await xSearch(a, ctx.userId);
      return { output: r, summary: 'Searched X' };
    },
  },
  {
    name: 'research',
    description: 'Research a question on the web with a small team: 2 to 4 research helpers each take one angle, search and read pages in parallel, and a writer returns one brief with numbered sources (also saved to your Library). Takes a minute or two. Use it when the request needs current facts from the web and more than a quick lookup.',
    parameters: obj({
      question: { type: 'string', description: 'What to find out, in plain words.' },
      helpers: { type: 'integer', description: 'How many research helpers, 2 to 4 (default 2).' },
    }, ['question']),
    activity: 'searching_web',
    label: 'Researching on the web',
    impl: async (a, ctx) => {
      const q = String(a.question ?? '').trim();
      if (!q) return { output: 'Error: question is empty.', summary: 'No question' };
      const r = await runResearch(ctx.userId, q, Number(a.helpers) || 2);
      const name = `research-${new Date().toISOString().slice(0, 10)}-${q.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-+$/, '')}.md`;
      const brief = `# ${q}\n\n${r.brief}\n`;
      try { await box.writeFile(`${libraryRoot()}/${ctx.botId}/${name}`, brief); fileCard(ctx.botId, name, brief); } catch { /* the brief still comes back */ }
      return { output: `${r.brief}

(Saved to your Library as ${name}.)`, summary: `Brief with ${r.sources.length} sources` };
    },
  },
  {
    name: 'coding_run',
    description: 'Change code in a GitHub repository as a pull request. Your engine works in the background on a new branch, runs the checks it can, and opens a pull request into the base branch; it never pushes to the base branch and never merges. The owner gets a message with the pull request link when it is done (it can take up to 45 minutes). Only for when the owner asked in their own words; confirm the repository and the change with them first if either is unclear.',
    parameters: obj({
      repo: { type: 'string', description: 'The repository, "owner/name" or its github.com link.' },
      task: { type: 'string', description: 'The change to make, in plain words, with any detail the owner gave.' },
      base: { type: 'string', description: 'The branch the pull request goes into (default main).' },
    }, ['repo', 'task']),
    activity: 'working',
    label: 'Starting a coding run',
    impl: async (a, ctx) => {
      if (!turnIsOwner(ctx.botId)) return { output: 'Not started: coding runs start only from the owner’s own message in HeyZubi (not from a routine, another bot, an outside program or another app). Ask the owner to request it in the HeyZubi chat.', summary: 'Owner only' };
      const r = await startCodingRun(ctx.userId, ctx.botId, a);
      if (typeof r === 'string') return { output: `Not started: ${r}`, summary: 'Not started' };
      return { output: JSON.stringify({ ok: true, run: r.id, repo: r.repo, branch: r.branch, base: r.base, note: 'Working in the background. Tell the owner it has started; a message with the pull request link will follow in this chat.' }), summary: `Coding on ${r.repo}` };
    },
  },
  {
    name: 'coding_runs',
    description: 'List your recent coding runs: repository, branch, status (running, done, no-pr, failed, stopped) and pull request link.',
    parameters: obj({}),
    activity: 'working',
    label: 'Checking coding runs',
    impl: async (_a, ctx) => ({ output: JSON.stringify(listCodingRuns(ctx.userId, ctx.botId, 10).map((r) => ({ ...r, summary: r.summary?.slice(0, 400) ?? null }))), summary: 'Listed coding runs' }),
  },
  {
    name: 'create_routine',
    description: 'Create a recurring routine you will run on a schedule. `schedule` is a 5-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 8 * * 1-5" for weekdays at 8:00. `prompt` is the instruction you will follow each time it runs.',
    parameters: obj({ name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string' }, timezone: { type: 'string', description: 'IANA timezone, e.g. America/New_York' } }, ['name', 'prompt', 'schedule']),
    activity: 'working',
    label: 'Setting up a routine',
    impl: async (a, ctx) => {
      try { new Cron(a.schedule, { paused: true, timezone: a.timezone || 'UTC' }); } catch (e: any) { return { output: `Invalid schedule: ${e.message}` }; }
      const id = newId('rt');
      db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id, ctx.botId, a.name, a.prompt, a.schedule, a.timezone || 'UTC', now());
      const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(id));
      scheduleRoutine(r);
      appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-created', text: `Routine created: ${a.name} · ${describeCron(a.schedule)}`, ref: id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }), summary: `Created routine ${a.name}` };
    },
  },
  {
    name: 'list_event_triggers',
    description: 'List the event triggers a connected app offers (e.g. new email, new Slack message, new GitHub PR), with each trigger\'s config fields. Use before create_event_routine.',
    parameters: obj({ toolkit: { type: 'string', description: 'Composio toolkit slug, e.g. gmail, slack, github, googlecalendar' } }, ['toolkit']),
    activity: 'connecting_service',
    label: 'Using a connected app',
    impl: async (a) => ({ output: JSON.stringify(await listTriggerTypes(String(a.toolkit).toLowerCase())) }),
  },
  {
    name: 'create_event_routine',
    description: 'Create a routine that runs whenever an event happens in a connected app (instead of on a schedule). `trigger_slug` comes from list_event_triggers; `config_json` is a JSON object string with that trigger\'s config fields (use "{}" if none). `prompt` is what you will do each time, given the event payload.',
    parameters: obj({ name: { type: 'string' }, prompt: { type: 'string' }, trigger_slug: { type: 'string' }, config_json: { type: 'string' } }, ['name', 'prompt', 'trigger_slug']),
    activity: 'working',
    label: 'Setting up a routine',
    impl: async (a, ctx) => {
      let config: Record<string, unknown> = {};
      try { config = a.config_json ? JSON.parse(a.config_json) : {}; } catch { return { output: 'config_json must be a JSON object string.' }; }
      try {
        const r = await createEventRoutine(ctx.userId, ctx.botId, { name: a.name, prompt: a.prompt, trigger_slug: a.trigger_slug, config });
        appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-created', text: `Routine created: ${a.name} · ${describeEvent(`event:${String(a.trigger_slug).toUpperCase()}`)}`, ref: r.id });
        hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
        return { output: JSON.stringify({ ok: true, routine_id: r.id }), summary: `Created event routine ${a.name}` };
      } catch (e: any) {
        return { output: `Could not create the trigger: ${e?.message ?? e}. If the app isn't connected, call request_app_connection first.` };
      }
    },
  },
  {
    name: 'stay_silent',
    description: 'End this turn without sending the user anything. Use during check-ins, routines or bot-to-bot exchanges when there is nothing worth telling the user.',
    parameters: obj({ reason: { type: 'string' } }),
    activity: 'working',
    label: 'Finishing up',
    impl: async () => ({ output: 'OK, staying silent. End your turn now without writing a reply.', endTurn: true, summary: 'Stayed silent' }),
  },
  {
    name: 'set_checkins',
    description: "Turn proactive check-ins on or off and set when they happen (only the primary Bot does check-ins). times are local 24h 'HH:MM' strings; timezone is IANA (e.g. America/Los_Angeles). Ask the user for their timezone if you don't know it.",
    parameters: obj({ enabled: { type: 'boolean' }, times: { type: 'array', items: { type: 'string' } }, timezone: { type: 'string' } }, ['enabled']),
    activity: 'working',
    label: 'Updating check-ins',
    impl: async (a, ctx) => {
      try {
        const r = setCheckins(ctx.userId, { enabled: !!a.enabled, times: a.times, timezone: a.timezone });
        return { output: JSON.stringify({ ok: true, ...r }), summary: r.enabled ? `Check-ins at ${r.times.join(', ')} ${r.timezone}` : 'Check-ins off' };
      } catch (e: any) {
        return { output: `Could not update check-ins: ${e?.message ?? e}` };
      }
    },
  },
  {
    name: 'list_routines',
    description: 'List your routines.',
    parameters: obj({}),
    activity: 'working',
    label: 'Checking routines',
    impl: async (_a, ctx) => ({ output: JSON.stringify(listRoutines(ctx.botId)) }),
  },
  {
    name: 'update_routine',
    description: 'Change or pause one of your routines.',
    parameters: obj({ routine_id: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string' }, timezone: { type: 'string' }, enabled: { type: 'boolean' } }, ['routine_id']),
    activity: 'working',
    label: 'Updating a routine',
    impl: async (a, ctx) => {
      const cur = db.prepare('SELECT * FROM routines WHERE id=? AND bot_id=?').get(a.routine_id, ctx.botId) as any;
      if (!cur) return { output: 'No such routine.' };
      const next = { ...cur, name: a.name ?? cur.name, prompt: a.prompt ?? cur.prompt, schedule: a.schedule ?? cur.schedule, timezone: a.timezone ?? cur.timezone, enabled: a.enabled === undefined ? cur.enabled : a.enabled ? 1 : 0 };
      try { new Cron(next.schedule, { paused: true, timezone: next.timezone }); } catch (e: any) { return { output: `Invalid schedule: ${e.message}` }; }
      db.prepare('UPDATE routines SET name=?,prompt=?,schedule=?,timezone=?,enabled=? WHERE id=?').run(next.name, next.prompt, next.schedule, next.timezone, next.enabled, cur.id);
      const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(cur.id));
      r.enabled ? scheduleRoutine(r) : unscheduleRoutine(r.id);
      appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-updated', text: `Routine updated: ${r.name} · ${r.enabled ? r.description : 'Paused'}`, ref: r.id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }) };
    },
  },
  {
    name: 'delete_routine',
    description: 'Delete one of your routines.',
    parameters: obj({ routine_id: { type: 'string' } }, ['routine_id']),
    activity: 'working',
    label: 'Removing a routine',
    impl: async (a, ctx) => {
      // Its own routines only, and checked first: otherwise naming another bot's routine would stop
      // its schedule and delete its trigger even though the row itself stayed.
      const cur = db.prepare('SELECT id FROM routines WHERE id=? AND bot_id=?').get(a.routine_id, ctx.botId) as any;
      if (!cur) return { output: 'No such routine.' };
      unscheduleRoutine(cur.id);
      await deleteEventTrigger(cur.id);
      db.prepare('DELETE FROM routines WHERE id=? AND bot_id=?').run(cur.id, ctx.botId);
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: 'Deleted.' };
    },
  },
  {
    name: 'list_prompts',
    description: 'List your saved prompts: the chips the owner sees above your message box (the 5 most used) and the rest of the list.',
    parameters: obj({}),
    activity: 'working',
    label: 'Checking saved prompts',
    impl: async (_a, ctx) => ({ output: JSON.stringify(listPrompts(ctx.botId).map((p) => ({ prompt_id: p.id, title: p.title, text: p.text, uses: p.uses }))) }),
  },
  {
    name: 'add_prompt',
    description: 'Save a prompt for the owner as a chip above your message box, when they ask you to. `title` is the short name on the chip (40 characters at most); `text` is what fills the box, written as the owner would say it to you (2000 at most). It never sends by itself.',
    parameters: obj({ title: { type: 'string' }, text: { type: 'string' } }, ['title', 'text']),
    activity: 'working',
    label: 'Saving a prompt',
    impl: async (a, ctx) => promptChange(ctx, () => addPrompt(ctx.botId, a.title, a.text, true), 'added'),
  },
  {
    name: 'update_prompt',
    description: 'Change the title or text of one of your saved prompts, when the owner asks you to (prompt_id from list_prompts).',
    parameters: obj({ prompt_id: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' } }, ['prompt_id']),
    activity: 'working',
    label: 'Changing a prompt',
    impl: async (a, ctx) => promptChange(ctx, () => updatePrompt(ctx.botId, String(a.prompt_id), { title: a.title, text: a.text }, true), 'changed'),
  },
  {
    name: 'delete_prompt',
    description: 'Delete one of your saved prompts, when the owner asks you to (prompt_id from list_prompts).',
    parameters: obj({ prompt_id: { type: 'string' } }, ['prompt_id']),
    activity: 'working',
    label: 'Removing a prompt',
    impl: async (a, ctx) => promptChange(ctx, () => deletePrompt(ctx.botId, String(a.prompt_id)), 'deleted'),
  },
  {
    name: 'create_task',
    description: 'Track a piece of work the user asked for as a task (use one per request when asked for several things at once).',
    parameters: obj({ title: { type: 'string' } }, ['title']),
    activity: 'working',
    label: 'Making a task',
    impl: async (a, ctx) => {
      const id = newId('task');
      db.prepare("INSERT INTO tasks(id,bot_id,title,state,created_at,updated_at) VALUES (?,?,?,'working',?,?)").run(id, ctx.botId, a.title, now(), now());
      hub.emit(ctx.userId, { type: 'tasks', botId: ctx.botId });
      return { output: JSON.stringify({ task_id: id }) };
    },
  },
  {
    name: 'update_task',
    description: 'Update a task: state is working, needs_input, or done.',
    parameters: obj({ task_id: { type: 'string' }, state: { type: 'string', enum: ['working', 'needs_input', 'done'] }, note: { type: 'string' } }, ['task_id', 'state']),
    activity: 'working',
    label: 'Updating a task',
    impl: async (a, ctx) => {
      db.prepare('UPDATE tasks SET state=?, note=COALESCE(?, note), updated_at=? WHERE id=? AND bot_id=?').run(a.state, a.note ?? null, now(), a.task_id, ctx.botId);
      hub.emit(ctx.userId, { type: 'tasks', botId: ctx.botId });
      return { output: 'Updated.' };
    },
  },
  {
    name: 'send_to_bot',
    description: "Send a message to another Bot on the user's team (by name) to delegate work or ask a question. Their reply will arrive later as a new message to you.",
    parameters: obj({ bot_name: { type: 'string' }, message: { type: 'string' } }, ['bot_name', 'message']),
    activity: 'messaging_named',
    label: 'Messaging a teammate',
    impl: async (a, ctx) => {
      const target = botByName(ctx.userId, a.bot_name);
      if (!target) return { output: `No bot named "${a.bot_name}". Team: ${(db.prepare('SELECT name FROM bots WHERE user_id=?').all(ctx.userId) as any[]).map((b) => b.name).join(', ')}` };
      if (target.id === ctx.botId) return { output: 'That is you.' };
      if (target.kind === 'room') return { output: `"${target.name}" is a group chat; use post_to_group instead.` };
      if (ctx.depth >= 3) return { output: 'Too many hops between bots; answer the user directly instead.' };
      ctx.enqueueBotMessage(ctx.botId, target.id, String(a.message), ctx.depth + 1);
      return { output: `Sent to ${target.name}. Their reply will come back to you as a message.`, summary: `Messaged ${target.name}` };
    },
  },
  {
    name: 'create_group',
    description: "Create a group chat between the user and several Bots on the team (by name). It appears in the user's sidebar; when the user posts there, the relevant Bots answer.",
    parameters: obj({ name: { type: 'string' }, bot_names: { type: 'array', items: { type: 'string' } } }, ['name', 'bot_names']),
    activity: 'working',
    label: 'Setting up a group',
    impl: async (a, ctx) => {
      const ids: string[] = [];
      const missing: string[] = [];
      for (const n of (a.bot_names ?? []) as string[]) {
        const b = botByName(ctx.userId, n);
        if (b && b.kind !== 'room') ids.push(b.id); else missing.push(n);
      }
      if (ids.length < 2) return { output: `A group needs at least 2 Bots. Not found: ${missing.join(', ') || 'none'}.` };
      const id = createRoom(ctx.userId, String(a.name), [...new Set(ids)]);
      appendRow(id, 'event', { type: 'event', event: 'bot-message', text: `Group created with ${(a.bot_names as string[]).filter((n) => !missing.includes(n)).join(', ')}` });
      return { output: JSON.stringify({ ok: true, group_id: id, missing }), summary: `Created group ${a.name}` };
    },
  },
  {
    name: 'post_to_group',
    description: 'Post a message into a group chat you are a member of.',
    parameters: obj({ group_name: { type: 'string' }, text: { type: 'string' } }, ['group_name', 'text']),
    activity: 'messaging_named',
    label: 'Posting to the group',
    impl: async (a, ctx) => {
      const out = postToRoom(ctx.botId, String(a.group_name), String(a.text));
      return { output: out, summary: `Posted to ${a.group_name}`, endTurn: out === 'Posted to the group.' };
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the user a multiple-choice question when you need a decision before continuing. Set other to true to add an "Other" choice with a box for their own words (don\'t list Other yourself). Ends your turn; their answer arrives as their next message.',
    parameters: obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, other: { type: 'boolean' } }, ['question', 'options']),
    activity: 'waiting_for_you',
    label: 'Waiting on you',
    impl: async (a, ctx) => {
      appendRow(ctx.botId, 'card', { type: 'card', card: 'question', question: a.question, options: (a.options ?? []).filter((o: unknown) => a.other !== true || !/^other\b/i.test(String(o).trim())).slice(0, 6), ...(a.other === true ? { other: true } : {}), status: 'pending' });
      return { output: 'Question shown to the user. Stop here and wait for their answer.', endTurn: true };
    },
  },
  {
    name: 'whatsapp_draft',
    description: "Open the floating WhatsApp window in the HeyZubi app with a message drafted for the owner's own WhatsApp (send-only, the account connected in Zubi HQ). Use it whenever the owner asks for WhatsApp in this app: to send, write or draft a message, or just \"open WhatsApp\" / \"open the WhatsApp window\" (then leave text empty). This tool IS the WhatsApp window: never open Zubi HQ or a browser for WhatsApp, and never change Hermes settings for it. Give to_group (the group's name) or to_number (phone number with country code, digits only; Indian numbers start with 91) when you know who, and the text. The owner checks it, previews and presses Confirm in that window; you cannot send, so never say a message was sent. At most 20 sends a day, shared with Zubi HQ.",
    parameters: obj({ to_group: { type: 'string', description: 'WhatsApp group name' }, to_number: { type: 'string', description: 'Phone number with country code, digits only' }, text: { type: 'string', description: 'The message, or the caption when there is an image (may be empty to just open WhatsApp)' }, image: { type: 'string', description: 'Optional: a picture to send, by its gallery name: from Generations ("poster.png", "refs/logo.png") or from the Zubi inbox on the owner’s network drive ("inbox/photo.jpg")' } }, []),
    activity: 'connecting_service',
    label: 'Opening WhatsApp',
    impl: async (a, ctx) => whatsappDraft(a, ctx),
  },
  {
    name: 'open_window',
    description: 'Open (or close) the Calendar, Gmail, YouTube, Instagram, Facebook, LinkedIn or Google Sheets window in the HeyZubi app, so the owner sees it. Call it every time the owner asks about their calendar, schedule, meetings or day (window="calendar"), their inbox or emails (window="gmail"), their YouTube channel or videos (window="youtube"), their Instagram posts or reels (window="instagram"), their Facebook Page, posts or reels (window="facebook"), their LinkedIn (window="linkedin") or their Google Sheets / spreadsheets (window="sheets"), as well as answering in words. Set close=true only when they ask to close it.',
    parameters: obj({
      window: { type: 'string', enum: ['calendar', 'gmail', 'youtube', 'instagram', 'facebook', 'linkedin', 'sheets'], description: 'Which window' },
      close: { type: 'boolean', description: 'Close it instead of opening it' },
    }, ['window']),
    activity: 'working',
    label: 'Opening a window',
    impl: async (a, ctx) => showPanel(ctx.userId, panelArg(a.window), a.close !== true),
  },
  {
    name: 'create_image',
    description: 'Create a picture from a description (xAI Grok Imagine, about $0.04 each) and save it into the Generations gallery (~/.hermes/generations). Use it when the owner asks for a picture, poster, greeting image and so on, including one to send on WhatsApp: then call whatsapp_draft with image set to the file name this returns, and the picture is attached to the draft. Describe it fully in the prompt (subject, style, any short text to show).',
    parameters: obj({
      prompt: { type: 'string', description: 'What the picture shows, its style, and any short text on it' },
      aspect: { type: 'string', enum: ['1:1', '4:5', '3:4', '9:16', '16:9', '4:3'], description: 'Shape (default 1:1). 9:16 for a phone status, 16:9 for wide.' },
    }, ['prompt']),
    activity: 'drafting_file',
    label: 'Creating an image',
    impl: async (a, ctx) => {
      const r = await createImage(ctx.userId, String(a.prompt ?? ''), a.aspect ? String(a.aspect) : undefined, ctx.botId);
      if ('error' in r) return { output: `No picture was made: ${r.error}`, summary: 'Image not made' };
      return { output: `Created "${r.rel}" in Generations (~/.hermes/generations/${r.rel}). To send it on WhatsApp, call whatsapp_draft with image="${r.rel}".`, summary: `Created ${r.name}` };
    },
  },
  {
    name: 'whatsapp_close',
    description: 'Close the floating WhatsApp window in the HeyZubi app when the owner asks to close or hide it. The draft is kept and nothing is sent.',
    parameters: obj({}, []),
    activity: 'connecting_service',
    label: 'Closing WhatsApp',
    impl: async (_a, ctx) => whatsappClose(ctx.userId),
  },
  {
    name: 'create_team_member',
    description: `Add a new team member (a bot) to HeyZubi, for the owner. It becomes a HeyZubi bot with its own Hermes profile, the same name, mascot and description in both apps, and its own screen and engine. This is the ONLY way to add a bot: never create Hermes profiles with the hermes CLI or a terminal. The owner decides first, on cards (ask_user): the name (three ideas, and other: true; the question also says the role, what it owns, its limits and its mascot), then the gender of its persona. Their answers are the go-ahead. A card then appears in this chat that walks the owner through signing the new member in to Claude. mascot is one of: ${MASCOTS}; leave it out to pick one from the role. persona is the full SOUL.md text (optional; a short default is written otherwise).`,
    parameters: obj({
      name: { type: 'string', description: 'Short first name, e.g. "Sam".' },
      role: { type: 'string', description: 'Short role label shown after the name, e.g. "Sales".' },
      description: { type: 'string', description: 'One or two sentences on what it owns and its limits.' },
      gender: { type: 'string', enum: [...GENDERS], description: 'The gender of its persona, as the owner chose it.' },
      persona: { type: 'string', description: 'Optional SOUL.md text: who it is, how it works, its rules.' },
      mascot: { type: 'string', enum: [...PROP_IDS] },
      color: { type: 'string', enum: COLORS.filter((c) => c !== 'black') },
    }, ['name', 'role', 'description', 'gender']),
    activity: 'working',
    label: 'Adding a team member',
    impl: async (a, ctx) => {
      if (ctx.botId !== primaryBotId() || !mayUsePrimary(ctx.userId)) return { output: 'Only the main agent adds team members, for the computer’s owner.' };
      if (!turnIsOwner(ctx.botId)) return { output: 'Not added: team members are added only from the owner’s own message in HeyZubi (not from a routine, another bot, an outside program or another app). Ask the owner to request it in the HeyZubi chat.', summary: 'Owner only' };
      const name = String(a.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!/^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,39}$/u.test(name)) return { output: 'Give a short name made of letters (and digits), for example "Sam".' };
      if (botByName(ctx.userId, name)) return { output: `There is already a team member called ${name}. Pick another name, or call team_member_status for it.` };
      const role = String(a.role ?? '').trim().slice(0, 40);
      const description = String(a.description ?? '').trim().slice(0, 500);
      if (!role || !description) return { output: 'A role and a description are needed.' };
      if (!isGender(a.gender)) return { output: 'Ask the owner for the gender of its persona first: ask_user with the options Female, Male and Neutral.' };
      const mascot = (PROP_IDS as readonly string[]).includes(a.mascot) ? a.mascot : propFor({ name, label: role, description });
      const color = (COLORS as string[]).includes(a.color) && a.color !== 'black' ? a.color : undefined;
      let bot: any;
      try {
        bot = createBot(ctx.userId, { name, label: role, description, avatarProp: mascot ?? null, avatarColor: color, mode: 'personal', gender: a.gender });
      } catch (e: any) {
        if (e instanceof UserError) return { output: e.message };
        throw e;
      }
      // Its persona goes in through Hermes's own profile editor (as the Profile tab does), once Hermes has made the profile.
      let persona = 'default';
      const given = typeof a.persona === 'string' ? a.persona.trim().slice(0, 20_000) : '';
      const soul = given && `${given}\n\n${personaLine(a.gender)}\n`;
      const home = await profileReady(bot.id, 150_000);
      if (soul) {
        if (!home) persona = 'not written yet: the profile was still being made. Call team_member_status in a minute, then set it with the owner in its settings › Hermes profile.';
        else {
          try { await configureProfile(bot.id, { soul }); persona = 'written'; }
          catch (e: any) { persona = `not written: ${String(e?.message ?? e).slice(0, 200)}`; }
        }
      }
      appendRow(ctx.botId, 'card', { type: 'card', card: 'teammate', teammateId: bot.id, name, role, status: 'pending' });
      const row = getBotRow(bot.id);
      return {
        output: JSON.stringify({
          created: true, name, role, gender: a.gender, mascot: mascot ?? null, hermes_profile: row?.hermes_profile ?? null,
          skills_folder: home ? path.join(home, 'skills') : null, persona,
          next: `A card is now in this chat for ${name}: it shows the setup and has the "Sign in to Claude" button. If skills should be installed, put each reviewed skill folder in skills_folder first. Then tell the owner in one or two short lines to sign ${name} in with the card, and stop. You'll get a message when ${name} is signed in.`,
        }),
        summary: `Added ${name} · ${role}`,
      };
    },
  },
  {
    name: 'team_member_status',
    description: 'Where a team member stands: engine, Claude sign-in (its own), model, Hermes profile, skills folder and installed skills, plus the next step to guide the owner through.',
    parameters: obj({ name: { type: 'string' } }, ['name']),
    activity: 'working',
    label: 'Checking a team member',
    impl: async (a, ctx) => {
      const bot = botByName(ctx.userId, String(a.name ?? ''));
      if (!bot || bot.kind === 'room') return { output: `No team member named "${a.name}". Team: ${(db.prepare("SELECT name FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room'").all(ctx.userId) as any[]).map((b) => b.name).join(', ')}` };
      if (bot.is_primary) return { output: 'That is the main agent.' };
      return { output: JSON.stringify(await memberStatus(bot)) };
    },
  },
  {
    name: 'reel_schedule_report',
    description: 'Report how scheduling an episode went, when the owner asked you to schedule it from Reels Factory: once per platform, after you saw it confirmed on screen (or could not do it).',
    parameters: obj({ episode: { type: 'integer' }, platform: { type: 'string', enum: ['instagram', 'facebook', 'youtube'] }, status: { type: 'string', enum: ['scheduled', 'failed'] }, link: { type: 'string' }, note: { type: 'string' } }, ['episode', 'platform', 'status']),
    activity: 'working',
    label: 'Reporting the schedule',
    impl: async (a, ctx) => {
      if (ctx.botId !== primaryBotId()) return { output: 'Only the main agent reports this.' };
      const { reportSchedule } = await import('../reels/routes.js');
      return { output: reportSchedule(Number(a.episode), String(a.platform), String(a.status), String(a.link ?? ''), String(a.note ?? '').slice(0, 300)), summary: `${a.platform}: ${a.status}` };
    },
  },
  {
    name: 'request_app_connection',
    description: 'Ask the user to connect an app (e.g. gmail, googlecalendar, slack, github, notion, linear) so you can use it. Use the Composio toolkit slug.',
    parameters: obj({ toolkit: { type: 'string' }, reason: { type: 'string' } }, ['toolkit', 'reason']),
    activity: 'connecting_service',
    label: 'Using a connected app',
    impl: async (a, ctx) => {
      const info = await toolkitInfo(String(a.toolkit).toLowerCase());
      if (!info) return { output: `Unknown toolkit "${a.toolkit}". Use COMPOSIO_SEARCH_TOOLS to find the right toolkit slug.` };
      appendRow(ctx.botId, 'card', { type: 'card', card: 'connect', toolkit: info.slug, toolkitName: info.name, logo: info.logo, reason: a.reason, status: 'pending' });
      return { output: `Asked the user to connect ${info.name}. Stop here; you'll be told when it's connected.`, endTurn: true };
    },
  },
];

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

// ---------- approvals policy ----------

export type Decision = 'allow' | 'ask' | 'block';

export interface Policy {
  decision: Decision;
  /** The tool the decision hangs on: the blocked one, or the first one the user is asked about. */
  key: string;
  toolkit?: string;
  title: string;
  /**
   * Every tool the user is asked about, as shown on the approval card. "Always allow" stores a
   * policy for exactly these. Empty when there is nothing that could be remembered.
   */
  asks: string[];
}

const toolkitOf = (slug: string) => slug.split('_')[0].toLowerCase();

/**
 * Whether a tool call may run, has to be approved first, or is refused.
 *
 * The app's own tools run. Of everything that goes to Composio, only the lookup tools in
 * LOOKUP_META_TOOLS run unasked. Any app action, the sandbox tools (whatever their code looks
 * like) and any COMPOSIO_* tool not known here ask, until the user has stored a policy for that
 * tool with "Always allow" (kept and honoured) or blocked it. A batch asks about each of its
 * actions that needs it, all on one card; one blocked action blocks the whole batch.
 */
export function policyFor(userId: string, toolName: string, args: any): Policy {
  if (toolMap.has(toolName)) return { decision: 'allow', key: toolName, title: toolName, asks: [] };
  // Composio's names are upper case. Folding first keeps another spelling from being a different tool here.
  const name = toolName.toUpperCase();
  const mode = (tool: string): string => {
    const p = db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=? COLLATE NOCASE').get(userId, tool) as any;
    return p?.mode ?? (LOOKUP_META_TOOLS.has(tool) ? 'always_allow' : 'needs_approval');
  };

  let slugs = [name];
  if (name === MULTI_EXECUTE) {
    const batch = batchActions(args);
    // A batch that cannot be read in full is asked about as a whole, and nothing about it is remembered.
    // (So is a batch inside a batch: allowing that by name would wave through whatever it holds.)
    slugs = [...new Set(batch.actions.map((a) => a.slug))];
    if (!batch.complete || slugs.includes(MULTI_EXECUTE)) return { decision: 'ask', key: name, title: 'Composio: run actions in your connected apps', asks: [] };
  }
  const asks: string[] = [];
  for (const slug of slugs) {
    const m = mode(slug);
    if (m === 'blocked') return { decision: 'block', key: slug, title: humanizeSlug(slug), asks: [] };
    if (m !== 'always_allow') asks.push(slug);
  }
  // What the tools in question belong to, for the activity line and the card's logo (none for Composio's own tools).
  const apps = [...new Set((asks.length ? asks : slugs).filter((s) => !s.startsWith('COMPOSIO_')).map(toolkitOf))];
  const toolkit = apps.length === 1 ? apps[0] : undefined;
  if (!asks.length) return { decision: 'allow', key: slugs[0], toolkit, title: humanizeSlug(slugs[0]), asks };
  const title = asks.length > 1 ? `Apps: run ${asks.length} actions`
    : SANDBOX_META_TOOLS.has(asks[0]) ? 'Composio: run code that can use your connected apps'
    : humanizeSlug(asks[0]);
  return { decision: 'ask', key: asks[0], toolkit, title, asks };
}

export function humanizeSlug(slug: string) {
  const parts = slug.split('_');
  const app = parts.shift() ?? '';
  return `${app.charAt(0) + app.slice(1).toLowerCase()}: ${parts.join(' ').toLowerCase()}`;
}

export async function runComposioTool(ctx: ToolCtx, name: string, args: any): Promise<ToolResult> {
  const r = await executeComposio(ctx.userId, name, args);
  const ok = r.resultType ? r.resultType === 'completed' : !r.error;
  const payload = ok ? r.data : { error: r.error, logId: r.logId };
  let out = JSON.stringify(payload ?? null);
  if (out.length > 60000) out = out.slice(0, 60000) + '…(truncated)';
  return { output: out, summary: ok ? 'done' : 'failed' };
}

/** A Hermes tool name as the app knows it: tools served by this app's MCP server lose their `mcp_hq_` prefix. */
export function appToolName(raw: string): { name: string; ours: boolean; server?: string } {
  const hq = /^mcp_+hq_+(.+)$/.exec(raw);
  if (hq) {
    // Hermes may fold names to lower case; ours are matched case-insensitively.
    const hit = [...toolMap.keys()].find((k) => k.toLowerCase() === hq[1].toLowerCase());
    return { name: hit ?? (/^composio_/i.test(hq[1]) ? hq[1].toUpperCase() : hq[1]), ours: true };
  }
  const other = /^mcp_+([a-zA-Z0-9-]+?)_+(.+)$/.exec(raw);
  if (other) return { name: other[2], ours: false, server: other[1] };
  return { name: raw, ours: false };
}

const words = (s: string) => s.replace(/[_-]+/g, ' ').trim();
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What to show while a tool runs. `raw` is the name Hermes reports. */
export function activityFor(raw: string): { kind: ActivityKind; label: string; detail?: string } {
  const { name, ours, server } = appToolName(raw);
  if (ours) {
    const t = toolMap.get(name);
    if (t) return { kind: t.activity, label: t.label, ...(name === 'x_search' ? { detail: 'X' } : {}) };
    return { kind: 'connecting_service', label: 'Using a connected app' };
  }
  if (server) return { kind: 'connecting_service', label: `Using ${words(server)}`, detail: sentence(words(server)) };
  if (name === 'terminal' || name === 'process' || name === 'execute_code') return { kind: 'running_commands', label: 'Running commands' };
  if (name === 'write_file' || name === 'patch') return { kind: 'drafting_file', label: 'Writing a file' };
  if (name === 'read_file' || name === 'search_files') return { kind: 'working', label: 'Reading files' };
  if (name === 'web_search') return { kind: 'searching_web', label: 'Searching the web' };
  if (name === 'web_extract') return { kind: 'reading_web', label: 'Reading a page' };
  if (name === 'x_search') return { kind: 'searching_web', label: 'Searching X', detail: 'X' };
  if (name.startsWith('browser_')) return { kind: 'browsing_web', label: 'Browsing a site' };
  if (name === 'computer_use') return { kind: 'on_its_computer', label: 'Using its computer' };
  if (name === 'vision_analyze') return { kind: 'working', label: 'Looking at an image' };
  if (name === 'memory') return { kind: 'remembering', label: 'Saving notes' };
  if (name === 'session_search') return { kind: 'remembering', label: 'Searching memory' };
  if (name === 'todo') return { kind: 'working', label: 'Planning' };
  if (name === 'delegate_task') return { kind: 'working', label: 'Handing off work' };
  if (name === 'send_message') return { kind: 'messaging_named', label: 'Sending a message' };
  if (name.startsWith('skill')) return { kind: 'working', label: 'Using a skill' };
  if (name === 'clarify') return { kind: 'waiting_for_you', label: 'Waiting on you' };
  if (name === 'cronjob') return { kind: 'working', label: 'Scheduling' };
  return { kind: 'working', label: sentence(words(name)) || 'Working' };
}

export function getBotName(botId: string) {
  return getBotRow(botId)?.name ?? 'Bot';
}
