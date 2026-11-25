// The HyperFrames editor for an episode. The cut lives as a HyperFrames project (studio/epNN/index.html): every shot is a
// clip on one line, captions, the clock and the white flash follow the shots wherever they go (assets/overlay.js), the
// theme and the sounds are their own clips. The owner edits it in HyperFrames itself (shown inside the app, see
// studio-proxy.ts); "make the cut" renders the picture with HyperFrames and mixes the series' sound around it.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { env } from '../env.js';
import { alike } from './checks.js';
import { captionWords, digits, partFile } from './edit.js';
import { ffmpeg, FONT_FILE, loudness, probe, py, type RunOpts } from './media.js';
import { ensureDir, epFile, ReelError, series, seriesDir } from './store.js';
import type { Check, Episode, RenderVersion } from './types.js';

type Opts = RunOpts & { say: (t: string) => void };
const ROOT = () => process.env.HQ_HYPERFRAMES || path.join(path.dirname(env.dbPath), 'hyperframes');
const CLI = () => path.join(ROOT(), 'node_modules', 'hyperframes', 'dist', 'cli.js');
/** The address the editor is shown on: an origin of its own, so its code can't use the app's sign-in. Unset = no editor. */
export const editorOrigin = () => { const o = (process.env.HQ_EDITOR_ORIGIN ?? '').trim().replace(/\/+$/, ''); return /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(o) ? o : ''; };
/** Off unless HQ_HYPERFRAMES_ON=1: kept for later, the cut is made by the app itself (edit.ts). */
export const studioReady = () => process.env.HQ_HYPERFRAMES_ON === '1' && !!editorOrigin() && fs.existsSync(CLI());
const LOWER = 0.1; // the theme's volume in the editor, where nothing ducks it

export const projectName = (ep: Episode) => `ep${String(ep.num).padStart(2, '0')}`;
export const projectDir = (ep: Episode) => epFile(ep, `studio/${projectName(ep)}`);
const htmlFile = (ep: Episode) => path.join(projectDir(ep), 'index.html');
export const hasProject = (ep: Episode) => fs.existsSync(htmlFile(ep));
const read = (f: string) => fs.readFileSync(f, 'utf8');
function write(f: string, s: string) { if (fs.existsSync(f) && read(f) === s) return; ensureDir(f); fs.writeFileSync(`${f}.tmp`, s); fs.renameSync(`${f}.tmp`, f); }
const R = (n: number) => String(Math.floor(n * 1e4 + 1e-3) / 1e4);
// Shots start and end on hundredths of a second, as the editor itself saves them (rounded down, so never after their first
// frame): neighbours meet exactly, with no sliver of black and no overlap that would put one on another line.
const G = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
const from = (n: number) => String(G(n));
const until = (a: number, b: number) => String(Math.round((G(b) - G(a)) * 100) / 100);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- the page, read and changed tag by tag (HyperFrames writes the same tags) ----------
interface Tag { raw: string; at: number; name: string; a: Record<string, string> }
function tags(html: string, name = 'video|audio'): Tag[] {
  return [...html.matchAll(new RegExp(`<(${name})\\b(?:"[^"]*"|'[^']*'|[^>"'])*>`, 'gi'))].map((m) => ({
    raw: m[0], at: m.index!, name: m[1].toLowerCase(),
    a: Object.fromEntries([...m[0].slice(m[1].length + 1).matchAll(/([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)].map((x) => [x[1].toLowerCase(), x[2] ?? x[3] ?? x[4] ?? ''])),
  }));
}
type Attrs = Record<string, string | null | undefined>;
function setAttrs(raw: string, set: Attrs): string {
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) continue;
    const re = new RegExp(`\\s${k}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>"']+))?(?=[\\s>/])`, 'i');
    if (v === null) raw = raw.replace(re, '');
    else if (re.test(raw)) raw = raw.replace(re, () => ` ${k}="${esc(v)}"`);
    else raw = raw.replace(/\s*\/?>$/, () => ` ${k}="${esc(v)}">`);
  }
  return raw;
}
const num = (v: string | undefined, d = 0) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : d; };
/** Rewrites chosen opening tags: `fn` gives the attributes to set, or null to leave the tag alone. */
function retag(html: string, name: string, fn: (t: Tag) => Attrs | null): string {
  let out = '', last = 0;
  for (const t of tags(html, name)) { const s = fn(t); if (!s) continue; out += html.slice(last, t.at) + setAttrs(t.raw, s); last = t.at + t.raw.length; }
  return out + html.slice(last);
}
export interface Clip { id: string; part: number; shot: number; start: number; dur: number; ms: number; rate: number; vol: number; own: boolean; src: string; hidden: boolean }
/** The shots on the line, in order. */
export function clips(html: string): Clip[] {
  return tags(html, 'video').filter((t) => /^[12]-\d+$/.test(t.a['data-shot'] ?? '')).map((t) => {
    const [part, shot] = t.a['data-shot'].split('-').map(Number);
    return { id: t.a.id ?? '', part, shot, start: num(t.a['data-start']), dur: num(t.a['data-duration']), ms: num(t.a['data-media-start']), rate: num(t.a['data-playback-rate'], 1) || 1, vol: 'muted' in t.a ? 0 : num(t.a['data-volume'], 1), own: t.a['data-take'] === 'own', src: t.a.src ?? '', hidden: t.a['data-hidden'] !== undefined && t.a['data-hidden'] !== 'false' };
  }).sort((a, b) => a.start - b.start);
}

// ---------- what the shots are made of ----------
const takeOf = (ep: Episode, part: number, n: number): RenderVersion | null => ep.render.parts[part - 1].versions.filter((q) => q.kind === 'shot' && q.shot === n && q.state === 'completed' && q.file && !(q.note ?? '').startsWith('[off]')).pop() ?? null;
interface PartInfo { part: number; file: string; st: number[]; end: number; fps: number; shots: { n: number; i: number; a: number; b: number; take: RenderVersion | null }[] }
function partInfo(ep: Episode, part: number): PartInfo {
  const rv = ep.review[part - 1], v = partFile(ep, part);
  if (!rv || !v?.file || !ep.script) throw new ReelError('The editor opens once both parts are rendered and reviewed.');
  const st = rv.shotStarts.map((f) => f / rv.fps), end = rv.frames / rv.fps;
  return { part, file: v.file, st, end, fps: rv.fps, shots: ep.script.parts[part - 1].shots.map((x, i) => ({ n: x.n, i, a: st[i], b: st[i + 1] ?? end, take: takeOf(ep, part, x.n) })) };
}
const stamp = (f: string) => { try { const s = fs.statSync(f); return `${s.size}-${Math.round(s.mtimeMs)}`; } catch { return '-'; } };
interface ScreenStat { ok: boolean; frames: number; good?: number; first?: number; last?: number; why?: string; shot: number; part: number; f0: number; f1: number; off?: boolean; [k: string]: unknown }

