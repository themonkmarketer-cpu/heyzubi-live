// The phone and laptop screens, built before any render: five fixed designs (lock screen, AI Employees dashboard, work
// list, Telegram report, text thread) filled with the episode's words. Every word is escaped; nothing is loaded.
import fs from 'node:fs';
import path from 'node:path';
import { shoot } from './media.js';
import { ensureDir, epFile } from './store.js';
import type { Episode, Script } from './types.js';

const e = (v: unknown, max = 160) => String(v ?? '').slice(0, max).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hex = (v: unknown, d = '#0891b2') => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : d);
const mix = (h: string, w: number) => `#${[1, 3, 5].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * (1 - w) + 255 * w).toString(16).padStart(2, '0')).join('')}`;
const FONT = '"Inter","Liberation Sans","Noto Color Emoji",Arial,sans-serif';
const page = (title: string, css: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${e(title)}</title><style>*{box-sizing:border-box;margin:0;padding:0}${css}</style></head><body>${body}</body></html>`;
const STATUS = '.status{height:150px;display:flex;justify-content:space-between;align-items:center;padding:40px 90px 0;font-size:50px;font-weight:700}';
/** Type as big as the longest line allows: these phones are small in the frame. */
const fit = (texts: unknown[], steps: [number, number][], last: number) => { const n = Math.max(0, ...texts.map((t) => String(t ?? '').length)); return steps.find(([len]) => n <= len)?.[1] ?? last; };
const bar = (t: unknown) => `<div class="status"><span>${e(t, 8)}</span><span>●●● ▮</span></div>`;

/** Phone lock screen: the problem, as three different notifications at most. */
const lock = (d: any) => page('lock', `body{width:1290px;height:2796px;overflow:hidden;font-family:${FONT};color:#fff;background:linear-gradient(170deg,#3b2a5a 0%,#8a4b3c 55%,#d9894a 100%)}${STATUS}.date{text-align:center;font-size:62px;font-weight:600;margin-top:70px;opacity:.9}.time{text-align:center;font-size:270px;font-weight:700;line-height:1;margin-top:10px;letter-spacing:-6px}.list{margin:90px 30px 0;display:flex;flex-direction:column;gap:30px;zoom:1.3}.n{display:flex;gap:34px;background:rgba(245,245,247,.9);color:#111;border-radius:56px;padding:40px 44px}.ic{width:110px;height:110px;border-radius:26px;background:#34c759;display:grid;place-items:center;font-size:64px;flex:none}.tx{flex:1}.hd{display:flex;justify-content:space-between;font-size:46px}.hd span{color:#6e6e73;font-size:40px}.bd{font-size:54px;line-height:1.32;margin-top:8px}.more{text-align:center;font-size:${fit([d.more], [[14, 190], [30, 160], [40, 120]], 90)}px;font-weight:900;line-height:1.12;margin:100px 50px 0}`,
  `${bar(d.time)}<div class="date">${e(d.date, 40)}</div><div class="time">${e(d.time, 8)}</div><div class="list">${(d.items ?? []).slice(0, 2).map((x: any) => `<div class="n"><div class="ic">${e(x.icon ?? '💬', 4)}</div><div class="tx"><div class="hd"><b>${e(x.from, 30)}</b><span>${e(x.when, 12)}</span></div><div class="bd">${e(x.text, 80)}</div></div></div>`).join('')}</div><div class="more">${e(d.more, 40)}</div>`);

/** Laptop: the AI Employees dashboard with this episode's one lit up. */
const dashboard = (d: any, s: Script) => {
  const c = hex(s.aiEmployee.color);
  const others = [['💬', 'Support', 'Answering', '#3b82f6'], ['📝', 'Quotes', 'Ready', '#8b5cf6'], ['🛒', 'Sales', 'Ready', '#f59e0b']].filter((o) => o[1].toLowerCase() !== s.aiEmployee.name.toLowerCase()).slice(0, 3);
  const card = (o: string[], on = false) => `<div class="card"${on ? ` style="border-color:${c};box-shadow:0 0 40px ${c}aa"` : ''}><div class="icon" style="background:${o[3]}">${e(o[0], 4)}</div><div class="name">${e(o[1], 14)}</div><div class="status">${e(o[2], 14)}</div></div>`;
  return page('My AI Employees', `body{width:1600px;height:1000px;background:#0f1117;font-family:${FONT};color:#f2f4f8;padding:56px 64px;overflow:hidden}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:44px}h1{font-size:64px;font-weight:800;letter-spacing:-1px}.live{font-size:30px;font-weight:700;color:#3ddc84;display:flex;align-items:center;gap:14px}.dot{width:22px;height:22px;border-radius:50%;background:#3ddc84;box-shadow:0 0 24px #3ddc84}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:28px;margin-bottom:44px}.card{background:#1a1d27;border-radius:28px;padding:34px 30px;border:2px solid #262a37}.icon{width:84px;height:84px;border-radius:22px;display:grid;place-items:center;font-size:46px;margin-bottom:22px}.name{font-size:38px;font-weight:800;margin-bottom:10px;white-space:nowrap}.status{font-size:26px;color:#3ddc84;font-weight:700}.feed{background:#1a1d27;border-radius:28px;padding:30px 38px;border:2px solid #262a37}.row{display:flex;align-items:center;gap:22px;font-size:34px;font-weight:600;padding:16px 0;border-bottom:2px solid #262a37}.row:last-child{border-bottom:none}.check{color:#3ddc84;font-size:38px}`,
    `<header><h1>My AI Employees</h1><div class="live"><span class="dot"></span>All working</div></header><div class="grid">${card(others[0])}${card(others[1] ?? others[0])}${card([s.aiEmployee.icon, s.aiEmployee.name, d.status ?? 'Working', c], true)}${card(others[2] ?? others[0])}</div><div class="feed">${(d.rows ?? s.aiEmployee.does).slice(0, 3).map((r: unknown) => `<div class="row"><span class="check">✔</span>${e(r, 60)}</div>`).join('')}</div>`);
};

/** Laptop: the list of what it did. */
const list = (d: any, s: Script) => {
  const two = !(d.rows ?? []).some((r: any) => r.b || r.c);
  const c = hex(s.aiEmployee.color), soft = mix(c, 0.92), mid = mix(c, 0.82);
  return page('list', `body{width:1600px;height:1000px;background:${soft};font-family:${FONT};color:#12302d;overflow:hidden}.chrome{height:64px;background:${mid};display:flex;align-items:center;gap:14px;padding:0 24px}.chrome i{width:18px;height:18px;border-radius:50%;display:inline-block}.url{margin-left:30px;flex:1;height:40px;background:#fff;border-radius:20px;display:flex;align-items:center;padding-left:24px;font-size:22px;color:#5b7472}.wrap{padding:30px 70px}.top{display:flex;flex-wrap:wrap;gap:22px;justify-content:space-between;align-items:flex-end;margin-bottom:30px}h1{font-size:${fit([d.title], [[34, 64]], 52)}px;white-space:nowrap}.sum{display:flex;gap:16px}.pill{font-size:32px;font-weight:800;padding:12px 24px;border-radius:30px;white-space:nowrap}.o{background:${mid};color:#7a1f3d}.b{background:#dcfce7;color:#15803d}.g{background:#fef3c7;color:#b45309}.row{display:grid;grid-template-columns:${two ? '1fr auto' : '270px 1fr 290px 320px'};align-items:center;background:#fff;border-radius:20px;padding:${two ? '44px 40px' : '30px'};margin-bottom:24px;font-size:${two ? 54 : 37}px;box-shadow:0 6px 18px rgba(18,48,45,.06)}.sh{color:#5b7472;font-weight:600}.ok{color:#15803d;font-weight:800;text-align:right}.last{opacity:.8}.last .ok{color:#b45309}`,
    `<div class="chrome"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><div class="url">🔒 ${e(d.url, 70)}</div></div><div class="wrap"><div class="top"><h1>${e(d.title, 44)}</h1><div class="sum">${(d.pills ?? []).slice(0, 3).map((p: unknown, i: number) => `<span class="pill ${'obg'[i]}">${e(p, 24)}</span>`).join('')}</div></div>${(d.rows ?? []).slice(0, 3).map((r: any) => `<div class="row">${two ? `<span><b>${e(r.a, 34)}</b></span>` : `<span><b>${e(r.a, 18)}</b></span><span>${e(r.b, 28)}</span><span class="sh">${e(r.c, 18)}</span>`}<span class="ok">${e(r.d, 18)}</span></div>`).join('')}${d.last && !two ? `<div class="row last"><span>${e(d.last.a, 18)}</span><span>${e(d.last.b, 34)}</span><span class="sh">${e(d.last.c, 22)}</span><span class="ok">${e(d.last.d, 22)}</span></div>` : ''}</div>`);
};

/** Phone: the Telegram report from the AI Employee. */
const telegram = (d: any, s: Script, h: number) => page('telegram', `body{width:1290px;height:${h}px;font-family:${FONT};position:relative;overflow:hidden;color:#111;background:#cfe0ee radial-gradient(rgba(255,255,255,.4) 3px,transparent 4px);background-size:90px 90px}${STATUS}.status{background:#fff;height:250px}.bar{background:#fff;display:flex;align-items:center;gap:36px;padding:20px 50px 34px;border-bottom:2px solid #ddd}.back{font-size:80px;color:#2a8ad8}.av{width:140px;height:140px;border-radius:50%;display:grid;place-items:center;font-size:74px;flex:none}.ttl{font-size:58px;font-weight:800;white-space:nowrap}.sub{font-size:44px;color:#8a8a8a;margin-top:6px}.chat{padding:50px 40px;display:flex;flex-direction:column;gap:30px;zoom:1.3}.day{align-self:center;background:rgba(40,80,120,.45);color:#fff;font-size:40px;font-weight:700;padding:10px 34px;border-radius:40px}.msg{align-self:flex-start;max-width:900px;background:#fff;border-radius:44px 44px 44px 12px;padding:40px 48px 26px;font-size:50px;line-height:1.4;box-shadow:0 3px 2px rgba(0,0,0,.12)}.t{display:block;text-align:right;font-size:36px;color:#9aa19a;margin-top:10px}.big{font-size:80px;font-weight:800;color:#16a34a;display:block;margin:6px 0;line-height:1.15}.req{display:flex;gap:60px;justify-content:space-between;border-top:2px solid #eee;padding:22px 0;font-size:48px}.req span{color:#6d28d9;font-weight:800}.input{position:absolute;bottom:0;left:0;right:0;height:230px;background:#fff;display:flex;align-items:center;gap:30px;padding:0 50px 40px;font-size:48px;color:#9a9a9a;border-top:2px solid #ddd}.input .f{flex:1}`,
  `${bar(d.time)}<div class="bar"><span class="back">‹</span><div class="av" style="background:${hex(s.aiEmployee.color)}">${e(s.aiEmployee.icon, 4)}</div><div><div class="ttl">${e(s.aiEmployee.name, 16)} AI Employee</div><div class="sub">bot</div></div></div><div class="chat"><div class="day">${e(d.day ?? 'Today', 24)}</div><div class="msg">📤 <b>${e(d.sent?.bold, 50)}</b> ${e(d.sent?.text, 110)}<span class="t">${e(d.sent?.at, 12)}</span></div><div class="msg">✅ <b>${e(d.result?.bold ?? 'Today', 24)}</b><span class="big">${e(d.result?.big, 40)}</span>${e(d.result?.text, 60)}<span class="t">${e(d.result?.at, 12)}</span></div><div class="msg">📊 ${e(d.day ?? 'Today', 24)}:${(d.stats ?? []).slice(0, 3).map((x: any) => `<div class="req"><b>${e(x.label, 30)}</b><span>${e(x.value, 14)}</span></div>`).join('')}<span class="t">${e(d.statsAt ?? d.result?.at, 12)}</span></div></div><div class="input"><span>📎</span><span class="f">Message</span><span>🎤</span></div>`);

/** Phone: the text the customer got. */
const text = (d: any, s: Script, h: number) => {
  const mail = d.kind === 'email', c = hex(s.aiEmployee.color), ms = (d.messages ?? []).slice(0, 4), size = fit(ms.filter((m: any) => !m.big).map((m: any) => m.text), [[12, 150], [18, 120], [34, 92], [70, 72]], 58);
  const msg = (m: any) => `<div class="${m.side === 'out' ? 'out' : 'in'}" style="font-size:${m.big ? (String(m.text ?? '').length <= 5 ? 400 : 200) : size}px;${m.big ? 'font-weight:900;line-height:1;' : size > 80 ? 'font-weight:700;line-height:1.18;' : ''}">${e(m.text, 170)}</div>`;
  if (mail) return page('email', `body{width:1290px;height:${h}px;font-family:${FONT};background:#fff;color:#111;position:relative;overflow:hidden}.status{height:235px;display:flex;justify-content:space-between;align-items:center;padding:10px 90px 0;font-size:50px;font-weight:700}.bar{background:${c};color:#fff;padding:50px 60px;font-size:92px;font-weight:800}.bar small{display:block;font-size:60px;font-weight:600;margin-top:8px}.chat{padding:20px 46px;display:flex;flex-direction:column}.in,.out{margin-top:46px;border-radius:60px;padding:46px 60px;font-weight:700}.in{background:${mix(c, 0.9)};align-self:flex-start}.out{background:#2563eb;color:#fff;align-self:flex-end}.foot{position:absolute;bottom:70px;left:0;right:0;text-align:center;font-size:54px;color:#78716c}`,
    `<div class="status"><span>${e(d.time, 8)}</span><span>●●● ▮</span></div><div class="bar">${e(d.from, 24)}<small>${e(d.subject ?? d.when, 44)}</small></div><div class="chat">${ms.map(msg).join('')}</div><div class="foot">Unsubscribe any time</div>`);
  return page('text', `body{width:1290px;height:${h}px;font-family:${FONT};position:relative;overflow:hidden;background:#fff;color:#111}${STATUS}.bar{display:flex;flex-direction:column;align-items:center;padding:20px 0 30px;border-bottom:2px solid #eee;background:#f7f7f8}.back{position:absolute;left:50px;top:190px;font-size:80px;color:#0a84ff}.av{width:170px;height:170px;border-radius:50%;display:grid;place-items:center;font-size:80px;color:#fff;font-weight:700}.ttl{font-size:46px;font-weight:600;margin-top:14px}.chat{padding:60px 46px;display:flex;flex-direction:column;gap:30px}.when{align-self:center;font-size:38px;color:#8e8e93;margin-top:20px}.in{align-self:flex-start;max-width:1020px;background:#e9e9eb;border-radius:50px;padding:36px 46px;font-size:58px;line-height:1.38}.out{align-self:flex-end;max-width:1020px;background:#0a84ff;color:#fff;border-radius:50px;padding:36px 46px;font-size:58px;line-height:1.38}.input{position:absolute;bottom:0;left:0;right:0;height:230px;display:flex;align-items:center;gap:30px;padding:0 50px 40px;font-size:48px;color:#9a9a9a;border-top:2px solid #eee}.input .f{flex:1;border:3px solid #ddd;border-radius:60px;padding:24px 40px}`,
  `${bar(d.time)}<span class="back">‹</span><div class="bar"><div class="av" style="background:${hex(s.aiEmployee.color)}">${e(String(d.from ?? 'S')[0], 2)}</div><div class="ttl">${e(d.from, 24)} ›</div></div><div class="chat"><div class="when">${e(d.when, 24)}</div>${ms.map(msg).join('')}</div><div class="input"><span>＋</span><span class="f">Text Message</span><span>🎤</span></div>`);
};

export const SCREEN_KINDS: Record<string, { kind: string; title: string; w: number; h: number }> = {
  s1: { kind: 'lock', title: 'The owner’s phone: the problem', w: 1290, h: 2796 },
  s2: { kind: 'dashboard', title: 'Laptop: the AI Employees', w: 1600, h: 1000 },
  s3: { kind: 'list', title: 'Laptop: what it did', w: 1600, h: 1000 },
  s4: { kind: 'telegram', title: 'The owner’s phone: Telegram report', w: 1290, h: 2700 },
  s5: { kind: 'text', title: 'The customer’s phone: the text', w: 1290, h: 2260 },
};
export function screenHtml(id: string, s: Script): string {
  const d = s.screens[id] ?? {};
  return id === 's1' ? lock(d) : id === 's2' ? dashboard(d, s) : id === 's3' ? list(d, s) : id === 's4' ? telegram(d, s, 2700) : text(d, s, 2260);
}
export async function buildScreens(ep: Episode, onProgress: (t: string) => void): Promise<Episode['screens']> {
  const s = ep.script!, out: Episode['screens'] = [];
  for (const [id, k] of Object.entries(SCREEN_KINDS)) {
    if (!s.screens[id]) continue;
    onProgress(`Drawing ${k.title.toLowerCase()}`);
    const html = ensureDir(epFile(ep, `screens/${id}.html`)), png = epFile(ep, `screens/${id}.png`);
    fs.writeFileSync(html, screenHtml(id, s));
    await shoot(html, png, k.w, k.h);
    out.push({ id, kind: k.kind, title: k.title, html: path.posix.join('screens', `${id}.html`), png: path.posix.join('screens', `${id}.png`) });
  }
  return out;
}
