// A small reader for spreadsheets a person uploads: .xlsx (zip of XML), old .xls (BIFF8 in an OLE file) and .csv. Values
// only: no formulas are run, nothing in the file is followed or fetched, and sizes are capped, as the file is untrusted.
import zlib from 'node:zlib';

export type Cell = string | number | null;
export interface Sheet { name: string; rows: Cell[][] }

const MAX_ROWS = 5000, MAX_COLS = 80, MAX_UNZIPPED = 40 * 1024 * 1024;

export function readSheets(buf: Buffer): Sheet[] {
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) return readXlsx(buf);
  if (buf.length > 512 && buf.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) return readXls(buf);
  return readCsv(buf);
}

function put(rows: Cell[][], r: number, c: number, v: Cell) {
  if (r < 0 || c < 0 || r >= MAX_ROWS || c >= MAX_COLS || v === null || v === '') return;
  while (rows.length <= r) rows.push([]);
  const row = rows[r];
  while (row.length <= c) row.push(null);
  row[c] = v;
}

// ---------- csv ----------

function readCsv(buf: Buffer): Sheet[] {
  let text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  text = text.replace(/^﻿/, '');
  if (/[\u0000]/.test(text.slice(0, 2000))) throw new Error('That isn’t a spreadsheet.');
  const first = text.slice(0, 4000);
  const sep = ['\t', ';', ','].map((s) => [s, first.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: Cell[][] = [];
  let r = 0, c = 0, cur = '', quoted = false;
  for (let i = 0; i < text.length && r < MAX_ROWS; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === sep) { put(rows, r, c++, cur.trim()); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      put(rows, r, c, cur.trim()); cur = ''; c = 0; r++;
    } else cur += ch;
  }
  put(rows, r, c, cur.trim());
  return [{ name: 'CSV', rows }];
}

// ---------- xlsx ----------

const unxml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
  if (e[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()];
  const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
});
/** What sits inside each <tag …>…</tag>, read in one pass (a pattern over a hostile file could take minutes). */
function inside(xml: string, tag: string, max = 200_000): { attrs: string; body: string }[] {
  const out: { attrs: string; body: string }[] = [];
  const close = `</${tag}>`;
  for (let p = 0; out.length < max;) {
    const a = xml.indexOf(`<${tag}`, p);
    if (a < 0) break;
    const after = xml[a + tag.length + 1];
    if (after !== ' ' && after !== '>' && after !== '/' && after !== '\n' && after !== '\r' && after !== '\t') { p = a + 1; continue; }
    const gt = xml.indexOf('>', a);
    if (gt < 0) break;
    if (xml[gt - 1] === '/') { out.push({ attrs: xml.slice(a + tag.length + 1, gt - 1), body: '' }); p = gt + 1; continue; }
    const e = xml.indexOf(close, gt);
    if (e < 0) break;
    out.push({ attrs: xml.slice(a + tag.length + 1, gt), body: xml.slice(gt + 1, e) });
    p = e + close.length;
  }
  return out;
}
/** The text of every <t> inside (a shared or inline string can be split into runs; phonetic hints are left out). */
const runs = (xml: string) => inside(xml.includes('<rPh') ? xml.split('<rPh').map((x, i) => (i ? x.split('</rPh>')[1] ?? '' : x)).join('') : xml, 't').map((m) => unxml(m.body)).join('');

function unzip(buf: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65_600; i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('That Excel file is damaged.');
  const out = new Map<string, Buffer>();
  let p = buf.readUInt32LE(end + 16), total = 0;
  for (let n = Math.min(buf.readUInt16LE(end + 10), 500); n > 0 && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n--) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), at = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    if (/^xl\/(workbook\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(name) && at + 30 <= buf.length) {
      const from = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
      const raw = buf.subarray(from, from + size);
      const data = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNZIPPED });
      total += data.length;
      if (total > MAX_UNZIPPED) throw new Error('That file is too big once unpacked.');
      out.set(name, data);
    }
    p += 46 + nl + xl + cl;
  }
  return out;
}

