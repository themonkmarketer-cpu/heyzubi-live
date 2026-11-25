// ffmpeg and the Python worker (server/box/reels.py): words, cuts, contact sheets, screen compositing. One heavy job at a time.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, ReelError } from './store.js';

const PY = () => process.env.HQ_REELS_PY || '/opt/data/home/.cache/watch/whisperx-venv/bin/python';
const HF = () => process.env.HQ_REELS_HF || '/opt/data/home/.cache/huggingface';
const SCRIPT = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '../../box/reels.py');
export const CHROME = () => process.env.HQ_REELS_CHROME || '/usr/bin/chromium';
/** The heavy sans used for captions and the clock. */
export const FONT_FILE = () => process.env.HQ_REELS_FONT || '/usr/share/fonts/opentype/inter/Inter-Black.otf';
export const FONT_NAME = () => process.env.HQ_REELS_FONT_NAME || 'Inter Black';

let chain: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const p = chain.then(job, job);
  chain = p.catch(() => {});
  return p;
}

export interface RunOpts { cwd?: string; signal?: AbortSignal; minutes?: number; onLine?: (line: string) => void; env?: NodeJS.ProcessEnv }
function run(cmd: string, args: string[], o: RunOpts = {}): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', line = '', done = false;
    const stop = (why: string) => { if (!done) { done = true; child.kill('SIGKILL'); reject(new ReelError(why)); } };
    const t = setTimeout(() => stop(`${path.basename(cmd)} took longer than ${o.minutes ?? 20} minutes.`), (o.minutes ?? 20) * 60_000);
    o.signal?.addEventListener('abort', () => stop('Stopped by you.'), { once: true });
    child.stdout.on('data', (d) => { const s = String(d); if (out.length < 8e6) out += s; line += s; for (let i = line.indexOf('\n'); i >= 0; i = line.indexOf('\n')) { o.onLine?.(line.slice(0, i)); line = line.slice(i + 1); } });
    child.stderr.on('data', (d) => { err = (err + String(d)).slice(-60_000); });
    child.on('error', (e) => { clearTimeout(t); if (!done) { done = true; reject(new ReelError(`${path.basename(cmd)} isn’t available here (${e.message}).`)); } });
    child.on('close', (code) => { clearTimeout(t); if (done) return; done = true; if (code === 0) resolve({ out, err }); else reject(new ReelError(`${path.basename(cmd)} stopped: ${err.trim().split('\n').slice(-3).join(' ').slice(-400) || `code ${code}`}`)); });
  });
}
export const ffmpeg = (args: string[], o: RunOpts = {}) => oneAtATime(() => run('ffmpeg', ['-hide_banner', '-y', ...args], o));
export async function py<T>(cmd: string, args: Record<string, unknown>, o: RunOpts = {}): Promise<T> {
  const { out } = await oneAtATime(() => run(PY(), [SCRIPT, cmd, JSON.stringify(args)], { ...o, env: { HF_HOME: HF(), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '6' }, onLine: (l) => { if (l.startsWith('@') && !l.startsWith('@@')) o.onLine?.(l.slice(1).trim()); } }));
  const i = out.lastIndexOf('@@JSON ');
  if (i < 0) throw new ReelError('The media worker gave no answer.');
  return JSON.parse(out.slice(i + 7)) as T;
}

// Stills for the storyboard: small and quick, so they don't wait behind a render's heavy jobs.
let grabbing = 0;
const waiting: (() => void)[] = [];
export async function grab(file: string, t: number, out: string, width = 360): Promise<void> {
  if (grabbing >= 3) await new Promise<void>((r) => waiting.push(r));
  grabbing++;
  ensureDir(out);
  const tmp = `${out}.${process.pid}-${Math.round(Math.random() * 1e6)}.jpg`;
  try {
    await new Promise<void>((res, rej) => execFile('ffmpeg', ['-v', 'error', '-y', '-ss', Math.max(0, t).toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', tmp], { timeout: 30_000 }, (e) => (e ? rej(new ReelError('That still couldn’t be taken.')) : res())));
    fs.renameSync(tmp, out);
  } finally { grabbing--; waiting.shift()?.(); }
}

export function probe(file: string): Promise<{ seconds: number; width: number; height: number; fps: number; frames: number }> {
  return new Promise((resolve, reject) => execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate,nb_frames', '-of', 'json', file], { timeout: 60_000 }, (e, out) => {
    if (e) return reject(new ReelError(`${path.basename(file)} couldn’t be read as media.`));
    const j = JSON.parse(out), v = (j.streams ?? []).find((s: any) => s.codec_type === 'video') ?? {};
    const [a, b] = String(v.r_frame_rate ?? '24/1').split('/').map(Number);
    resolve({ seconds: Number(j.format?.duration) || 0, width: v.width ?? 0, height: v.height ?? 0, fps: b ? a / b : 24, frames: Number(v.nb_frames) || 0 });
  }));
}

export async function loudness(file: string): Promise<{ lufs: number; peak: number }> {
  const { err } = await oneAtATime(() => run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'], { minutes: 5 }));
  const s = err.slice(err.lastIndexOf('Summary:'));
  return { lufs: Number(/I:\s+(-?[\d.]+) LUFS/.exec(s)?.[1] ?? NaN), peak: Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(s)?.[1] ?? NaN) };
}
/** A page drawn to a picture. The page is ours (built from escaped text), opened from a file with no network. */
export async function shoot(html: string, png: string, w: number, h: number) {
  ensureDir(png);
  const profile = fs.mkdtempSync(path.join(path.dirname(png), '.chrome-'));
  try {
    await oneAtATime(() => run(CHROME(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--host-resolver-rules=MAP * ~NOTFOUND', `--user-data-dir=${profile}`, '--force-device-scale-factor=1', `--window-size=${w},${h}`, `--screenshot=${png}`, `file://${html.replace(/\\/g, '/')}`], { minutes: 2 }));
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
  if (!fs.existsSync(png)) throw new ReelError('A screen couldn’t be drawn.');
}
