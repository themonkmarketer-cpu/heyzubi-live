// The series' rules as checks: the hook checklist, pace, dialogue, keyword, truth, AI-slop and prompt rules that were
// applied by hand. "must" stops an approval; "should" is shown and can be accepted.
import type { Check, Episode, Script, Shot } from './types.js';
import { formula, type PastEpisode, type Series } from './store.js';

const words = (s: string) => s.replace(/[“”"]/g, '').trim().split(/\s+/).filter(Boolean);
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const bag = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 3));
/** How alike two lines are (shared longer words). */
/** A line said clearly higher or lower than the character's own sample. Shouting raises a voice, so only a drop counts there. */
export function voiceDrift(l: { pitch?: number; refPitch?: number }, x?: { delivery?: string; line?: string }): boolean {
  if (!l.pitch || !l.refPitch) return false;
  const off = l.pitch / l.refPitch - 1, loud = /shout|yell|scream|frantic|pant|alarm|loud|panic|excite|desperat|exasperat|thrilled/i.test(x?.delivery ?? '') || (x?.line ?? '').includes('!');
  return loud ? off < -0.12 : off < -0.12 || off > 0.25;
}
export function alike(a: string, b: string): number {
  const x = bag(a), y = bag(b);
  if (!x.size || !y.size) return 0;
  let n = 0; for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}
const TECH = /\b(chat ?gpt|google|website|app|software|ai|a\.i\.|automation|crm|seo|algorithm|bot|agent)\b/i;
const MOUTH = /\b(sip(s|ping)?|drink(s|ing)?|eat(s|ing)?|chew(s|ing)?|bite(s)?|straw|cup (at|to) (his|her|the) (lips|mouth))\b/i;

const allShots = (s: Script): (Shot & { part: number })[] => s.parts.flatMap((p, i) => p.shots.map((x) => ({ ...x, part: i + 1 })));
export const spoken = (s: Script) => allShots(s).filter((x) => x.line && x.speaker);

