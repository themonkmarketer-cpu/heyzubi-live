import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { cleanShots } from './edit.js';
import { allEpisodes, epFile, series, slotLabel, socialDir } from './store.js';
import { studioShots } from './studio.js';
import type { CastMember, Episode } from './types.js';

const execFileP = promisify(execFile);
/** ffmpeg in the background (the app keeps answering while it runs). */
const ff = (args: string[]) => execFileP('ffmpeg', ['-loglevel', 'error', '-y', ...args], { timeout: 10 * 60_000, maxBuffer: 1 << 20 });
const H264 = ['-an', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

/**
 * The cut's picture with the screens on but no captions, clock or flash, and where each shot sits in it. The studio's
 * joined.mov is that already; the plain edit writes edit/clean.mp4 beside the final. None when it predates the final.
 */
function cleanSource(e: Episode): { file: string; shots: { part: number; shot: number; at: number; dur: number }[] } | null {
  const final = epFile(e, e.edit.final!);
  const file = epFile(e, e.edit.studioSig ? 'edit/joined.mov' : 'edit/clean.mp4');
  if (!fs.existsSync(file) || fs.statSync(file).mtimeMs < fs.statSync(final).mtimeMs - 30 * 60_000) return null;
  const shots = e.edit.studioSig ? studioShots(e) : cleanShots(e);
  return shots.length ? { file, shots } : null;
}

/**
 * The bridge from Reels Factory to the owner's PC. Each episode's AI Employee also gets a landing page, built on the PC
 * (by the session that makes the series' pages). Once an episode's final cut is approved and its cover picked, HeyZubi
 * writes a hand-off for it: handoff/epNN/ holds brief.json (what the page needs to know), BRIEF.md (the same, to read),
 * reel.mp4, the cover and the cast pictures. The PC pulls new hand-offs, hands them to that session, and, once the
 * page is live, registers its link back (register-page.ts), which puts the page on the episode's card.
 *
 * A hand-off is written again only when the final cut, the cover or the page changes (its `sig`), so the PC sees each change once.
 */
export const handoffDir = () => path.join(socialDir(), 'handoff');
const two = (n: number) => String(n).padStart(2, '0');

const ready = (e: Episode) => !e.archived && e.stages.edit?.status === 'done' && !!e.edit.final && !!e.cover.picked && !!e.script;

function readJson<T>(f: string): T | null { try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T; } catch { return null; } }

function copyIfChanged(from: string, to: string) {
  const a = fs.statSync(from);
  const b = fs.existsSync(to) ? fs.statSync(to) : null;
  if (!b || b.size !== a.size || b.mtimeMs < a.mtimeMs) fs.copyFileSync(from, to);
}

/** A cast member's picture: the one the record names, else the episode's cast/<key>-N file (JPEG first). */
function castFile(e: Episode, c: CastMember): string | null {
  if (c.image && fs.existsSync(epFile(e, c.image))) return epFile(e, c.image);
  try {
    const dir = epFile(e, 'cast');
    const mine = fs.readdirSync(dir).filter((f) => f.startsWith(`${c.key}-`) && /\.(jpe?g|png|webp)$/i.test(f)).sort((a, b) => Number(/\.png$/i.test(a)) - Number(/\.png$/i.test(b)) || a.localeCompare(b));
    return mine.length ? path.join(dir, mine[0]) : null;
  } catch { return null; }
}

function brief(e: Episode, pages: Record<string, { url: string }>) {
  const s = e.script!;
  const cover = e.cover.picked!;
  const pic = (c: CastMember) => { const f = castFile(e, c); return f ? `cast/${c.key}${path.extname(f)}` : null; };
  const slot = e.pack?.slot ?? null;
  return {
    num: e.num, title: s.title || e.title, slug: s.slug, trade: s.trade, logline: s.logline,
    aiEmployee: { name: s.aiEmployee.name, does: s.aiEmployee.does, howItWorks: s.aiEmployee.howItWorks, icon: s.aiEmployee.icon, color: s.aiEmployee.color },
    keywords: { primary: s.keywords.primary, ownerSide: s.keywords.ownerSide, secondary: s.keywords.secondary },
    tip: s.tip, honesty: s.honesty, question: s.question,
    caption: { line1: s.caption.line1, story: s.caption.story },
    instagramCaption: e.pack?.instagram ?? null,
    slot, slotLabel: slot ? slotLabel(slot).label : null,
    cast: s.cast.map((c) => ({ name: c.name, line: c.castLine, kind: c.kind, picture: pic(c) })),
    seconds: e.edit.seconds ?? null,
    files: { video: 'reel.mp4', cover: `cover${path.extname(cover)}`, cast: s.cast.map(pic).filter(Boolean) as string[] },
    landingPage: pages[String(e.num)]?.url ?? null,
    clean: null as string | null,
    shots: [] as { part: number; shot: number; at: number; seconds: number; screen: string | null; picture: string; clip: string | null }[],
    sig: `3|${e.edit.final}|${cover}`, // the leading number is the hand-off's format: raising it rewrites every hand-off once
    writtenAt: new Date().toISOString(),
  };
}