function readXlsx(buf: Buffer): Sheet[] {
  const z = unzip(buf);
  const get = (n: string) => z.get(n)?.toString('utf8') ?? '';
  const strings = inside(get('xl/sharedStrings.xml'), 'si').map((m) => runs(m.body));
  const rels = new Map([...get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^<>]*>/g)].map((m) => [/\bId="([^"]+)"/.exec(m[0])?.[1] ?? '', (/\bTarget="([^"]+)"/.exec(m[0])?.[1] ?? '').replace(/^\/?(xl\/)?/, 'xl/')]));
  const sheets: Sheet[] = [];
  for (const m of get('xl/workbook.xml').matchAll(/<sheet\b[^<>]*>/g)) {
    const xml = get(rels.get(/\br:id="([^"]+)"/.exec(m[0])?.[1] ?? '') ?? '');
    if (!xml) continue;
    const rows: Cell[][] = [];
    if (sheets.length >= 30) break;
    for (const c of inside(xml, 'c', 400_000)) {
      const ref = /\br="([A-Z]{1,3})(\d{1,7})"/.exec(c.attrs);
      if (!ref || !c.body) continue;
      const col = [...ref[1]].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const t = /\bt="([^"]+)"/.exec(c.attrs)?.[1] ?? 'n';
      const v = inside(c.body, 'v', 1)[0]?.body;
      put(rows, Number(ref[2]) - 1, col, t === 'inlineStr' ? runs(c.body).trim() : v === undefined ? null : t === 's' ? (strings[Number(v)] ?? '').trim() : t === 'n' ? Number(v) : unxml(v).trim());
    }
    sheets.push({ name: unxml(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? ''), rows });
  }
  return sheets;
}

// ---------- old xls (BIFF8) ----------

/** The workbook stream out of the OLE file around it. */
function oleWorkbook(buf: Buffer): Buffer {
  const size = 1 << buf.readUInt16LE(0x1e), mini = 1 << buf.readUInt16LE(0x20);
  if ((size !== 512 && size !== 4096) || mini !== 64) throw new Error('That Excel file is damaged.');
  const sector = (n: number) => buf.subarray((n + 1) * size, (n + 2) * size);
  const limit = Math.ceil(buf.length / size) + 2;
  const difat: number[] = [];
  for (let i = 0; i < 109; i++) difat.push(buf.readUInt32LE(0x4c + i * 4));
  for (let n = buf.readUInt32LE(0x44), k = 0; n < 0xfffffffa && k < limit; k++) {
    const s = sector(n);
    if (s.length < size) break;
    for (let i = 0; i < size / 4 - 1; i++) difat.push(s.readUInt32LE(i * 4));
    n = s.readUInt32LE(size - 4);
  }
  const fat: number[] = [];
  for (const n of new Set(difat)) { if (n >= 0xfffffffa) continue; const s = sector(n); for (let i = 0; i + 4 <= s.length; i += 4) fat.push(s.readUInt32LE(i)); }
  const chain = (start: number) => { const o: Buffer[] = []; for (let n = start, k = 0; n < 0xfffffffa && k < limit; k++) { o.push(sector(n)); n = fat[n] ?? 0xfffffffe; } return Buffer.concat(o); };
  const dir = chain(buf.readUInt32LE(0x30));
  let root: Buffer | null = null, book: Buffer | null = null;
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const e = dir.subarray(p, p + 128), nl = e.readUInt16LE(64);
    const name = e.toString('utf16le', 0, Math.max(0, Math.min(nl, 64) - 2));
    if (e[66] === 5) root = e;
    if (e[66] === 2 && (name === 'Workbook' || (name === 'Book' && !book))) book = e;
  }
  if (!book) throw new Error('That Excel file has no sheets.');
  const start = book.readUInt32LE(116), len = book.readUInt32LE(120);
  if (len >= buf.readUInt32LE(0x38)) return chain(start).subarray(0, len);
  if (!root) throw new Error('That Excel file is damaged.');
  const small = chain(root.readUInt32LE(116)), mf = chain(buf.readUInt32LE(0x3c));
  const parts: Buffer[] = [];
  for (let n = start, k = 0; n < 0xfffffffa && k <= len / mini + 2; k++) { parts.push(small.subarray(n * mini, (n + 1) * mini)); n = n * 4 + 4 <= mf.length ? mf.readUInt32LE(n * 4) : 0xfffffffe; }
  return Buffer.concat(parts).subarray(0, len);
}

