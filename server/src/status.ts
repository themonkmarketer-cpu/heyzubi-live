import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { env } from './env.js';
import type { AuthVars } from './lib/auth.js';
import { connectedToolkits } from './composio.js';
import { engineFor, engineInfo, primaryBotId } from './engine.js';
import { getBotRow } from './store.js';
import { zubiGoogleAccounts } from './panels.js';
import { healthChecks } from './health.js';
import { chatHeaders, dropOneOff, noteChat, tidyEngineSessions } from './engine-sessions.js';

/**
 * Settings → Status, after Zubi HQ's Settings page: four live checks (Agent, Voice, Google, Obsidian), the data
 * mode line, and a one-prompt "Test agent" that runs in its own engine conversation so it never lands in the chat.
 * Secrets never leave the server: a check says whether a key works, never what it is.
 */
export const statusApi = new Hono<AuthVars>();

const XAI = 'https://api.x.ai/v1';
const VAULT = process.env.HQ_OBSIDIAN_VAULT ?? '/opt/vault';

interface Card { key: 'agent' | 'voice' | 'google' | 'obsidian'; title: string; ok: boolean; state: string; line: string }

async function agentCard(): Promise<Card> {
  const id = primaryBotId();
  if (!id) return { key: 'agent', title: 'Agent', ok: false, state: 'No main team member', line: '' };
  try {
    const info = await engineInfo(id);
    const ok = info.status === 'ready';
    return { key: 'agent', title: 'Agent', ok, state: ok ? 'Connected' : info.status === 'starting' ? 'Starting' : 'Not answering', line: `Hermes ${info.version ?? ''} · ${info.model ?? 'default model'}`.replace(/\s+·/, ' ·') };
  } catch {
    return { key: 'agent', title: 'Agent', ok: false, state: 'Not answering', line: '' };
  }
}

/** The voice account (xAI), checked without starting a call: is the key accepted, and is there credit? */
async function voiceCard(): Promise<Card> {
  if (!env.xaiKey) return { key: 'voice', title: 'Voice', ok: false, state: 'Key missing', line: 'xAI' };
  const h = { Authorization: `Bearer ${env.xaiKey}` };
  try {
    const [key, voices] = await Promise.all([
      fetch(`${XAI}/api-key`, { headers: h, signal: AbortSignal.timeout(8000) }),
      fetch(`${XAI}/tts/voices`, { headers: h, signal: AbortSignal.timeout(8000) }),
    ]);
    const k: any = key.ok ? await key.json().catch(() => ({})) : {};
    if (!key.ok || k.api_key_blocked || k.api_key_disabled) return { key: 'voice', title: 'Voice', ok: false, state: 'Key not accepted', line: 'xAI' };
    if (k.team_blocked) return { key: 'voice', title: 'Voice', ok: false, state: 'Account blocked', line: 'xAI' };
    if (!voices.ok) {
      const t = await voices.text().catch(() => '');
      return { key: 'voice', title: 'Voice', ok: false, state: /credits|spending limit/i.test(t) ? 'Out of credits' : 'Not answering', line: 'xAI · add credits or raise the limit at console.x.ai' };
    }
    return { key: 'voice', title: 'Voice', ok: true, state: 'Connected', line: 'xAI voice · voice messages, live calls, Clicky' };
  } catch {
    return { key: 'voice', title: 'Voice', ok: false, state: 'Not answering', line: 'xAI' };
  }
}

/** Google, through Zubi's own Composio connection (the one her tools and the Gmail/Calendar panels use). */
async function googleCard(userId: string): Promise<Card & { gmail: boolean; calendar: boolean }> {
  try {
    const l = (await zubiGoogleAccounts()).filter((a) => /^active$/i.test(a.status));
    const gm = l.filter((a) => a.toolkit === 'gmail'), cal = l.filter((a) => a.toolkit === 'googlecalendar');
    const gmail = gm.length > 0, calendar = cal.length > 0;
    const state = gmail && calendar ? 'Connected' : gmail || calendar ? 'Partly connected' : 'Not connected';
    const emails = [...new Set(l.map((a) => a.label).filter(Boolean))];
    return { key: 'google', title: 'Google', ok: gmail && calendar, state, line: `${emails.join(', ') || 'no accounts'} · Gmail ${gm.length} · Calendar ${cal.length}`, gmail, calendar };
  } catch {
    // Fall back to the app's own connections when Zubi's sign-in is renewing.
    try {
      const t = await connectedToolkits(userId);
      const gmail = t.has('gmail'), calendar = t.has('googlecalendar');
      return { key: 'google', title: 'Google', ok: gmail && calendar, state: gmail || calendar ? 'Partly connected' : 'Renewing sign-in', line: 'Zubi’s Composio sign-in renews the next time she uses an app', gmail, calendar };
    } catch {
      return { key: 'google', title: 'Google', ok: false, state: 'Not answering', line: 'Composio', gmail: false, calendar: false };
    }
  }
}