function markdown(b: ReturnType<typeof brief>) {
  return [
    `# Ep ${b.num}: ${b.title}`,
    '',
    `Made in HeyZubi's Reels Factory. ${b.slotLabel ? `Goes out ${b.slotLabel}.` : 'Not scheduled yet.'}`,
    '',
    `- Trade: ${b.trade}`,
    `- AI Employee: **${b.aiEmployee.name}**. ${b.aiEmployee.howItWorks}`,
    ...b.aiEmployee.does.map((d) => `  - ${d}`),
    `- Logline: ${b.logline}`,
    `- Primary keyword: ${b.keywords.primary}`,
    `- Tip in the caption: ${b.tip}`,
    `- Honesty line: ${b.honesty}`,
    '',
    '## Cast',
    ...b.cast.map((c) => `- ${c.name}: ${c.line || (c.kind === 'series' ? 'series regular' : '')}${c.picture ? ` (picture: ${c.picture})` : ''}`),
    '',
    '## Files here',
    `- ${b.files.video}: the approved final cut${b.seconds ? ` (${b.seconds.toFixed(1)} s)` : ''}`,
    `- ${b.files.cover}: the picked cover`,
    ...b.files.cast.map((f) => `- ${f}`),
    ...(b.clean ? [
      '',
      '## Clean picture (screens on; no captions, clock or flash; no sound)',
      `- ${b.clean}: the whole cut`,
      ...b.shots.filter((x) => x.clip).map((x) => `- ${x.clip}: Part ${x.part} shot ${x.shot}, from ${x.at.toFixed(1)} s, screen ${x.screen}. ${x.picture}`),
      '- shots.json: every shot with its start time in clean.mp4, to cut others',
    ] : []),
    '',
    b.landingPage ? `Landing page: ${b.landingPage}` : 'Landing page: not built yet.',
    '',
  ].join('\n');
}

/** The clean picture and a five-second clip from the start of every shot that has a screen (the AI Employee's screens). */
async function cleanPieces(e: Episode, dir: string, b: ReturnType<typeof brief>) {
  const src = cleanSource(e);
  fs.rmSync(path.join(dir, 'shots'), { recursive: true, force: true });
  if (!src) return;
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  const clean = path.join(dir, 'clean.mp4');
  await ff(['-i', src.file, ...H264, clean]);
  const end = Math.max(...src.shots.map((x) => x.at + x.dur));
  const r = (n: number) => Math.round(n * 100) / 100;
  for (const s of src.shots.sort((a, b2) => a.at - b2.at)) {
    const x = e.script!.parts[s.part - 1]?.shots.find((q) => q.n === s.shot);
    const entry = { part: s.part, shot: s.shot, at: r(s.at), seconds: r(s.dur), screen: x?.screen ?? null, picture: String(x?.picture ?? '').replace(/\s+/g, ' ').slice(0, 240), clip: null as string | null };
    if (x?.screen) {
      const name = `p${s.part}-s${s.shot}-${x.screen}.mp4`;
      await ff(['-ss', s.at.toFixed(3), '-t', Math.min(5, end - s.at).toFixed(3), '-i', clean, ...H264, path.join(dir, 'shots', name)]);
      entry.clip = `shots/${name}`;
    }
    b.shots.push(entry);
  }
  b.clean = 'clean.mp4';
  fs.writeFileSync(path.join(dir, 'shots.json'), JSON.stringify(b.shots, null, 2));
}

let busy = false;
/** Write hand-offs for episodes that are ready and new or changed. Returns the episode numbers written. */
export async function writeHandoffs(): Promise<number[]> {
  if (busy) return [];
  busy = true;
  try { return await writeAll(); } finally { busy = false; }
}

async function writeAll(): Promise<number[]> {
  let pages: Record<string, { url: string }> = {};
  try { pages = series().pages ?? {}; } catch { /* no series yet */ }
  const made: number[] = [];
  for (const e of allEpisodes()) {
    if (!ready(e)) continue;
    const dir = path.join(handoffDir(), `ep${two(e.num)}`);
    const b = brief(e, pages);
    const old = readJson<{ sig?: string; landingPage?: string | null }>(path.join(dir, 'brief.json'));
    if (old?.sig === b.sig && (old.landingPage ?? null) === b.landingPage) continue;
    fs.mkdirSync(path.join(dir, 'cast'), { recursive: true });
    copyIfChanged(epFile(e, e.edit.final!), path.join(dir, b.files.video));
    copyIfChanged(epFile(e, e.cover.picked!), path.join(dir, b.files.cover));
    for (const c of e.script!.cast) { const f = castFile(e, c); if (f) copyIfChanged(f, path.join(dir, `cast/${c.key}${path.extname(f)}`)); }
    try { await cleanPieces(e, dir, b); } catch (err) { console.warn(`[handoff] Ep ${e.num} clean shots failed:`, (err as Error)?.message ?? err); }
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), markdown(b));
    fs.writeFileSync(path.join(dir, 'brief.json.tmp'), JSON.stringify(b, null, 2));
    fs.renameSync(path.join(dir, 'brief.json.tmp'), path.join(dir, 'brief.json'));
    made.push(e.num);
  }
  return made;
}

/** A minute after start, then every 10 minutes. */
export function initHandoffs() {
  if (process.env.HEYZUBI_NO_SCHEDULER) return;
  const run = () => {
    writeHandoffs().then((m) => { if (m.length) console.log(`[handoff] wrote Ep ${m.join(', Ep ')}`); }).catch((e) => console.warn('[handoff] failed:', (e as Error)?.message ?? e));
  };
  setTimeout(run, 60_000).unref?.();
  setInterval(run, 10 * 60_000).unref?.();
}
