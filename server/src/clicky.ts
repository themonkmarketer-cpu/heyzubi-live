// Clicky on a team member's screen: the person holds a key (or the Ask button) while watching or driving
// a screen, says what they want, and the team member looks at that screen, answers out loud and points
// at the thing to click. Same idea as Theo's Clicky companion, but for the screens in HeyZubi.
// One screenshot and one vision call per question. Nothing is clicked and nothing is saved in the chat.
import { Hono } from 'hono';
import OpenAI from 'openai';
import { db } from './db.js';
import { env } from './env.js';
import { rateLimit, type AuthVars } from './lib/auth.js';
import { getBotRow } from './store.js';
import { computerState } from './computer.js';
import { orgo } from './orgo.js';
import { usage } from './usage.js';

export const clickyApi = new Hono<AuthVars>();

const xai = new OpenAI({ apiKey: env.xaiKey, baseURL: 'https://api.x.ai/v1', timeout: 60_000 });
const MODEL = process.env.HQ_CLICKY_MODEL ?? env.xaiModel;
const asks = rateLimit(30, 10 * 60_000); // 30 questions per 10 minutes per person

export interface ClickyMark { kind: 'circle' | 'arrow' | 'step'; step?: number; x: number; y: number; label?: string }
export interface ClickyAnswer { text: string; point: { x: number; y: number; label?: string } | null; marks: ClickyMark[] }

const prompt = (name: string, w: number, h: number) => `You are ${name}, a friendly helper. The screen in the screenshot is your own computer screen in the HeyZubi app, so anything on it that greets or names "${name}" is about you. The person asking is the owner of the team, watching or driving your screen; never call them ${name}. They just held the talk key and asked you something. Their question comes with one screenshot of that screen, ${w}x${h} pixels.

How to answer:
- Your reply is spoken aloud, so write the way you talk: one to three short sentences, plain words, no lists, no markdown, no emoji. Under 60 words.
- A greeting or small talk ("hi", "thanks") is not a request: reply with one short friendly line and nothing else.
- Answer from what is actually on the screen. Never pretend to see something you can't. If it isn't there, say what to open first.
- If they ask how to do something, where a button or menu is, or what to click, point at it. Point whenever a specific element on the screen helps; don't point for general questions or at something they're obviously already looking at.

Pointing: after your spoken words, at the very end, add one tag
[POINT:x,y:label]
where x,y are whole-number pixel coordinates in the ${w}x${h} screenshot (0,0 is the top-left; x goes right, y goes down), aimed at the centre of the element, and label is one to three words ("save button"). Use [POINT:none] when nothing needs pointing at.

For a task with several steps you may also mark them, before the POINT tag:
[MARK:kind:x,y:label]
where kind is circle, arrow, or the step number (1, 2, 3...). Point at the first step.

Example: "click file at the top left, then save as. [MARK:1:24,12:file] [MARK:2:60,140:save as] [POINT:24,12:file]"

Never mention these tags, coordinates or the screenshot in your words.`;

/** Pull the POINT and MARK tags out of the reply; coordinates come back as fractions of the screen (0..1). */
export function parseClicky(raw: string, w: number, h: number): ClickyAnswer {
  const fx = (n: string) => Math.min(1, Math.max(0, Number(n) / w));
  const fy = (n: string) => Math.min(1, Math.max(0, Number(n) / h));
  const marks: ClickyMark[] = [];
  for (const m of raw.matchAll(/\[MARK:(circle|arrow|\d{1,2}):(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?::([^\]:]{0,40}))?(?::screen\d+)?\]/gi)) {
    const k = m[1].toLowerCase();
    const step = /^\d+$/.test(k) ? Number(k) : undefined;
    marks.push({ kind: step ? 'step' : (k as 'circle' | 'arrow'), step, x: fx(m[2]), y: fy(m[3]), label: m[4]?.trim() || undefined });
    if (marks.length >= 8) break;
  }
  let point: ClickyAnswer['point'] = null;
  const p = raw.match(/\[POINT:(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?::([^\]:]{0,40}))?(?::screen\d+)?\]/i);
  if (p) point = { x: fx(p[1]), y: fy(p[2]), label: p[3]?.trim() || undefined };
  const text = raw.replace(/\[(POINT|MARK):[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim();
  return { text, point, marks };
}

clickyApi.post('/ask', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ botId?: string; question?: string; history?: { q: string; a: string }[] }>().catch(() => ({} as any));
  const bot = body.botId ? getBotRow(body.botId) : null;
  if (!bot || bot.user_id !== user.id) return c.json({ error: 'not found' }, 404);
  const question = String(body.question ?? '').trim().slice(0, 1000);
  if (!question) return c.json({ error: 'Say what you need first.' }, 400);
  if (asks.full(user.id)) return c.json({ error: 'That’s a lot of questions in a row. Give it a few minutes.' }, 429);
  asks.count(user.id);

  // The screen the person is looking at: this team member's own screen on the computer.
  const scr = db.prepare('SELECT screen_id FROM screens WHERE bot_id=?').get(bot.id) as { screen_id: string } | undefined;
  if (!env.orgoComputerId || computerState(user.id).status !== 'running' || !scr) {
    return c.json({ error: `${bot.name}’s screen isn’t open, so there’s nothing to look at yet.` }, 409);
  }
  let shot: { image: string; mime_type?: string; width: number; height: number };
  try {
    shot = await orgo.screenshot(env.orgoComputerId, scr.screen_id);
  } catch (e: any) {
    console.warn('[clicky] screenshot failed:', e?.message);
    return c.json({ error: 'Couldn’t see the screen just now. Try again.' }, 502);
  }
  const w = Number(shot.width) || 1280;
  const h = Number(shot.height) || 800;
  const b64 = shot.image.replace(/^data:[^,]+,/, '');

  const history = (Array.isArray(body.history) ? body.history : []).slice(-4)
    .map((t: { q?: string; a?: string }) => `User: ${String(t?.q ?? '').slice(0, 300)}\n${bot.name}: ${String(t?.a ?? '').slice(0, 400)}`).join('\n');

  try {
    const res: any = await xai.responses.create({
      model: MODEL,
      store: false,
      reasoning: { effort: 'low' }, // a spoken helper has to answer in a few seconds
      input: [
        { role: 'system', content: prompt(bot.name, w, h) },
        {
          role: 'user',
          content: [
            ...(history ? [{ type: 'input_text', text: `Earlier in this conversation (text only):\n${history}` }] : []),
            { type: 'input_text', text: `SCREEN 1 (${w}x${h} pixels):` },
            { type: 'input_image', image_url: `data:${shot.mime_type ?? 'image/jpeg'};base64,${b64}`, detail: 'high' },
            { type: 'input_text', text: question },
          ],
        },
      ],
    } as any);
    usage.grok(user.id, res.usage, 'Clicky');
    const raw = String(res.output_text ?? '').trim();
    if (!raw) return c.json({ error: 'No answer this time. Ask again.' }, 502);
    const out = parseClicky(raw, w, h);
    if (!out.text) out.text = out.point?.label ? `Here: ${out.point.label}.` : 'Here.';
    return c.json(out);
  } catch (e: any) {
    console.warn('[clicky] answer failed:', e?.status, e?.message);
    if (/credits|spending limit/i.test(String(e?.message ?? ''))) return c.json({ error: 'Paused: the xAI account is out of credits or at its monthly spending limit.' }, 502);
    return c.json({ error: 'Couldn’t get an answer just now. Try again.' }, 502);
  }
});
