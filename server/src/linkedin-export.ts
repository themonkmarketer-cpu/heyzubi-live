// LinkedIn gives apps no way to read a company Page's posts with the owner's connection, so the LinkedIn window's numbers
// come from the analytics file the owner exports from their Page (Analytics › Content › Export) and uploads here. Only
// the posts' words, links, dates and counts are kept, one file per person in the data folder; uploading again updates.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { readSheets, type Cell, type Sheet } from './sheet-read.js';

export interface LinkedInPost { id: string; title: string; kind: 'video' | 'picture' | 'album' | 'text'; link: string; thumb: string; at: number; views: number | null; likes: number | null; comments: number | null; shares: number | null }
export interface LinkedInExport { at: number; file: string; posts: LinkedInPost[] }

export class ExportError extends Error {}
export const EXPORT_MAX = 8 * 1024 * 1024;
const KEEP = 500;

const fileOf = (userId: string) => path.join(path.dirname(env.dbPath), 'linkedin-export', `${userId.replace(/[^\w-]/g, '_')}.json`);

export function linkedInExport(userId: string): LinkedInExport | null {
  try { return JSON.parse(fs.readFileSync(fileOf(userId), 'utf8')); } catch { return null; }
}
export function dropLinkedInExport(userId: string) { fs.rmSync(fileOf(userId), { force: true }); }

/** The columns, by the names LinkedIn's exports have used; the first that matches wins. */
const COLUMNS: Record<string, RegExp> = {
  title: /^((post|update|content) ?(title|text|copy|commentary)|title|commentary|post|update)$/i,
  link: /^((post|update|content) ?(link|url|permalink)|link|url|permalink)$/i,
  at: /^((post |update )?(created|published|posted)( date| on| at)?|(post|update|publish) date|date)$/i,
  type: /^((content|media) type|type|format)$/i,
  views: /^impressions?( \(total\))?$/i,
  likes: /^(likes?|reactions?)( \(total\))?$/i,
  comments: /^comments?( \(total\))?$/i,
  shares: /^(reposts?|shares?)( \(total\))?$/i,
};

const text = (v: Cell | undefined) => String(v ?? '').replace(/\s+/g, ' ').trim();
function num(v: Cell | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
  const t = text(v).replace(/[,\s ]/g, '');
  return /^\d+(\.\d+)?$/.test(t) ? Math.round(Number(t)) : null;
}
/** A date: Excel's day number, or text (LinkedIn writes month/day/year). */
function when(v: Cell | undefined): number {
  if (typeof v === 'number') return v > 20_000 && v < 80_000 ? Math.round((v - 25_569) * 86_400_000) : 0;
  const t = text(v);
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?/.exec(t);
  if (m) { const us = Number(m[1]) <= 12; return Date.UTC(Number(m[3]), Number(us ? m[1] : m[2]) - 1, Number(us ? m[2] : m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0)); }
  const d = Date.parse(t);
  return d > 946_684_800_000 ? d : 0;
}
const kindOf = (t: string): LinkedInPost['kind'] => (/video/i.test(t) ? 'video' : /multi|carousel|document|pdf|album/i.test(t) ? 'album' : /image|photo|picture/i.test(t) ? 'picture' : 'text');
const safeLink = (v: Cell | undefined) => { const t = text(v); return /^https:\/\/(www\.)?linkedin\.com\/(feed\/update|posts|company|pulse|video|showcase)\/[^\s"<>]+$/i.test(t) ? t.slice(0, 300) : ''; };

/** The posts in an exported file. Throws an ExportError with something to show when it isn't that file. */
export function parseLinkedInExport(buf: Buffer): LinkedInPost[] {
  let sheets: Sheet[];
  try { sheets = readSheets(buf); } catch (e) { throw new ExportError(e instanceof Error && /^That /.test(e.message) ? e.message : 'That file couldn’t be read. Upload the Excel or CSV file LinkedIn exported.'); }
  let totalsOnly = false;
  for (const { rows } of sheets) {
    for (let h = 0; h < Math.min(rows.length, 15); h++) {
      const col: Record<string, number> = {};
      for (const [k, re] of Object.entries(COLUMNS)) { const i = rows[h].findIndex((v) => re.test(text(v))); if (i >= 0) col[k] = i; }
      const counts = ['views', 'likes', 'comments', 'shares'].filter((k) => k in col).length;
      if (counts < 2) continue;
      if (!('link' in col) && !('title' in col)) { totalsOnly = true; continue; } // the daily totals sheet
      const posts: LinkedInPost[] = [];
      for (const r of rows.slice(h + 1)) {
        const link = safeLink(r[col.link]), title = text(r[col.title]).slice(0, 200), at = when(r[col.at]);
        if (!link && !title) continue;
        posts.push({
          id: crypto.createHash('sha256').update(link || `${title}|${at}`).digest('hex').slice(0, 16),
          title, kind: kindOf(text(r[col.type])), link, thumb: '', at,
          views: num(r[col.views]), likes: num(r[col.likes]), comments: num(r[col.comments]), shares: num(r[col.shares]),
        });
      }
      if (posts.length) return posts;
    }
  }
  throw new ExportError(totalsOnly
    ? 'That file has daily totals but no list of posts. Export the content report from your Page’s Analytics.'
    : 'No posts found in that file. Upload the content report exported from your LinkedIn Page’s Analytics.');
}

/** Reads an uploaded export and keeps it: posts seen before get their new numbers, older ones stay. */
export function saveLinkedInExport(userId: string, name: string, buf: Buffer): LinkedInExport {
  const byId = new Map((linkedInExport(userId)?.posts ?? []).map((p) => [p.id, p]));
  for (const p of parseLinkedInExport(buf)) byId.set(p.id, p);
  const out: LinkedInExport = {
    at: Date.now(),
    file: name.replace(/[\u0000-\u001f\\/]/g, ' ').trim().slice(0, 120) || 'export',
    posts: [...byId.values()].sort((a, b) => b.at - a.at).slice(0, KEEP),
  };
  const f = fileOf(userId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(out), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
  return out;
}
