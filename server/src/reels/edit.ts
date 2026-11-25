// The review and the edit. Review: what was said against the script, where the cuts are, a contact sheet, each voice's
// pitch. Edit: the series' recipe: the two parts joined, screens laid on the devices, one-word captions, the countdown
// clock, the dip to white, the theme ducked under the dialogue, accent sounds, two-pass loudness to -14 LUFS.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, FONT_FILE, FONT_NAME, loudness, probe, py, type RunOpts } from './media.js';
import { ensureDir, epFile, formula, ReelError, series, seriesDir } from './store.js';
import { alike } from './checks.js';
import type { Check, Episode, LineCheck, PartReview, RenderVersion, Script } from './types.js';

type Word = [number, number, string];
const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' '), TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const say = (n: number): string => (n < 20 ? ONES[n] : n < 100 ? TENS[Math.floor(n / 10)] + (n % 10 ? ONES[n % 10] : '') : n < 1000 ? `${ONES[Math.floor(n / 100)]}hundred${n % 100 ? say(n % 100) : ''}` : n < 10_000 ? `${say(Math.floor(n / 1000))}thousand${n % 1000 ? say(n % 1000) : ''}` : String(n));
/** A word for comparing: lower case, no punctuation, numbers as they are said. */
const norm = (w: string) => { const t = w.toLowerCase().replace(/[^a-z0-9]/g, ''); return /^\d{1,4}$/.test(t) ? say(Number(t)) : t; };
/** Whisper splits hyphenated words ("no" "-shows"): put back together. */
export const tidyWords = (w: Word[], fix = formula().hear): Word[] => w.reduce<Word[]>((o, x) => { const p = o[o.length - 1]; if (p && /^[-’']/.test(x[2]) && x[0] - p[1] < 0.3) { p[1] = x[1]; p[2] += x[2]; } else o.push([x[0], x[1], fix.reduce((s, [a, b]) => s.replace(new RegExp(a, 'i'), b), x[2])]); return o; }, []);
export const partFile = (ep: Episode, part: number): RenderVersion | null => {
  const p = ep.render.parts[part - 1];
  return p.versions.find((v) => v.v === p.picked && v.state === 'completed' && v.kind !== 'shot') ?? null;
};

/**
 * Each script shot's first frame: the cuts, in order, that best keep every shot near its planned time and its planned
 * length. A render drifts by a second or more, so length counts for more than the clock; a flash inside a shot (a phone
 * lighting up) makes two lengths wrong and is left out. Where no cut fits, the planned length is kept.
 */
export function shotStarts(shots: { start: number }[], cuts: number[], fps: number): number[] {
  const want = shots.map((x) => x.start * fps);
  let beam: { pos: number; j: number; cost: number; out: number[] }[] = [{ pos: 0, j: -1, cost: 0, out: [0] }];
  for (let i = 1; i < want.length; i++) {
    const dur = want[i] - want[i - 1], next: typeof beam = [];
    for (const b of beam) {
      next.push({ pos: b.pos + dur, j: b.j, cost: b.cost + fps * 3, out: [...b.out, Math.round(b.pos + dur)] });
      for (let k = b.j + 1; k < cuts.length; k++) {
        const c = cuts[k], len = c - b.pos;
        if (len < 8) continue;
        if (c - want[i] > fps * 3) break;
        if (want[i] - c > fps * 3) continue;
        next.push({ pos: c, j: k, cost: b.cost + Math.abs(len - dur) + 0.35 * Math.abs(c - want[i]) + 6 * (k - b.j - 1), out: [...b.out, c] });
      }
    }
    beam = next.sort((a, b) => a.cost - b.cost).slice(0, 400);
  }
  const left = (b: (typeof beam)[0]) => b.cost + 6 * (cuts.length - 1 - b.j);
  const best = beam.sort((a, b) => left(a) - left(b))[0].out;
  for (let i = 1; i < best.length; i++) best[i] = Math.max(best[i], best[i - 1] + 8);
  return best;
}

/** Best run of heard words for each line, in order. */
export function matchLines(s: Script, part: number, words: Word[], starts: number[], fps: number): LineCheck[] {
  const out: LineCheck[] = [];
  let from = 0;
  for (const [i, x] of s.parts[part - 1].shots.entries()) {
    if (!x.line || !x.speaker) continue;
    const want = x.line.split(/\s+/).map(norm).filter(Boolean);
    const t0 = starts[i] / fps - 1.2;
    let best = { score: 0, a: from, b: from };
    for (let a = from; a < words.length && words[a][0] < t0 + 9; a++) {
      if (words[a][0] < t0) continue;
      for (let len = Math.max(1, want.length - 3); len <= want.length + 3 && a + len <= words.length; len++) {
        const heard = words.slice(a, a + len).map((w) => norm(w[2]));
        let hit = 0, j = 0;
        for (const w of want) { const k = heard.indexOf(w, j); if (k >= 0) { hit++; j = k + 1; } }
        const score = hit / Math.max(want.length, heard.length);
        if (score > best.score) best = { score, a, b: a + len };
      }
    }
    const seg = words.slice(best.a, best.b);
    const ok = best.score > 0.25 && seg.length;
    out.push({ speaker: x.speaker, text: x.line, heard: ok ? seg.map((w) => w[2]).join(' ') : '', score: ok ? Math.round(best.score * 100) / 100 : 0, start: ok ? seg[0][0] : starts[i] / fps, end: ok ? seg[seg.length - 1][1] : starts[i] / fps, shot: x.n });
    if (ok) from = best.b;
  }
  return out;
}

export async function reviewPart(ep: Episode, part: number, o: RunOpts & { say: (t: string) => void }): Promise<PartReview> {
  const s = ep.script!, v = partFile(ep, part);
  if (!v?.file) throw new ReelError(`Part ${part} has no finished render yet.`);
  const file = epFile(ep, v.file);
  o.say(`Part ${part}: finding the cuts`);
  const c = await py<{ cuts: number[]; frames: number; fps: number }>('cuts', { file }, o);
  o.say(`Part ${part}: listening to the lines`); // without the script as a hint: with it, Whisper skips lines and hears what was written instead of what was said
  const w = await py<{ words: Word[] }>('words', { file }, { ...o, minutes: 15 });
  const starts = shotStarts(s.parts[part - 1].shots, c.cuts, c.fps);
  w.words = tidyWords(w.words);
  const lines = matchLines(s, part, w.words, starts, c.fps);
  o.say(`Part ${part}: checking the voices`);
  const spans = lines.filter((l) => l.score > 0.4 && l.end - l.start > 0.5);
  if (spans.length) {
    const f = await py<{ f0: (number | null)[] }>('pitch', { file, spans: spans.map((l) => [l.start, l.end]) }, o);
    const ref = new Map<string, number>();
    for (const m of ep.cast) if (m.voiceFile) {
      const vf = m.kind === 'series' ? path.join(seriesDir(), m.voiceFile) : epFile(ep, m.voiceFile);
      if (fs.existsSync(vf)) { const r = await py<{ f0: (number | null)[] }>('pitch', { file: vf }, o); if (r.f0[0]) ref.set(m.key, r.f0[0]); }
    }
    spans.forEach((l, i) => { if (f.f0[i]) l.pitch = Math.round(f.f0[i]!); const r = ref.get(l.speaker.toLowerCase()); if (r) l.refPitch = Math.round(r); });
  }
  o.say(`Part ${part}: making the contact sheet`);
  const sheet = `review/part${part}-v${v.v}.jpg`;
  const per = starts.map((f, i) => Math.round((f + (starts[i + 1] ?? c.frames)) / 2));
  await py('sheet', { file, out: epFile(ep, sheet), frames: per.flatMap((f, i) => [Math.min(starts[i] + 3, f), f]), cols: 8 }, o);
  return {
    cuts: c.cuts, frames: c.frames, fps: c.fps, lines, sheet, words: w.words, notes: [],
    hookAt: w.words[0]?.[0] ?? -1, secondVoiceAt: lines[1]?.score ? lines[1].start : -1, shotStarts: starts, asl: Math.round((c.frames / c.fps / (c.cuts.length + 1)) * 100) / 100,
  };
}

// ---------- the edit ----------
interface Seg { src: string; a: number; b: number }
/** A part as the pieces kept (dropped shots out, retaken shots in), and where a moment of it lands. */
function plan(ep: Episode, part: number) {
  const rv = ep.review[part - 1]!, v = partFile(ep, part)!, o = ep.edit.options;
  const fps = rv.fps, end = rv.frames / fps;
  const st = rv.shotStarts.map((f) => f / fps);
  const shots = ep.script!.parts[part - 1].shots;
  const lo = part === 1 ? Math.max(0, o.trimStart) : 0, hi = part === 2 ? end - Math.max(0, o.trimEnd) : end;
  const segs: Seg[] = [];
  const map: { a: number; b: number; at: number; s: number; n: number }[] = [];
  let at = 0;
  shots.forEach((x, i) => {
    const tr = o.trims?.find((d) => d.part === part && d.shot === x.n), full = Math.max(lo, st[i]), stop = Math.min(hi, st[i + 1] ?? end);
    const cutIn = Math.min(tr?.in ?? 0, Math.max(0, stop - full - 0.3)), a = full + cutIn, b = Math.max(a + Math.min(0.3, stop - a), stop - (tr?.out ?? 0));
    if (b - a < 0.04 || o.dropShots.some((d) => d.part === part && d.shot === x.n)) return;
    const re = ep.render.parts[part - 1].versions.filter((q) => q.kind === 'shot' && q.shot === x.n && q.state === 'completed' && q.file && !(q.note ?? '').startsWith('[off]')).pop();
    const last = segs[segs.length - 1];
    if (!re && last && last.src === v.file && Math.abs(last.b - a) < 0.001) { last.b = b; } else segs.push(re ? { src: re.file!, a: cutIn, b: cutIn + (b - a) } : { src: v.file!, a, b });
    map.push({ a, b, at, s: st[i], n: x.n }); at += b - a;
  });
  const to = (t: number): number | null => { const m = map.find((q) => (t >= q.a - 1e-6 && t < q.b - 1e-6) || Math.abs(t - q.s) < 1e-6); return m ? m.at + Math.max(0, t - m.a) : null; };
  const kept = new Map(map.map((m) => [m.n, { a: m.a, b: m.b, at: m.at }]));
  return { segs, seconds: at, to, st, end, shots, fps, kept };
}

async function join(ep: Episode, part: number, segs: Seg[], o: RunOpts): Promise<string> {
  const out = epFile(ep, `edit/p${part}.mov`);
  ensureDir(out);
  const inputs = segs.flatMap((s) => ['-i', epFile(ep, s.src)]);
  const g = segs.map((s, i) => `[${i}:v]trim=${s.a.toFixed(4)}:${s.b.toFixed(4)},setpts=PTS-STARTPTS,fps=24,scale=480:854:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=1,trim=0:${(s.b - s.a).toFixed(4)}[v${i}];[${i}:a]atrim=${s.a.toFixed(4)}:${s.b.toFixed(4)},asetpts=PTS-STARTPTS,aresample=48000,apad=whole_dur=${(s.b - s.a).toFixed(4)},atrim=0:${(s.b - s.a).toFixed(4)}[a${i}]`).join(';');
  await ffmpeg([...inputs, '-filter_complex', `${g};${segs.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segs.length}:v=1:a=1[v][a]`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '8', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', out], o);
  return out;
}

/** "ninety" -> "90", "twenty-four" -> "24" (as the series shows them); "one" stays a word. */
export function digits(w: string): string {
  return w.replace(/[A-Za-z]+(?:-[A-Za-z]+)?/, (x) => {
    const [p, q] = x.toLowerCase().split('-'), t = TENS.indexOf(p), o = ONES.indexOf(p), u = q === undefined ? 0 : ONES.indexOf(q);
    return t >= 0 && u >= 0 && u < 10 ? String(t * 10 + u) : o > 1 && q === undefined ? String(o) : x;
  });
}
const ts = (t: number) => `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;

/** Heard words with the script's spelling wherever they line up (the series' caption fixes, done from the script itself). */
export function captionWords(ep: Episode, part: number): [number, number, string, number][] {
  const rv = ep.review[part - 1]!, s = ep.script!;
  const out: [number, number, string, number][] = [];
  const used = new Set<number>();
  for (const l of rv.lines) {
    if (!l.score) continue;
    const x = s.parts[part - 1].shots.find((q) => q.n === l.shot)!;
    const want = (x.caption || x.line || '').replace(/[“”"]/g, '').split(/\s+/).filter((w) => norm(w));
    const idx = rv.words.map((w, i) => i).filter((i) => rv.words[i][0] >= l.start - 0.01 && rv.words[i][1] <= l.end + 0.01 && !used.has(i));
    idx.forEach((i) => used.add(i));
    const heard = idx.map((i) => rv.words[i]);
    if (!heard.length) continue;
    // words that match are anchors; what lies between two anchors shares the time between them
    const pairs: { w: number; h: number }[] = [];
    let j = 0;
    want.forEach((w, wi) => { for (let k = j; k < Math.min(heard.length, j + 4); k++) if (norm(heard[k][2]) === norm(w)) { pairs.push({ w: wi, h: k }); j = k + 1; break; } });
    const stops = [{ w: -1, h: -1 }, ...pairs, { w: want.length, h: heard.length }];
    for (let p = 1; p < stops.length; p++) {
      const A = stops[p - 1], B = stops[p];
      const gapW = want.slice(A.w + 1, B.w), gapH = heard.slice(A.h + 1, B.h);
      if (gapW.length) {
        const a = gapH[0]?.[0] ?? (A.h >= 0 ? heard[A.h][1] : heard[0][0]), b = gapH[gapH.length - 1]?.[1] ?? (B.h < heard.length ? heard[B.h][0] : heard[heard.length - 1][1]);
        const step = Math.max(0.08, (b - a) / gapW.length);
        gapW.forEach((w, i) => out.push([a + i * step, a + (i + 1) * step, w, l.shot]));
      }
      if (B.h < heard.length && B.w < want.length) out.push([heard[B.h][0], heard[B.h][1], want[B.w], l.shot]);
    }
  }
  const fixes = ep.edit.options.captionFixes ?? [];
  return out.sort((a, b) => a[0] - b[0]).map(([a, b, w, n]) => { const f = fixes.find(([x]) => norm(x) === norm(w)); return [a, b, f ? f[1] : w, n] as [number, number, string, number]; }).filter((w) => w[2].trim());
}

export async function buildEdit(ep: Episode, o: RunOpts & { say: (t: string) => void }): Promise<Partial<Episode['edit']>> {
  const s = ep.script!, sr = series(), opt = ep.edit.options, dir = epFile(ep, 'edit');
  fs.mkdirSync(dir, { recursive: true });
  const P = [plan(ep, 1), plan(ep, 2)];
  o.say('Joining the two parts');
  for (const part of [1, 2]) await join(ep, part, P[part - 1].segs, o);
  fs.writeFileSync(path.join(dir, 'concat.txt'), "file 'p1.mov'\nfile 'p2.mov'\n");
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', 'joined.mov'], { ...o, cwd: dir });
  const p1 = (await probe(path.join(dir, 'p1.mov'))).seconds, END = (await probe(path.join(dir, 'joined.mov'))).seconds;
  const J = (part: number, t: number) => { const x = P[part - 1].to(t); return x === null ? null : (part === 2 ? p1 : 0) + x; };

  // ---- screens on the devices ----
  const stats: Record<string, any> = {}, previews: string[] = [], wake: Record<string, number> = {};
  const ov: { name: string; at: number }[] = [];
  for (const part of [1, 2]) for (const [i, x] of s.parts[part - 1].shots.entries()) {
    const set = opt.screenOn?.[`${part}-${x.n}`], id = set ?? x.screen, extra = !!id && id !== x.screen;
    if (!id || !ep.screens.some((q) => q.id === id)) continue;
    const so: { on: boolean; f0?: number; f1?: number; motion?: 'track' | 'static' } = extra ? { on: true } : opt.screens[id] ?? { on: true }, sid = extra ? `${id}@${part}-${x.n}` : id;
    if (!so.on) { stats[sid] = { off: true }; continue; }
    const pl = P[part - 1], rv = ep.review[part - 1]!;
    const k = pl.kept.get(x.n);
    if (!k) { stats[sid] = { off: true, why: 'its shot was dropped', part, shot: x.n }; continue; }
    // a retaken shot is its own clip: the screen is tracked on that, not on the part it replaced
    const re = ep.render.parts[part - 1].versions.filter((q) => q.kind === 'shot' && q.shot === x.n && q.state === 'completed' && q.file && !(q.note ?? '').startsWith('[off]')).pop();
    const inF = Math.round((k.a - Math.max(part === 1 ? Math.max(0, opt.trimStart) : 0, pl.st[i])) * rv.fps), lenF = Math.round((k.b - k.a) * rv.fps);
    const f0 = re ? so.f0 ?? inF : Math.max(so.f0 ?? 0, Math.round(k.a * rv.fps)), f1 = re ? so.f1 ?? inF + lenF - 1 : Math.min(so.f1 ?? Infinity, Math.round(k.b * rv.fps) - 1);
    if (f1 - f0 < 2) { stats[sid] = { off: true, why: 'its shot is too short now', part, shot: x.n }; continue; }
    const at = (part === 2 ? p1 : 0) + k.at + (re ? (f0 - inF) / rv.fps : f0 / rv.fps - k.a);
    o.say(`Screen ${id.slice(1)}: laying it on the device`);
    const tag = `${id}-${part}-${x.n}`;
    const video = partFile(ep, part)!;
    const args = { video: epFile(ep, re ? re.file! : video.file!), f0, f1, screen: epFile(ep, ep.screens.find((q) => q.id === id)!.png), out: path.join(dir, 'overlays'), name: tag, preview: epFile(ep, `edit/previews/${tag}.jpg`), motion: so.motion ?? (id === 's3' && !extra ? 'static' : 'track') };
    // The same screen on the same frames is laid once: an edit elsewhere doesn't wait for it again.
    const kf = path.join(dir, 'overlays', tag, 'made.json'), key = JSON.stringify(['2', args.video, fs.statSync(args.video).mtimeMs, f0, f1, fs.statSync(args.screen).mtimeMs, args.motion]);
    let r: any = null;
    try { const was = JSON.parse(fs.readFileSync(kf, 'utf8')); if (was.key === key && (!was.r.ok || fs.existsSync(path.join(dir, 'overlays', tag, `${tag}_000.png`)))) r = was.r; } catch { /* not made yet */ }
    if (!r) { r = await py<any>(id === 's2' ? 'laptop' : 'screen', args, { ...o, minutes: 25, onLine: (t) => o.say(`Screen ${id.slice(1)}: ${t}`) }); fs.mkdirSync(path.dirname(kf), { recursive: true }); fs.writeFileSync(kf, JSON.stringify({ key, r })); }
    stats[sid] = { ...r, shot: x.n, part, f0, f1 };
    if (r.ok) { if (!extra) wake[id] = at + (Number(r.first) || 0) / rv.fps; ov.push({ name: tag, at }); previews.push(`edit/previews/${tag}.jpg`); }
  }

  // ---- captions ----
  o.say('Writing the captions');
  const caps: Word[] = [], stops: number[] = [];
  for (const part of [1, 2]) for (const [a, b, w, n] of captionWords(ep, part)) {
    let x = J(part, a);
    const i = s.parts[part - 1].shots.findIndex((q) => q.n === n), pl = P[part - 1];
    const own = i >= 0 ? J(part, pl.st[i]) : null, stop = own === null ? null : own + ((pl.st[i + 1] ?? pl.end) - pl.st[i]);
    // Whisper starts some words a little early, over the cut before: they wait for their own speaker. Nothing runs past its shot.
    if (x === null && i >= 0 && pl.st[i] - a > 0 && pl.st[i] - a < 0.55) x = own;
    if (x === null) continue;
    let y = x + (b - a);
    if (own !== null && x < own && own - x < 0.55) { x = own + 0.01; y = Math.max(y, own + 0.2); }
    if (stop !== null && x < stop - 0.12 && y > stop) y = stop - 0.01;
    caps.push([x, Math.min(y, part === 1 ? p1 - 0.01 : END), w]);
    // nothing is still shown when the shot it belongs to has ended
    const hit = pl.st.findIndex((s0, q) => J(part, s0) !== null && x! >= J(part, s0)! - 0.001 && x! < J(part, s0)! + ((pl.st[q + 1] ?? pl.end) - s0)), kp = hit >= 0 ? pl.kept.get(pl.shots[hit].n) : null;
    stops.push(kp ? (part === 2 ? p1 : 0) + kp.at + (kp.b - kp.a) - 0.005 : END);
  }
  const order = caps.map((_, i) => i).sort((a, b) => caps[a][0] - caps[b][0]), caps0 = order.map((i) => caps[i]), stops0 = order.map((i) => stops[i]);
  caps.splice(0, caps.length, ...caps0);
  for (let i = 1; i < caps.length; i++) if (caps[i][0] < caps[i - 1][0] + 0.12) { caps[i][0] = caps[i - 1][0] + 0.12; caps[i][1] = Math.max(caps[i][1], caps[i][0] + 0.12); }
  const ev = caps.map(([a, b, w], i) => {
    const nx = caps[i + 1]?.[0];
    let end = nx !== undefined && nx - b < 0.4 ? nx - 0.01 : b + 0.15;
    end = Math.max(end, a + 0.12); if (nx !== undefined) end = Math.min(end, nx - 0.01);
    if (stops0[i] > a + 0.05) end = Math.min(end, stops0[i]);
    return end > a ? `Dialogue: 0,${ts(a)},${ts(end)},Word,,0,0,0,,{\\pos(540,1000)}${digits(w).toUpperCase().replace(/^[,.?!;:"“”]+|[,.?!;:"“”]+$/g, '').replace(/[{}\\\n]/g, '')}` : '';
  }).filter(Boolean);
  fs.writeFileSync(path.join(dir, 'captions.ass'), `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Word,${FONT_NAME()},84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,4,3,5,60,60,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${ev.join('\n')}\n`);

  // ---- clock ----
  const secs = (c: string) => c.split(':').reduce((a, x) => a * 60 + Number(x), 0);
  const font = FONT_FILE().replace(/\\/g, '/').replace(/:/g, '\\\\:');
  const clock = (S0: number, t0: number, t1: number, color: string, tick: boolean, flash: 'none' | 'jump' | 'pulse') => {
    const base = `between(t,${t0.toFixed(3)},${t1.toFixed(3)})`;
    const en = flash === 'jump' ? `${base}*if(lt(t-${t0.toFixed(3)},1),lt(mod(t-${t0.toFixed(3)},0.5),0.25),1)` : flash === 'pulse' ? `${base}*lt(mod(t-${t0.toFixed(3)},0.4),0.25)` : base;
    const S = tick ? `(${S0}-(t-${t0.toFixed(3)}))` : String(S0);
    const part = (x: string) => `%{eif\\:${x}\\:d\\:2}`;
    return `drawtext=fontfile='${font}':text='${part(`floor(${S}/3600)`)}\\:${part(`mod(floor(${S}/60)\\,60)`)}\\:${part(`mod(floor(${S})\\,60)`)}':fontsize=66:fontcolor=${color}:borderw=6:bordercolor=black@0.85:x=(w-tw)/2:y=170:enable='${en}'`;
  };
  const jumps: { at: number; v: number }[] = [];
  s.parts[0].shots.forEach((x, i) => { if (x.clock && /^\d\d:\d\d:\d\d$/.test(x.clock)) { const at = i ? J(1, P[0].st[i]) : 0; if (at !== null) jumps.push({ at: Math.max(0, at - 0.5 / 24), v: secs(x.clock) }); } });
  if (!jumps.length || jumps[0].at > 0.05) jumps.unshift({ at: 0, v: 86400 });
  const v: string[] = ['ass=captions.ass'];
  jumps.forEach((j, i) => v.push(clock(j.v, j.at, i + 1 < jumps.length ? jumps[i + 1].at : p1, '0xFF3B30', true, i === 0 ? 'none' : i === jumps.length - 1 ? 'pulse' : 'jump')));
  const s4i = s.parts[1].shots.findIndex((x) => x.screen === 's4'), tipI = s.parts[1].shots.findIndex((x) => x.line && alike(x.line, s.tip) >= 0.5);
  const tg0 = s4i >= 0 ? wake.s4 ?? J(2, P[1].st[s4i]) : null, tg1 = s4i >= 0 ? J(2, P[1].st[s4i + 1] ?? P[1].end - 0.05) : null;
  const tipEnd = J(2, P[1].st[(tipI >= 0 ? tipI : 3) + 1] ?? 9) ?? p1 + 10;
  v.push(clock(0, p1, tg0 ?? tipEnd, '0x33FF66', false, 'none'));
  if (tg1 !== null && tg1 < tipEnd) v.push(clock(0, tg1, tipEnd, '0x33FF66', false, 'none'));

  // ---- sound ----
  const ins: string[] = ['-i', 'joined.mov', '-i', path.join(seriesDir(), sr.theme)];
  const s1 = s.parts[0].shots.findIndex((x) => x.screen === 's1'), s3 = s.parts[0].shots.findIndex((x) => x.screen === 's3');
  const sfx: [string, number, number][] = [];
  const add = (n: string, at: number | null, db: number) => { if (at !== null && at >= 0 && at < END && fs.existsSync(path.join(seriesDir(), 'sfx', `${n}.mp3`))) sfx.push([n, at, db]); };
  if (s1 >= 0) add('ding', (wake.s1 ?? J(1, P[0].st[s1]) ?? -1) + 0.05, -10);
  jumps.slice(1).forEach((j) => add('whoosh', j.at - 0.06, -6));
  if (s3 >= 0) { const t = J(1, P[0].st[s3]); if (t !== null) { add('riser', t - 1.34, -12); add('ding', t + 0.5, -8); } }
  add('impact', p1 - 0.02, -2);
  if (tg0 !== null) add('ding', tg0 + 0.05, -8);
  for (const [n] of sfx) ins.push('-i', path.join(seriesDir(), 'sfx', `${n}.mp3`));
  const a = ['[0:a]aresample=48000,asplit=2[dia][sc]', `[1:a]aresample=48000,atrim=0:${END.toFixed(3)},asetpts=PTS-STARTPTS,equalizer=f=1800:t=q:w=1:g=3,afade=t=in:d=0.2,afade=t=out:st=${(END - 1).toFixed(3)}:d=1.0,volume=${opt.musicDb}dB[mus]`, '[mus][sc]sidechaincompress=threshold=0.02:ratio=10:attack=10:release=400[duck]'];
  const labels = ['[dia]', '[duck]'];
  sfx.forEach(([, at, db], i) => { a.push(`[${2 + i}:a]aresample=48000,volume=${db}dB,adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)}[s${i}]`); labels.push(`[s${i}]`); });
  a.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=first[mixr]`, `[mixr]atrim=0:${END.toFixed(3)},asetpts=PTS-STARTPTS,alimiter=limit=0.7:attack=3:release=60:level=disabled[mix]`);

  // ---- picture ----
  const lift = (opt.brighten ?? []).map((d) => { const pl = P[d.part - 1], i = pl.shots.findIndex((x) => x.n === d.shot), a = i >= 0 ? J(d.part, pl.st[i]) : null; return a === null ? '' : `between(t,${(a - 0.5 / 24).toFixed(4)},${(a + (pl.st[i + 1] ?? pl.end) - pl.st[i] - 0.5 / 24).toFixed(4)})`; }).filter(Boolean).join('+');
  const n0 = 2 + sfx.length, vc = [`[0:v]scale=1080:1920:flags=lanczos,setsar=1${lift ? `,eq=gamma=1.14:contrast=1.08:saturation=1.25:enable='${lift}'` : ''}[v0]`];
  let last = 'v0';
  ov.forEach((x, k) => {
    ins.push('-framerate', '24', '-i', `overlays/${x.name}/${x.name}_%03d.png`);
    vc.push(`[${n0 + k}:v]format=rgba,setpts=PTS-STARTPTS+${(x.at + 0.5 / 24).toFixed(4)}/TB[o${k}]`, `[${last}][o${k}]overlay=0:0:eof_action=pass[v${k + 1}]`); last = `v${k + 1}`;
  });
  vc.push(`color=c=white:s=1080x1920:r=24:d=${END.toFixed(3)},format=rgba,fade=t=in:st=${(p1 - 0.25).toFixed(3)}:d=0.25:alpha=1,fade=t=out:st=${p1.toFixed(3)}:d=0.5:alpha=1,colorchannelmixer=aa=0.6[dip]`, `[${last}][dip]overlay=0:0:eof_action=pass[vd]`, `[vd]${v.join(',')}[v]`);
  fs.writeFileSync(path.join(dir, 'pass1.txt'), `${a.join(';\n')};\n[mix]loudnorm=I=-14:TP=-1.5:LRA=9:print_format=json[a]`);
  o.say('Mixing the sound (1 of 2)');
  const m1 = await ffmpeg([...ins, '-/filter_complex', 'pass1.txt', '-map', '[a]', '-f', 'null', '-'], { ...o, cwd: dir });
  const m = JSON.parse(/\{[^{}]*"input_i"[^{}]*\}/.exec(m1.err)?.[0] ?? '{}');
  if (!m.input_i) throw new ReelError('The sound couldn’t be measured.');
  fs.writeFileSync(path.join(dir, 'final.txt'), `${vc.join(';\n')};\n${a.join(';\n')};\n[mix]loudnorm=I=-14:TP=-1.5:LRA=9:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000[a]`);
  const version = ep.edit.version + 1, rel = `edit/ep${String(ep.num).padStart(2, '0')}-final-v${version}.mp4`;
  o.say('Rendering the cut');
  await ffmpeg([...ins, '-/filter_complex', 'final.txt', '-map', '[v]', '-map', '[a]', '-t', END.toFixed(3), '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', path.basename(rel)], { ...o, cwd: dir, minutes: 40 });
  o.say('Checking the cut');
  const L = await loudness(epFile(ep, rel)), pr = await probe(epFile(ep, rel));
  const checks: Check[] = [
    { id: 'len', label: 'Length 52 to 60 seconds', ok: pr.seconds >= 51.5 && pr.seconds <= 60.6, level: 'should', detail: `${pr.seconds.toFixed(1)} s` },
    { id: 'lufs', label: 'Loudness -14 LUFS (±0.5)', ok: Math.abs(L.lufs + 14) <= 0.5, level: 'must', detail: `${L.lufs} LUFS` },
    { id: 'peak', label: 'True peak at or below -1.0 dB', ok: L.peak <= -1.0, level: 'must', detail: `${L.peak} dBFS` },
    { id: 'size', label: '1080 × 1920', ok: pr.width === 1080 && pr.height === 1920, level: 'must', detail: `${pr.width}×${pr.height}` },
    ...Object.entries(stats).map(([id, x]) => ({ id: `scr-${id}`, label: `${ep.screens.find((q) => q.id === id.split('@')[0])?.title ?? id}${id.includes('@') ? `, also on Part ${x.part} shot ${x.shot}` : ''}`, ok: !!x.ok && (x.good === undefined || x.good >= ((x.last ?? x.frames - 1) - (x.first ?? 0) + 1) * 0.7), level: 'should' as const, detail: x.off ? x.why ?? 'switched off' : x.ok ? `${x.good} of ${x.last !== undefined ? x.last - x.first + 1 : x.frames} frames fitted${x.first > 2 ? `; it lights up ${(x.first / 24).toFixed(1)} s into the shot` : ''}` : x.why })),
    { id: 'capn', label: 'Captions', ok: ev.length > 60, level: 'should', detail: `${ev.length} words` },
  ];
  // Each part as it is cut now (retakes in, dropped shots out), for its card.
  const partFiles: string[] = [];
  for (const part of [1, 2]) { const f = `edit/part${part}-v${version}.mp4`; await ffmpeg(['-i', `p${part}.mov`, '-vf', 'scale=720:1280:flags=lanczos', '-c:v', 'libx264', '-crf', '21', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', path.basename(f)], { ...o, cwd: dir }); partFiles.push(f); }
  return { final: rel, seconds: pr.seconds, lufs: L.lufs, peak: L.peak, version, checks, screenStats: stats, previews, partFiles, studioSig: undefined };
}

/** Full-size clean frames for the cover, with a numbered sheet of more to choose from. */
export async function coverScan(ep: Episode, o: RunOpts): Promise<{ sheet: string; times: number[] }> {
  const file = epFile(ep, 'edit/joined.mov');
  const r = await py<{ frames: number[]; fps: number }>('sheet', { file, out: epFile(ep, 'covers/scan.jpg'), count: 48, cols: 8 }, o);
  return { sheet: 'covers/scan.jpg', times: r.frames.map((f) => f / r.fps) };
}
export async function coverStills(ep: Episode, times: number[], o: RunOpts): Promise<{ t: number; file: string }[]> {
  const list = times.map((t) => [Math.round(t * 1000) / 1000, `c-${t.toFixed(2)}.jpg`] as [number, string]);
  const r = await py<{ stills: [number, string, boolean][] }>('stills', { file: epFile(ep, 'edit/joined.mov'), out: epFile(ep, 'covers'), times: list }, o);
  return r.stills.filter((x) => x[2]).map(([t, n]) => ({ t, file: `covers/${n}` }));
}
