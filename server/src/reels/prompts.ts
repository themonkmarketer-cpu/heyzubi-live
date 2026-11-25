// The two Seedance prompts, put together the series' way: cast and voice bindings, props, places, continuity locks, one
// timestamped line per shot, style and sound. And the request bodies for them.
import { formula, series, type Series } from './store.js';
import type { CastMember, Episode, Script, Shot } from './types.js';

const mm = (t: number) => `00:${String(Math.round(t)).padStart(2, '0')}`;
const at = (c: CastMember) => `@${c.name.split(' ').pop() && c.kind !== 'series' && /^(mr|mrs|ms|dr)\b/i.test(c.name) ? c.name.replace(/[^A-Za-z]/g, '') : c.name.split(' ')[0]}`;
const sentence = (s: string) => { const t = s.trim(); return !t ? '' : /[.!?]$/.test(t) ? t : `${t}.`; };

/** "Vic Brennan, 44, runs…" -> "44, runs…": the name is already said. */
function withoutName(c: CastMember): string {
  const t = (c.castLine ?? '').replace(/[.]$/, ''), first = c.name.split(' ')[0].toLowerCase(), i = t.indexOf(', ');
  return i > 0 && i < 34 && (t.toLowerCase().startsWith(first) || t.toLowerCase().startsWith(c.name.toLowerCase())) ? t.slice(i + 2) : t;
}

/** The episode's lead: whoever speaks most in Part 1 besides the series' own two. */
export function leadKey(s: Script): string {
  const n = new Map<string, number>(), { hero, closer } = formula().roles;
  for (const x of s.parts[0]?.shots ?? []) { const k = (x.speaker ?? '').toLowerCase(); if (x.line && k && k !== hero && k !== closer) n.set(k, (n.get(k) ?? 0) + 1); }
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? closer;
}
/** Is this person named in a shot's picture ("@Sam", "Mrs. Ray")? */
export function named(c: CastMember, text: string): boolean {
  const w = c.name.split(' ').map((x) => x.replace(/[^A-Za-z]/g, '')).filter((x) => x.length > 2 && !/^(mr|mrs|ms|dr|the)$/i.test(x));
  return w.some((x) => new RegExp(`\\b${x}\\b`, 'i').test(text)) || new RegExp(`@${c.name.replace(/[^A-Za-z]/g, '')}\\b`, 'i').test(text);
}
/**
 * Whose clip is the reference video. Seedance casts whoever is in it as a main character, so a part gets its lead's clip
 * (another character's once made them play the lead). Part 2 renders first, with the clip of the one who closes it.
 */
export function videoKey(s: Script, cast: CastMember[], part: number, shotN?: number): string {
  const lead = leadKey(s), { closer } = formula().roles;
  if (!shotN) return part === 1 ? lead : closer;
  const x = s.parts[part - 1].shots.find((q) => q.n === shotN)!, l = cast.find((c) => c.key === lead), sp = (x.speaker ?? '').toLowerCase();
  const hasCloser = sp === closer || new RegExp(`\\b${formula().names.closer}\\b`).test(x.picture), hasLead = sp === lead || (!!l && named(l, x.picture));
  return hasCloser && !hasLead ? closer : lead;
}
/** kie.ai is sent pictures and voices only, as the series always did there: the prompt then says nothing of a video. */
export const withoutVideo = (p: string) => p.replace(/ and video reference 1(?=\))/g, '').replace(/ ?\(video reference 1\)/g, '').replace(/ ?Video reference 1 is [^\n]*?\.(?= |\n|$)/g, '');

