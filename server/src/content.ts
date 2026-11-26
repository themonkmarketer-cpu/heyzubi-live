import { Cron } from 'croner';
import { Hono } from 'hono';
import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import { newId } from './lib/ids.js';
import { rateLimit, requireUser, type AuthVars } from './lib/auth.js';
import { askJson } from './reels/writer.js';
import { scheduleRoutine } from './routines.js';
import { appendRow, describeCron, getBotRow, toRoutine } from './store.js';

/**
 * Content helpers:
 *  - Announce: one announcement, drafted for every platform at once (Instagram, Facebook, LinkedIn, X, WhatsApp Status,
 *    YouTube community, email), each in that platform's length and habits. Drafts only: nothing is posted.
 *  - Trend scout: one click sets up a nightly routine for a team member that looks for what is trending in the owner's
 *    field and leaves a short report in its Library for the morning.
 */

export const contentApi = new Hono<AuthVars>();
contentApi.use('*', requireUser);
const asks = rateLimit(30, 60 * 60_000);

export const PLATFORMS = [
  { key: 'instagram', name: 'Instagram', rule: 'caption up to 2,200 characters; hook in the first line; 3–8 hashtags at the end' },
  { key: 'facebook', name: 'Facebook', rule: 'friendly post, 40–120 words, one clear call to action' },
  { key: 'linkedin', name: 'LinkedIn', rule: 'professional, short paragraphs, 80–200 words, at most 3 hashtags' },
  { key: 'x', name: 'X', rule: 'at most 280 characters including any link or hashtag' },
  { key: 'whatsapp', name: 'WhatsApp Status', rule: 'at most 2 short lines, plain text, no hashtags' },
  { key: 'youtube', name: 'YouTube community post', rule: 'conversational, 30–90 words, may end with a question' },
  { key: 'email', name: 'Email', rule: 'a subject line on the first line as "Subject: …", then a body of 60–150 words' },
] as const;

contentApi.post('/announce', async (c) => {
  const user = c.get('user').id;
  const p = await c.req.json().catch(() => ({})) as any;
  const text = String(p.text ?? '').trim().slice(0, 4000);
  const link = String(p.link ?? '').trim().slice(0, 300);
  const wanted = (Array.isArray(p.platforms) ? p.platforms : PLATFORMS.map((x) => x.key)).filter((k: string) => PLATFORMS.some((x) => x.key === k));
  if (text.length < 10) return c.json({ error: 'Write what you want to announce (a sentence or more).' }, 400);
  if (!wanted.length) return c.json({ error: 'Pick at least one platform.' }, 400);
  if (asks.full(user)) return c.json({ error: 'That’s a lot of announcements this hour; try again later.' }, 429);
  asks.count(user);
  const list = PLATFORMS.filter((x) => wanted.includes(x.key));
  try {
    const r = await askJson<{ drafts: { platform: string; text: string }[] }>({
      instructions: 'You write social media and email copy for a small business owner. Plain, specific, no hype words, no emoji walls. Keep every fact from the announcement and invent none. Answer with JSON only.',
      prompt: [
        `The announcement:\n${text}`,
        link ? `Link to include where it fits: ${link}` : 'There is no link.',
        `Write one draft for each platform, following its rule:\n${list.map((x) => `- ${x.key} (${x.name}): ${x.rule}`).join('\n')}`,
        'Answer as {"drafts":[{"platform":"<key>","text":"<the draft>"}]} with one entry per platform key, in the order given.',
      ].join('\n\n'),
      check: (v) => {
        const got = new Set((v?.drafts ?? []).map((d) => d.platform));
        const missing = list.filter((x) => !got.has(x.key)).map((x) => x.key);
        const long = (v?.drafts ?? []).filter((d) => d.platform === 'x' && d.text.length > 280).map(() => 'the X draft is over 280 characters');
        return [...(missing.length ? [`missing drafts for: ${missing.join(', ')}`] : []), ...long];
      },
      tries: 3, minutes: 3,
    });
    const drafts = list.map((x) => ({ platform: x.key, name: x.name, text: String(r.drafts.find((d) => d.platform === x.key)?.text ?? '').trim() }));
    return c.json({ drafts });
  } catch (e: any) {
    return c.json({ error: `The drafts couldn’t be written: ${String(e?.message ?? e).slice(0, 200)}` }, 502);
  }
});

/** Set up the nightly trend scout as a routine for one team member. */
contentApi.post('/trend-scout', async (c) => {
  const user = c.get('user').id;
  const p = await c.req.json().catch(() => ({})) as any;
  const b = getBotRow(String(p.botId ?? ''));
  if (!b || b.user_id !== user || b.kind === 'room') return c.json({ error: 'Pick a team member.' }, 400);
  const topic = String(p.topic ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (topic.length < 3) return c.json({ error: 'Say what field to watch, e.g. “AI tools for small US businesses”.' }, 400);
  const hour = Math.min(23, Math.max(0, Math.round(Number(p.hour ?? 22))));
  const tz = typeof p.timezone === 'string' && /^[A-Za-z_]+\/[A-Za-z_\/-]+$/.test(p.timezone) ? p.timezone : 'Asia/Kolkata';
  const schedule = `0 ${hour} * * *`;
  try { new Cron(schedule, { paused: true, timezone: tz }); } catch { return c.json({ error: 'That time or timezone isn’t valid.' }, 400); }
  const prompt = [
    `Nightly trend scout for: ${topic}.`,
    'Look at what is new and rising in the last 24 hours (search the web; check short-video and social trends where you can).',
    'Pick the 5 trends most useful to the owner. For each: what it is, the evidence with links, why it matters for the owner, and one content or offer idea.',
    'Save the report as a Markdown file in your Library named trend-scout-YYYY-MM-DD.md, and reply with a 3-line summary. Read and write only your own files: don’t post, send or contact anyone.',
  ].join('\n');
  const id = newId('rt');
  db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id, b.id, `Trend scout: ${topic}`.slice(0, 80), prompt, schedule, tz, now());
  const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(id));
  scheduleRoutine(r);
  appendRow(b.id, 'event', { type: 'event', event: 'routine-created', text: `Routine created: ${r.name} · ${describeCron(schedule)}`, ref: id });
  hub.emit(user, { type: 'routines', botId: b.id });
  return c.json({ routine: r });
});