/** A part, or a retaken shot, at full size with its screens laid on and its dark shots lifted. Made once per state. */
async function asset(ep: Episode, info: PartInfo, take: { n: number; v: RenderVersion } | null, stats: Record<string, ScreenStat>, o: Opts): Promise<string> {
  const rel = take ? take.v.file! : info.file, src = epFile(ep, rel), s = ep.script!, opt = ep.edit.options, dir = projectDir(ep);
  const mine = info.shots.filter((x) => (take ? x.n === take.n : !x.take));
  const scr = mine.flatMap((x) => {
    const planned = s.parts[info.part - 1].shots[x.i].screen, set = opt.screenOn?.[`${info.part}-${x.n}`], id = set ?? planned, extra = !!id && id !== planned, sc = id ? ep.screens.find((q) => q.id === id) : null;
    if (!id || !sc) return [];
    const so: { on: boolean; f0?: number; f1?: number; motion?: 'track' | 'static' } = extra ? { on: true } : opt.screens[id] ?? { on: true }, sid = extra ? `${id}@${info.part}-${x.n}` : id;
    if (!so.on) { stats[id] = { ok: false, off: true, frames: 0, shot: x.n, part: info.part, f0: 0, f1: 0 }; return []; }
    const len = Math.round((x.b - x.a) * info.fps), from = take ? 0 : Math.round(x.a * info.fps);
    return [{ id, sid, n: x.n, png: epFile(ep, sc.png), f0: Math.max(from, so.f0 ?? from), f1: Math.min(so.f1 ?? Infinity, from + len - 1), motion: so.motion ?? (id === 's3' && !extra ? 'static' : 'track') }];
  });
  const lift = (opt.brighten ?? []).filter((d) => d.part === info.part).flatMap((d) => { const x = mine.find((q) => q.n === d.shot); return x ? [take ? '1' : `between(t,${(x.a - 0.5 / 24).toFixed(4)},${(x.b - 0.5 / 24).toFixed(4)})`] : []; });
  const key = crypto.createHash('sha1').update(JSON.stringify(['2', rel, stamp(src), scr.map((x) => [x.id, stamp(x.png), x.f0, x.f1, x.motion]), lift])).digest('hex').slice(0, 8);
  const name = `assets/${path.basename(rel, path.extname(rel))}-${key}.mp4`, out = path.join(dir, name), side = path.join(dir, '..', 'made', `${path.basename(name)}.json`);
  if (fs.existsSync(out) && fs.existsSync(side)) { Object.assign(stats, JSON.parse(read(side))); return name; }
  const made: Record<string, ScreenStat> = {}, ins = ['-i', src];
  const vc = [`[0:v]fps=24,scale=1080:1920:flags=lanczos,setsar=1${lift.length ? `,eq=gamma=1.14:contrast=1.08:saturation=1.25:enable='${lift.join('+')}'` : ''}[v0]`];
  let k = 0;
  for (const x of scr) {
    if (x.f1 - x.f0 < 2) { made[x.sid] = { ok: false, off: true, why: 'its shot is too short', frames: 0, shot: x.n, part: info.part, f0: x.f0, f1: x.f1 }; continue; }
    o.say(`Screen ${x.id.slice(1)}: laying it on the device`);
    const tag = `${x.id}-${info.part}-${x.n}`, od = epFile(ep, 'studio/made/overlays');
    const r = await py<any>(x.id === 's2' ? 'laptop' : 'screen', { video: src, f0: x.f0, f1: x.f1, screen: x.png, out: od, name: tag, preview: ensureDir(epFile(ep, `edit/previews/${tag}.jpg`)), motion: x.motion }, { ...o, minutes: 25, onLine: (t) => o.say(`Screen ${x.id.slice(1)}: ${t}`) });
    made[x.sid] = { ...r, shot: x.n, part: info.part, f0: x.f0, f1: x.f1 };
    if (!r.ok) continue;
    ins.push('-framerate', '24', '-i', path.join(od, tag, `${tag}_%03d.png`)); k++;
    vc.push(`[${k}:v]format=rgba,setpts=PTS-STARTPTS+${((x.f0 + 0.5) / info.fps).toFixed(4)}/TB[o${k}]`, `[v${k - 1}][o${k}]overlay=0:0:eof_action=pass[v${k}]`);
  }
  o.say(take ? `Preparing the new take of Part ${info.part} shot ${take.n}` : `Preparing Part ${info.part} for the editor`);
  const graph = epFile(ep, 'studio/made/graph.txt');
  write(graph, `${vc.join(';\n')};\n[v${k}]format=yuv420p[v]`);
  ensureDir(out);
  await ffmpeg([...ins, '-/filter_complex', graph, '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-crf', '16', '-preset', 'fast', '-g', '12', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', `${out}.part.mp4`], { ...o, minutes: 20 });
  fs.renameSync(`${out}.part.mp4`, out);
  write(side, JSON.stringify(made));
  Object.assign(stats, made);
  return name;
}

// ---------- captions and clock, timed inside their part ----------
function story(ep: Episode, P: PartInfo[], stats: Record<string, ScreenStat>) {
  const s = ep.script!;
  const parts = P.map((p) => {
    const w = captionWords(ep, p.part).map(([a, b, text, n]) => {
      const x = p.shots.find((q) => q.n === n);
      // A word heard a little before the cut waits for its own speaker, and none runs past its shot.
      if (x) { if (a < x.a && x.a - a < 0.55) { a = x.a + 0.01; b = Math.max(b, a + 0.2); } if (a < x.b - 0.12 && b > x.b) b = x.b - 0.01; }
      return [a, b, text] as [number, number, string];
    }).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < w.length; i++) if (w[i][0] < w[i - 1][0] + 0.12) { w[i][0] = w[i - 1][0] + 0.12; w[i][1] = Math.max(w[i][1], w[i][0] + 0.12); }
    return {
      st: p.shots.map((x) => [x.n, x.a, x.b]),
      words: w.map(([a, b, t], i) => { const nx = w[i + 1]?.[0]; let e = nx !== undefined && nx - b < 0.4 ? nx - 0.01 : b + 0.15; e = Math.max(e, a + 0.12); if (nx !== undefined) e = Math.min(e, nx - 0.01); const own = p.shots.find((q) => a >= q.a && a < q.b); if (own) e = Math.min(e, own.b - 0.005); return [Number(a.toFixed(3)), Number(e.toFixed(3)), digits(t).toUpperCase().replace(/^[,.?!;:"“”]+|[,.?!;:"“”]+$/g, '')]; }).filter((x) => (x[1] as number) > (x[0] as number) && x[2]),
    };
  });
  const secs = (c: string) => c.split(':').reduce((a, x) => a * 60 + Number(x), 0);
  const jumps = s.parts[0].shots.filter((x) => x.clock && /^\d\d:\d\d:\d\d$/.test(x.clock)).map((x) => [x.n, secs(x.clock!)]);
  if (!jumps.length || jumps[0][0] !== s.parts[0].shots[0].n) jumps.unshift([s.parts[0].shots[0].n, 86400]);
  const p2 = s.parts[1].shots, s4 = p2.find((x) => x.screen === 's4'), tip = p2.findIndex((x) => x.line && alike(x.line, s.tip) >= 0.5);
  return { parts, jumps, zero: { until: p2[tip >= 0 ? tip : 3]?.n ?? p2[p2.length - 1].n, hide: s4?.n ?? null, wake: s4 ? (Number(stats.s4?.first) || 0) / 24 : 0 } };
}

const OVERLAY = `// Captions, the countdown and the white flash, drawn from where the shots are right now: move, trim or drop a shot and
// they follow. Written by the app; changed only there.
(function () {
  var S = window.STORY, root = document.getElementById('root');
  function n(el, k, d) { var v = parseFloat(el.getAttribute(k)); return isFinite(v) ? v : d; }
  function shots() {
    return Array.prototype.slice.call(document.querySelectorAll('video[data-shot]')).filter(function (v) { var h = v.getAttribute('data-hidden'); return h === null || h === 'false'; }).map(function (v) {
      var q = v.getAttribute('data-shot').split('-');
      return { part: +q[0], shot: +q[1], start: n(v, 'data-start', 0), dur: n(v, 'data-duration', 0), ms: n(v, 'data-media-start', 0), rate: n(v, 'data-playback-rate', 1) || 1, own: v.getAttribute('data-take') === 'own' };
    }).sort(function (a, b) { return a.start - b.start; });
  }
  function put(id, text, color) { var el = document.getElementById(id); if (!el) return; var sp = el.querySelector('span') || el; if (sp.textContent !== text) sp.textContent = text; if (color) sp.style.color = color; }
  function two(x) { return (x < 10 ? '0' : '') + x; }
  function hms(v) { v = Math.max(0, Math.floor(v)); return two(Math.floor(v / 3600)) + ':' + two(Math.floor(v / 60) % 60) + ':' + two(v % 60); }
  function draw(t) {
    var L = shots(), cur = null, i, j;
    for (i = 0; i < L.length; i++) if (t >= L[i].start - 1e-4 && t < L[i].start + L[i].dur - 1e-4) cur = L[i];
    var word = '';
    if (cur) {
      var P = S.parts[cur.part - 1], x = cur.ms + (t - cur.start) * cur.rate;
      if (cur.own) for (i = 0; i < P.st.length; i++) if (P.st[i][0] === cur.shot) x += P.st[i][1];
      for (i = 0; i < P.words.length; i++) if (x >= P.words[i][0] && x < P.words[i][1]) word = P.words[i][2];
    }
    put('captions', word);
    var first2 = null, end1 = 0;
    for (i = 0; i < L.length; i++) if (L[i].part === 2) { first2 = L[i].start; break; } else end1 = L[i].start + L[i].dur;
    root.style.setProperty('--flash', first2 === null ? 0 : t >= first2 - 0.25 && t < first2 ? 0.6 * (t - first2 + 0.25) / 0.25 : t >= first2 && t < first2 + 0.5 ? 0.6 * (1 - (t - first2) / 0.5) : 0);
    var text = '', color = '#FF3B30';
    if (first2 === null || t < first2) {
      var J = [];
      for (j = 0; j < S.jumps.length; j++) {
        var at = null;
        for (i = 0; i < L.length; i++) if (L[i].part === 1 && L[i].shot >= S.jumps[j][0]) { at = L[i].start; break; }
        if (j === 0) at = 0;
        if (at !== null) J.push([at, S.jumps[j][1]]);
      }
      for (j = J.length - 1; j >= 0; j--) if (t >= J[j][0] - 0.5 / 24) break;
      if (j < 0) j = 0;
      if (J.length) {
        var d = Math.max(0, t - J[j][0]), on = true;
        if (j > 0 && j === J.length - 1) on = (d % 0.4) < 0.25; else if (j > 0 && d < 1) on = (d % 0.5) < 0.25;
        text = on ? hms(J[j][1] - d) : '';
      }
    } else {
      color = '#33FF66';
      var until = null, h0 = null, h1 = null;
      for (i = 0; i < L.length; i++) if (L[i].part === 2) {
        if (L[i].shot <= S.zero.until) until = L[i].start + L[i].dur;
        if (S.zero.hide !== null && L[i].shot === S.zero.hide) { if (h0 === null) h0 = L[i].start + S.zero.wake; h1 = L[i].start + L[i].dur; }
      }
      if (until !== null && t < until && !(h0 !== null && t >= h0 && t < h1)) text = '00:00:00';
    }
    put('clock', text, color);
  }
  var D = n(root, 'data-duration', 60) + 120;
  gsap.registerPlugin({ name: 'story', init: function () { return true; }, render: function (ratio) { draw(ratio * D); } });
  window.storyTimeline = gsap.timeline({ paused: true }).to({ t: 0 }, { story: 1, duration: D, ease: 'none' }, 0);
  draw(0);
})();
`;

// ---------- making and refreshing the project ----------
interface Made { P: PartInfo[]; src: Map<string, { src: string; own: boolean; a: number; b: number }>; stats: Record<string, ScreenStat> }
async function materials(ep: Episode, o: Opts): Promise<Made> {
  const P = [partInfo(ep, 1), partInfo(ep, 2)], stats: Record<string, ScreenStat> = {}, src: Made['src'] = new Map();
  for (const p of P) {
    const main = await asset(ep, p, null, stats, o);
    for (const x of p.shots) src.set(`${p.part}-${x.n}`, x.take ? { src: await asset(ep, p, { n: x.n, v: x.take }, stats, o), own: true, a: 0, b: x.b - x.a } : { src: main, own: false, a: x.a, b: x.b });
  }
  const dir = projectDir(ep), copy = (from: string, rel: string) => { const to = path.join(dir, rel); if (!fs.existsSync(to)) { ensureDir(to); fs.copyFileSync(from, to); } };
  copy(path.join(seriesDir(), series().theme), 'assets/theme.mp3');
  for (const n of ['ding', 'whoosh', 'riser', 'impact']) { const f = path.join(seriesDir(), 'sfx', `${n}.mp3`); if (fs.existsSync(f)) copy(f, `assets/${n}.mp3`); }
  copy(FONT_FILE(), `assets/fonts/captions${path.extname(FONT_FILE())}`);
  const gs = path.join(ROOT(), 'node_modules', 'hyperframes', 'dist', 'vendor', 'npm');
  const gv = fs.existsSync(gs) ? fs.readdirSync(gs).filter((x) => x.startsWith('gsap@')).sort().pop() : null;
  if (gv) copy(path.join(gs, gv, 'dist', 'gsap.min.js'), 'assets/gsap.min.js');
  write(path.join(dir, 'assets/story.js'), `window.STORY = ${JSON.stringify(story(ep, P, stats)).replace(/</g, '\\u003c')};\n`);
  write(path.join(dir, 'assets/overlay.js'), OVERLAY);
  write(path.join(dir, 'hyperframes.json'), JSON.stringify({ name: projectName(ep) }, null, 2));
  return { P, src, stats };
}
const nameOf = (ep: Episode, key?: string) => ep.cast.find((c) => c.key === key)?.name ?? (key ? key[0].toUpperCase() + key.slice(1) : '');

/** The automatic cut as a fresh project. */
function compose(ep: Episode, m: Made): string {
  const s = ep.script!, o = ep.edit.options, shots: string[] = [], at = new Map<string, number>();
  let t = 0;
  for (const p of m.P) for (const x of p.shots) {
    const k = `${p.part}-${x.n}`, q = m.src.get(k)!, tr = o.trims?.find((d) => d.part === p.part && d.shot === x.n), sh = s.parts[p.part - 1].shots[x.i];
    if (o.dropShots.some((d) => d.part === p.part && d.shot === x.n)) continue;
    const lead = p.part === 1 && x.i === 0 ? Math.max(0, o.trimStart) : 0, tail = p.part === 2 && x.i === p.shots.length - 1 ? Math.max(0, o.trimEnd) : 0;
    const full = q.b - q.a, a = Math.min(full - 0.3, Math.max(lead, tr?.in ?? 0)), len = Math.max(0.3, full - Math.max(0, a) - Math.max(tail, tr?.out ?? 0));
    shots.push(shotTag(p.part, x.n, t, len, q.a + Math.max(0, a), q, sh.line ? nameOf(ep, sh.speaker) : sh.screen ? 'Screen' : 'Silent'));
    at.set(k, t); t += len;
  }
  const end = t, p2 = [...at.entries()].find(([k]) => k.startsWith('2-'))?.[1] ?? end;
  const snd: string[] = [];
  const add = (n: string, anchor: string | null, off: number, db: number, label: string) => {
    if (!anchor || !at.has(anchor) || !fs.existsSync(path.join(projectDir(ep), `assets/${n}.mp3`))) return;
    const st = at.get(anchor)! + off;
    if (st >= 0 && st < end) snd.push(`<audio id="snd${snd.length + 1}" class="clip" data-label="${label}" src="assets/${n}.mp3" data-start="${R(st)}" data-duration="${R(Math.min(soundLength(ep, n), end - st))}" data-track-index="${12 + (snd.length % 2)}" data-volume="${R(10 ** (db / 20))}" data-anchor="${anchor}" data-off="${R(off)}" data-set="${R(st)}"></audio>`);
  };
  const sid = (part: number, id: string) => { const x = s.parts[part - 1].shots.find((q) => q.screen === id); return x ? `${part}-${x.n}` : null; };
  const wake = (id: string) => (Number(m.stats[id]?.first) || 0) / 24;
  add('ding', sid(1, 's1'), wake('s1') + 0.05, -10, 'Ding');
  for (const x of s.parts[0].shots.slice(1)) if (x.clock && /^\d\d:\d\d:\d\d$/.test(x.clock)) add('whoosh', `1-${x.n}`, -0.06 - 0.5 / 24, -6, 'Whoosh');
  add('riser', sid(1, 's3'), -1.34, -12, 'Riser'); add('ding', sid(1, 's3'), 0.5, -8, 'Ding');
  add('impact', [...at.keys()].find((k) => k.startsWith('2-') && at.get(k) === p2) ?? null, -0.02, -2, 'Impact');
  add('ding', sid(2, 's4'), wake('s4') + 0.05, -8, 'Ding');
  const ext = path.extname(FONT_FILE());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(`Episode ${ep.num}: ${ep.title}`)}</title>
<script src="assets/gsap.min.js"></script>
<style>
@font-face { font-family: "Episode Captions"; src: url("assets/fonts/captions${ext}"); font-weight: 900; }
html, body { margin: 0; background: #000; }
#root { position: relative; width: 1080px; height: 1920px; overflow: hidden; background: #000; }
.shot { position: absolute; left: 0; top: 0; width: 1080px; height: 1920px; object-fit: cover; z-index: 1; }
#root::after { content: ""; position: absolute; inset: 0; background: #fff; opacity: var(--flash, 0); z-index: 20; pointer-events: none; }
#clock, #captions { position: absolute; left: 60px; width: 960px; display: flex; align-items: center; justify-content: center; font-family: "Episode Captions", sans-serif; font-weight: 900; white-space: nowrap; color: #fff; text-align: center; paint-order: stroke fill; }
#clock { top: 160px; height: 90px; font-size: 66px; z-index: 30; -webkit-text-stroke: 12px rgba(0,0,0,.85); }
#captions { top: 930px; height: 140px; font-size: 84px; z-index: 40; -webkit-text-stroke: 8px #000; text-shadow: 3px 3px 0 rgba(0,0,0,.5); }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${R(end)}" data-width="1080" data-height="1920">
${shots.join('\n')}
<div id="clock" class="clip" data-label="Clock" data-start="0" data-duration="${R(end)}" data-track-index="2" data-track-kind="graphics" data-layout-allow-overflow><span></span></div>
<div id="captions" class="clip" data-label="Captions (follow the shots)" data-start="0" data-duration="${R(end)}" data-track-index="3" data-track-kind="captions" data-layout-allow-overflow><span></span></div>
<audio id="music" class="clip" data-label="Theme" src="assets/theme.mp3" data-start="0" data-duration="${R(end)}" data-track-index="11" data-volume="${LOWER}"></audio>
${snd.join('\n')}
</div>
<script src="assets/story.js"></script>
<script src="assets/overlay.js"></script>
<script>window.__timelines = window.__timelines || {}; window.__timelines["main"] = window.storyTimeline;</script>
</body>
</html>
`;
}
function shotTag(part: number, n: number, start: number, dur: number, ms: number, q: { src: string; own: boolean }, who: string) {
  return `<video id="p${part}s${n}" class="clip shot" data-label="${esc(`P${part}·${n} ${who}`.trim())}" src="${q.src}" data-start="${from(start)}" data-duration="${until(start, start + dur)}" data-media-start="${R(ms)}" data-track-index="1" data-has-audio="true" data-shot="${part}-${n}"${q.own ? ' data-take="own"' : ''} playsinline></video>`;
}
const lengths = new Map<string, number>();
function soundLength(ep: Episode, n: string): number { return lengths.get(`${ep.id}/${n}`) ?? 1.5; }
async function measureSounds(ep: Episode) { for (const n of ['ding', 'whoosh', 'riser', 'impact']) { const f = path.join(projectDir(ep), `assets/${n}.mp3`); if (fs.existsSync(f)) try { lengths.set(`${ep.id}/${n}`, Math.max(0.3, (await probe(f)).seconds)); } catch { /* keeps the default */ } } }

/** New takes, screens and lifted shots put under the owner's own cut; nothing the owner placed moves. */
function refresh(html: string, m: Made): string {
  return retag(html, 'video', (t) => {
    const q = m.src.get(t.a['data-shot'] ?? ''), p = m.P[Number((t.a['data-shot'] ?? '1').split('-')[0]) - 1];
    if (!q || t.a.src === q.src) return null;
    const was = t.a['data-take'] === 'own', x = p.shots.find((y) => `${p.part}-${y.n}` === t.a['data-shot'])!;
    const local = num(t.a['data-media-start']) - (was ? 0 : x.a);
    return { src: q.src, 'data-media-start': R(Math.max(0, local + (q.own ? 0 : x.a))), 'data-take': q.own ? 'own' : null };
  });
}
/** The ends line up with the last shot, and each sound keeps its place at its shot. */
export function tidy(html: string): string {
  // On the hundredths, and neighbours closed up where a sliver was left between them.
  const grid = new Map<string, { a: number; b: number }>();
  let next = -1, shift = 0;
  for (const c of clips(html)) {
    if (c.hidden) continue;
    const n = Math.max(5, Math.round(c.dur * 100));
    let a = Math.round(c.start * 100) + shift;
    if (next >= 0 && a !== next && Math.abs(a - next) <= 4) { shift += next - a; a = next; }
    grid.set(c.id, { a: a / 100, b: (a + n) / 100 });
    next = a + n;
  }
  html = retag(html, 'video', (t) => {
    const g = t.a['data-shot'] ? grid.get(t.a.id ?? '') : null;
    if (!g || (t.a['data-start'] === from(g.a) && t.a['data-duration'] === until(g.a, g.b))) return null;
    return { 'data-start': from(g.a), 'data-duration': until(g.a, g.b) };
  });
  const L = clips(html).filter((c) => !c.hidden);
  if (!L.length) return html;
  const end = Math.max(...L.map((c) => c.start + c.dur));
  const first = new Map<string, Clip>();
  for (const c of L) { const k = `${c.part}-${c.shot}`; if (!first.has(k)) first.set(k, c); }
  html = retag(html, 'audio', (t) => {
    if (t.a.id === 'music') return { 'data-duration': R(Math.max(0.5, end - num(t.a['data-start']))) };
    const k = t.a['data-anchor'];
    if (!k) return null;
    const at = num(t.a['data-start']), set = num(t.a['data-set'], at);
    if (Math.abs(at - set) > 0.03) { // moved by hand: it belongs to the shot it lies on now
      const on = [...L].reverse().find((c) => at >= c.start - 0.05) ?? L[0];
      return { 'data-anchor': `${on.part}-${on.shot}`, 'data-off': R(at - on.start), 'data-set': R(at) };
    }
    const c = first.get(k);
    if (!c) return null;
    const to = Math.max(0, c.start + num(t.a['data-off']));
    return Math.abs(to - at) < 0.003 ? null : { 'data-start': R(to), 'data-set': R(to) };
  });
  return retag(html, 'div', (t) => (t.a.id === 'root' ? { 'data-duration': R(end) } : t.a.id === 'clock' || t.a.id === 'captions' ? { 'data-start': '0', 'data-duration': R(end) } : null));
}

/** Everything the editor needs, up to date. `fresh` starts over from the automatic cut (the old one is kept beside it). */
export async function prepare(ep: Episode, o: Opts, fresh = false): Promise<Made> {
  const m = await materials(ep, o), f = htmlFile(ep);
  if (fresh && fs.existsSync(f)) { const to = epFile(ep, `studio/before/${Date.now()}.html`); ensureDir(to); fs.copyFileSync(f, to); fs.rmSync(f); }
  if (!fs.existsSync(f)) { await measureSounds(ep); write(f, tidy(compose(ep, m))); }
  else write(f, tidy(refresh(read(f), m)));
  return m;
}
/** What the page shows about the project without touching it. */
export function studioState(ep: Episode) {
  if (!hasProject(ep)) return { ready: studioReady(), made: false };
  const f = htmlFile(ep), html = read(f), L = clips(html).filter((c) => !c.hidden), used = new Set(L.map((c) => `${c.part}-${c.shot}`));
  return {
    ready: studioReady(), made: true, changedAt: Math.round(fs.statSync(f).mtimeMs), seconds: L.length ? Math.max(...L.map((c) => c.start + c.dur)) : 0, shots: L.length,
    clips: L.map((c) => ({ id: c.id, part: c.part, shot: c.shot, start: c.start, dur: c.dur })),
    gone: ep.script ? ep.script.parts.flatMap((p, i) => p.shots.filter((x) => !used.has(`${i + 1}-${x.n}`)).map((x) => ({ part: i + 1, shot: x.n }))) : [],
    sig: currentSig(ep),
  };
}
/** What the cut is made of: changes when anything seen or heard does. */
export const cutSig = (html: string, story = '') => crypto.createHash('sha1').update(html.replace(/\sdata-(hf-id|set)="[^"]*"/g, '').replace(/\s+/g, ' ') + story).digest('hex').slice(0, 12);
export const currentSig = (ep: Episode) => (hasProject(ep) ? cutSig(read(htmlFile(ep)), storyText(ep)) : '');
const storyText = (ep: Episode) => { try { return read(path.join(projectDir(ep), 'assets/story.js')); } catch { return ''; } };

/** Trims, dropped and put-back shots asked for elsewhere (the agent), carried into the owner's cut. */
export function applyCut(ep: Episode, before: Episode['edit']['options']) {
  if (!studioReady() || !hasProject(ep)) return;
  const o = ep.edit.options, f = htmlFile(ep), P = [partInfo(ep, 1), partInfo(ep, 2)];
  let html = read(f), line = clips(html);
  const key = (d: { part: number; shot: number }) => `${d.part}-${d.shot}`, was = new Set(before.dropShots.map(key)), is = new Set(o.dropShots.map(key));
  const order = P.flatMap((p) => p.shots.map((x) => `${p.part}-${x.n}`));
  const trim = (q: typeof o, k: string) => { const t = q.trims?.find((d) => key(d) === k); return { in: Math.max(t?.in ?? 0, k === order[0] ? q.trimStart : 0), out: Math.max(t?.out ?? 0, k === order[order.length - 1] ? q.trimEnd : 0) }; };
  // what each clip becomes: gone, or with new edges
  const gone = new Set<string>(), edge = new Map<string, { ms: number; dur: number }>(), back: string[] = [];
  for (const k of order) {
    const here = line.filter((c) => key(c) === k), p = P[Number(k[0]) - 1], x = p.shots.find((y) => `${p.part}-${y.n}` === k)!;
    if (is.has(k) && !was.has(k)) for (const c of here) gone.add(c.id);
    else if (!is.has(k) && was.has(k) && !here.length) back.push(k);
    const a = trim(before, k), b = trim(o, k);
    if (here.length === 1 && (Math.abs(a.in - b.in) > 0.005 || Math.abs(a.out - b.out) > 0.005)) { const base = here[0].own ? 0 : x.a, full = x.b - x.a, lead = Math.min(full - 0.3, b.in); edge.set(here[0].id, { ms: base + lead, dur: Math.max(0.3, full - lead - b.out) }); }
  }
  if (!gone.size && !edge.size && !back.length) return;
  if (gone.size) for (const id of gone) html = html.replace(new RegExp(`\\s*<video\\b(?=[^>]*\\sid="${id}")(?:"[^"]*"|[^>"])*>\\s*</video>`, 'i'), '');
  for (const k of back) {
    const p = P[Number(k[0]) - 1], x = p.shots.find((y) => `${p.part}-${y.n}` === k)!, sh = ep.script!.parts[p.part - 1].shots[x.i];
    const next = clips(html).find((c) => order.indexOf(key(c)) > order.indexOf(k));
    const tag = shotTag(p.part, x.n, next ? next.start - 0.001 : 9999, x.b - x.a, x.take ? 0 : x.a, { src: '', own: !!x.take }, sh.line ? nameOf(ep, sh.speaker) : 'Silent');
    html = html.replace(/<div\b[^>]*\sid="clock"/, (x) => `${tag}\n${x}`);
  }
  line = clips(html);
  let t = 0;
  const to = new Map<string, { at: number; dur: number }>();
  for (const c of line) { const d = edge.get(c.id)?.dur ?? c.dur; to.set(c.id, { at: t, dur: d }); t += d; }
  html = retag(html, 'video', (q) => { const x = to.get(q.a.id ?? ''); return x && q.a['data-shot'] ? { 'data-start': from(x.at), 'data-duration': until(x.at, x.at + x.dur), ...(edge.has(q.a.id) ? { 'data-media-start': R(edge.get(q.a.id)!.ms) } : {}) } : null; });
  write(f, tidy(html));
  if (back.length) void openStudio(ep, true, false).catch(() => {}); // its picture is put in with the others
}

// ---------- the cut ----------
const childEnv = () => {
  const home = path.join(ROOT(), 'home');
  fs.mkdirSync(home, { recursive: true });
  const shell = (() => { const d = path.join(ROOT(), 'chrome'); try { for (const a of fs.readdirSync(d, { recursive: true }) as string[]) if (/chrome-headless-shell(\.exe)?$/.test(a) && fs.statSync(path.join(d, a)).isFile()) return path.join(d, a); } catch { /* none */ } return process.env.HQ_REELS_CHROME || (process.platform === 'win32' ? '' : '/usr/bin/chromium'); })();
  // Only what it needs: none of the app's keys.
  const keep = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'LANG', 'TZ', 'LOCALAPPDATA', 'ProgramFiles'].filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));
  return { ...keep, HOME: home, USERPROFILE: home, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_SKIP_SKILLS: '1', HYPERFRAMES_NO_OPTIONAL_INSTALL: '1', CI: '1', NO_COLOR: '1', ...(shell ? { HYPERFRAMES_BROWSER_PATH: shell } : {}) } as NodeJS.ProcessEnv;
};
function hf(args: string[], cwd: string, o: Opts, minutes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI(), ...args], { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let out = '', done = false, pct = -1;
    const end = (why: string) => { if (done) return; done = true; try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } reject(new ReelError(why)); };
    const t = setTimeout(() => end(`The render took longer than ${minutes} minutes.`), minutes * 60_000);
    o.signal?.addEventListener('abort', () => end('Stopped by you.'), { once: true });
    const on = (d: Buffer) => { const s = String(d); out = (out + s).slice(-40_000); const m = [...s.matchAll(/(\d{1,3})%/g)].pop(); if (m && Number(m[1]) >= pct + 5) { pct = Number(m[1]); o.say(`Rendering the cut: ${pct}%`); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('error', (e) => { clearTimeout(t); if (!done) { done = true; reject(new ReelError(`HyperFrames couldn’t start (${e.message}).`)); } });
    child.on('close', (code) => { clearTimeout(t); if (done) return; done = true; if (code === 0) resolve(out); else reject(new ReelError(`HyperFrames stopped: ${out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter((l) => l && !/%|^@hf|^\[INFO/.test(l)).slice(-3).join(' ').slice(-400) || `code ${code}`}`)); });
  });
}

/** The owner's cut, rendered: the picture by HyperFrames, the sound mixed as the series does (theme ducked, -14 LUFS). */
export async function buildStudioEdit(ep: Episode, o: Opts): Promise<Partial<Episode['edit']>> {
  const m = await prepare(ep, o), dir = epFile(ep, 'edit'), proj = projectDir(ep), html = read(htmlFile(ep)), sig = currentSig(ep);
  fs.mkdirSync(dir, { recursive: true });
  const L = clips(html).filter((c) => !c.hidden && c.dur > 0.02);
  if (!L.length) throw new ReelError('There are no shots in the editor.');
  const END = Math.max(...L.map((c) => c.start + c.dur));
  o.say('Joining the shots');
  // Clean frames for the cover, and the voices: the shots from their renders, gaps as black.
  const segs: { src: string | null; a: number; len: number; rate: number; vol: number }[] = [];
  let t = 0;
  L.forEach((c, i) => {
    if (c.start - t > 0.02) { segs.push({ src: null, a: 0, len: c.start - t, rate: 1, vol: 0 }); t = c.start; }
    const from = Math.max(0, t - c.start), stop = Math.min(c.start + c.dur, L[i + 1] ? Math.max(c.start, L[i + 1].start) : Infinity), len = stop - c.start - from;
    if (len < 0.02) return;
    segs.push({ src: path.join(proj, c.src), a: c.ms + from * c.rate, len, rate: c.rate, vol: c.vol }); t = stop;
  });
  const ins1 = segs.flatMap((s) => (s.src ? ['-i', s.src] : []));
  let k = -1;
  const g = segs.map((s, i) => {
    if (!s.src) return `color=c=black:s=1080x1920:r=24:d=${s.len.toFixed(4)},format=yuv420p,setsar=1[v${i}];anullsrc=r=48000:cl=stereo,atrim=0:${s.len.toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`;
    k++;
    const tempo = Math.abs(s.rate - 1) > 0.001 ? `,atempo=${Math.min(2, Math.max(0.5, s.rate))}` : '';
    return `[${k}:v]trim=${s.a.toFixed(4)}:${(s.a + s.len * s.rate).toFixed(4)},setpts=(PTS-STARTPTS)/${s.rate},fps=24,format=yuv420p,setsar=1,tpad=stop_mode=clone:stop_duration=1,trim=0:${s.len.toFixed(4)},setpts=PTS-STARTPTS[v${i}];[${k}:a]atrim=${s.a.toFixed(4)}:${(s.a + s.len * s.rate).toFixed(4)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo${tempo},volume=${s.vol},apad=whole_dur=${s.len.toFixed(4)},atrim=0:${s.len.toFixed(4)}[a${i}]`;
  }).join(';\n');
  write(path.join(dir, 'join.txt'), `${g};\n${segs.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segs.length}:v=1:a=1[v][a]`);
  await ffmpeg([...ins1, '-/filter_complex', 'join.txt', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '14', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', 'joined.mov'], { ...o, cwd: dir, minutes: 20 });

  o.say('Rendering the cut');
  const raw = path.join(dir, 'picture.mp4');
  fs.rmSync(raw, { force: true });
  await hf(['render', proj, '--quality', 'looks', '--crf', '19', '--fps', '24', '--output', raw], proj, o, 40);
  if (!fs.existsSync(raw)) throw new ReelError('HyperFrames made no picture.');

  // ---- sound ----
  const ins: string[] = ['-i', 'joined.mov'], opt = ep.edit.options, a: string[] = ['[0:a]aresample=48000,asplit=2[dia][sc]'], labels = ['[dia]'];
  const extra = tags(html).filter((q) => (q.name === 'audio' || (!q.a['data-shot'] && q.a['data-has-audio'] === 'true')) && q.a.src && q.a['data-hidden'] !== 'true' && q.a['data-hidden'] !== '' && !('muted' in q.a));
  for (const q of extra) {
    const file = path.resolve(proj, q.a.src.split(/[?#]/)[0]), at = num(q.a['data-start']), dur = num(q.a['data-duration'], 0), ms = num(q.a['data-media-start']), vol = num(q.a['data-volume'], 1);
    if (!file.startsWith(path.resolve(proj) + path.sep) || !fs.existsSync(file) || at >= END || vol <= 0) continue;
    const i = ins.filter((x) => x === '-i').length, len = Math.min(dur || 600, END - at), fi = num(q.a['data-fade-in']), fo = num(q.a['data-fade-out']);
    ins.push('-i', file);
    const base = `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=${ms.toFixed(3)}:${(ms + len).toFixed(3)},asetpts=PTS-STARTPTS${fi > 0 ? `,afade=t=in:d=${fi}` : ''}${fo > 0 ? `,afade=t=out:st=${Math.max(0, len - fo).toFixed(3)}:d=${fo}` : ''}`;
    const delay = `adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)}`;
    if (q.a.id === 'music') { a.push(`${base},equalizer=f=1800:t=q:w=1:g=3,afade=t=in:d=0.2,afade=t=out:st=${Math.max(0, len - 1).toFixed(3)}:d=1.0,volume=${opt.musicDb}dB,volume=${(vol / LOWER).toFixed(4)},${delay}[mus]`); }
    else { a.push(`${base},volume=${vol},${delay}[x${i}]`); labels.push(`[x${i}]`); }
  }
  if (a.some((x) => x.endsWith('[mus]'))) { a.push('[mus][sc]sidechaincompress=threshold=0.02:ratio=10:attack=10:release=400[duck]'); labels.splice(1, 0, '[duck]'); } else a.push('[sc]anullsink');
  a.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=first[mixr]`, `[mixr]atrim=0:${END.toFixed(3)},asetpts=PTS-STARTPTS,alimiter=limit=0.7:attack=3:release=60:level=disabled[mix]`);
  fs.writeFileSync(path.join(dir, 'pass1.txt'), `${a.join(';\n')};\n[mix]loudnorm=I=-14:TP=-1.5:LRA=9:print_format=json[a]`);
  o.say('Mixing the sound');
  const m1 = await ffmpeg([...ins, '-/filter_complex', 'pass1.txt', '-map', '[a]', '-f', 'null', '-'], { ...o, cwd: dir });
  const q = JSON.parse(/\{[^{}]*"input_i"[^{}]*\}/.exec(m1.err)?.[0] ?? '{}');
  if (!q.input_i) throw new ReelError('The sound couldn’t be measured.');
  fs.writeFileSync(path.join(dir, 'final.txt'), `${a.join(';\n')};\n[mix]loudnorm=I=-14:TP=-1.5:LRA=9:measured_I=${q.input_i}:measured_TP=${q.input_tp}:measured_LRA=${q.input_lra}:measured_thresh=${q.input_thresh}:offset=${q.target_offset}:linear=true,aresample=48000[a]`);
  const version = ep.edit.version + 1, rel = `edit/ep${String(ep.num).padStart(2, '0')}-final-v${version}.mp4`, vi = ins.filter((x) => x === '-i').length;
  await ffmpeg([...ins, '-i', 'picture.mp4', '-/filter_complex', 'final.txt', '-map', `${vi}:v`, '-map', '[a]', '-t', END.toFixed(3), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', path.basename(rel)], { ...o, cwd: dir, minutes: 20 });
  fs.rmSync(raw, { force: true });
  o.say('Checking the cut');
  const Lu = await loudness(epFile(ep, rel)), pr = await probe(epFile(ep, rel)), st = JSON.parse(read(path.join(proj, 'assets/story.js')).replace(/^window\.STORY = |;\s*$/g, ''));
  const words = (st.parts as { words: unknown[] }[]).reduce((n, x) => n + x.words.length, 0), used = new Set(L.map((c) => `${c.part}-${c.shot}`));
  const checks: Check[] = [
    { id: 'len', label: 'Length 52 to 60 seconds', ok: pr.seconds >= 51.5 && pr.seconds <= 60.6, level: 'should', detail: `${pr.seconds.toFixed(1)} s` },
    { id: 'lufs', label: 'Loudness -14 LUFS (±0.5)', ok: Math.abs(Lu.lufs + 14) <= 0.5, level: 'must', detail: `${Lu.lufs} LUFS` },
    { id: 'peak', label: 'True peak at or below -1.0 dB', ok: Lu.peak <= -1.0, level: 'must', detail: `${Lu.peak} dBFS` },
    { id: 'size', label: '1080 × 1920', ok: pr.width === 1080 && pr.height === 1920, level: 'must', detail: `${pr.width}×${pr.height}` },
    { id: 'gaps', label: 'No gaps between shots', ok: segs.every((s) => s.src), level: 'should', detail: segs.every((s) => s.src) ? `${L.length} shots` : `${segs.filter((s) => !s.src).length} black` },
    ...Object.entries(m.stats).map(([id, x]) => ({ id: `scr-${id}`, label: `${ep.screens.find((z) => z.id === id.split('@')[0])?.title ?? id}${id.includes('@') ? `, also on Part ${x.part} shot ${x.shot}` : ''}`, ok: !!x.ok && used.has(`${x.part}-${x.shot}`) && (x.good === undefined || x.good >= ((x.last ?? x.frames - 1) - (x.first ?? 0) + 1) * 0.7), level: 'should' as const, detail: x.off ? x.why ?? 'switched off' : !used.has(`${x.part}-${x.shot}`) ? 'its shot was left out' : x.ok ? `${x.good} of ${x.last !== undefined ? x.last - x.first! + 1 : x.frames} frames fitted${(x.first ?? 0) > 2 ? `; it lights up ${(x.first! / 24).toFixed(1)} s into the shot` : ''}` : String(x.why ?? 'not fitted') })),
    { id: 'capn', label: 'Captions', ok: words > 60, level: 'should', detail: `${words} words` },
  ];
  const previews = fs.existsSync(path.join(dir, 'previews')) ? Object.entries(m.stats).filter(([, x]) => x.ok).map(([id, x]) => `edit/previews/${id.split('@')[0]}-${x.part}-${x.shot}.jpg`).filter((x) => fs.existsSync(epFile(ep, x))) : [];
  return { final: rel, seconds: pr.seconds, lufs: Lu.lufs, peak: Lu.peak, version, checks, screenStats: m.stats, previews, studioSig: sig };
}

/** A shot that was left out, back at its place in the story. */
export function putBack(ep: Episode, part: number, shot: number) { applyCut(ep, { ...ep.edit.options, dropShots: [...ep.edit.options.dropShots, { part, shot }] }); }
const jobs = new Map<string, { note: string; error?: string; done: boolean }>();
/** Gets the project ready (the first time it takes a few minutes) and starts the editor; asked again until it is open. */
export async function openStudio(ep: Episode, again: boolean, fresh: boolean): Promise<{ state: 'open' | 'working' | 'failed'; note?: string; url?: string }> {
  if (!studioReady()) throw new ReelError('The editor isn’t set up on this server.');
  let j = jobs.get(ep.id);
  if (!j || (j.done && (again || j.error))) {
    if (!again && j?.error) return { state: 'failed', note: j.error };
    const job: { note: string; error?: string; done: boolean } = { note: 'Getting the shots ready', done: false };
    j = job;
    jobs.set(ep.id, job);
    void (async () => { await prepare(ep, { say: (t) => { job.note = t; } }, fresh); await studioPort(ep); })().then(() => { job.done = true; }, (e) => { job.done = true; job.error = e instanceof ReelError ? e.message : 'The editor couldn’t be prepared.'; if (!(e instanceof ReelError)) console.warn('[reels] editor:', e); });
    await Promise.race([new Promise((r) => setTimeout(r, 4000)), (async () => { while (!job.done) await new Promise((r) => setTimeout(r, 100)); })()]);
  }
  if (j.error) return { state: 'failed', note: j.error };
  if (!j.done) return { state: 'working', note: j.note };
  return { state: 'open', url: `${editorOrigin()}/?ep=${projectName(ep)}` };
}

// ---------- the running editors ----------
interface Running { port: number; child: ChildProcess; used: number; open: number; up: Promise<void> }
const live = new Map<string, Running>();
const freePort = () => new Promise<number>((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
function kill(name: string) { const r = live.get(name); if (!r) return; live.delete(name); try { if (process.platform === 'win32') r.child.kill(); else process.kill(-r.child.pid!, 'SIGTERM'); } catch { /* gone */ } }
export const stopStudio = (ep: Episode) => kill(projectName(ep));
/** The port of an episode's editor, started when needed. It listens on this machine only. */
export async function studioPort(ep: Episode): Promise<number> {
  const name = projectName(ep);
  const had = live.get(name);
  if (had) { had.used = Date.now(); await had.up; return had.port; }
  if (!studioReady() || !hasProject(ep)) throw new ReelError('The editor isn’t ready yet.');
  for (const k of [...live.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, Math.max(0, live.size - 2)).map((x) => x[0])) kill(k);
  const port = await freePort();
  const child = spawn(process.execPath, [CLI(), 'preview', projectDir(ep), '--foreground', '--force-new', '--no-open', '--port', String(port)], { cwd: projectDir(ep), env: { ...childEnv(), HYPERFRAMES_PREVIEW_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let tail = '';
  for (const s of [child.stdout, child.stderr]) s?.on('data', (d) => { tail = (tail + String(d)).slice(-2000); });
  const r: Running = { port, child, used: Date.now(), open: 0, up: Promise.resolve() };
  r.up = (async () => {
    for (let i = 0; i < 120; i++) {
      await new Promise((x) => setTimeout(x, 500));
      if (child.exitCode !== null) break;
      try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch { /* not yet */ }
    }
    kill(name);
    throw new ReelError(`The editor didn’t start: ${tail.trim().split('\n').slice(-2).join(' ').slice(-300)}`);
  })();
  r.up.catch(() => {});
  child.on('exit', () => { if (live.get(name) === r) live.delete(name); });
  live.set(name, r);
  await r.up;
  return port;
}
export function studioUse(name: string, d: 1 | -1 | 0) { const r = live.get(name); if (r) { r.used = Date.now(); r.open = Math.max(0, r.open + d); } }
setInterval(() => { for (const [k, r] of live) if (!r.open && Date.now() - r.used > 25 * 60_000) kill(k); }, 60_000).unref();
process.on('exit', () => { for (const k of live.keys()) kill(k); });