export interface PartRefs { images: { name: string; asset: string }[]; audio: { name: string; asset: string; seconds: number }[]; members: CastMember[] }
/** Who is in a part, in reference order: the series' own first, then this episode's; the laptop screen last. */
export function refsFor(s: Script, cast: CastMember[], part: number, screenAsset: string | null): PartRefs {
  const speaking = new Set(s.parts[part - 1].shots.map((x) => (x.speaker ?? '').toLowerCase()).filter(Boolean));
  const members = cast.filter((c) => c.parts.includes(part) || speaking.has(c.key));
  members.sort((a, b) => Number(b.kind === 'series') - Number(a.kind === 'series'));
  const images = members.filter((m) => m.imageAsset).map((m) => ({ name: m.name, asset: m.imageAsset! }));
  const audio = members.filter((m) => m.voiceAsset && speaking.has(m.key)).map((m) => ({ name: m.name, asset: m.voiceAsset!, seconds: m.voiceSeconds ?? 5 }));
  if (screenAsset && s.parts[part - 1].shots.some((x) => x.screen === 's2')) images.push({ name: 'Screen', asset: screenAsset });
  return { images, audio, members };
}

function shotLine(x: Shot, cast: CastMember[]): string {
  const who = cast.find((c) => c.key === (x.speaker ?? '').toLowerCase());
  const line = x.line && who
    ? x.offscreen ? ` ${at(who)}'s voice (his or her audio reference), ${x.delivery || 'steady'}: "${x.line}"` : ` ${at(who)}, ${x.delivery || 'clear'}${x.start === 0 ? ', from the very first frame' : ''}: "${x.line}"`
    : '';
  return `[${mm(x.start)} - ${mm(x.end)}] ${sentence(x.camera)} ${sentence(x.picture)}${line}${x.sound && !line ? ` ${sentence(x.sound)}` : ''}`;
}

export function buildPrompt(s: Script, cast: CastMember[], part: number, refs: PartRefs, sr: Series, video = videoKey(s, cast, part)): string {
  const p = s.parts[part - 1], F = formula(), { hero, closer } = F.roles;
  const img = (n: string) => refs.images.findIndex((i) => i.name === n) + 1, aud = (n: string) => refs.audio.findIndex((i) => i.name === n) + 1;
  const castLines = refs.members.map((c) => {
    const i = img(c.name), a = aud(c.name), vid = c.key === video;
    const look = i ? `(image reference ${i}${vid ? ' and video reference 1' : ''})` : vid ? '(video reference 1)' : '';
    const voice = a ? ` ${at(c)}'s voice is audio reference ${a}: use exactly this voice for every line ${at(c)} speaks${p.shots.some((x) => x.speaker?.toLowerCase() === c.key && x.offscreen) ? ', including any line said off screen' : ''}.` : '';
    const about = withoutName(c);
    return `${at(c)} is ${c.name}${look ? ` ${look}` : ''}${about ? `, ${about}` : ''}.${!i && c.kind === 'described' ? ` ${sentence(c.lock)}` : ''}${voice}${vid ? ` Video reference 1 is for ${at(c)}'s look only, not for the framing, the place, the light or any words.` : ''}`.replace(/\s+/g, ' ').trim();
  });
  const appears = refs.members.filter((c) => ![hero, leadKey(s)].includes(c.key) && c.kind !== 'described').map((c) => {
    const ns = p.shots.filter((x) => (x.speaker?.toLowerCase() === c.key && !x.offscreen) || named(c, x.picture)).map((x) => x.n);
    return ns.length ? `${at(c)} appears only in shot${ns.length > 1 ? 's' : ''} ${ns.join(', ')}.` : c.key === closer ? `${c.name} does not appear.` : '';
  }).filter(Boolean);
  if (!refs.members.some((c) => c.key === video)) castLines.push('Video reference 1 is for the rendering style only: nobody in it appears.');
  const lead = refs.members.find((c) => c.key === leadKey(s)), end = refs.members.find((c) => c.key === closer);
  const silent = p.shots.filter((x) => !x.line).map((x) => x.n);
  const screenOn = img('Screen');
  return [
    'CAST & WORLD', 'CHARACTERS', ...castLines, 'PROPS',
    ...(screenOn ? [`@Screen is the laptop screen (image reference ${screenOn}). Whenever the laptop screen faces the camera, it shows this screen exactly.`] : []),
    sentence(p.props), 'LOCATIONS', sentence(s.location), '',
    'CONTINUITY LOCKS',
    [...refs.members.filter((c) => c.kind !== 'described' || img(c.name)).map((c) => sentence(c.lock)), ...appears, sentence(`Time: ${p.time.replace(/^time:\s*/i, '')}`),
      lead && end && lead !== end ? `${at(lead)} and ${at(end)} are two different people and never swap: ${at(lead)} is ${withoutName(lead)}; ${at(end)} is ${withoutName(end)}.` : '',
      F.locks,
      'Expressions are big and exaggerated, cartoon-feature intensity.',
      `No readable signs, labels or printed words anywhere; phone and laptop screens glow plain white with no words${screenOn ? ', except @Screen' : ''}.`,
      p.shots[0].line && part === 1 ? 'Someone speaks from the very first frame; there is no silent opening.' : '',
      silent.length ? `Nobody speaks in shot${silent.length > 1 ? 's' : ''} ${silent.join(' and ')}.` : '',
      'Pace: a hard cut on every timestamp, fast and punchy like a viral short; characters speak in full sentences; no slow fades or dissolves.'].filter(Boolean).join(' '), '',
    ...p.shots.map((x) => `${shotLine(x, cast)}\n`),
    `${sr.style} ${sentence(p.light)}`, `${sr.audio} ${sentence(p.audio)}`,
  ].join('\n').trim();
}

