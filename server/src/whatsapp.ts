import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import type { Policy, ToolCtx, ToolResult } from './agent/tools.js';

/**
 * WhatsApp, send-only, shared with Zubi HQ's command center: the same Baileys bridge in the main
 * agent's Hermes home (`whatsapp-send`), the same paired account, the same send history, and so the
 * same daily cap and gap between messages. Pairing stays in Zubi HQ. Every message is shown to the
 * user on an approval card first and goes out only on "Allow"; there is no "Always allow".
 */
const DIR = path.join(env.hermesHome, 'whatsapp-send');
const SESSION = path.join(DIR, 'session');
const PORT = Number(process.env.HQ_WA_PORT ?? 3011);
const BRIDGE = `http://127.0.0.1:${PORT}`;
const HISTORY = path.join(env.hermesHome, 'command-center', 'whatsapp-history.json');
const NODE = process.env.HQ_WA_NODE ?? '/usr/local/bin/node';
export const WA_CAP = 20;
const GAP_MS = 5000;
const TEXT_MAX = 4000;

async function call(method: string, p: string, body?: unknown, timeoutMs = 20_000): Promise<{ status: number; data: any }> {
  try {
    const r = await fetch(BRIDGE + p, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  } catch {
    return { status: 0, data: null };
  }
}

/** Baileys writes creds.json before a code is scanned; only a pairing fills `me` (same check as Zubi HQ). */
export function waPaired(): boolean {
  try { return !!JSON.parse(fs.readFileSync(path.join(SESSION, 'creds.json'), 'utf8')).me; } catch { return false; }
}

const up = async () => (await call('GET', '/health', undefined, 2000)).status === 200;

let starting: Promise<boolean> | null = null;
/** The bridge answers, or is started the way Zubi HQ starts it, as the owner of the session files. */
export function ensureBridge(): Promise<boolean> {
  if (!starting) {
    starting = (async () => {
      if (await up()) return true;
      if (!waPaired()) return false;
      const owner = fs.statSync(SESSION);
      const log = fs.openSync(path.join(DIR, 'bridge.log'), 'a');
      try {
        const child = spawn(NODE, ['bridge.js', '--port', String(PORT), '--session', SESSION], {
          cwd: DIR, detached: true, stdio: ['ignore', log, log], uid: owner.uid, gid: owner.gid,
          env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: env.hermesHome, LANG: 'C.UTF-8', WHATSAPP_SEND_READ_RECEIPTS: 'false' },
        });
        child.on('error', (e) => console.warn(`[whatsapp] bridge did not start: ${e.message}`));
        child.unref();
      } finally {
        fs.closeSync(log);
      }
      for (let i = 0; i < 60; i++) {
        if (await up()) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    })().finally(() => { starting = null; });
  }
  return starting;
}

// ---------- the history Zubi HQ keeps (one file, so the cap covers both apps) ----------

const pad = (n: number) => String(n).padStart(2, '0');
const day = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d = new Date()) => `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function history(): any[] {
  try { const h = JSON.parse(fs.readFileSync(HISTORY, 'utf8')); return Array.isArray(h) ? h : []; } catch { return []; }
}

function addHistory(entry: Record<string, unknown>) {
  const h = history();
  h.push(entry);
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  const owner = fs.existsSync(HISTORY) ? fs.statSync(HISTORY) : fs.statSync(SESSION);
  const tmp = `${HISTORY}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(h, null, 1), { mode: 0o600 });
  try { fs.chownSync(tmp, owner.uid, owner.gid); } catch { /* not root: the file is already ours */ }
  fs.renameSync(tmp, HISTORY);
}

export const sentToday = () => history().filter((e) => String(e.day) === day() && e.result !== 'blocked').length;

function msSinceLastSend(): number {
  const last = history().map((e) => Date.parse(String(e.ts).replace(' ', 'T'))).filter((t) => !Number.isNaN(t)).sort((a, b) => b - a)[0];
  return last ? Date.now() - last : Infinity;
}

// ---------- the tool ----------

interface Target { kind: 'group' | 'person'; label: string; jid: string }