/** The Obsidian vault (mounted read-only): found, and how many notes. */
function obsidianCard(): Card & { notes: number } {
  try {
    if (!fs.statSync(VAULT).isDirectory()) throw new Error('not a folder');
    let notes = 0;
    const walk = (d: string, depth: number) => {
      if (depth > 6 || notes > 20000) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
        else if (e.name.endsWith('.md')) notes++;
      }
    };
    walk(VAULT, 0);
    return { key: 'obsidian', title: 'Obsidian', ok: true, state: 'Connected', line: `Vault · ${notes.toLocaleString()} notes`, notes };
  } catch {
    return { key: 'obsidian', title: 'Obsidian', ok: false, state: 'Not found', line: 'Vault folder not mounted', notes: 0 };
  }
}

statusApi.get('/', async (c) => {
  const user = c.get('user');
  const [agent, voice, google] = await Promise.all([agentCard(), voiceCard(), googleCard(user.id)]);
  const obsidian = obsidianCard();
  const live = agent.ok && voice.ok && google.ok && obsidian.ok;
  return c.json({
    checked: Date.now(),
    cards: [obsidian, google, voice, agent].map(({ key, title, ok, state, line }) => ({ key, title, ok, state, line })),
    dataMode: { live, text: `Obsidian ${obsidian.ok ? 'live' : 'offline'} · Google ${google.gmail || google.calendar ? 'live' : 'offline'}` },
    google: { gmail: google.gmail, calendar: google.calendar },
  });
});

/** Health (after Theo's): engines and their sign-ins, Zubi's HeyZubi tools, routines, skills, the safety hook, storage, the Windows app. */
/** Removes the Hermes sessions beyond each team member's one, now (also done every hour). */
statusApi.post('/tidy-sessions', async (c) => c.json({ removed: await tidyEngineSessions() }));

statusApi.get('/health', async (c) => c.json({ checked: Date.now(), items: await healthChecks(c.get('user').id) }));

/** One short paid prompt through the main team member's engine, in its one session (never shown in the chat). */
statusApi.post('/test-agent', async (c) => {
  const id = primaryBotId();
  if (!id) return c.json({ ok: false, error: 'There is no main team member yet.' }, 409);
  const bot = getBotRow(id);
  const t0 = Date.now();
  try {
    const engine = await engineFor(id);
    const r = await fetch(`${engine.url}/v1/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: { 'content-type': 'application/json', ...(engine.key ? { authorization: `Bearer ${engine.key}` } : {}), ...chatHeaders(id, engine) },
      body: JSON.stringify({
        model: bot?.model || 'hermes-agent',
        ...(bot?.provider ? { provider: bot.provider } : {}),
        input: 'Connection test from the HeyZubi Settings page. Reply with one short sentence saying you are online.',
        instructions: 'This is a connection test. Reply in one short sentence. Do not call any tools.',
        conversation: `hq-test-${Date.now()}`,
        stream: false,
        store: false,
      }),
    });
    const j: any = await r.json().catch(() => ({}));
    noteChat(id, engine, r); // in the one session, or a test that leaves none behind
    if (!Object.keys(chatHeaders(id, engine)).length) dropOneOff(engine, r);
    if (!r.ok) return c.json({ ok: false, error: String(j?.error?.message ?? j?.error ?? `HTTP ${r.status}`).slice(0, 200), ms: Date.now() - t0 }, 502);
    const text = String(j.output_text ?? (j.output ?? []).flatMap((o: any) => o?.content ?? []).map((x: any) => x?.text ?? '').join(' ')).trim();
    return c.json({ ok: !!text, reply: text.slice(0, 300), ms: Date.now() - t0, model: j.model ?? bot?.model ?? '' });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.name === 'TimeoutError' ? 'No answer within 90 seconds.' : String(e?.message ?? e).slice(0, 200), ms: Date.now() - t0 }, 502);
  }
});
