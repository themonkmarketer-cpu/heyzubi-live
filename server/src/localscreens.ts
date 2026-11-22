import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { env } from './env.js';
import type { OrgoComputer, OrgoScreen } from './orgo.js';

/**
 * Local screens (HQ_SCREENS=local): this machine stands in for the Orgo computer.
 *
 * Every screen is an X display here: Xvfb draws it, xfwm4 manages its windows and x11vnc serves it on
 * 127.0.0.1 for the viewer relay (vnc.ts). Display numbers follow Orgo's: the default screen (the
 * primary bot's) is :99, the others are "screen-100" (:100), "screen-101" (:101) and so on, so the
 * rest of the app (displayFor, cdpPortFor, the box scripts) works unchanged.
 *
 * Nothing here runs a desktop session: the box scripts (server/box/) already draw the wallpaper, dock,
 * home screen and Chrome on a bare display. Processes are found by their command line, so a server
 * restart picks up screens that are still running instead of starting them twice.
 */

const DEFAULT = 99;
const FIRST_EXTRA = 100;
/** VNC port of display :N. Kept away from 5900-6100, where other VNC and X servers usually listen. */
export const vncPortFor = (screenId: string) => 15900 + displayNum(screenId);

const LOGS = '/var/log/hq';

function displayNum(screenId: string): number {
  if (!screenId || screenId === 'default') return DEFAULT;
  const n = Number(screenId.replace('screen-', ''));
  if (!Number.isInteger(n) || n < FIRST_EXTRA || n > FIRST_EXTRA + 50) throw new Error(`not a local screen: ${screenId}`);
  return n;
}

const screenIdFor = (n: number) => (n === DEFAULT ? 'default' : `screen-${n}`);

function size(): { width: number; height: number } {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(env.localScreenSize);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 800 };
}

// ---------------------------------------------------------------- state on disk

const dir = () => env.localScreensDir;
const registryFile = () => path.join(dir(), 'screens.json');
const passFile = () => path.join(dir(), 'vnc.pass');
const authFile = () => path.join(dir(), 'vnc.rfbauth');

function ensureDir() {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(LOGS, { recursive: true });
}

/** Extra screens handed out so far (the default screen is always there). */
function registry(): number[] {
  try {
    const list = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
    return Array.isArray(list) ? list.filter((n) => Number.isInteger(n) && n >= FIRST_EXTRA).sort((a, b) => a - b) : [];
  } catch {
    return [];
  }
}

