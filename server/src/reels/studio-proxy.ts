// The HyperFrames editor, shown inside the app. It answers on an address of its own (HQ_EDITOR_ORIGIN, another port of the
// same host), so its code and the episode's page run apart from the app: they can't read the app or act with its sign-in
// (its API refuses writes from any other origin). Only the owner of the episode gets in, and only what editing needs is
// passed on: no sharing, no publishing, no installing, no rendering from in there.
import { env } from '../env.js';
import { userFromCookieHeader } from '../lib/auth.js';
import { allEpisodes, ownerOf } from './store.js';
import { editorOrigin, projectName, studioPort, studioReady, studioUse } from './studio.js';
import type { Episode } from './types.js';

const host = () => { try { return new URL(editorOrigin()).host.toLowerCase(); } catch { return ''; } };
export const isEditorHost = (h: string | null | undefined) => !!h && !!host() && h.toLowerCase() === host();

const READS = [/^\/$/, /^\/(assets|icons)\/[\w.-]+$/, /^\/favicon\.svg$/, /^\/api\/(runtime\.js|events|fonts|fonts\/file|environment\/ffmpeg|registry\/blocks|projects)$/, /^\/api\/media-jobs\/[\w-]+\/progress$/];
const NO = /^(render|renders|registry|share|publish|open|desktop)(\/|$)/;
const NAME = /^\/api\/projects\/(ep\d{2,4})(?:\/(.*))?$/;