export function scriptChecks(s: Script, history: PastEpisode[]): Check[] {
  const out: Check[] = [], F = formula(), closer = F.roles.closer;
  const add = (id: string, label: string, ok: boolean, level: 'must' | 'should', detail = '') => out.push({ id, label, ok, level, ...(detail ? { detail } : {}) });
  const lines = spoken(s), first = lines[0], second = lines[1];
  add('parts', 'Two parts of 30 seconds', s.parts.length === 2 && s.parts.every((p) => p.shots.length > 0 && Math.abs(p.shots[p.shots.length - 1].end - 30) < 0.01), 'must');
  s.parts.forEach((p, i) => {
    add(`shots${i}`, `Part ${i + 1}: 10 to 12 shots`, p.shots.length >= 10 && p.shots.length <= 12, 'must', `${p.shots.length} shots`);
    const gap = p.shots.findIndex((x, k) => Math.abs(x.start - (k ? p.shots[k - 1].end : 0)) > 0.01 || x.end <= x.start);
    add(`times${i}`, `Part ${i + 1}: shot times join up from 0 to 30`, gap < 0, 'must', gap < 0 ? '' : `shot ${gap + 1}`);
    const n = p.shots.filter((x) => x.line).length;
    add(`lines${i}`, `Part ${i + 1}: 10 to 13 lines`, n >= 10 && n <= 13, 'must', `${n} lines`);
  });
  if (first) {
    const w = words(first.line!).length;
    add('hook0', 'Spoken from the first frame', first.part === 1 && first.start === 0, 'must');
    add('hookwords', 'First line 5 to 10 words', w >= 5 && w <= 10, 'must', `${w} words: “${first.line}”`);
    const owner = s.cast.find((c) => c.kind !== 'described' && !Object.values(F.roles).includes(c.key));
    const named = s.cast.some((c) => c.key !== first.speaker?.toLowerCase() && new RegExp(`\\b${c.name.split(' ')[0]}\\b`, 'i').test(first.line!)) || /\b(pop|dad|mom|boss|tío|sis|bro)\b/i.test(first.line!);
    add('hookname', 'Someone else says it to the owner, by name', named && first.speaker?.toLowerCase() !== owner?.key, 'must', first.speaker);
    add('hooktech', 'No tech word in the first line', !TECH.test(first.line!), 'must');
    add('hookloss', 'The first line names a loss, ideally with a number', /\b(lost|lose|losing|gone|never|no|empty|miss(ed|ing)?|stole|quit|left|late|owe[sd]?|cancel+ed|zero|nobody|dead|wasted|twice)\b/i.test(first.line!) || /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand)\b/i.test(first.line!), 'must', first.line);
    add('hookcut', 'First cut by 3 seconds, close framing', first.end <= 3 && !/\bwide\b/i.test(first.camera), 'must', first.camera);
  }
  if (second) add('second', 'A second voice answers by 3 seconds', second.part === 1 && second.start <= 3 && second.speaker !== first?.speaker, 'must', second.speaker);
  add('unexpected', 'One unexpected detail in the first frame', !!s.unexpected?.trim(), 'must', s.unexpected);
  const long = lines.filter((l) => { const n = words(l.line!).length; return n > 13 || n < 3; });
  add('linelen', 'Lines of 6 to 10 words (3 to 13 at the outside)', !long.length, 'must', long.slice(0, 3).map((l) => `“${l.line}”`).join(' · '));
  const med = lines.map((l) => words(l.line!).length).sort((a, b) => a - b)[Math.floor(lines.length / 2)] ?? 0;
  add('median', 'Median line about 8 words', med >= 6 && med <= 10, 'should', `${med} words`);
  const digits = lines.filter((l) => /\d/.test(l.line!));
  add('digits', 'Numbers spelled as spoken', !digits.length, 'must', digits.map((l) => l.line).join(' · '));
  add('mustsay', F.mustSay.label, lines.some((l) => norm(l.line!).includes(F.mustSay.text)), 'must');
  const last = lines.slice(-F.closing.lines.length);
  add('close', F.closing.label, last.length === F.closing.lines.length && last.every((l, n) => l.speaker?.toLowerCase() === closer && F.closing.lines[n].every((x) => l.line!.toLowerCase().includes(x))), 'must', last.map((l) => l.line).join(' / '));
  const build = s.parts[0]?.shots.filter((x) => x.speaker?.toLowerCase() === closer) ?? [];
  add('closer', F.closerLabel, build.length === 1 && !/\?$/.test(build[0].line ?? ''), 'should');
  const kw = norm(s.keywords?.primary ?? '');
  const hits = lines.filter((l) => kw && norm(l.line!).replace(/-/g, ' ').includes(kw));
  add('keyword', `Main phrase spoken twice: “${s.keywords?.primary ?? ''}”`, hits.length >= 2, 'should', `${hits.length} times`);
  add('keyword10', 'Main or owner phrase in the first 10 seconds', [s.keywords?.primary, s.keywords?.ownerSide].some((k) => k && lines.some((l) => l.part === 1 && l.start < 10 && norm(l.line!).includes(norm(k)))), 'should');
  add('term', 'Says AI Employee, never AI team or workforce', lines.some((l) => /AI Employee/i.test(l.line!)) && !lines.some((l) => /AI (team|workforce|staff)/i.test(l.line!)), 'must');
  const reruns = lines.map((l) => { const h = history.flatMap((e) => e.lines.map((t) => ({ t, n: e.num }))).find((x) => !F.fixedLines.some((f) => norm(l.line!).includes(norm(f))) && words(l.line!).length > 4 && alike(l.line!, x.t) >= 0.85); return h ? `“${l.line}” (Ep ${h.n})` : null; }).filter(Boolean) as string[];
  add('rerun', 'No line repeated from earlier episodes', !reruns.length, 'must', reruns.slice(0, 3).join(' · '));
  const mouth = allShots(s).filter((x) => x.line && MOUTH.test(x.picture.replace(/never (drinks|eats|sips)[^.]*\.?/gi, '').replace(/no (drinking|eating|sipping)/gi, '').replace(/nothing near (his|her|the) mouth/gi, '')));
  add('mouth', 'Nobody eats, drinks or sips on a line', !mouth.length, 'must', mouth.map((x) => `P${x.part} shot ${x.n}`).join(', '));
  add('turn', 'The turn (it works) lands by the end of Part 1', s.parts[0]?.shots.some((x) => x.start >= 20 && x.screen), 'should');
  const ids = Object.keys(s.screens ?? {});
  add('screens', 'Five screens, each used in a silent or over-the-shoulder shot', ids.length >= 4 && ids.every((id) => allShots(s).some((x) => x.screen === id)), 'must', ids.join(', '));
  add('demo', 'No DEMO word anywhere', !/\bdemo\b/i.test(JSON.stringify({ s: s.screens, p: s.parts })), 'must');
  add('honest', 'The AI Employee only does what it really does', (s.honesty ?? '').length > 60, 'must', s.honesty);
  add('tip', 'One tip worth saving', !!s.tip?.trim() && lines.some((l) => alike(l.line!, s.tip) >= 0.5), 'should', s.tip);
  add('names', 'No real brands; no line too close to a real person', !/\b(starbucks|walmart|costco|target|amazon|apple|uber|instagram|tiktok|facebook|yelp|tesla)\b/i.test(JSON.stringify(s.parts)), 'should');
  return out;
}