/** The shared strings: one record plus its continuations, where a string may be cut and change width at the seam. */
function sharedStrings(parts: Buffer[]): string[] {
  let k = 0, p = 8;
  const need = () => { while (k < parts.length && p >= parts[k].length) { k++; p = 0; } return k < parts.length; };
  const u8 = () => (need() ? parts[k][p++] : 0), u16 = () => u8() | (u8() << 8), u32 = () => (u16() | (u16() << 16)) >>> 0;
  const skip = (n: number) => { while (n > 0 && need()) { const s = Math.min(n, parts[k].length - p); p += s; n -= s; } };
  const total = Math.min(parts[0].length >= 8 ? parts[0].readUInt32LE(4) : 0, 200_000);
  const out: string[] = [];
  while (out.length < total && need()) {
    let left = u16();
    let flags = u8();
    const rich = flags & 8 ? u16() : 0, ext = flags & 4 ? u32() : 0;
    let s = '';
    while (left > 0 && k < parts.length) {
      const wide = flags & 1, room = Math.floor((parts[k].length - p) / (wide ? 2 : 1)), n = Math.min(left, room);
      s += wide ? parts[k].toString('utf16le', p, p + n * 2) : parts[k].toString('latin1', p, p + n);
      p += n * (wide ? 2 : 1); left -= n;
      if (left > 0) { k++; p = 0; if (k >= parts.length || !parts[k].length) break; flags = (flags & ~1) | (parts[k][p++] & 1); }
    }
    skip(rich * 4 + ext);
    out.push(s);
  }
  return out;
}

const rk = (n: number) => {
  let v: number;
  if (n & 2) v = n >> 2;
  else { const b = Buffer.alloc(8); b.writeInt32LE(n & ~3, 4); v = b.readDoubleLE(0); }
  return n & 1 ? v / 100 : v;
};

function readXls(buf: Buffer): Sheet[] {
  const b = oleWorkbook(buf);
  const rec = (p: number) => (p + 4 <= b.length ? { type: b.readUInt16LE(p), data: b.subarray(p + 4, p + 4 + b.readUInt16LE(p + 2)), next: p + 4 + b.readUInt16LE(p + 2) } : null);
  const bounds: { name: string; at: number }[] = [];
  let strings: string[] = [];
  for (let p = 0, r = rec(0); r; p = r.next, r = rec(p)) {
    if (r.type === 0x0a) break;
    if (r.type === 0x85 && r.data.length >= 8) bounds.push({ at: r.data.readUInt32LE(0), name: r.data[7] & 1 ? r.data.toString('utf16le', 8, 8 + r.data[6] * 2) : r.data.toString('latin1', 8, 8 + r.data[6]) });
    if (r.type === 0xfc) {
      const parts = [r.data];
      for (let c = rec(r.next); c && c.type === 0x3c; c = rec(c.next)) parts.push(c.data);
      strings = sharedStrings(parts);
    }
  }
  return bounds.slice(0, 30).map(({ name, at }) => {
    const rows: Cell[][] = [];
    let depth = 0, formula: [number, number] | null = null;
    for (let p = at, r = rec(at); r; p = r.next, r = rec(p)) {
      const d = r.data;
      if (r.type === 0x809) depth++;
      else if (r.type === 0x0a) { if (--depth <= 0) break; }
      else if (depth !== 1) continue; // a chart inside the sheet
      else if (r.type === 0xfd && d.length >= 10) put(rows, d.readUInt16LE(0), d.readUInt16LE(2), (strings[d.readUInt32LE(6)] ?? '').trim());
      else if (r.type === 0x203 && d.length >= 14) put(rows, d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
      else if (r.type === 0x27e && d.length >= 10) put(rows, d.readUInt16LE(0), d.readUInt16LE(2), rk(d.readInt32LE(6)));
      else if (r.type === 0xbd && d.length >= 12) { for (let c = d.readUInt16LE(2), q = 4; q + 6 <= d.length - 2; c++, q += 6) put(rows, d.readUInt16LE(0), c, rk(d.readInt32LE(q + 2))); }
      else if (r.type === 0x204 && d.length >= 9) { const n = d.readUInt16LE(6); put(rows, d.readUInt16LE(0), d.readUInt16LE(2), (d[8] & 1 ? d.toString('utf16le', 9, 9 + n * 2) : d.toString('latin1', 9, 9 + n)).trim()); }
      else if (r.type === 0x06 && d.length >= 14) {
        if (d.readUInt16LE(12) === 0xffff) formula = d[6] === 0 ? [d.readUInt16LE(0), d.readUInt16LE(2)] : null;
        else put(rows, d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
      } else if (r.type === 0x207 && formula && d.length >= 3) { const n = d.readUInt16LE(0); put(rows, formula[0], formula[1], d[2] & 1 ? d.toString('utf16le', 3, 3 + n * 2) : d.toString('latin1', 3, 3 + n)); formula = null; }
    }
    return { name, rows };
  });
}
