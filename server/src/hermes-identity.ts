import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { AVATAR_FILL, avatarMarkup, lookOf, propFor } from './avatar-props.js';
import { db } from './db.js';
import { hermesTarget, type Owner } from './engine.js';
import { ZUBI_MASCOT_SVG } from './zubi-mascot.js';

/**
 * One identity in both places. A team member that is a Hermes profile (the main bot is the default profile) shows in
 * Hermes with the same name and the same mascot as in HeyZubi: HeyZubi writes them into the profile, in the fields
 * Hermes's own Bots roster reads (`profile.yaml` display_name, plus the Bots title when Hermes keeps one, and
 * `assets/avatar.png`). The soul needs no copying: HeyZubi and Hermes read the same SOUL.md in the profile.
 * HeyZubi is the source; a name changed in Hermes is set back on the next sync.
 */

const AVATAR_PX = 256;

/** The bot's avatar as a standalone SVG (the main bot is Zubi, the HeyZubi mascot). */
function avatarSvg(b: any): string {
  if (b.engine === 'primary' || b.is_primary) {
    return ZUBI_MASCOT_SVG.replace("viewBox='-10 -10 120 120'", `viewBox='-3 -3 106 106' width='${AVATAR_PX}' height='${AVATAR_PX}'`);
  }
  const look = lookOf(b.avatar_shape, propFor({ avatarProp: b.avatar_prop, name: b.name, label: b.label, description: b.description }));
  const fill = AVATAR_FILL[b.avatar_color as string] ?? AVATAR_FILL.blue;
  const [x, y, w, h] = look.box;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_PX}" height="${AVATAR_PX}" viewBox="${x - 3} ${y - 3} ${w + 6} ${h + 6}">${avatarMarkup(look, fill)}</svg>`;
}

/** SVG to a transparent PNG with the computer's Chromium (headless, a throwaway profile). */
function renderPng(svg: string): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-avatar-'));
  const html = path.join(dir, 'a.html');
  const png = path.join(dir, 'a.png');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>${svg}`);
  return new Promise((resolve, reject) => {
    execFile('chromium', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      `--user-data-dir=${path.join(dir, 'profile')}`, '--default-background-color=00000000',
      `--window-size=${AVATAR_PX},${AVATAR_PX}`, `--screenshot=${png}`, `file://${html}`,
    ], { timeout: 45_000 }, (err) => {
      try {
        if (!fs.existsSync(png)) return reject(err ?? new Error('no picture was made'));
        resolve(fs.readFileSync(png));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

function writeOwned(file: string, data: string | Buffer, owner: Owner | null, mode = 0o644) {
  const tmp = `${file}.heyzubi-tmp`;
  fs.writeFileSync(tmp, data, { mode });
  if (owner) fs.chownSync(tmp, owner.uid, owner.gid);
  fs.renameSync(tmp, file);
}

/** profile.yaml: the display name (and the Bots title, when Hermes keeps one). Comments and other keys are kept. */
function syncName(dir: string, name: string, owner: Owner | null): boolean {
  const file = path.join(dir, 'profile.yaml');
  const doc = fs.existsSync(file) ? YAML.parseDocument(fs.readFileSync(file, 'utf8')) : new YAML.Document({});
  if (doc.errors.length) throw new Error(`${file} could not be read, so it was left alone`);
  let changed = false;
  if (doc.get('display_name') !== name) { doc.set('display_name', name); changed = true; }
  const bots = doc.getIn(['ui_meta', 'hermes-bots']);
  if (bots && YAML.isMap(bots) && bots.get('title') !== name) {
    doc.setIn(['ui_meta', 'hermes-bots', 'title'], name);
    // Hermes clients compare-and-set ui_meta by revision: move it on so theirs notice the change.
    const rev = Number(doc.getIn(['_ui_meta_revisions', 'hermes-bots']) ?? 0);
    doc.setIn(['_ui_meta_revisions', 'hermes-bots'], (Number.isFinite(rev) ? rev : 0) + 1);
    changed = true;
  }
  if (changed) writeOwned(file, doc.toString(), owner);
  return changed;
}

/** assets/avatar.png, redrawn only when the drawing changed (its hash is kept beside it). */
async function syncAvatar(dir: string, svg: string, owner: Owner | null): Promise<boolean> {
  const assets = path.join(dir, 'assets');
  const stamp = path.join(assets, '.heyzubi-avatar');
  const hash = crypto.createHash('sha256').update(svg).digest('hex');
  const png = path.join(assets, 'avatar.png');
  try { if (fs.readFileSync(stamp, 'utf8').trim() === hash && fs.existsSync(png)) return false; } catch { /* first time */ }
  const blob = await renderPng(svg);
  fs.mkdirSync(assets, { recursive: true });
  if (owner) fs.chownSync(assets, owner.uid, owner.gid);
  // One avatar file per profile, as Hermes keeps it.
  for (const ext of ['jpg', 'webp']) fs.rmSync(path.join(assets, `avatar.${ext}`), { force: true });
  writeOwned(png, blob, owner);
  writeOwned(stamp, `${hash}\n`, owner);
  return true;
}

const queue = new Map<string, Promise<void>>();

/** Bring the bot's Hermes profile in line with HeyZubi. Calls for one bot run one after another; errors are logged. */
export function syncIdentity(botId: string): Promise<void> {
  const prev = queue.get(botId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const b = db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;
    const target = b ? hermesTarget(botId) : null;
    if (!b || !target || !fs.existsSync(target.dir)) return;
    const named = syncName(target.dir, String(b.name).slice(0, 64), target.owner);
    const drawn = await syncAvatar(target.dir, avatarSvg(b), target.owner);
    if (named || drawn) console.log(`[identity] ${b.name}: Hermes profile ${target.label} now shows${named ? ' the same name' : ''}${named && drawn ? ' and' : ''}${drawn ? ' the same mascot' : ''}`);
  }).catch((e: any) => console.warn(`[identity] ${botId}: ${e?.message ?? e}`));
  queue.set(botId, next);
  void next.finally(() => { if (queue.get(botId) === next) queue.delete(botId); });
  return next;
}

/** On server start: every bot that is a Hermes profile. */
export function syncAllIdentities() {
  const bots = db.prepare("SELECT id FROM bots WHERE engine='primary' OR (engine='managed' AND hermes_profile IS NOT NULL)").all() as { id: string }[];
  for (const b of bots) void syncIdentity(b.id);
}