function saveRegistry(list: number[]) {
  ensureDir();
  const tmp = `${registryFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...new Set(list)].sort((a, b) => a - b)), { mode: 0o600 });
  fs.renameSync(tmp, registryFile());
}

/** The VNC password, made once. VNC auth only uses the first 8 characters, so it is exactly 8. */
function vncPassword(): string {
  ensureDir();
  try {
    const p = fs.readFileSync(passFile(), 'utf8').trim();
    if (p.length === 8 && fs.existsSync(authFile())) return p;
  } catch { /* make one */ }
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const p = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
  fs.writeFileSync(passFile(), p, { mode: 0o600 });
  execFileSync('x11vnc', ['-storepasswd', p, authFile()], { stdio: 'ignore' });
  fs.chmodSync(authFile(), 0o600);
  return p;
}

// ---------------------------------------------------------------- processes

interface Proc { pid: number; argv: string[] }

function procs(): Proc[] {
  const out: Proc[] = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (argv.length) out.push({ pid: Number(name), argv });
    } catch { /* gone */ }
  }
  return out;
}

const base = (s: string) => s.split('/').pop() ?? s;

/** The process of `bin` that serves display :n. */
function find(all: Proc[], bin: string, n: number): Proc | undefined {
  const d = `:${n}`;
  return all.find((p) => base(p.argv[0]) === bin && (p.argv.includes(d) || p.argv.includes(`--display=${d}`)));
}

function launch(argv: string[], log: string, extraEnv: Record<string, string> = {}) {
  ensureDir();
  const fd = fs.openSync(path.join(LOGS, log), 'a');
  try {
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: {
        PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: process.env.HOME ?? '/root',
        LANG: process.env.LANG ?? 'C.UTF-8',
        ...extraEnv,
      },
    });
    child.on('error', (e) => console.warn(`[screens] ${argv[0]} failed to start: ${e.message}`));
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return check();
}

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });

const xSocket = (n: number) => `/tmp/.X11-unix/X${n}`;

/** Start whatever is missing for display :n (X server, window manager, VNC server). Safe to call often. */
async function ensureDisplay(n: number): Promise<void> {
  let all = procs();
  if (!find(all, 'Xvfb', n)) {
    // A server that died leaves its lock and socket behind, and a new one refuses to start over them.
    for (const f of [`/tmp/.X${n}-lock`, xSocket(n)]) { try { fs.unlinkSync(f); } catch { /* none */ } }
    fs.mkdirSync('/tmp/.X11-unix', { recursive: true, mode: 0o1777 });
    const { width, height } = size();
    launch(['Xvfb', `:${n}`, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-dpi', '96', '+extension', 'RANDR'], `xvfb-${n}.log`);
    if (!(await waitFor(() => fs.existsSync(xSocket(n)), 8000))) throw new Error(`display :${n} did not start (see ${LOGS}/xvfb-${n}.log)`);
    all = procs();
  }
  if (!find(all, 'xfwm4', n)) {
    launch(['xfwm4', `--display=:${n}`, '--compositor=off', '--sm-client-disable'], `xfwm4-${n}.log`, { DISPLAY: `:${n}` });
  }
  if (!find(all, 'x11vnc', n)) {
    const port = vncPortFor(screenIdFor(n));
    vncPassword();
    launch(['x11vnc', '-display', `:${n}`, '-rfbport', String(port), '-localhost', '-rfbauth', authFile(), '-forever', '-shared',
      '-noxdamage', '-noxrecord', '-xkb', '-quiet'], `x11vnc-${n}.log`);
    if (!(await waitFor(() => portOpen(port), 8000))) throw new Error(`the VNC server for display :${n} did not start (see ${LOGS}/x11vnc-${n}.log)`);
  }
}

function stopDisplay(n: number) {
  const d = `:${n}`;
  for (const p of procs()) {
    if (['Xvfb', 'xfwm4', 'x11vnc'].includes(base(p.argv[0])) && (p.argv.includes(d) || p.argv.includes(`--display=${d}`))) {
      try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ }
    }
  }
}

function screen(n: number): OrgoScreen {
  return { id: screenIdFor(n), display: `:${n}`, ...size(), default: n === DEFAULT };
}

let ensuring: Promise<void> | null = null;
/** Every screen we know about is up. Shared by concurrent callers. */
function ensureAll(): Promise<void> {
  if (!ensuring) {
    ensuring = (async () => {
      for (const n of [DEFAULT, ...registry()]) await ensureDisplay(n);
    })().finally(() => { ensuring = null; });
  }
  return ensuring;
}

// ---------------------------------------------------------------- the stand-in for Orgo's API

export const localOrgo = {
  workspaces: async () => [],

  /** The "computer" is this machine; asking about it also brings every known screen up. */
  getComputer: async (id: string): Promise<OrgoComputer> => {
    await ensureAll();
    const { width, height } = size();
    return { id, status: 'running', name: 'this computer', resolution: `${width}x${height}`, asleep: null };
  },
  start: async (_id: string) => { await ensureAll(); return {}; },
  resume: async (_id: string) => { await ensureAll(); return {}; },
  suspend: async (_id: string) => ({}),
  vncPassword: async (_id: string) => ({ password: vncPassword(), desktop_api_token: '' }),

  listScreens: async (_id: string): Promise<OrgoScreen[]> => {
    await ensureAll();
    return [DEFAULT, ...registry()].map(screen);
  },
  createScreen: async (_id: string): Promise<OrgoScreen> => {
    const used = registry();
    let n = FIRST_EXTRA;
    while (used.includes(n)) n++;
    saveRegistry([...used, n]);
    await ensureDisplay(n);
    return screen(n);
  },
  getScreen: async (_id: string, screenId: string): Promise<OrgoScreen> => {
    const n = displayNum(screenId);
    if (n !== DEFAULT && !registry().includes(n)) throw new Error(`no screen ${screenId}`);
    await ensureDisplay(n);
    return screen(n);
  },
  deleteScreen: async (_id: string, screenId: string): Promise<void> => {
    const n = displayNum(screenId);
    if (n === DEFAULT) return;
    stopDisplay(n);
    saveRegistry(registry().filter((x) => x !== n));
  },

  /** A JPEG of the screen, taken with GDK (python3-gi is installed for the box scripts anyway). */
  screenshot: (_id: string, screenId?: string) =>
    new Promise<{ image: string; mime_type?: string; width: number; height: number }>((resolve, reject) => {
      const n = displayNum(screenId ?? 'default');
      const code = [
        'import sys, gi',
        "gi.require_version('Gdk', '3.0')",
        'from gi.repository import Gdk',
        'w = Gdk.get_default_root_window()',
        'pb = Gdk.pixbuf_get_from_window(w, 0, 0, w.get_width(), w.get_height())',
        "ok, buf = pb.save_to_bufferv('jpeg', ['quality'], ['75'])",
        "sys.stdout.write('%d %d\\n' % (pb.get_width(), pb.get_height()))",
        'sys.stdout.flush()',
        'sys.stdout.buffer.write(buf)',
      ].join('\n');
      execFile('/usr/bin/python3', ['-c', code], {
        encoding: 'buffer', timeout: 15_000, maxBuffer: 32 * 1024 * 1024,
        env: { PATH: '/usr/bin:/bin', DISPLAY: `:${n}`, GDK_BACKEND: 'x11', HOME: process.env.HOME ?? '/root' },
      }, (err, stdout) => {
        if (err) return reject(err);
        const nl = stdout.indexOf(10);
        const [w, h] = stdout.subarray(0, nl).toString().split(' ').map(Number);
        resolve({ image: stdout.subarray(nl + 1).toString('base64'), mime_type: 'image/jpeg', width: w, height: h });
      });
    }),

  /** Only used without HQ_LOCAL; with local screens the server always runs on the computer itself. */
  bash: (_id: string, screenId: string | undefined, command: string, timeout = 120) =>
    new Promise<{ success: boolean; output: string; exit_code: number }>((resolve) => {
      const n = displayNum(screenId ?? 'default');
      execFile('bash', ['-c', command], { timeout: timeout * 1000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, DISPLAY: `:${n}` } }, (err, stdout, stderr) => {
        const exit = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
        resolve({ success: exit === 0, output: `${stdout ?? ''}${stderr ?? ''}`, exit_code: exit });
      });
    }),

  exportFile: async (_id: string, _path: string): Promise<{ url?: string }> => {
    throw new Error('exportFile is not used with local screens (files are served straight from disk)');
  },
};
