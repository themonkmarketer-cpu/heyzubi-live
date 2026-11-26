import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seriesDir } from './store.js';
import { writeHandoffs } from './handoff.js';

/**
 * Registers an episode's landing page once it is live: takes a small picture of the page (a throwaway headless
 * Chromium, never the posting browser's profile), saves it as series/pages/epNN.jpg, and records the link in
 * series.json: on the episode's history entry, or for an episode made in HeyZubi under `pages`. The episode's card then
 * shows the page. Run on the box by the PC's bridge:
 *
 *   node --env-file=<app env> server/dist/reels/register-page.js <episode number> <https page link>
 */
const [numArg, url] = process.argv.slice(2);
const num = Number(numArg);
if (!Number.isInteger(num) || num < 1 || !/^https:\/\/[\w.-]+\/[\w./-]*$/.test(url ?? '')) {
  console.error('Usage: register-page.js <episode number> <https page link>');
  process.exit(2);
}

const two = String(num).padStart(2, '0');
const rel = `pages/ep${two}.jpg`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heyzubi-page-'));
try {
  const png = path.join(tmp, 'page.png');
  execFileSync('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${path.join(tmp, 'profile')}`,
    '--window-size=1280,800', '--force-device-scale-factor=0.5', '--virtual-time-budget=8000', `--screenshot=${png}`, url], { stdio: 'ignore', timeout: 90_000 });
  if (!fs.existsSync(png)) throw new Error('the page picture was not taken');
  fs.mkdirSync(path.join(seriesDir(), 'pages'), { recursive: true });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', png, '-q:v', '4', path.join(seriesDir(), rel)], { stdio: 'ignore', timeout: 60_000 });

  const f = path.join(seriesDir(), 'series.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  const past = (s.history ?? []).find((h: { num: number }) => h.num === num);
  if (past) { past.page = url; past.pagePreview = rel; } else { s.pages = { ...(s.pages ?? {}), [String(num)]: { url, preview: rel } }; }
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2));
  fs.renameSync(`${f}.tmp`, f);
  await writeHandoffs(); // the hand-off records the page too
  console.log(JSON.stringify({ ok: true, num, url, preview: rel, where: past ? 'history' : 'pages' }));
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }));
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