export function promptChecks(prompts: string[], s: Script, audioSeconds: number[], images: number[]): Check[] {
  const out: Check[] = [];
  prompts.forEach((p, i) => {
    out.push({ id: `chars${i}`, label: `Part ${i + 1}: prompt under 7,500 characters`, ok: p.length <= 7500, level: 'must', detail: p.length.toLocaleString() });
    out.push({ id: `audio${i}`, label: `Part ${i + 1}: voice samples under 30 seconds in total`, ok: audioSeconds[i] <= 29.8, level: 'must', detail: `${audioSeconds[i].toFixed(1)} s` });
    out.push({ id: `imgs${i}`, label: `Part ${i + 1}: reference images`, ok: images[i] >= 2 && images[i] <= 9, level: 'must', detail: String(images[i]) });
    out.push({ id: `list${i}`, label: `Part ${i + 1}: nothing asks for “a list of” on a screen`, ok: !/a (tidy )?list of/i.test(p), level: 'must' });
  });
  const tools = s.parts.flatMap((p, i) => p.shots.filter((x) => /\b(wrench|screwdriver|drill|pliers|hammer|saw)\b/i.test(x.picture) && !/\b(grip|jaws|on the|against|holding|raised|in (his|her) hand|spinning|points?)\b/i.test(x.picture)).map((x) => `P${i + 1} shot ${x.n}`));
  out.push({ id: 'tools', label: 'Tools touch what they work on', ok: !tools.length, level: 'should', detail: tools.join(', ') });
  const laugh = s.parts.flatMap((p, i) => p.shots.filter((x, k) => /\b(laugh(s|ing)?|giggl|chuckl)/i.test(x.picture) && !/(not|never|no|does not|doesn't) laugh/i.test(x.picture) && !(k && p.shots[k - 1].line)).map((x) => `P${i + 1} shot ${x.n}`));
  out.push({ id: 'laugh', label: 'Every laugh has a line before it', ok: !laugh.length, level: 'should', detail: laugh.join(', ') });
  return out;
}

export function packChecks(ep: Episode, sr: Series): Check[] {
  const p = ep.pack!;
  const out: Check[] = [];
  const add = (id: string, label: string, ok: boolean, level: 'must' | 'should', detail = '') => out.push({ id, label, ok, level, ...(detail ? { detail } : {}) });
  const kw = (ep.script?.keywords.primary ?? '').toLowerCase();
  add('line1', 'Caption line 1 asks the search phrase as a question', /\?/.test(p.instagram.split('\n')[0]) && norm(p.instagram.split('\n')[0]).includes(norm(kw)), 'should', p.instagram.split('\n')[0].slice(0, 120));
  add('tags', `Ends with ${sr.hashtags} and no other hashtags`, p.instagram.trim().endsWith(sr.hashtags) && (p.instagram.match(/#\w+/g) ?? []).length === sr.hashtags.split(/\s+/).length, 'must');
  add('bio', 'Instagram says “in my bio”, Facebook says “linked on my Page”', /in my bio/i.test(p.instagram) && /linked on my page/i.test(p.facebook) && !/in my bio/i.test(p.facebook), 'must');
  add('aie', 'Names the fix as “AI Employee (AI Agent)” and says AI for small business', /AI Employee \(AI Agent\)/.test(p.instagram) && /AI for small business/i.test(p.instagram), 'must');
  add('affil', 'No affiliate disclosure comment', !/(affiliate|commission)/i.test(p.commentInstagram + p.commentFacebook), 'must');
  add('dash', 'No em dashes', !/—/.test(p.instagram + p.facebook + p.commentInstagram + p.youtubeTitle), 'must');
  add('income', 'No income claim', !/\b(get rich|make \$|earn \$|passive income)\b/i.test(p.instagram), 'must');
  add('fbtags', 'Six to eight Facebook tags', p.facebookTags.length >= 6 && p.facebookTags.length <= 8, 'should', String(p.facebookTags.length));
  add('yt', 'YouTube title under 60 characters, starting with the phrase', p.youtubeTitle.length <= 60 && norm(p.youtubeTitle).startsWith(norm(kw).split(' ')[0] ?? ''), 'should', `${p.youtubeTitle.length}: ${p.youtubeTitle}`);
  add('ai', 'One of your AI Employees really does this (you confirmed)', ep.aiConfirmed === 'yes', 'should');
  if (p.platforms.includes('whatsapp')) add('wa', 'WhatsApp line: short, one paragraph', !!p.whatsapp && p.whatsapp.length <= 300 && !p.whatsapp.includes('\n'), 'should', `${(p.whatsapp ?? '').length}`);
  add('share', 'One specific “Send this to the … who …” line', /Send this to the /i.test(p.instagram), 'should');
  return out;
}

export const musts = (c: Check[]) => c.filter((x) => !x.ok && x.level === 'must');