export function videoBody(prompt: string, refs: PartRefs, refVideo: string, seconds = 30): any {
  return {
    content: [{ type: 'text', text: prompt },
      ...refs.images.map((i) => ({ type: 'image_url', role: 'reference_image', image_url: { url: `tvasset:${i.asset}` } })),
      { type: 'video_url', role: 'reference_video', video_url: { url: `tvasset:${refVideo}` } },
      ...refs.audio.map((a) => ({ type: 'audio_url', role: 'reference_audio', audio_url: { url: `tvasset:${a.asset}` } }))],
    duration: seconds, resolution: '480p', ratio: '9:16', generate_audio: true,
  };
}
export function imageBody(prompt: string, styleAsset: string, wide: boolean): any {
  return { prompt, images: [`tvasset:${styleAsset}`], resolution: '2k', aspect_ratio: wide ? '16:9' : '9:16', output_format: 'png' };
}
/** A single shot again: the same cast, locks, style and sound, one timestamp. */
export function retakeBody(ep: Episode, part: number, shotN: number, note: string, refs: PartRefs, videoAsset: string): { body: any; seconds: number } {
  const s = ep.script!, sr = series(), x = s.parts[part - 1].shots.find((q) => q.n === shotN)!;
  const seconds = Math.max(4, Math.min(12, Math.ceil(x.end - x.start)));
  const one: Script = { ...s, parts: s.parts.map((p, i) => (i === part - 1 ? { ...p, shots: [{ ...x, n: 1, start: 0, end: seconds, picture: [x.picture, x.line && !x.offscreen && !/mouth/i.test(note) ? 'The mouth of the one who speaks opens and moves clearly with every word from the first frame' : '', note].filter(Boolean).map(sentence).join(' ') }] } : p)) };
  const used = { ...refs, members: refs.members.filter((m) => m.key === x.speaker?.toLowerCase() || new RegExp(`@?${m.name.split(' ')[0]}\\b`, 'i').test(x.picture) || m.key === formula().roles.hero) };
  const names = new Set(used.members.map((m) => m.name));
  const r: PartRefs = { members: used.members, images: refs.images.filter((i) => names.has(i.name) || (i.name === 'Screen' && x.screen === 's2')), audio: refs.audio.filter((a) => names.has(a.name) && x.speaker) };
  return { body: videoBody(buildPrompt(one, ep.cast, part, r, sr, videoKey(s, ep.cast, part, shotN)), r, videoAsset, seconds), seconds };
}
