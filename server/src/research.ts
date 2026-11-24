// Research team (from Theo): 2–4 research helpers each take one angle of a question, search and read the web
// in parallel (xAI's web_search tool), and a writer turns their findings into one brief with numbered sources.
// Every call is logged under "Research" in the spend panel.
import { env } from './env.js';
import { usage } from './usage.js';

const XAI = 'https://api.x.ai/v1/responses';

async function grok(userId: string, input: { role: string; content: string }[], opts: { tools?: unknown[]; effort?: string; timeoutMs?: number } = {}) {
  const res = await fetch(XAI, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.xaiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    body: JSON.stringify({ model: env.xaiModel, store: false, input, ...(opts.tools ? { tools: opts.tools } : {}), reasoning: { effort: opts.effort ?? 'low' } }),
  });
  if (!res.ok) throw new Error(`xAI answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  usage.grok(userId, data.usage, 'Research');
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
  return { text: parts.join('\n\n').trim(), links: [...links] };
}

/** Split the question into N angles that together cover it (falls back to the question itself). */
async function plan(userId: string, question: string, n: number): Promise<string[]> {
  try {
    const r = await grok(userId, [
      { role: 'system', content: `Split a research question into exactly ${n} distinct, non-overlapping angles that together answer it. Reply with a JSON array of ${n} short questions and nothing else.` },
      { role: 'user', content: question },
    ], { effort: 'low', timeoutMs: 60_000 });
    const arr = JSON.parse(r.text.replace(/^```(json)?|```$/g, '').trim());
    if (Array.isArray(arr) && arr.length) return arr.slice(0, n).map((x: unknown) => String(x).slice(0, 300));
  } catch { /* one angle per helper below */ }
  return Array.from({ length: n }, (_, i) => (i === 0 ? question : `${question} (look for different sources and recent facts, angle ${i + 1})`));
}

export interface ResearchResult { brief: string; sources: string[]; angles: string[] }

export async function runResearch(userId: string, question: string, helpers = 2): Promise<ResearchResult> {
  const n = Math.min(4, Math.max(2, Math.round(helpers) || 2));
  const angles = await plan(userId, question, n);
  const found = await Promise.allSettled(angles.map((angle) => grok(userId, [
    { role: 'system', content: 'You are one member of a research team. Search the web for this angle, open and read the most relevant pages, and report what you found as short factual bullet points. After each bullet put the URL it came from in brackets. Note dates and say when sources disagree or something is uncertain. No preamble.' },
    { role: 'user', content: angle },
  ], { tools: [{ type: 'web_search' }], effort: 'low', timeoutMs: 240_000 })));
  const notes: string[] = [];
  const pool: string[] = [];
  found.forEach((f, i) => {
    if (f.status !== 'fulfilled' || !f.value.text) { notes.push(`Angle ${i + 1} (${angles[i]}): no findings came back.`); return; }
    notes.push(`Angle ${i + 1}: ${angles[i]}\n${f.value.text.slice(0, 12_000)}`);
    for (const u of f.value.links) if (!pool.includes(u)) pool.push(u);
  });
  if (!pool.length && notes.every((x) => x.includes('no findings'))) throw new Error('The research helpers found nothing; try a more specific question.');
  const numbered = pool.slice(0, 40);
  const w = await grok(userId, [
    { role: 'system', content: 'Write a research brief from the team\'s findings below, answering the question. Start with the answer in two or three sentences, then the key findings as short bullet points, each ending with numbered citations like [1] or [2][5] that refer to the numbered source list given. Use only the findings; say plainly what is uncertain or where sources disagree. End with a "Sources" section listing the numbers and URLs you cited. Plain markdown, no other preamble.' },
    { role: 'user', content: `Question: ${question}\n\nNumbered sources:\n${numbered.map((u, i) => `[${i + 1}] ${u}`).join('\n')}\n\nFindings:\n${notes.join('\n\n')}` },
  ], { effort: 'low', timeoutMs: 180_000 });
  return { brief: (w.text || notes.join('\n\n')).slice(0, 40_000), sources: numbered, angles };
}
