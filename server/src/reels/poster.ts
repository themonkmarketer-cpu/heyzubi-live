// Scheduling from here: a Chrome of its own (its own profile, never the team member's) that HeyZubi drives on the box,
// the way the series was scheduled before. The owner signs in to it once, by hand, on the screen. Every field is read back
// and the last button is pressed only when all of them are right; afterwards the platform's own list must show it once.
// It is driven through a pipe, so there is no port another program on the box could use.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import Database from 'better-sqlite3';
import { box, displayFor } from '../box.js';
import { screenFor, screenForWork } from '../computer.js';
import { primaryBotId } from '../engine.js';
import { getBotRow } from '../store.js';
import { epFile, ensureDir, ReelError, series, seriesDir } from './store.js';
import type { Episode } from './types.js';

export type Platform = 'instagram' | 'facebook' | 'youtube' | 'whatsapp';
export const PLATFORMS: Platform[] = ['instagram', 'facebook', 'youtube', 'whatsapp'];
export const TITLE: Record<Platform, string> = { instagram: 'Instagram', facebook: 'The Facebook Page', youtube: 'YouTube', whatsapp: 'WhatsApp Status' };
const HOME: Record<Platform, string> = { instagram: 'https://www.instagram.com/', facebook: 'https://business.facebook.com/latest/home', youtube: 'https://studio.youtube.com/', whatsapp: 'https://web.whatsapp.com/' };

/** Which accounts: private, beside the rest of the series. */
interface Accounts { instagram?: { handle: string }; facebook?: { assetId: string; businessId: string; page: string }; youtube?: { channelId: string; handle?: string } }
export function accounts(): Accounts {
  try { return JSON.parse(fs.readFileSync(path.join(seriesDir(), 'posting.json'), 'utf8')) as Accounts; } catch { return {}; }
}
/** Outside the team members' profiles, which a screen's tidy-up may close. */
const PROFILE = () => process.env.HQ_POSTING_PROFILE || path.join(process.env.HOME || '/root', 'heyzubi', 'posting');
const CHROME = () => ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/lib/chromium/chromium', '/usr/bin/chromium'].find((f) => fs.existsSync(f));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- the browser ----------
class Browser {
  private id = 0; private buf = ''; private open = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  listeners = new Set<(method: string, params: any, session?: string) => void>();
  gone = false;
  constructor(readonly child: ChildProcess, private out: Writable, input: Readable) {
    input.setEncoding('utf8');
    input.on('data', (d: string) => {
      this.buf += d;
      for (let i = this.buf.indexOf('\0'); i >= 0; i = this.buf.indexOf('\0')) {
        const m = JSON.parse(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1);
        if (m.id) { const p = this.open.get(m.id); this.open.delete(m.id); if (p) { if (m.error) p.no(new Error(m.error.message)); else p.ok(m.result); } }
        else for (const l of [...this.listeners]) l(m.method, m.params, m.sessionId);
      }
    });
    const end = () => { this.gone = true; for (const p of this.open.values()) p.no(new Error('The posting browser closed.')); this.open.clear(); };
    child.on('exit', end); out.on('error', end); input.on('error', end);
  }
  send(method: string, params: object = {}, sessionId?: string, seconds = 60): Promise<any> {
    if (this.gone) return Promise.reject(new Error('The posting browser closed.'));
    const id = ++this.id;
    return new Promise((ok, no) => {
      const t = setTimeout(() => { this.open.delete(id); no(new Error(`${method} took too long.`)); }, seconds * 1000);
      this.open.set(id, { ok: (v) => { clearTimeout(t); ok(v); }, no: (e) => { clearTimeout(t); no(e); } });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }
}
let browser: Browser | null = null, busy = false;
/** The owner's sign-in window: an ordinary Chrome on the same profile, with nothing connected to it. */
let plain: ChildProcess | null = null;
export const postingBusy = () => busy;
export const browserOpen = () => (!!browser && !browser.gone) || !!plain;

async function spawnChrome(extra: string[], stdio: ('ignore' | 'pipe')[]): Promise<ChildProcess> {
  const bin = CHROME(), zubi = primaryBotId();
  if (!bin || !zubi) throw new ReelError('There is no Chrome for posting on this computer.');
  const user = String(getBotRow(zubi)!.user_id);
  await screenForWork(user, zubi).catch(() => {});
  const { screenId } = await screenFor(user, zubi);
  fs.mkdirSync(PROFILE(), { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(PROFILE())) if (f.startsWith('Singleton')) fs.rmSync(path.join(PROFILE(), f), { force: true });
  const child = spawn(bin, ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble', '--password-store=basic', '--disable-dev-shm-usage', '--lang=en-GB', '--class=HQPosting', '--window-size=1280,780', `--user-data-dir=${PROFILE()}`, ...extra], {
    stdio, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root', LANG: 'C.UTF-8', DISPLAY: displayFor(screenId), ...(process.env.TZ ? { TZ: process.env.TZ } : {}) },
  });
  child.on('error', () => {});
  return child;
}
async function closePlain(): Promise<void> {
  const c = plain;
  plain = null;
  if (!c || c.exitCode !== null || c.signalCode) return;
  const gone = new Promise<void>((ok) => c.once('exit', () => ok()));
  c.kill('SIGTERM'); // Chrome closes its windows and writes the sign-ins down
  await Promise.race([gone, sleep(8000)]);
  if (c.exitCode === null && !c.signalCode) c.kill('SIGKILL');
}
async function launch(): Promise<Browser> {
  if (browser && !browser.gone) return browser;
  await closePlain();
  const child = await spawnChrome(['--remote-debugging-pipe', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion', 'about:blank'], ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']);
  const b = new Browser(child, child.stdio[3] as Writable, child.stdio[4] as Readable);
  await b.send('Target.setDiscoverTargets', { discover: true }, undefined, 30).catch(() => { throw new ReelError('The posting browser didn’t start.'); });
  browser = b;
  return b;
}
/** Closed properly, so the sign-ins are written down. */
export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  await closePlain();
  if (!b || b.gone) return;
  await b.send('Browser.close', {}, undefined, 8).catch(() => {});
  for (let i = 0; i < 30 && !b.gone; i++) await sleep(200);
  if (!b.gone) b.child.kill('SIGKILL');
}

class Tab {
  private constructor(readonly b: Browser, readonly target: string, readonly s: string, private signal?: AbortSignal) {}
  static async open(url: string, signal?: AbortSignal, size?: [number, number]): Promise<Tab> {
    const b = await launch();
    const all = (await b.send('Target.getTargets')).targetInfos as { targetId: string; type: string; url: string }[];
    const blank = all.find((t) => t.type === 'page' && /^(about:blank|chrome:\/\/newtab)/.test(t.url));
    const target = blank?.targetId ?? (await b.send('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await b.send('Target.attachToTarget', { targetId: target, flatten: true });
    const t = new Tab(b, target, sessionId, signal);
    for (const d of ['Page', 'Runtime', 'DOM']) await t.send(`${d}.enable`);
    if (size) { await t.send('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false }); await t.send('Emulation.setFocusEmulationEnabled', { enabled: true }); }
    // "Leave this page?" never holds it up: nothing is saved from here.
    b.listeners.add((m, _p, s) => { if (m === 'Page.javascriptDialogOpening' && s === sessionId) void b.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {}); });
    if (url !== 'about:blank') await t.go(url);
    return t;
  }
  send(m: string, p: object = {}, seconds = 60): Promise<any> { if (this.signal?.aborted) return Promise.reject(new ReelError('Stopped.')); return this.b.send(m, p, this.s, seconds); }
  async go(url: string) { await this.send('Page.bringToFront').catch(() => {}); await this.send('Page.navigate', { url }); await sleep(2500); }
  /** A function run in the page, with plain values for arguments. */
  async ev<T = any>(fn: (...a: any[]) => T | Promise<T>, ...args: any[]): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true }, 90);
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 200));
    return r.result.value as T;
  }
  async wait<T>(what: string, seconds: number, fn: () => Promise<T | null | undefined | false>): Promise<T> {
    const end = Date.now() + seconds * 1000;
    for (;;) {
      const v = await fn().catch((e) => { if (this.signal?.aborted || this.b.gone) throw e; return null; });
      if (v) return v;
      if (Date.now() > end) throw new ReelError(`${what} didn’t appear.`);
      await sleep(700);
    }
  }
  async clickAt(p: { x: number; y: number }) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(500);
  }
  /** Where something is: a selector, and (with text) the innermost visible one that says exactly that. */
  spot(sel: string, o: { text?: string; last?: boolean; within?: string; scroll?: boolean; starts?: boolean } = {}) {
    return this.ev((sel: string, o: { text?: string; last?: boolean; within?: string; scroll?: boolean; starts?: boolean }) => {
      const roots: ParentNode[] = o.within ? [...document.querySelectorAll<HTMLElement>(o.within)].filter((e) => e.getBoundingClientRect().width > 0) : [document];
      const els = roots.flatMap((r) => [...r.querySelectorAll<HTMLElement>(sel)]).filter((e) => {
        const r = e.getBoundingClientRect(), t = (e.innerText ?? '').trim() || e.getAttribute('aria-label') || '';
        return r.width > 0 && r.height > 0 && (o.text === undefined || (o.starts ? t.startsWith(o.text) : t === o.text));
      });
      const deep = o.text === undefined ? els : els.filter((e) => !els.some((q) => q !== e && e.contains(q)));
      const e = o.last ? deep[deep.length - 1] : deep[0];
      if (!e) return null;
      if (o.scroll !== false) e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, n: deep.length };
    }, sel, o);
  }
  async click(sel: string, o: { text?: string; last?: boolean; within?: string; scroll?: boolean; starts?: boolean; seconds?: number; what?: string } = {}) {
    const p = await this.wait(o.what ?? o.text ?? sel, o.seconds ?? 15, () => this.spot(sel, o));
    await this.clickAt(p);
    return p;
  }
  async key(key: string, code: string, vk: number, modifiers = 0, text?: string) {
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(140);
  }
  async typeKeys(s: string) { for (const ch of s) { const up = ch.toUpperCase(); await this.key(ch, /\d/.test(ch) ? `Digit${ch}` : `Key${up}`, up.charCodeAt(0), 0, ch); } }
  enter() { return this.key('Enter', 'Enter', 13, 0, '\r'); }
  /** Everything in a field replaced. */
  async fill(sel: string, text: string) {
    const p = await this.wait(sel, 20, () => this.ev((sel: string) => { const e = [...document.querySelectorAll<HTMLElement>(sel)].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ block: 'center' }); e.focus(); const r = e.getBoundingClientRect(); return { x: r.x + Math.min(30, r.width / 2), y: r.y + Math.min(14, r.height / 2) }; }, sel));
    await this.clickAt(p);
    await this.key('a', 'KeyA', 65, 2); await this.key('Backspace', 'Backspace', 8);
    await sleep(300);
    await this.send('Input.insertText', { text });
    await sleep(900);
  }
  text(sel: string): Promise<string | null> { return this.ev((sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].find((x) => x.getBoundingClientRect().width > 0)?.innerText ?? null, sel); }
  /** A file put in a file field. */
  async setFile(sel: string, file: string): Promise<boolean> {
    const { root } = await this.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeIds } = await this.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: sel });
    if (!nodeIds.length) return false;
    await this.send('DOM.setFileInputFiles', { nodeId: nodeIds[nodeIds.length - 1], files: [file] });
    return true;
  }
  /** A button that opens the computer's file window: the file is given instead. */
  async choose(file: string, press: () => Promise<unknown>): Promise<void> {
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true });
    try {
      for (let i = 0; i < 3; i++) {
        let hit: (m: string, p: any, s?: string) => void = () => {};
        const opened = new Promise<any>((ok) => { hit = (m, p, s) => { if (m === 'Page.fileChooserOpened' && s === this.s) ok(p); }; this.b.listeners.add(hit); });
        await press();
        const p = await Promise.race([opened, sleep(8000).then(() => null)]);
        this.b.listeners.delete(hit);
        if (p) { await this.send('DOM.setFileInputFiles', { backendNodeId: p.backendNodeId, files: [file] }); return; }
      }
      throw new ReelError('The page didn’t open its file window.');
    } finally { await this.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {}); }
  }
  async shot(file: string) { const { data } = await this.b.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 }, this.s); fs.writeFileSync(ensureDir(file), Buffer.from(data, 'base64')); }
  /** The tab stays, empty, for the next one: a window without tabs closes. */
  async close() { await this.b.send('Page.navigate', { url: 'about:blank' }, this.s, 15).catch(() => {}); await sleep(1200); await this.b.send('Target.detachFromTarget', { sessionId: this.s }).catch(() => {}); }
}