function page(text: string, status: 401 | 403 | 404 | 502 | 503) {
  return new Response(`<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;height:100vh;font:15px system-ui,sans-serif;color:#555">${text}</body>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': ancestors() } });
}
const ancestors = () => { const more = String(process.env.HQ_FRAME_ANCESTORS ?? '').split(/[\s,]+/).filter((o) => /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(o)); let app = ''; try { app = new URL(env.appUrl).origin; } catch { /* none */ } return `frame-ancestors 'self' ${[app, ...more].filter(Boolean).join(' ')}`; };
// Nothing in there may talk to anyone but this address.
const csp = () => `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'; ${ancestors()}`;

/** The editor opened for the first time: only the picture, the line of shots and what the clicked thing is made of. */
const BOOT = (name: string, dark: boolean, app: string) => {
  const panel = (id: string, title: string, w = 200, h?: number) => ({ id, contentComponent: 'panel', tabComponent: 'props.defaultTabComponent', title, renderer: 'always', minimumWidth: w, ...(h ? { minimumHeight: h } : {}) });
  const layout = { grid: { root: { type: 'branch', data: [{ type: 'branch', data: [{ type: 'branch', data: [{ type: 'leaf', data: { views: ['preview'], activeView: 'preview', id: '1' }, size: 1180 }, { type: 'leaf', data: { views: ['design', 'assets'], activeView: 'design', id: '2' }, size: 300 }], size: 520 }, { type: 'leaf', data: { views: ['timeline'], activeView: 'timeline', id: '3' }, size: 340 }], size: 1480 }], size: 860 }, width: 1480, height: 860, orientation: 'HORIZONTAL' }, panels: { preview: panel('preview', 'Preview', 320, 160), timeline: panel('timeline', 'Timeline', 100, 100), design: panel('design', 'Design', 200), assets: panel('assets', 'Assets', 200) }, activeGroup: '1' };
  return String.raw`<style>[data-testid="header-open-in-desktop"],[data-testid="header-export"],.hz-hide,.hz-sec{display:none!important}</style><script>(function(){
try{var G='hf-studio-ui-preferences',K=G+':${name}';var g={};try{g=JSON.parse(localStorage.getItem(G)||'{}')}catch(e){}g.theme='${dark ? 'dark' : 'light'}';if(g.rippleEditEnabled===undefined)g.rippleEditEnabled=true;localStorage.setItem(G,JSON.stringify(g));
if(!localStorage.getItem('hz-layout:${name}')){localStorage.setItem('hz-layout:${name}','1');localStorage.setItem(K,JSON.stringify({dockLayout:${JSON.stringify(layout)}}));}
localStorage.setItem('hyperframes-studio:telemetryNoticeShown','1');}catch(e){}
window.__HF_CLI_TELEMETRY_DISABLED=true;
var APP=${JSON.stringify(app)};function tell(m){try{parent.postMessage(Object.assign({heyzubiEditor:'${name}'},m),APP)}catch(e){}}
var last='';setInterval(function(){var q=new URLSearchParams((location.hash.split('?')[1])||'');var s=q.get('selId')||'',t=q.get('t')||'0';if(s+'|'+t!==last){var ch=last.split('|')[0]!==s;last=s+'|'+t;if(ch){setTimeout(tidy,60);setTimeout(tidy,500)}tell({sel:s,t:parseFloat(t)||0})}},300);
var f=window.fetch;window.fetch=function(i,o){if(o&&o.credentials==='omit')o=Object.assign({},o,{credentials:'same-origin'});var r=f.call(this,i,o);var m=((o&&o.method)||(i&&i.method)||'GET').toUpperCase(),u=String((i&&i.url)||i);if(m!=='GET'&&m!=='HEAD'&&/\/api\/projects\/[^/]+\/(files|file-mutations|gsap)/.test(u))r.then(function(x){if(x.ok)tell({saved:Date.now()})},function(){});return r};
var HIDE=/^(Share|Export|Capture|Lint|Inspector|Switch to (dark|light) theme|Install the desktop app|Get the free HyperFrames desktop app|Ask agent about this element|Record gesture.*)$/;
var NAMES=['Style','Motion','Overlays'],done='';
function tidy(){var b=document.querySelectorAll('button,a'),i,e;for(i=0;i<b.length;i++){e=b[i];if(e.classList.contains('hz-hide'))continue;var t=(e.getAttribute('aria-label')||'').trim()||(e.innerText||'').replace(/\s+/g,' ').trim(),u=(e.innerText||'').split('\n')[0].trim();if(HIDE.test(t)||HIDE.test(u))e.classList.add('hz-hide')}
var id=last.split('|')[0],shot=/^p[12]s[0-9]/.test(id),sp=document.querySelectorAll('span'),media=null,shut=false,old=document.querySelectorAll('.hz-sec');for(i=0;i<old.length;i++)old[i].classList.remove('hz-sec');
for(i=0;i<sp.length;i++){e=sp[i];var x=e.textContent;if(x.length<60&&x.indexOf('Describe a change to the agent')>=0){var d=e.closest('div');if(d)d.classList.add('hz-hide');continue}
if(x!=='Media'&&NAMES.indexOf(x)<0)continue;var bt=e.closest('button'),box=bt||(e.parentElement&&e.parentElement.parentElement),up=box&&box.parentElement;if(!up||!/flex-1 flex-col/.test(up.className))continue;
if(x==='Media'){media=bt;continue}var hide=shot?true:x!=='Style';if(hide)box.classList.add('hz-sec');if(hide&&!bt&&x==='Style')shut=true}
if(shot&&shut&&media&&done!==id){done=id;media.click()}}
var w=0;new MutationObserver(function(){if(w)return;w=setTimeout(function(){w=0;tidy()},150)}).observe(document.documentElement,{childList:true,subtree:true});
})();</script>`;
};

function episodeOf(name: string, userId: string): Episode | null {
  return allEpisodes().find((e) => projectName(e) === name && ownerOf(e.id) === userId) ?? null;
}

export async function editorFetch(req: Request): Promise<Response> {
  if (!studioReady()) return page('The editor isn’t set up here.', 404);
  const url = new URL(req.url), p = url.pathname, read = ['GET', 'HEAD'].includes(req.method), site = req.headers.get('sec-fetch-site');
  // Everything comes from the editor's own page; the page itself is opened by the app's frame.
  if (!read && (req.headers.get('origin') !== editorOrigin() || (site && site !== 'same-origin'))) return page('Refused.', 403);
  if (read && site && !['same-origin', 'none'].includes(site) && !(site === 'same-site' && p === '/')) return page('Refused.', 403);
  const user = userFromCookieHeader(req.headers.get('cookie') ?? undefined);
  if (!user) return page('Sign in to the app first, then open the editor again.', 401);
  const m = NAME.exec(p);
  if (!(m ? !NO.test(m[2] ?? '') && (read || !!m[2]) : read && READS.some((r) => r.test(p)))) return page('Not available in here.', 403);
  const ref = (() => { try { return new URL(req.headers.get('referer') ?? '').searchParams.get('ep'); } catch { return null; } })();
  const name = m?.[1] ?? (p === '/' ? url.searchParams.get('ep') : ref) ?? /(?:^|;\s*)hz_editor=(ep\d{2,4})/.exec(req.headers.get('cookie') ?? '')?.[1] ?? '';
  const ep = /^ep\d{2,4}$/.test(name) ? episodeOf(name, user.id) : null;
  if (!ep) return page('That episode isn’t here.', 404);
  let port: number;
  try { port = await studioPort(ep); } catch (e) { return page((e as Error).message, 503); }
  const inner = `http://127.0.0.1:${port}`, h = new Headers();
  for (const k of ['accept', 'accept-language', 'content-type', 'range', 'if-none-match', 'if-modified-since', 'if-match', 'last-event-id', 'cache-control', 'sec-fetch-dest', 'sec-fetch-mode']) { const v = req.headers.get(k); if (v) h.set(k, v); }
  for (const [k, v] of req.headers) if (/^x-(hf|hyperframes|studio)[\w-]*$/i.test(k)) h.set(k, v);
  h.set('accept-encoding', 'identity');
  h.set('sec-fetch-site', 'same-origin');
  if (!read) h.set('origin', inner);
  const r0 = req.headers.get('referer');
  h.set('referer', r0?.startsWith(editorOrigin()) ? inner + r0.slice(editorOrigin().length) : `${inner}/`);
  const stop = new AbortController();
  req.signal?.addEventListener('abort', () => stop.abort(), { once: true });
  studioUse(name, 1);
  let closed = false;
  const free = () => { if (!closed) { closed = true; studioUse(name, -1); } };
  let res: Response;
  try { res = await fetch(inner + p + url.search, { method: req.method, headers: h, body: read ? undefined : req.body, redirect: 'manual', signal: stop.signal, ...(read ? {} : { duplex: 'half' }) } as RequestInit); }
  catch { free(); return page('The editor stopped answering. Open it again.', 502); }
  const out = new Headers();
  for (const [k, v] of res.headers) if (!/^(x-frame-options|content-security-policy|content-encoding|content-length|transfer-encoding|connection|keep-alive|set-cookie|access-control-.*)$/i.test(k)) out.set(k, v);
  if (res.headers.get('content-length') && !res.headers.get('content-encoding')) out.set('content-length', res.headers.get('content-length')!);
  const own = res.headers.get('content-security-policy');
  out.set('content-security-policy', own && /sandbox/.test(own) ? `${own.replace(/frame-ancestors[^;]*;?/g, '').replace(/[;\s]+$/, '')}; ${csp()}` : csp());
  out.set('referrer-policy', 'same-origin');
  out.set('x-content-type-options', 'nosniff');
  // The shots' files never change under their name: kept by the browser, so scrubbing doesn't fetch them again.
  if (/\/preview\/assets\/[\w.-]+-[0-9a-f]{8}\.mp4$/.test(p) && [200, 206].includes(res.status)) out.set('cache-control', 'private, max-age=604800, immutable');
  if (p === '/' && res.ok && /text\/html/.test(res.headers.get('content-type') ?? '')) {
    const html = await res.text();
    free();
    out.delete('content-length'); out.delete('etag');
    out.set('cache-control', 'no-store');
    out.append('set-cookie', `hz_editor=${name}; Path=/; HttpOnly; SameSite=Lax${editorOrigin().startsWith('https:') ? '; Secure' : ''}`);
    let app = ''; try { app = new URL(env.appUrl).origin; } catch { /* none */ }
    return new Response(html.replace('<head>', () => `<head>${BOOT(name, url.searchParams.get('theme') === 'dark', app)}`), { status: 200, headers: out });
  }
  if (!res.body) { free(); return new Response(null, { status: res.status, headers: out }); }
  // A picture or a finished answer ends by itself; the live line of changes ends when the page goes.
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) { try { const { done, value } = await reader.read(); if (done) { free(); ctl.close(); } else ctl.enqueue(value); } catch { free(); try { ctl.close(); } catch { /* closed */ } } },
    cancel() { free(); stop.abort(); },
  });
  return new Response([204, 304].includes(res.status) ? null : body, { status: res.status, headers: out });
}