async function resolve(a: { to_group?: string; to_number?: string }): Promise<Target | string> {
  if (a.to_group && String(a.to_group).trim()) {
    const want = String(a.to_group).trim().toLowerCase();
    const { status, data } = await call('GET', '/groups', undefined, 25_000);
    if (status !== 200) return 'Could not read the WhatsApp group list. Try again in a moment.';
    const groups: any[] = data?.groups ?? [];
    const exact = groups.filter((g) => String(g.name).toLowerCase() === want);
    const near = exact.length ? exact : groups.filter((g) => String(g.name).toLowerCase().includes(want));
    if (near.length === 0) return `No WhatsApp group named "${a.to_group}". Ask the owner which group.`;
    if (near.length > 1) return `Several groups match "${a.to_group}": ${near.slice(0, 8).map((g) => g.name).join(', ')}. Ask the owner which one.`;
    return { kind: 'group', label: `Group: ${near[0].name} (${near[0].size} members)`, jid: near[0].id };
  }
  const num = String(a.to_number ?? '').replace(/[\s()+-]/g, '');
  if (!num) return 'Say who it goes to: a group name (to_group) or a phone number with its country code (to_number).';
  if (!/^[1-9]\d{7,14}$/.test(num)) return 'Give the number with its country code, digits only, for example 919783555153 (no leading 0).';
  const { status, data } = await call('POST', '/check', { number: num }, 20_000);
  if (status !== 200) return String(data?.error ?? 'Could not check that number on WhatsApp.');
  if (!data?.exists) return 'That number is not on WhatsApp.';
  return { kind: 'person', label: `+${num}`, jid: data.jid };
}

export async function whatsappSend(a: { to_group?: string; to_number?: string; text?: string }, ctx: ToolCtx): Promise<ToolResult> {
  const text = String(a.text ?? '').trim();
  if (!text) return { output: 'Write the message first.', summary: 'No text' };
  if (text.length > TEXT_MAX) return { output: `A WhatsApp message can be up to ${TEXT_MAX} characters (this one is ${text.length}).`, summary: 'Too long' };
  if (!(await ensureBridge())) return { output: 'WhatsApp is not connected. Ask the owner to connect it in Zubi HQ (Zubi Live, WhatsApp), then try again. Nothing was sent.', summary: 'Not connected' };
  const health = await call('GET', '/health', undefined, 3000);
  if (health.data?.status !== 'connected') return { output: 'WhatsApp is reconnecting. Try again in a minute. Nothing was sent.', summary: 'Reconnecting' };
  if (sentToday() >= WA_CAP) return { output: `The daily limit of ${WA_CAP} WhatsApp messages is reached (shared with Zubi HQ). It resets at midnight. Nothing was sent.`, summary: 'Daily limit' };
  const target = await resolve(a);
  if (typeof target === 'string') return { output: `${target} Nothing was sent.`, summary: 'Not sent' };

  // The owner sees exactly who and what, and decides. No "Always allow": `asks` is empty.
  const { requestApproval } = await import('./agent/loop.js');
  const pol: Policy = { decision: 'ask', key: 'whatsapp_send', toolkit: 'whatsapp', title: 'WhatsApp: send this WhatsApp message', asks: [] };
  const answer = await requestApproval({ userId: ctx.userId, botId: ctx.botId }, pol, { to: target.label, message: text }, null);
  if (answer !== 'allow') return { output: 'The owner did not approve it. Nothing was sent.', summary: 'Not approved' };

  if (sentToday() >= WA_CAP) return { output: `The daily limit of ${WA_CAP} was reached while waiting. Nothing was sent.`, summary: 'Daily limit' };
  const wait = GAP_MS - msSinceLastSend();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const entry: Record<string, unknown> = {
    id: crypto.randomBytes(5).toString('hex'), ts: stamp(), day: day(), kind: target.kind, to: target.label, jid: target.jid,
    type: 'text', text: text.slice(0, 200), image: '', via: 'heyzubi',
  };
  const r = await call('POST', '/send', { chatId: target.jid, message: text }, 60_000);
  if (r.status === 200 && r.data?.success) Object.assign(entry, { result: 'sent', message_id: r.data?.messageId ?? '' });
  else if (r.status === 0) Object.assign(entry, { result: 'unknown', error: 'No answer from WhatsApp. It may or may not have been sent: check the chat before sending again' });
  else Object.assign(entry, { result: 'failed', error: String(r.data?.error ?? `HTTP ${r.status}`).slice(0, 200) });
  addHistory(entry);
  const left = Math.max(0, WA_CAP - sentToday());
  if (entry.result === 'sent') return { output: `Sent to ${target.label}. ${left} WhatsApp messages left today.`, summary: `Sent to ${target.label}` };
  return { output: `Not confirmed as sent (${entry.result}): ${entry.error}. Do not send it again before the owner checks the chat.`, summary: 'Not sent' };
}
