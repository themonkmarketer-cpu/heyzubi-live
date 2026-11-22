import fs from 'node:fs';
import { box } from './box.js';
import { env } from './env.js';

/**
 * The folder on the shared computer that holds each bot's browser profile and Library files.
 * Computers set up before the project was renamed have `/root/bothq` (Bot HQ) or `/root/grokbot`; they
 * keep using it (moving it would pull the folder out from under running browsers). server/box/hqlib.py
 * applies the same rule.
 */
const CURRENT = '/root/heyzubi';
const LEGACY = ['/root/bothq', '/root/grokbot'];
/** The current folder if it is there, else the first older one that is, else the current one. */
const pick = (exists: (dir: string) => boolean) => (exists(CURRENT) ? CURRENT : LEGACY.find(exists) ?? CURRENT);

let boxData = env.localBox ? pick((d) => fs.existsSync(d)) : CURRENT;

export const libraryRoot = () => `${boxData}/files`;
export const profilesRoot = () => `${boxData}/profiles`;

/** Without HQ_LOCAL the computer is reached through Orgo's API: ask it once which folder it has. */
export async function resolveBoxData(): Promise<void> {
  if (env.localBox || !env.orgoComputerId) return;
  const r = await box.bash([CURRENT, ...LEGACY].map((d) => `[ -d ${d} ] && echo has:${d};`).join(' ') + ' true', 30);
  boxData = pick((d) => r.output.split('\n').includes(`has:${d}`));
}