// ---------- signing in (the owner, by hand) ----------
/** Whether each account's sign-in is kept in the profile: the names and dates of cookies only, never their values. */
export function signedIn(): Record<Platform, boolean> {
  const none = { instagram: false, facebook: false, youtube: false, whatsapp: false }, f = path.join(PROFILE(), 'Default', 'Cookies');
  // WhatsApp keeps its link in the site's own storage, not in cookies: its folder there is only big once linked.
  const wa = (() => { try { const d = path.join(PROFILE(), 'Default', 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb'); return fs.readdirSync(d).reduce((a, x) => a + fs.statSync(path.join(d, x)).size, 0) > 400_000; } catch { return false; } })();
  none.whatsapp = wa;
  const tmp = path.join(PROFILE(), `.look-${process.pid}`);
  try {
    if (!fs.existsSync(f)) return none;
    fs.copyFileSync(f, tmp);
    if (fs.existsSync(`${f}-wal`)) fs.copyFileSync(`${f}-wal`, `${tmp}-wal`);
    const d = new Database(tmp, { fileMustExist: true });
    const nowUtc = (Date.now() / 1000 + 11644473600) * 1e6;
    const has = (host: string, name: string) => !!d.prepare('SELECT 1 FROM cookies WHERE host_key LIKE ? AND name=? AND (expires_utc=0 OR expires_utc>?)').get(host, name, nowUtc);
    const r = { instagram: has('%instagram.com', 'sessionid'), facebook: has('%facebook.com', 'c_user'), youtube: has('%google.com', 'SID'), whatsapp: wa };
    d.close();
    return r;
  } catch { return none; } finally { for (const x of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${tmp}${x}`, { force: true }); }
}
/** The posting browser in front on the team member's screen, at a sign-in page. */
export async function openForSignIn(p: Platform): Promise<void> {
  if (busy) throw new ReelError('It is scheduling right now. Wait until it is done.');
  // Nothing is connected to it (Google refuses a sign-in otherwise): the owner's sign-in is theirs alone.
  await closeBrowser();
  const c = await spawnChrome(['--new-window', HOME[p]], ['ignore', 'ignore', 'ignore']);
  plain = c;
  c.once('exit', () => { if (plain === c) plain = null; });
  await sleep(3000);
  const zubi = primaryBotId()!, { screenId } = await screenFor(String(getBotRow(zubi)!.user_id), zubi);
  await box.bash('wmctrl -x -a HQPosting; wmctrl -x -r HQPosting -b add,maximized_vert,maximized_horz', 8, screenId).catch(() => {});
}

// ---------- the three platforms ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const same = (a: string, b: string) => { const n = (s: string) => s.replace(/[​ ]/g, ' ').replace(/\s+/g, ' ').trim(); return n(a) === n(b); };
interface Job { sending?: () => void; ep: Episode; dir: string; at: { y: number; m: number; d: number; hh: string; mm: string; dow: string }; say: (t: string) => void; signal: AbortSignal; dry: boolean }
export interface Posted { status: 'scheduled' | 'ready'; link?: string; note: string; shot?: string }
const read = (j: Job, f: string) => fs.readFileSync(path.join(j.dir, f), 'utf8').replace(/\r/g, '').trim();
async function needLogin(t: Tab, p: Platform) {
  const out = await t.ev(() => /\/accounts\/login|accounts\.google\.com|\/login(\/|\?|$)|loginpage/.test(location.href) || !!document.querySelector('input[type=password]'));
  if (out) throw new ReelError(`The posting browser isn’t signed in to ${p === 'facebook' ? 'Facebook' : TITLE[p]}. Say “sign in”, sign in on the screen, then “schedule” again.`);
}

/** Instagram's own calendar, the week the slot is in: what stands on that day, with its time and first words. */
async function igDay(t: Tab, j: Job): Promise<{ time: string; text: string }[]> {
  await t.go('https://www.instagram.com/scheduled_content/');
  await sleep(6000);
  await needLogin(t, 'instagram');
  const head = `${j.at.dow} ${j.at.d}`;
  for (let i = 0; i < 6; i++) {
    const r = await t.wait('Instagram’s calendar', 30, () => t.ev((head: string, month: string) => {
      const els = [...document.querySelectorAll<HTMLElement>('body *')];
      if (!els.some((e) => e.children.length === 0 && (e.innerText ?? '').trim() === 'Schedule content')) return null;
      const col = els.find((e) => { const x = (e.innerText ?? '').replace(/\s+/g, ' ').trim(), q = e.getBoundingClientRect(); return x === head && q.width > 0 && q.height < 80; });
      if (!col || !document.body.innerText.includes(month)) return { on: false, tiles: [] as { time: string; text: string }[] };
      const c = col.getBoundingClientRect(), mid = c.x + c.width / 2;
      const tiles = [...document.querySelectorAll<HTMLElement>('[role=button], a')].map((e) => ({ r: e.getBoundingClientRect(), x: (e.innerText ?? '').trim() })).filter((q) => /\d{1,2}:\d\d [AP]M/.test(q.x) && q.r.width > 30 && q.r.width < 400 && Math.abs(q.r.x + q.r.width / 2 - mid) < 70);
      return { on: true, tiles: tiles.map((q) => ({ time: /\d{1,2}:\d\d [AP]M/.exec(q.x)![0], text: q.x.slice(0, 200) })) };
    }, head, MONTHS[j.at.m - 1]));
    if (r.on) return r.tiles.filter((x, n) => r.tiles.findIndex((y) => y.time === x.time && y.text === x.text) === n);
    const next = await t.ev(() => { const today = [...document.querySelectorAll<HTMLElement>('[role=button],button')].find((e) => (e.innerText ?? '').trim() === 'Today'); const row = today?.parentElement; const s = [...document.querySelectorAll('svg[aria-label]')].find((e) => /next/i.test(e.getAttribute('aria-label') ?? '')); const b = s?.closest('[role=button],button') ?? [...(row?.querySelectorAll('[role=button],button') ?? [])].pop(); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    if (!next) break;
    await t.clickAt(next); await sleep(3500);
  }
  throw new ReelError('Instagram’s calendar couldn’t be read, so nothing was pressed.');
}

async function instagram(t: Tab, j: Job): Promise<Posted> {
  const acc = accounts().instagram, cap = read(j, 'caption-us-ig.txt'), first = cap.replace(/\s+/g, ' ').slice(0, 26), H = Number(j.at.hh), h12 = H % 12 || 12, ap = H < 12 ? 'AM' : 'PM', clock = `${h12}:${j.at.mm} ${ap}`;
  if (!acc) throw new ReelError('Which Instagram account is it? posting.json doesn’t say.');
  const mineOf = (l: { time: string; text: string }[]) => l.filter((x) => x.text.replace(/\s+/g, ' ').includes(first));
  j.say('Instagram: looking at the calendar');
  const before = await igDay(t, j), mine = mineOf(before);
  if (mine.some((x) => x.time === clock)) return { status: 'scheduled', note: 'It was on the calendar already; nothing was pressed.' };
  if (mine.length) throw new ReelError(`It is on the calendar already, but at ${mine[0].time}. Change or remove that one first.`);
  if (before.some((x) => x.time === clock)) throw new ReelError(`Another post already stands at ${clock} that day. Nothing was pressed.`);
  if (!await t.ev((h: string) => [...document.querySelectorAll('a[href]')].some((a) => a.getAttribute('href') === `/${h}/`), acc.handle)) throw new ReelError(`The posting browser is on another Instagram account than @${acc.handle}.`);
  j.say('Instagram: uploading the reel');
  let set = false;
  for (let i = 0; i < 5 && !set; i++) { await t.click('button,[role=button],div', { text: 'Schedule content', scroll: false }); await sleep(2500); set = await t.setFile('input[type=file]', path.join(j.dir, 'reel-v1.mp4')); }
  if (!set) throw new ReelError('Instagram didn’t ask for the video.');
  await t.wait('Instagram’s crop step', 120, async () => { const ok = await t.spot('button,[role=button]', { text: 'OK', within: '[role=dialog]' }); if (ok) await t.clickAt(ok); return t.spot('[role=button],button,div', { text: 'Next', within: '[role=dialog]' }); });
  await t.click('svg[aria-label="Select crop"]', { scroll: false });
  await t.click('span,div', { text: 'Original', within: '[role=dialog]' });
  await t.click('[role=button],button,div', { text: 'Next', within: '[role=dialog]', scroll: false });
  await t.wait('The cover step', 40, () => t.spot('span,div', { text: 'Cover photo' }));
  if (!await t.setFile('[role=dialog] input[type=file]', path.join(j.dir, 'cover.jpg'))) throw new ReelError('Instagram’s cover step has no place for the picture.');
  await sleep(4500);
  await t.click('[role=button],button,div', { text: 'Next', within: '[role=dialog]', scroll: false });
  j.say('Instagram: caption, AI label and time');
  await t.fill('[role=dialog] [contenteditable="true"]', cap);
  // A list of hashtags may open over the fields: the title bar closes it.
  const bar = await t.spot('[role=dialog] [role=heading], [role=dialog] h1, [role=dialog] div', { text: 'New reel', scroll: false });
  if (bar) await t.clickAt(bar);
  const toggle = async (label: string, want: boolean) => {
    const now = () => t.ev((label: string) => { const l = [...document.querySelectorAll<HTMLElement>('[role=dialog] span,[role=dialog] div')].find((e) => e.children.length === 0 && (e.innerText ?? '').trim() === label); let n: Element | null = l ?? null, b: HTMLInputElement | null = null; for (let i = 0; i < 8 && n && !b; i++) { n = n.parentElement; b = n?.querySelector<HTMLInputElement>('input[type=checkbox],[role=switch]') ?? null; } if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { on: b.checked ?? b.getAttribute('aria-checked') === 'true', x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, label);
    const a = await t.wait(label, 12, now);
    if (a.on !== want) { await t.clickAt(a); await sleep(900); }
    if ((await now())?.on !== want) throw new ReelError(`Instagram’s “${label}” didn’t switch.`);
  };
  await toggle('Add AI label', true);
  await toggle('Schedule content', true);
  const label = `${j.at.dow}, ${MONTHS[j.at.m - 1].slice(0, 3)} ${j.at.d}, ${j.at.y}`;
  const dates = () => t.ev(() => [...document.querySelectorAll<HTMLElement>('[role=dialog] [role=button],[role=dialog] button')].map((e) => (e.innerText ?? '').trim()).filter((x) => /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+, \d{4}$/.test(x)));
  if (!(await dates()).includes(label)) {
    const cur = (await dates())[0];
    if (!cur) throw new ReelError('Instagram’s date field wasn’t found.');
    await t.click('[role=button],button', { text: cur, within: '[role=dialog]' });
    await sleep(900);
    const month = `${MONTHS[j.at.m - 1]} ${j.at.y}`;
    // The calendar behind the window shows a month too: only the picker's own heading with its weekdays counts.
    for (let i = 0; i < 3; i++) {
      const p = await t.ev((month: string) => { const h = [...document.querySelectorAll<HTMLElement>('span,div')].filter((e) => e.children.length === 0 && /^[A-Z][a-z]+ \d{4}$/.test((e.innerText ?? '').trim()) && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().width < 260).pop(); if (!h) return null; const r = h.getBoundingClientRect(), row = h.parentElement!; const nx = [...row.querySelectorAll('button,[role=button]')].pop()?.getBoundingClientRect(); return { on: (h.innerText ?? '').trim() === month, nx: nx ? { x: nx.x + nx.width / 2, y: nx.y + nx.height / 2 } : { x: r.x + r.width + 90, y: r.y + r.height / 2 } }; }, month);
      if (!p || p.on) break;
      await t.clickAt(p.nx); await sleep(700);
    }
    await t.click('button', { text: String(j.at.d), last: true, scroll: false, what: `Day ${j.at.d}` });
    await sleep(900);
  }
  for (const [l, k] of [['Hours', String(h12).padStart(2, '0')], ['Minutes', j.at.mm], ['AM PM', ap[0]]] as const) { await t.click(`[role=dialog] input[aria-label="${l}"]`); await t.typeKeys(k); await sleep(400); }
  const b = await t.ev(() => { const g = (l: string) => { const i = document.querySelector<HTMLInputElement>(`[role=dialog] input[aria-label="${l}"]`); return i ? i.getAttribute('aria-valuetext') || i.getAttribute('aria-valuenow') || i.value : null; }; return { h: g('Hours'), m: g('Minutes'), ap: g('AM PM'), cap: document.querySelector<HTMLElement>('[role=dialog] [contenteditable="true"]')?.innerText ?? '' }; });
  const d = await dates();
  if (!d.includes(label) || Number(b.h) !== h12 || Number(b.m) !== Number(j.at.mm) || String(b.ap).toUpperCase() !== ap || !same(b.cap, cap)) throw new ReelError(`Instagram’s fields didn’t read back right (${d[0] ?? 'no date'}, ${b.h}:${b.m} ${b.ap}${same(b.cap, cap) ? '' : ', the caption differs'}). Nothing was pressed.`);
  if (j.dry) return { status: 'ready', note: `Everything read back right: ${label}, ${clock}, AI label on, the caption in place. That day the calendar holds: ${before.map((x) => x.time).join(', ') || 'nothing yet'}. Schedule was not pressed.` };
  j.say('Instagram: scheduling');
  if (j.signal.aborted) throw new ReelError('Stopped.');
  await t.click('[role=button],button,div', { text: 'Schedule', within: '[role=dialog]', scroll: false });
  await t.wait('Instagram’s “has been scheduled”', 240, () => t.ev(() => /has been scheduled/i.test(document.body.innerText) || null));
  const after = mineOf(await igDay(t, j)).filter((x) => x.time === clock);
  return { status: 'scheduled', note: after.length === 1 ? `Cover and AI label on; the calendar shows it once, ${label} at ${clock}.` : `Instagram said it is scheduled, but the calendar shows it ${after.length} times: have a look.` };
}

async function facebook(t: Tab, j: Job): Promise<Posted> {
  const acc = accounts().facebook, cap = read(j, 'caption-us-fb.txt'), first = cap.replace(/\s+/g, ' ').slice(0, 40);
  if (!acc) throw new ReelError('Which Facebook Page is it? posting.json doesn’t say.');
  const when = `${j.at.d} ${MONTHS[j.at.m - 1]}`, hm = `${j.at.hh}:${j.at.mm}`;
  const listed = async () => {
    await t.go(`https://business.facebook.com/latest/posts/scheduled_posts?asset_id=${acc.assetId}&business_id=${acc.businessId}`);
    await sleep(9000);
    await needLogin(t, 'facebook');
    await t.wait('The Page’s scheduled list', 40, () => t.ev(() => /Scheduled/.test(document.body.innerText) || null));
    return t.ev((first: string) => { const L = document.body.innerText.split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x && x !== '​'); return L.map((x, i) => (x.startsWith(first) ? L.slice(i, i + 9).join(' | ') : '')).filter(Boolean); }, first);
  };
  j.say('Facebook: looking at what is scheduled');
  const was = await listed();
  if (was.some((x) => x.includes(when) && x.includes(hm))) return { status: 'scheduled', note: 'It was in the Page’s scheduled list already; nothing was pressed.' };
  if (was.length) throw new ReelError('It is in the Page’s scheduled list already, at another time. Change or remove that one first.');
  j.say('Facebook: uploading the reel');
  await t.go(`https://business.facebook.com/latest/reels_composer/?asset_id=${acc.assetId}&business_id=${acc.businessId}`);
  await t.wait('Facebook’s “Create reel”', 60, () => t.spot('[role=button],span,div', { text: 'Add video' }));
  // The Page only: Instagram has its own scheduling.
  const to = () => t.ev(() => (document.querySelector<HTMLElement>('[role=combobox]')?.innerText ?? '').replace(/[​\n]+/g, ' ').trim());
  if (!same(await to(), acc.page)) {
    await t.click('[role=combobox]'); await sleep(1200);
    const ig = accounts().instagram?.handle ?? '';
    const row = await t.spot('[role=option],[role=menuitemcheckbox],label', { text: ig, starts: true }) ?? await t.spot('span,div', { text: ig, last: true });
    if (!row) throw new ReelError('Facebook’s “Post to” list wasn’t found.');
    await t.clickAt(row); await sleep(700);
    const head = await t.spot('span,div', { text: 'Create reel' }); if (head) await t.clickAt({ x: head.x + 500, y: head.y });
    await sleep(900);
  }
  if (!same(await to(), acc.page)) throw new ReelError(`Facebook would post to “${await to()}”, not only to the Page. Nothing was pressed.`);
  await t.choose(path.join(j.dir, 'reel-v1.mp4'), () => t.click('[role=button],span,div', { text: 'Add video' }));
  await t.wait('Facebook’s copyright check', 420, () => t.ev(() => /safe to publish/i.test(document.body.innerText) || null));
  j.say('Facebook: thumbnail, text and tags');
  await t.click('span,div', { text: 'Upload image', seconds: 60 });
  await sleep(1500);
  await t.choose(path.join(j.dir, 'cover.jpg'), () => t.click('a,span,div,[role=button]', { text: 'Upload Image', last: true }));
  await t.wait('The thumbnail', 60, () => t.ev(() => /change image/i.test(document.body.innerText) || null));
  await t.fill('[contenteditable="true"]', cap);
  const rd = await t.spot('span,div', { text: 'Reel details' }); if (rd) await t.clickAt({ x: rd.x + 320, y: rd.y });
  if (!same(await t.text('[contenteditable="true"]') ?? '', cap)) throw new ReelError('Facebook’s text didn’t read back right. Nothing was pressed.');
  const tagBox = () => t.ev(() => { const h = [...document.querySelectorAll('span,div')].find((x) => x.children.length === 0 && (x.textContent ?? '').trim() === 'Tags'); let c: Element | null = h ?? null; for (let i = 0; i < 8 && c; i++) { c = c.parentElement; const q = c?.querySelector<HTMLInputElement>('input'); if (q) { q.scrollIntoView({ block: 'center' }); q.focus(); const r = q.getBoundingClientRect(); return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2, text: (c as HTMLElement).innerText }; } } return null; });
  const tags: string[] = JSON.parse(read(j, 'keywords.json')).facebook_tags ?? [];
  for (const tag of tags.slice(0, 8)) { const p = await tagBox(); if (!p) break; await t.clickAt(p); await t.send('Input.insertText', { text: tag }); await sleep(900); await t.enter(); await sleep(700); }
  const tagged = ((await tagBox())?.text ?? '').split('\n').map((x) => x.replace(/​/g, '').trim()).filter((x) => x && !/^(Tags|optional|•)/i.test(x) && !/maximum number/i.test(x));
  for (let i = 0; i < 2; i++) { await t.click('[role=button],button,span,div', { text: 'Next', last: true, scroll: false }); await sleep(4500); }
  await t.wait('Facebook’s scheduling step', 40, () => t.spot('span,div', { text: 'Scheduling options' }));
  await t.click('span,div,[role=button]', { text: 'Schedule', scroll: false });
  await sleep(1500);
  await t.click('input[placeholder="dd/mm/yyyy"]'); await sleep(900);
  const month = `${MONTHS[j.at.m - 1]} ${j.at.y}`;
  for (let i = 0; i < 3 && !await t.ev((m: string) => document.body.innerText.includes(m), month); i++) { const nx = await t.spot('[aria-label*="next" i]', { last: true, scroll: false }); if (!nx) break; await t.clickAt(nx); await sleep(700); }
  await t.click('[role=gridcell],td,[role=button],span,div', { text: String(j.at.d), last: true, scroll: false, what: `Day ${j.at.d}` });
  await sleep(900);
  for (const [l, k] of [['hours', j.at.hh], ['minutes', j.at.mm]] as const) { await t.click(`input[aria-label="${l}"]`); await t.typeKeys(k); await sleep(300); }
  const so = await t.spot('span,div', { text: 'Scheduling options' }); if (so) await t.clickAt({ x: so.x + 320, y: so.y });
  const f = await t.ev(() => { const v = (l: string) => { const i = document.querySelector<HTMLInputElement>(`input[aria-label="${l}"]`); return i ? i.value || i.getAttribute('aria-valuetext') || i.getAttribute('aria-valuenow') || i.placeholder || '' : ''; }; const box = document.querySelector('input[aria-label="hours"]')?.closest('div')?.parentElement?.parentElement; return { d: document.querySelector<HTMLInputElement>('input[placeholder="dd/mm/yyyy"]')?.value ?? '', h: v('hours'), m: v('minutes'), near: (box?.innerText ?? '').replace(/\s+/g, ' '), tz: /Asia\/(Kolkata|Calcutta)/.test(document.body.innerText) }; });
  const timeOk = (f.h !== '' && Number(f.h) === Number(j.at.hh) && f.m !== '' && Number(f.m) === Number(j.at.mm)) || f.near.replace(/\s/g, '').includes(hm);
  if (f.d !== `${when} ${j.at.y}` || !timeOk || !f.tz) throw new ReelError(`Facebook’s date and time didn’t read back right (${f.d || 'no date'}, ${f.h}:${f.m} ${f.near.slice(0, 40)}). Nothing was pressed.`);
  if (j.dry) return { status: 'ready', note: `Everything read back right: ${f.d}, ${hm}, the Page only, text, thumbnail and ${tagged.length} tags in place. Schedule was not pressed.` };
  j.say('Facebook: scheduling');
  if (j.signal.aborted) throw new ReelError('Stopped.');
  await t.click('[role=button],button,span,div', { text: 'Schedule', last: true, scroll: false });
  await t.wait('Facebook’s “Reel scheduled”', 120, () => t.ev(() => /reel scheduled/i.test([...document.querySelectorAll<HTMLElement>('[role=dialog]')].map((d) => d.innerText).join(' ')) || null));
  const done = await t.spot('[role=button],span,div', { text: 'Done' }); if (done) await t.clickAt(done);
  // A reel shows in the list once Facebook has processed it.
  let right: string[] = [];
  for (let i = 0; i < 6 && !right.length; i++) { if (i) await sleep(30_000); right = (await listed()).filter((x) => x.includes(when) && x.includes(hm)); }
  return { status: 'scheduled', note: `Thumbnail in place; tags: ${tagged.join(', ') || 'none'}. ${right.length === 1 ? `The Page’s list shows it once, ${when} ${hm}.` : `The Page’s list shows it ${right.length} times at that time: have a look.`}` };
}

async function youtube(t: Tab, j: Job): Promise<Posted> {
  const acc = accounts().youtube;
  if (!acc) throw new ReelError('Which YouTube channel is it? posting.json doesn’t say.');
  const [title, ...rest] = read(j, 'youtube.txt').split('\n'), body = rest.join('\n').trim(), cut = body.lastIndexOf('\n\nTags: ');
  const description = (cut < 0 ? body : body.slice(0, cut)).trim(), tags = cut < 0 ? [] : body.slice(cut + 8).split(',').map((x) => x.trim()).filter(Boolean);
  const day = `${j.at.d} ${MONTHS[j.at.m - 1].slice(0, 3)} ${j.at.y}`, hm = `${j.at.hh}:${j.at.mm}`, D = 'ytcp-uploads-dialog';
  j.say('YouTube: looking in Studio');
  await t.go(`https://studio.youtube.com/channel/${acc.channelId}/videos/short`);
  await sleep(9000);
  await needLogin(t, 'youtube');
  await t.wait('Your list of Shorts in Studio', 40, () => t.ev((c: string) => (location.href.includes(c) && !!document.querySelector('ytcp-video-row')) || null, acc.channelId));
  const row = await t.ev((title: string) => { const r = [...document.querySelectorAll<HTMLElement>('ytcp-video-row')].find((x) => x.innerText.includes(title)); return r ? { text: r.innerText.replace(/\s+/g, ' '), href: r.querySelector('a[href*="/video/"]')?.getAttribute('href') ?? '' } : null; }, title);
  if (row) {
    const id = /\/video\/([\w-]+)/.exec(row.href)?.[1], link = id ? `https://youtube.com/shorts/${id}` : undefined;
    if (/Scheduled/i.test(row.text)) return { status: 'scheduled', link, note: 'It was scheduled in Studio already; nothing was pressed.' };
    throw new ReelError(`A video with this title is in Studio already (${/Draft|Private|Public|Unlisted/i.exec(row.text)?.[0] ?? 'not scheduled'}). Finish or delete it there first; nothing was pressed.`);
  }
  if (j.dry) return { status: 'ready', note: 'Signed in to the right channel, and the title is free. The upload itself isn’t tried without scheduling, because Studio keeps a draft of it.' };
  j.say('YouTube: uploading');
  await t.go(`https://studio.youtube.com/channel/${acc.channelId}/videos/upload?d=ud`);
  await t.wait('Studio’s upload window', 40, async () => (await t.setFile('input[type=file][name=Filedata]', path.join(j.dir, 'reel-v1.mp4'))) || null);
  await t.wait('Studio’s details', 120, () => t.spot(`${D} #title-textarea #textbox`, { scroll: false }));
  await sleep(6000);
  await t.fill(`${D} #title-textarea #textbox`, title);
  await t.fill(`${D} #description-textarea #textbox`, description);
  if (!same(await t.text(`${D} #title-textarea #textbox`) ?? '', title) || !same(await t.text(`${D} #description-textarea #textbox`) ?? '', description)) throw new ReelError('Studio’s title or description didn’t read back right. A draft stays in Studio.');
  j.say('YouTube: cover, playlist and settings');
  await t.wait('Studio’s thumbnail', 30, async () => (await t.setFile(`${D} input#file-loader`, path.join(j.dir, 'cover.jpg'))) || null);
  await sleep(5000);
  const playlist = series().youtubePlaylist;
  if (playlist) {
    await t.click(`${D} ytcp-video-metadata-playlists ytcp-dropdown-trigger`); await sleep(2000);
    await t.click('ytcp-playlist-dialog *', { text: playlist, starts: true }); await sleep(700);
    await t.click('ytcp-playlist-dialog button, ytcp-playlist-dialog ytcp-button', { text: 'Done' }); await sleep(1200);
  }
  await t.click(`${D} tp-yt-paper-radio-button[name=VIDEO_MADE_FOR_KIDS_NOT_MFK]`); await sleep(500);
  await t.click(`${D} #toggle-button`); await sleep(2000);
  await t.click(`${D} tp-yt-paper-radio-button[name=VIDEO_HAS_ALTERED_CONTENT_YES]`); await sleep(800);
  await t.ev((keep: string[]) => { for (const c of document.querySelectorAll<HTMLElement>('ytcp-uploads-dialog #tags-container ytcp-chip')) if (!keep.includes(c.innerText.trim().toLowerCase())) c.querySelector<HTMLElement>('#delete-icon, ytcp-icon-button')?.click(); }, tags.map((x) => x.toLowerCase()));
  await sleep(800);
  const chips = () => t.ev(() => [...document.querySelectorAll<HTMLElement>('ytcp-uploads-dialog #tags-container ytcp-chip')].map((c) => c.innerText.trim()));
  for (const tag of tags) { if ((await chips()).some((c) => c.toLowerCase() === tag.toLowerCase())) continue; await t.click(`${D} #tags-container input#text-input`); await t.send('Input.insertText', { text: tag }); await sleep(200); await t.enter(); await sleep(350); }
  const set = await t.ev(() => { const on = (n: string) => document.querySelector(`ytcp-uploads-dialog tp-yt-paper-radio-button[name=${n}]`)?.getAttribute('aria-checked') === 'true', d = document.querySelector<HTMLElement>('ytcp-uploads-dialog'); return { ai: on('VIDEO_HAS_ALTERED_CONTENT_YES'), kids: on('VIDEO_MADE_FOR_KIDS_NOT_MFK'), id: /(?:youtube\.com\/shorts\/|youtu\.be\/)([\w-]+)/.exec(`${d?.innerText ?? ''} ${[...(d?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href')).join(' ')}`)?.[1] ?? '' }; });
  if (!set.ai || !set.kids) throw new ReelError('Studio’s AI use or audience didn’t switch. A draft stays in Studio.');
  for (let i = 0; i < 3; i++) { await t.click(`${D} #next-button`, { scroll: false }); await sleep(3500); if (await t.spot(`${D} #second-container-expand-button`, { scroll: false })) break; }
  j.say('YouTube: setting the time');
  await t.click(`${D} #second-container-expand-button`); await sleep(2000);
  await t.click(`${D} #datepicker-trigger`); await sleep(1500);
  await t.click('ytcp-date-picker input'); await t.key('a', 'KeyA', 65, 2); await t.send('Input.insertText', { text: day }); await t.enter(); await sleep(1500);
  await t.click(`${D} ytcp-visibility-scheduler input`); await t.key('a', 'KeyA', 65, 2); await t.send('Input.insertText', { text: hm }); await t.enter(); await sleep(1200);
  const st = () => t.ev(() => { const d = document.querySelector('ytcp-uploads-dialog')!; return { date: d.querySelector<HTMLElement>('#datepicker-trigger')?.innerText.trim() ?? '', time: d.querySelector<HTMLInputElement>('ytcp-visibility-scheduler input')?.value ?? '', txt: (d.querySelector<HTMLElement>('ytcp-visibility-scheduler')?.innerText ?? '').replace(/\s+/g, ' '), btn: d.querySelector<HTMLElement>('#done-button')?.innerText.trim() ?? '' }; });
  if (!/GMT\+0?5:?30/.test((await st()).txt)) {
    await t.click(`${D} ytcp-visibility-scheduler *`, { text: 'Time zone' }); await sleep(1500);
    await t.click('tp-yt-paper-item, ytcp-text-menu *', { text: '(GMT+0530)', starts: true });
    await sleep(1200);
  }
  const r = await st();
  if (r.date !== day || r.time !== hm || !/GMT\+0?5:?30/.test(r.txt) || r.btn !== 'Schedule') throw new ReelError(`Studio’s date and time didn’t read back right (${r.date}, ${r.time}, ${r.btn}). A draft stays in Studio.`);
  j.say('YouTube: scheduling');
  if (j.signal.aborted) throw new ReelError('Stopped. A draft stays in Studio.');
  await t.click(`${D} #done-button`, { scroll: false });
  await sleep(9000);
  if (!set.id) return { status: 'scheduled', note: 'Scheduled; open Studio once to check it.' };
  await t.go(`https://studio.youtube.com/video/${set.id}/edit`);
  await sleep(9000);
  const ed = await t.ev(() => ({ title: document.querySelector<HTMLElement>('#title-textarea #textbox')?.innerText ?? '', vis: (document.querySelector<HTMLElement>('ytcp-video-metadata-visibility')?.innerText ?? '').replace(/\s+/g, ' ') }));
  if (!/Scheduled/i.test(ed.vis)) throw new ReelError(`Studio’s page says “${ed.vis.slice(0, 60) || 'nothing'}”, not Scheduled. Look at it in Studio.`);
  return { status: 'scheduled', link: `https://youtube.com/shorts/${set.id}`, note: `${day} at ${hm} (India), the cover, AI use Yes, ${tags.length} tags.${same(ed.title, title) ? '' : ' The title on the page differs: have a look.'}` };
}
/**
 * WhatsApp Status, by the owner's playbook: My Status only, the composer and the My status row are the only things read
 * (never the chat or status lists, never a picture of them), one press of Send, and posted only when My status shows it.
 * WhatsApp has no scheduler: this runs at the slot's time (flow.ts).
 */
async function whatsapp(t: Tab, j: Job): Promise<Posted> {
  const file = path.join(j.dir, 'whatsapp-status.mp4'), cap = read(j, 'caption-whatsapp.txt').replace(/\s+/g, ' ');
  if (!fs.existsSync(file) || fs.statSync(file).size > 9_900_000) throw new ReelError('The WhatsApp copy of the reel is missing or over 10 MB.');
  j.say('WhatsApp: opening');
  await t.go('https://web.whatsapp.com/');
  const st = await t.wait('WhatsApp Web', 90, () => t.ev(() => (document.querySelector('#pane-side') ? 'in' : document.querySelector('[data-ref], canvas[aria-label]') ? 'qr' : null)));
  if (st === 'qr') throw new ReelError('WhatsApp isn’t linked on the posting browser. Say “sign in to whatsapp” and scan the code with your phone.');
  await sleep(4000);
  if (await t.ev(() => document.querySelector('button[aria-label="Status"],[role=button][aria-label="Status"]')?.getAttribute('aria-pressed')) !== 'true') await t.click('button[aria-label="Status"],[role=button][aria-label="Status"]', { scroll: false });
  await sleep(15000); // My status syncs late in a fresh tab
  const mine = () => t.ev(() => document.querySelector<HTMLElement>('[data-testid="status-header"]')?.innerText.replace(/\s+/g, ' ').slice(0, 60) ?? '');
  const before = await mine();
  const COMPOSE = '[contenteditable=true][aria-label="Add a caption"]';
  j.say('WhatsApp: loading the reel');
  await t.choose(file, async () => {
    if (!await t.spot('[role=menuitem]', { text: 'Photos & videos', starts: true, scroll: false })) { await t.click('[aria-label="Add status"]', { scroll: false }); await sleep(1500); }
    await t.click('[role=menuitem]', { text: 'Photos & videos', starts: true, scroll: false });
  });
  const secs = Number((await t.wait('WhatsApp’s composer', 90, () => t.ev((c: string) => { const v = [...document.querySelectorAll('video')].map((x) => x.duration).filter((x) => x > 0); return document.querySelector(c) && v.length ? v[0] : null; }, COMPOSE))));
  await t.click(COMPOSE, { scroll: false });
  await t.send('Input.insertText', { text: cap });
  await sleep(1200);
  const c = await t.ev((c: string) => ({ cap: (document.querySelector<HTMLElement>(c)?.innerText ?? '').trim(), send: document.querySelectorAll('[aria-label="Send 1 selected"]').length, aud: [...document.querySelectorAll<HTMLElement>('button,[role=button]')].map((e) => (e.innerText ?? '').trim()).filter((x) => /^Status \([^)]*\)$/.test(x)) }), COMPOSE);
  const ok = same(c.cap, cap) && c.send === 1 && c.aud.length === 1 && c.aud[0] === 'Status (Contacts)';
  // The composer fills the window now, so this picture shows only the post.
  const rel = `review/posting-whatsapp.jpg`, shot = await t.shot(epFile(j.ep, rel)).then(() => rel, () => undefined);
  const discard = async () => { await t.click('[aria-label="Close"]', { scroll: false }).catch(() => {}); await sleep(900); await t.click('button,[role=button]', { text: 'Discard', scroll: false, seconds: 5 }).catch(() => {}); };
  if (!ok || j.dry) {
    await discard();
    if (!ok) throw new ReelError(`WhatsApp’s composer didn’t read back right (${same(c.cap, cap) ? 'caption right' : 'the caption differs'}, ${c.send === 1 ? 'one Send' : `${c.send} Send buttons`}, audience ${c.aud.join(', ') || 'not found'}). Nothing was sent; your Status privacy is left as it is.`);
    return { status: 'ready', shot, note: `The reel (${Math.round(secs)} s) and the caption are in the composer, audience ${c.aud[0]}. It was discarded: nothing was sent.` };
  }
  j.say('WhatsApp: sending');
  if (j.signal.aborted) { await discard(); throw new ReelError('Stopped before Send.'); }
  j.sending?.();
  await t.click('[aria-label="Send 1 selected"]', { scroll: false });
  let row = '';
  for (let i = 0; i < 90; i++) { await sleep(2000); row = await mine(); if (row && row !== before && !/Sending|Click to add/i.test(row) && /Today|now|minute/i.test(row)) break; }
  if (!/Today|now|minute/i.test(row) || /Sending/i.test(row)) throw new ReelError(`Send was pressed once, but My status doesn’t show it yet (“${row || 'nothing'}”). It is not sent again: look at My status on your phone.`);
  return { status: 'scheduled', shot, note: `Posted to My Status (Contacts); My status shows “${row}”.` };
}
const DO: Record<Platform, (t: Tab, j: Job) => Promise<Posted>> = { instagram, facebook, youtube, whatsapp };

// ---------- the daily YouTube comment ----------
export interface PinJob { label: string; id: string; text: string }
export interface Pinned { label: string; id: string; result: 'pinned' | 'already' | 'not public' | 'would pin' | 'failed'; note?: string }
/**
 * Once a Short is public: the prepared comment, posted once as the channel and pinned (Murtaza, 24 Nov 2026: "Yes, daily
 * check"). A video that already has a comment pinned by the channel is left alone, so nothing is ever posted twice.
 * With `dry`, only looks.
 */
export async function pinComments(list: PinJob[], o: { signal: AbortSignal; dry?: boolean }): Promise<Pinned[]> {
  const handle = accounts().youtube?.handle;
  if (!handle) throw new ReelError('Which YouTube handle is it? posting.json doesn’t say.');
  if (busy) throw new ReelError('The posting browser is busy.');
  busy = true;
  const out: Pinned[] = [];
  let t: Tab | null = null;
  try {
    t = await Tab.open('about:blank', o.signal, [1680, 1000]);
    for (const v of list) {
      if (o.signal.aborted) break;
      try {
        await t.go(`https://studio.youtube.com/video/${v.id}/edit`);
        await sleep(7000);
        await needLogin(t, 'youtube');
        const vis = await t.wait('Studio’s visibility', 40, () => t!.ev(() => document.querySelector<HTMLElement>('ytcp-video-metadata-visibility')?.innerText.replace(/\s+/g, ' ').trim() || null));
        if (!/\bPublic\b/.test(vis) || /\bScheduled\b/i.test(vis)) { out.push({ label: v.label, id: v.id, result: 'not public', note: vis.slice(0, 40) }); continue; }
        await t.go(`https://www.youtube.com/watch?v=${v.id}`);
        await sleep(6000);
        const comments = async () => {
          await t!.ev(() => document.querySelector('ytd-comments')?.scrollIntoView({ block: 'start' }));
          await sleep(2500);
          return t!.ev((h: string) => [...document.querySelectorAll<HTMLElement>('ytd-comment-thread-renderer')].slice(0, 10).map((c) => ({ mine: !!c.querySelector(`a[href="/${h}"], a[href$="/${h}"]`) || (c.querySelector<HTMLElement>('#author-text')?.innerText.trim() === h), pinned: !!c.querySelector('#pinned-comment-badge ytd-pinned-comment-badge-renderer, #pinned-comment-badge:not([hidden]) *') && /Pinned by/i.test(c.querySelector<HTMLElement>('#pinned-comment-badge')?.innerText ?? ''), text: (c.querySelector<HTMLElement>('#content-text')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 80) })), handle);
        };
        await t.wait('The comments', 40, () => t!.ev(() => !!document.querySelector('ytd-comments #simplebox-placeholder, ytd-comments ytd-comment-thread-renderer') || null).then(async (x) => { if (!x) await t!.ev(() => window.scrollBy(0, 700)); return x; }));
        const now = await comments(), first = v.text.replace(/\s+/g, ' ').slice(0, 40);
        if (now.some((c) => c.mine && c.pinned)) { out.push({ label: v.label, id: v.id, result: 'already' }); continue; }
        if (o.dry) { out.push({ label: v.label, id: v.id, result: 'would pin', note: `public and not pinned yet${now.some((c) => c.mine && c.text.startsWith(first.slice(0, 30))) ? ', but our comment is there unpinned' : ''}: it would get the comment` }); continue; }
        // Posted only when our comment isn't there yet (a run stopped between posting and pinning finds it).
        if (!now.some((c) => c.mine && c.text.startsWith(first.slice(0, 30)))) {
          await t.click('ytd-comments #simplebox-placeholder');
          await sleep(1200);
          await t.click('ytd-comments #contenteditable-root');
          await t.send('Input.insertText', { text: v.text });
          await sleep(1000);
          const typed = await t.text('ytd-comments #contenteditable-root');
          if (!same(typed ?? '', v.text)) throw new ReelError('The comment didn’t read back right; nothing was posted.');
          await t.click('ytd-comments #submit-button button, ytd-comments #submit-button');
          await t.wait('The new comment', 40, async () => (await comments()).some((c) => c.mine && c.text.startsWith(first.slice(0, 30))) || null);
        }
        const menu = await t.ev((h: string, first: string) => { const c = [...document.querySelectorAll<HTMLElement>('ytd-comment-thread-renderer')].find((x) => (x.querySelector<HTMLElement>('#author-text')?.innerText.trim() === h || !!x.querySelector(`a[href$="/${h}"]`)) && (x.querySelector<HTMLElement>('#content-text')?.innerText ?? '').replace(/\s+/g, ' ').startsWith(first)); const b = c?.querySelector<HTMLElement>('#action-menu button, #action-menu yt-icon-button'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, handle, first.slice(0, 30));
        if (!menu) throw new ReelError('The comment is posted, but its menu wasn’t found to pin it. Pin it by hand.');
        await t.clickAt(menu); await sleep(1200);
        await t.click('ytd-menu-service-item-renderer, tp-yt-paper-item', { text: 'Pin', scroll: false });
        await sleep(1200);
        await t.click('yt-confirm-dialog-renderer #confirm-button button, yt-confirm-dialog-renderer #confirm-button', { scroll: false, seconds: 10 });
        await sleep(3000);
        await t.go(`https://www.youtube.com/watch?v=${v.id}`); await sleep(6000);
        await t.wait('The comments', 40, () => t!.ev(() => !!document.querySelector('ytd-comments ytd-comment-thread-renderer') || null).then(async (x) => { if (!x) await t!.ev(() => window.scrollBy(0, 700)); return x; }));
        const after = await comments();
        out.push(after.some((c) => c.mine && c.pinned) ? { label: v.label, id: v.id, result: 'pinned' } : { label: v.label, id: v.id, result: 'failed', note: 'posted, but “Pinned by” doesn’t show yet: have a look' });
      } catch (e) {
        out.push({ label: v.label, id: v.id, result: 'failed', note: e instanceof ReelError ? e.message : String((e as Error).message).slice(0, 120) });
      }
    }
  } finally { await t?.close(); busy = false; await closeBrowser(); }
  return out;
}

/** One platform after the other; each tells its result. With `dry` nothing is scheduled: it stops before the last button. */
export async function postAll(ep: Episode, list: Platform[], o: { signal: AbortSignal; dry?: boolean; sending?: () => void; say: (t: string) => void; done: (p: Platform, r: Posted | { error: string; shot?: string }) => void }): Promise<void> {
  if (busy) throw new ReelError('Another episode is being scheduled. Wait until it is done.');
  const pack = ep.pack!, dir = epFile(ep, pack.folder!), m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(pack.slot ?? '');
  if (!m) throw new ReelError('The slot isn’t set.');
  const at = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), hh: m[4], mm: m[5], dow: DAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()] };
  busy = true;
  try {
    for (const p of list) {
      let tab: Tab | null = null;
      try {
        o.say(`${TITLE[p]}: opening`);
        tab = await Tab.open('about:blank', o.signal, [1680, 900]);
        const r = await DO[p](tab, { ep, dir, at, say: o.say, signal: o.signal, dry: !!o.dry, sending: o.sending }), rel = `review/posting-${p}.jpg`;
        if (r.status === 'ready' && p !== 'whatsapp') r.shot = await tab.shot(epFile(ep, rel)).then(() => rel, () => undefined);
        o.done(p, r);
      } catch (e) {
        const rel = `review/posting-${p}.jpg`;
        // Never a picture of WhatsApp outside its composer: the chats would be in it.
        const shot = p === 'whatsapp' ? undefined : await tab?.shot(epFile(ep, rel)).then(() => rel, () => undefined);
        if (!(e instanceof ReelError)) console.warn('[reels] posting', p, (e as Error).message);
        o.done(p, { error: o.signal.aborted ? 'Stopped.' : e instanceof ReelError ? e.message : `The page didn’t work as expected (${String((e as Error).message).slice(0, 120)}).`, shot });
      } finally { await tab?.close(); }
      if (o.signal.aborted) break;
    }
  } finally { busy = false; await closeBrowser(); }
}
