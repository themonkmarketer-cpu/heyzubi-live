import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check as CheckIcon, Copy, Download, Pencil, RefreshCw, Upload, X } from 'lucide-react';
import { epFileUrl, seriesFileUrl, socialApi, voiceDrift, usd, type Cast, type Check, type Episode, type Home, type Shot, type Slot, type StageId, type Version } from '../../lib/socialApi';

type Act = (fn: () => Promise<unknown>, follow?: boolean) => Promise<void>;
interface P { ep: Episode; slots: Slot[]; busy: boolean; act: Act; keys?: Home['keys']; onKeys: () => void; hookTypes: string[] }

export function StagePanel({ stage, ...p }: P & { stage: StageId }) {
  const C = PANELS[stage];
  return <C {...p} />;
}

// ---------- shared ----------
function Checks({ list, title = 'Rules' }: { list: Check[]; title?: string }) {
  const [all, setAll] = useState(false);
  const bad = list.filter((c) => !c.ok);
  const shown = all ? list : bad;
  if (!list.length) return null;
  return (
    <div className="schecks">
      <button type="button" className="schecks__head" aria-expanded={all} onClick={() => setAll(!all)}><b>{title}</b><span className={bad.some((c) => c.level === 'must') ? 'spill is-failed' : bad.length ? 'spill is-stale' : 'spill is-done'}>{bad.length ? `${list.length - bad.length} of ${list.length} met` : `all ${list.length} met`}</span><small>{all ? 'Show fewer' : 'Show all'}</small></button>
      {shown.length > 0 && <ul>{shown.map((c) => <li key={c.id} className={c.ok ? 'is-ok' : c.level === 'must' ? 'is-must' : 'is-should'}>{c.ok ? <CheckIcon size={13} aria-hidden /> : <AlertTriangle size={13} aria-hidden />}<span>{c.label}{c.detail ? <small> {c.detail}</small> : null}</span></li>)}</ul>}
    </div>
  );
}
function Approve({ label, on, busy, children, warn }: { label: string; on: () => void; busy: boolean; children?: ReactNode; warn?: string | null }) {
  return <div className="sgate"><div className="sgate__t">{children}{warn && <small className="sgate__w"><AlertTriangle size={12} aria-hidden /> {warn}</small>}</div><button type="button" className="btn btn--primary" disabled={busy} onClick={on}>{label}</button></div>;
}
function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return <button type="button" className="sicon" title="Copy" aria-label="Copy" onClick={() => { void navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); }); }}>{ok ? <CheckIcon size={13} /> : <Copy size={13} />}</button>;
}
const waiting = (ep: Episode, s: StageId) => ep.stages[s].status === 'needs_you';
const mustBad = (l: Check[]) => l.filter((c) => !c.ok && c.level === 'must');

// ---------- 1 story ----------
function Story({ ep, busy, act }: P) {
  const [sel, setSel] = useState<number | null>(null);
  const [own, setOwn] = useState('');
  const need = waiting(ep, 'story');
  const go = (b: Record<string, unknown>) => void act(() => socialApi.approve(ep.id, 'story', b));
  return (
    <>
      {ep.story.brief && <p className="social__fine">Your idea: {ep.story.brief}</p>}
      <div className="sopts">
        {ep.story.options.map((o, i) => {
          const on = need ? sel === i : ep.story.picked?.title === o.title;
          return (
            <button key={i} type="button" className={`sopt${on ? ' is-on' : ''}`} disabled={!need || busy} aria-pressed={on} onClick={() => { setSel(i); setOwn(''); }}>
              <span className="sopt__k">{'ABCD'[i]}</span><b>{o.title}</b><small>{o.trade} · {o.aiEmployee} AI Employee</small>
              <span className="sopt__hook"><q>{o.hookLine}</q><cite>{o.hookSpeaker}</cite><q>{o.secondLine}</q><cite>{o.secondSpeaker}</cite></span>
              <span>{o.problem}</span><small><b>{o.who}</b></small><small>Odd detail: {o.unexpected}</small><small>{o.why}</small>
            </button>
          );
        })}
      </div>
      {need && <label className="sfield"><span>Or your own story</span><textarea className="text-input" rows={3} maxLength={1200} value={own} placeholder="Who, the trade, the problem with a number, and what the AI Employee does" onChange={(e) => { setOwn(e.target.value); if (e.target.value) setSel(null); }} /></label>}
      {need && <Approve label={own.trim() ? 'Write my story' : sel !== null ? `Write “${ep.story.options[sel].title}”` : 'Pick a story'} busy={busy || (sel === null && !own.trim())} on={() => go(own.trim() ? { custom: own.trim() } : { pick: sel })}><span>The script is written next. Free.</span></Approve>}
      {need && <button type="button" className="link-btn" disabled={busy} onClick={() => void act(() => socialApi.run(ep.id, 'story'))}>Four different stories</button>}
    </>
  );
}

// ---------- 2 script ----------
function ShotRow({ ep, part, x, edit, busy, act }: { ep: Episode; part: number; x: Shot; edit: boolean; busy: boolean; act: Act }) {
  const [on, setOn] = useState(false);
  const [f, setF] = useState({ line: x.line ?? '', delivery: x.delivery ?? '', picture: x.picture, camera: x.camera, caption: x.caption ?? '' });
  useEffect(() => { setF({ line: x.line ?? '', delivery: x.delivery ?? '', picture: x.picture, camera: x.camera, caption: x.caption ?? '' }); }, [x.line, x.delivery, x.picture, x.camera, x.caption]);
  const who = ep.cast.find((c) => c.key === x.speaker)?.name ?? x.speaker;
  if (on) return (
    <tr className="is-edit"><td colSpan={5}>
      <div className="sshot">
        {(['line', 'caption', 'delivery', 'camera'] as const).map((k) => <label key={k} className="sfield"><span>{({ line: `${who || 'No one'} says (as spoken)`, caption: 'Caption wording, if different', delivery: 'How', camera: 'Camera' } as const)[k]}</span><input className="text-input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>)}
        <label className="sfield"><span>Picture</span><textarea className="text-input" rows={3} value={f.picture} onChange={(e) => setF({ ...f, picture: e.target.value })} /></label>
        <div className="sshot__acts"><button type="button" className="btn btn--secondary btn--sm" onClick={() => setOn(false)}>Cancel</button><button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void act(() => socialApi.script(ep.id, { part, shot: x.n, ...f }), false).then(() => setOn(false))}>Save</button></div>
      </div>
    </td></tr>
  );
  return (
    <tr>
      <td className="snum">{x.n}<small>{x.start}–{x.end}s</small></td>
      <td><span className="scam">{x.camera}</span>{x.picture}</td>
      <td>{x.line ? <><b>{who}</b> <q>{x.line}</q></> : <span className="social__fine">{x.sound || 'no line'}</span>}</td>
      <td>{x.screen && <span className="stag">{x.screen.toUpperCase()}</span>}{x.clock && <span className="stag is-clock">{x.clock}</span>}</td>
      <td>{edit && <button type="button" className="sicon" aria-label={`Edit shot ${x.n}`} title="Edit" onClick={() => setOn(true)}><Pencil size={13} /></button>}</td>
    </tr>
  );
}
function ScriptPanel({ ep, busy, act }: P) {
  const s = ep.script, need = waiting(ep, 'script');
  const [note, setNote] = useState('');
  const [cap, setCap] = useState('9');
  const [ai, setAi] = useState<'yes' | 'later' | null>(ep.aiConfirmed ?? null);
  const [anyway, setAnyway] = useState(false);
  if (!s) return null;
  const bad = mustBad(ep.checks);
  return (
    <>
      <div className="sgrid2">
        <div className="sbox"><h3>{s.aiEmployee.icon} {s.aiEmployee.name} AI Employee</h3><p>{s.aiEmployee.howItWorks}</p><small><b>Honest because:</b> {s.honesty}</small></div>
        <div className="sbox"><h3>Keywords</h3><p><b>{s.keywords.primary}</b> · {s.keywords.ownerSide} · {s.keywords.secondary.join(' · ')}</p>{s.keywords.evidence?.slice(0, 3).map((e, i) => <small key={i}>{e}</small>)}<small><b>Tip:</b> {s.tip}</small><small><b>Odd detail:</b> {s.unexpected}</small><small><b>Running gag:</b> {s.runningGag}</small></div>
      </div>
      <Checks list={ep.checks} title="Series rules" />
      {s.parts.map((p, i) => (
        <div key={i} className="sscript">
          <h3>Part {i + 1} <small>{i ? '0:30 to 1:00' : '0:00 to 0:30'} · {p.time}</small></h3>
          <table><thead><tr><th>#</th><th>Picture</th><th>Line</th><th /><th /></tr></thead><tbody>{p.shots.map((x) => <ShotRow key={x.n} ep={ep} part={i + 1} x={x} edit={need} busy={busy} act={act} />)}</tbody></table>
        </div>
      ))}
      <div className="sgrid2"><div className="sbox"><h3>Cast</h3>{ep.cast.map((c) => <p key={c.key}><b>{c.name}</b> {c.kind === 'series' ? '(series)' : c.kind === 'sheet' ? '(new character)' : c.kind === 'ref' ? '(new reference picture)' : '(described)'}<small>{c.castLine || c.lock}{c.voice ? ` · voice: ${c.voice.voiceName}` : ''}</small></p>)}</div><div className="sbox"><h3>Caption opening</h3><p>{s.caption.line1} {s.caption.story}</p><small>{s.forward}</small></div></div>
      {need && (
        <>
          <div className="snotes"><textarea className="text-input" rows={2} value={note} placeholder="What should change? e.g. make the last line drier, swap the crate for a wheelbarrow" aria-label="Changes" onChange={(e) => setNote(e.target.value)} /><button type="button" className="btn btn--secondary btn--sm" disabled={busy || !note.trim()} onClick={() => void act(() => socialApi.run(ep.id, 'script', { note: note.trim() })).then(() => setNote(''))}><RefreshCw size={13} aria-hidden /> Rewrite</button></div>
          <Approve label={`Approve, ${usd(Number(cap) || 0)} limit`} busy={busy || !ai || !(Number(cap) > 0) || (bad.length > 0 && !anyway)} on={() => void act(() => socialApi.approve(ep.id, 'script', { capUsd: Number(cap), anyway, aiEmployee: ai }))} warn={bad.length ? `${bad.length} rule${bad.length > 1 ? 's' : ''} not met` : null}>
            <div className="sai" role="radiogroup" aria-label="Does one of your AI Employees really do this?"><b>Does one of your AI Employees really do what the {s.aiEmployee.name} AI Employee does here?</b><label className="sswitch"><input type="radio" name="ai" checked={ai === 'yes'} onChange={() => setAi('yes')} /> Yes, it does</label><label className="sswitch"><input type="radio" name="ai" checked={ai === 'later'} onChange={() => setAi('later')} /> Not confirmed yet, go on</label><small>If it does less, ask for a rewrite above so the lines match.</small></div>
            <label className="scap">Most this episode may cost: $<input className="text-input" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Spending limit in dollars" /></label>
            {bad.length > 0 && <label className="sswitch"><input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} /> Approve anyway</label>}
            <small>Approving starts the new characters’ pictures (about $0.04 each) and voices. Renders still wait for your OK on the storyboard.</small>
          </Approve>
        </>
      )}
    </>
  );
}

// ---------- 3 cast ----------
function CastCard({ ep, c, busy, act, need }: { ep: Episode; c: Cast; busy: boolean; act: Act; need: boolean }) {
  const [prompt, setPrompt] = useState(c.imagePrompt ?? '');
  const [open, setOpen] = useState(false);
  const img = c.image ? (c.kind === 'series' ? seriesFileUrl(c.image) : epFileUrl(ep.id, c.image)) : null;
  const voice = c.voiceFile ? (c.kind === 'series' ? seriesFileUrl(c.voiceFile) : epFileUrl(ep.id, c.voiceFile)) : null;
  return (
    <article className="scast">
      {img ? <a href={img} target="_blank" rel="noreferrer"><img src={img} alt={c.name} /></a> : <div className="scast__no">{c.kind === 'described' ? 'Described in words' : 'No picture yet'}</div>}
      <div><h3>{c.name} <small>{c.kind === 'series' ? 'series' : c.kind === 'sheet' ? 'new character' : c.kind === 'ref' ? 'reference' : 'extra'}</small></h3><p>{c.lock}</p>
        {voice && <audio controls preload="none" src={voice} />}{c.voice && <small>{c.voice.voiceName}{c.voiceSeconds ? ` · ${c.voiceSeconds.toFixed(1)} s` : ''} · “{c.voice.sample}”</small>}
        {need && c.kind !== 'series' && <div className="scast__acts">
          {['sheet', 'ref'].includes(c.kind) && <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => setOpen(!open)}>Picture again (about $0.04)</button>}
          {c.voice && <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void act(() => socialApi.run(ep.id, 'cast', { key: c.key, what: 'voice' }))}>Voice again</button>}
        </div>}
        {open && <div className="sshot"><textarea className="text-input" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Picture prompt" /><button type="button" className="btn btn--primary btn--sm" disabled={busy || !prompt.trim()} onClick={() => void act(() => socialApi.run(ep.id, 'cast', { key: c.key, what: 'image', prompt })).then(() => setOpen(false))}>Draw it</button></div>}
      </div>
    </article>
  );
}
function CastPanel({ ep, busy, act }: P) {
  const need = waiting(ep, 'cast');
  return <><div className="scasts">{ep.cast.map((c) => <CastCard key={c.key} ep={ep} c={c} busy={busy} act={act} need={need} />)}</div>{need && <Approve label="Approve the cast" busy={busy} on={() => void act(() => socialApi.approve(ep.id, 'cast', {}))}><span>Check faces, outfits and voices. The screens and storyboard come next.</span></Approve>}</>;
}

// ---------- 4 screens ----------
function ScreenCard({ ep, id, title, png, busy, act }: { ep: Episode; id: string; title: string; png: string; busy: boolean; act: Act }) {
  const data = ep.script!.screens[id];
  const [t, setT] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const save = () => { try { const d = JSON.parse(t!); setErr(''); void act(() => socialApi.screen(ep.id, id, d), false).then(() => setT(null)); } catch { setErr('That isn’t valid: check quotes and commas.'); } };
  return (
    <figure className="sscreen">
      <a href={epFileUrl(ep.id, png)} target="_blank" rel="noreferrer"><img src={`${epFileUrl(ep.id, png)}&t=${ep.stages.screens.endedAt ?? 0}`} alt={title} /></a>
      <figcaption><b>{id.toUpperCase()}</b> {title}<button type="button" className="sicon" aria-label={`Edit ${title}`} title="Edit the words" onClick={() => setT(t === null ? JSON.stringify(data, null, 2) : null)}><Pencil size={13} /></button></figcaption>
      {t !== null && <div className="sshot"><textarea className="text-input is-code" rows={12} value={t} onChange={(e) => setT(e.target.value)} aria-label="Screen words" />{err && <small className="card__error">{err}</small>}<button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={save}>Draw it again</button></div>}
    </figure>
  );
}
function Screens({ ep, busy, act }: P) {
  return <><div className="sscreens">{ep.screens.map((s) => <ScreenCard key={s.id} ep={ep} id={s.id} title={s.title} png={s.png} busy={busy} act={act} />)}</div><p className="social__fine">Built before any render and laid onto the devices in the edit. You approve them with the storyboard.</p></>;
}

// ---------- 5 storyboard ----------
function Storyboard({ ep, busy, act, keys, onKeys }: P) {
  const b = ep.storyboard, need = waiting(ep, 'storyboard');
  const [open, setOpen] = useState<number | null>(null);
  if (!b) return null;
  const over = b.quoteUsd !== null && b.quoteUsd > ep.capUsd - ep.spent + 0.005;
  return (
    <>
      <div className="sscreens is-small">{ep.screens.map((s) => <figure key={s.id} className="sscreen"><img src={epFileUrl(ep.id, s.png)} alt={s.title} /><figcaption><b>{s.id.toUpperCase()}</b> {s.title}</figcaption></figure>)}</div>
      <Checks list={b.checks} title="Prompt rules" />
      {b.prompts.map((p, i) => (
        <div key={i} className="sbox">
          <h3>Part {i + 1} <small>{b.chars[i].toLocaleString()} characters</small><CopyBtn text={p} /></h3>
          <small>Pictures: {b.refs[i].images.join(', ') || 'none'} · Voices: {b.refs[i].audio.join(', ') || 'none'} · Reference video: {b.refs[i].video}</small>
          <button type="button" className="link-btn" onClick={() => setOpen(open === i ? null : i)}>{open === i ? 'Hide the prompt' : 'Read the prompt'}</button>
          {open === i && <pre className="sprompt">{p}</pre>}
        </div>
      ))}
      {need && (b.quoteUsd === null
        ? <div className="social__note is-warn"><AlertTriangle size={15} aria-hidden /><span>{keys?.topview ? 'There is no price yet.' : 'TopView needs its key before there is a price.'} You can also add your own clips on the Render stage.</span>{keys?.topview ? <button type="button" className="link-btn" disabled={busy} onClick={() => void act(() => socialApi.run(ep.id, 'storyboard'))}>Ask again</button> : <button type="button" className="link-btn" onClick={onKeys}>Connections</button>}</div>
        : <Approve label={`Approve and render, up to ${usd(b.quoteUsd)}`} busy={busy || over} on={() => void act(() => socialApi.approve(ep.id, 'storyboard', { confirmUsd: b.quoteUsd }))} warn={over ? `Above what’s left of your limit (${usd(ep.capUsd - ep.spent)}). Raise it under Spending.` : null}><span>Two 30-second parts at 480p on TopView. This spends money{b.usualUsd ? `: usually about ${usd(b.usualUsd)}, never more than ${usd(b.quoteUsd)}` : ''}.</span></Approve>)}
    </>
  );
}

// ---------- 6 render ----------
function VersionRow({ ep, part, v, busy, act }: { ep: Episode; part: number; v: Version; busy: boolean; act: Act }) {
  const picked = v.kind !== 'shot' && ep.render.parts[part - 1].picked === v.v, off = (v.note ?? '').startsWith('[off]');
  return <li><span>{v.kind === 'shot' ? `Shot ${v.shot} retake` : v.kind === 'import' ? 'Your clip' : v.kind === 'voice' ? `Shot ${v.shot} said again` : 'Render'} v{v.v}</span><small>{v.state}{v.usd ? ` · ${usd(v.usd)}` : v.estimate ? ` · about ${usd(v.estimate)}` : ''} · {v.provider}{v.error ? ` · ${v.error}` : ''}</small>{v.state === 'completed' && (v.kind === 'shot' ? <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void act(() => socialApi.version(ep.id, part, v.v), false)}>{off ? 'Use' : 'Don’t use'}</button> : picked ? <span className="spill is-done">In use</span> : <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void act(() => socialApi.version(ep.id, part, v.v), false)}>Use this</button>)}</li>;
}
function Player({ ep, part }: { ep: Episode; part: number }) {
  const p = ep.render.parts[part - 1], v = p.versions.find((x) => x.v === p.picked);
  return v?.file ? <video controls preload="metadata" playsInline src={epFileUrl(ep.id, v.file)} /> : <div className="scast__no">Part {part} isn’t made yet</div>;
}
function Render({ ep, busy, act, keys }: P) {
  const ref = useRef<HTMLInputElement>(null);
  const [part, setPart] = useState(1);
  const [q, setQ] = useState<{ parts: number[]; usd: number; left: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const missing = [2, 1].filter((p) => ep.render.parts[p - 1].picked === null), made = missing.length < 2;
  const st = ep.stages.render, can = !!ep.storyboard && ep.stages.storyboard.status === 'done' && missing.length > 0 && st.status !== 'running';
  const key = `${ep.id}-${missing.join()}-${ep.updatedAt}`;
  useEffect(() => { let on = true; setErr(null); if (can) socialApi.quoteRender(ep.id).then((x) => { if (on) setQ(x); }).catch((e) => { if (on) setErr((e as Error).message); }); return () => { on = false; }; }, [key, can]); // eslint-disable-line react-hooks/exhaustive-deps
  const lead = ep.render.lead, who = lead ? ep.cast.find((c) => c.key === lead.key) : undefined, doubt = !!lead?.doubt && lead.v === ep.render.parts[1].picked && missing.includes(1);
  return (
    <>
      {doubt && who && <div className="sbox is-warn sdoubt"><b>Is this {who.name}?</b><p>The check wasn’t sure: {lead!.doubt}. Whoever is in the second picture will play {who.name} in Part 1.</p><div>{who.image && <figure><img src={who.kind === 'series' ? seriesFileUrl(who.image) : epFileUrl(ep.id, who.image)} alt={`${who.name}’s own picture`} /><figcaption>{who.name}</figcaption></figure>}<figure><img src={epFileUrl(ep.id, lead!.file.replace(/\.mp4$/, '.jpg'))} alt="From Part 2" /><figcaption>In Part 2</figcaption></figure></div></div>}
      <div className="sparts">{[1, 2].map((n) => (
        <div key={n} className="spart"><h3>Part {n}</h3><Player ep={ep} part={n} /><ul className="svers">{ep.render.parts[n - 1].versions.map((v) => <VersionRow key={v.v} ep={ep} part={n} v={v} busy={busy} act={act} />)}</ul><button type="button" className="btn btn--secondary btn--sm" disabled={busy || !ep.script} onClick={() => { setPart(n); ref.current?.click(); }}><Upload size={13} aria-hidden /> Use my own clip</button>
          {(ep.review[n - 1]?.notes ?? []).some((x) => !x.startsWith('[')) && <div className="sbox is-warn"><b>Worth a look</b><ul>{ep.review[n - 1]!.notes.filter((x) => !x.startsWith('[')).map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          {ep.render.parts[n - 1].picked !== null && missing.length > 0 && ep.storyboard && <><p className="social__fine">Not happy with it? Retake one shot or the whole part:</p><Retake ep={ep} part={n} busy={busy} act={act} /></>}</div>
      ))}</div>
      {can && <Approve label={`${doubt ? `Yes, it’s ${who?.name}: render` : 'Render'} ${missing.map((p) => `Part ${p}`).join(' and ')}${q ? `, up to ${usd(q.usd)}` : ''}`} busy={busy || (!!q && q.usd > q.left + 0.005)} on={() => void act(() => socialApi.run(ep.id, 'render'), false)} warn={q && q.usd > q.left + 0.005 ? `Only ${usd(q.left)} left of your limit. Raise it under Spending.` : err}><span>{!made ? 'Part 2 renders first, then Part 1.' : `Part ${missing[0]} is missing; Part ${missing[0] === 1 ? 2 : 1} is kept as it is.`} About 8 minutes each.</span>{q && q.usd <= q.left + 0.005 && <small>Usually less. {usd(q.left)} left of your limit.</small>}</Approve>}
      <input ref={ref} type="file" accept="video/mp4,video/quicktime" hidden aria-label="Clip" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void act(() => socialApi.importPart(ep.id, part, f), false); }} />
      <div className="sbox"><h3>Where it renders</h3><label className="sswitch"><input type="radio" name="prov" checked={ep.render.provider === 'topview'} onChange={() => void act(() => socialApi.provider(ep.id, 'topview'), false)} /> TopView (first choice)</label><label className="sswitch"><input type="radio" name="prov" disabled={!keys?.kie} checked={ep.render.provider === 'kie'} onChange={() => void act(() => socialApi.provider(ep.id, 'kie'), false)} /> kie.ai (fallback{keys?.kie ? ', about $4.20 a part' : ': add its key in Connections'})</label><small>Every job is priced before it starts, checked against your limit, and logged. If HeyZubi restarts, it picks the same job up again.</small></div>
    </>
  );
}

// ---------- 7 review ----------
export function Retake({ ep, part, busy, act, only }: { ep: Episode; part: number; busy: boolean; act: Act; only?: number }) {
  const [pickShot, setShot] = useState(''), shot = only ? String(only) : pickShot;
  const [note, setNote] = useState('');
  const [q, setQ] = useState<{ usd: number; left: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const arg = { part, ...(shot ? { shot: Number(shot) } : {}), note };
  const ask = async () => { setAsking(true); setErr(null); try { setQ(await socialApi.quoteRetake(ep.id, arg)); } catch (e) { setErr((e as Error).message); } setAsking(false); };
  if (!ep.storyboard) return <p className="social__fine">Retakes need the storyboard’s prompts.</p>;
  return (
    <div className="sretake">
      {!only && <select className="text-input" value={shot} aria-label="What to retake" onChange={(e) => { setShot(e.target.value); setQ(null); }}><option value="">All of Part {part}</option>{ep.script!.parts[part - 1].shots.map((x) => <option key={x.n} value={x.n}>Shot {x.n}: {(x.line || x.picture).slice(0, 40)}</option>)}</select>}
      <input className="text-input" value={note} maxLength={500} placeholder="What must be right this time" aria-label="Note" onChange={(e) => { setNote(e.target.value); setQ(null); }} />
      {q ? <button type="button" className="btn btn--primary btn--sm" disabled={busy || q.usd > q.left + 0.005} onClick={() => void act(() => socialApi.retake(ep.id, { ...arg, confirmUsd: q.usd }), false).then(() => setQ(null))}>Retake, up to {usd(q.usd)}</button> : <button type="button" className="btn btn--secondary btn--sm" disabled={busy || asking} onClick={() => void ask()}>{asking ? 'Pricing…' : 'Price a retake'}</button>}
      {q && q.usd > q.left + 0.005 && <small className="card__error">Only {usd(q.left)} left of your limit.</small>}{err && <small className="card__error">{err}</small>}
    </div>
  );
}
function ReviewPanel({ ep, busy, act }: P) {
  const need = waiting(ep, 'review');
  return (
    <>
      {[1, 2].map((n) => {
        const r = ep.review[n - 1];
        return (
          <div key={n} className="sreview">
            <h3>Part {n}</h3>
            <div className="sreview__top"><Player ep={ep} part={n} />
              {r && <div className="sreview__facts">
                <ul className="sfacts"><li className={r.hookAt >= 0 && (n === 2 || r.hookAt < 0.4) ? 'is-ok' : 'is-bad'}>First word at {r.hookAt.toFixed(2)} s</li>{n === 1 && <li className={r.secondVoiceAt > 0 && r.secondVoiceAt <= 3.6 ? 'is-ok' : 'is-bad'}>Second voice at {r.secondVoiceAt.toFixed(2)} s</li>}<li className={r.asl <= 2.9 ? 'is-ok' : 'is-bad'}>{r.cuts.length + 1} shots, {r.asl} s each</li><li className={r.lines.every((l) => l.score >= 0.7) ? 'is-ok' : 'is-bad'}>{r.lines.filter((l) => l.score >= 0.7).length} of {r.lines.length} lines as written</li></ul>
                {r.notes.some((x) => !x.startsWith('[')) ? <div className="sbox is-warn"><b>Worth a look</b><ul>{r.notes.filter((x) => !x.startsWith('[')).map((x, i) => <li key={i}>{x}</li>)}</ul></div> : <p className="social__fine">Nothing odd was noticed in the picture. Watch it through yourself.</p>}
              </div>}
            </div>
            {r && <><a href={epFileUrl(ep.id, r.sheet)} target="_blank" rel="noreferrer"><img className="ssheet" src={epFileUrl(ep.id, r.sheet)} alt={`Contact sheet of Part ${n}`} loading="lazy" /></a>
              <table className="social__table slines"><thead><tr><th>Shot</th><th>Written</th><th>Heard</th><th>Voice</th>{need && <th />}</tr></thead><tbody>{r.lines.map((l, i) => { const off = l.pitch && l.refPitch ? Math.round((l.pitch / l.refPitch - 1) * 100) : null; return <tr key={i} className={l.score < 0.7 || l.lips === false ? 'is-bad' : ''}><td>{l.shot}</td><td><b>{ep.cast.find((c) => c.key === l.speaker)?.name ?? l.speaker}</b> {l.text}</td><td>{l.heard || 'not heard'}{l.lips === false && <small className="is-bad">Mouth doesn’t move</small>}</td><td>{l.pitch ? <span className={voiceDrift(l, ep.script?.parts[n - 1].shots.find((q) => q.n === l.shot)) !== null ? 'is-bad' : ''}>{l.pitch} Hz{off !== null ? ` (${off > 0 ? '+' : ''}${off}%)` : ''}</span> : '–'}</td>{need && <td>{l.score > 0 && <button type="button" className="link-btn" disabled={busy} title="Say this line again in the character’s own ElevenLabs voice and lay it over the picture. Uses a few of your ElevenLabs characters; no render." onClick={() => void act(() => socialApi.revoice(ep.id, n, l.shot), false)}>Say it again</button>}</td>}</tr>; })}</tbody></table></>}
            {(need || ep.stages.review.status === 'stale') && <Retake ep={ep} part={n} busy={busy} act={act} />}
            {ep.render.parts[n - 1].versions.some((v) => v.kind === 'shot' || v.kind === 'voice') && <ul className="svers">{ep.render.parts[n - 1].versions.filter((v) => v.kind !== 'import' && (v.kind !== 'part' || v.state === 'completed')).map((v) => <VersionRow key={v.v} ep={ep} part={n} v={v} busy={busy} act={act} />)}</ul>}
          </div>
        );
      })}
      {need && <Approve label="Approve both parts" busy={busy || ep.review.some((r) => !r)} on={() => void act(() => socialApi.approve(ep.id, 'review', {}))}><span>The edit starts next. Free. Shots you don’t want can be dropped there.</span></Approve>}
    </>
  );
}

// ---------- 8 edit ----------
export function EditPanel({ ep, busy, act }: P) {
  const need = waiting(ep, 'edit'), o = ep.edit.options;
  const [m, setM] = useState(o.musicDb), [a, setA] = useState(String(o.trimStart)), [z, setZ] = useState(String(o.trimEnd));
  const [drop, setDrop] = useState(o.dropShots), [lift, setLift] = useState(o.brighten ?? []), [scr, setScr] = useState(o.screens), [fix, setFix] = useState(o.captionFixes.map((f) => f.join(' = ')).join('\n'));
  const [anyway, setAnyway] = useState(false);
  const bad = mustBad(ep.edit.checks);
  const has = (p: number, s: number) => drop.some((d) => d.part === p && d.shot === s);
  const save = () => void act(async () => { await socialApi.edit(ep.id, { musicDb: m, trimStart: a, trimEnd: z, dropShots: drop, brighten: lift, screens: scr, captionFixes: fix.split('\n').map((l) => l.split('=').map((x) => x.trim())).filter((x) => x[0] && x.length > 1) }); return socialApi.run(ep.id, 'edit'); });
  return (
    <>
      <div className="sedit">
        <div className="sedit__v">{ep.edit.final ? <video controls preload="metadata" playsInline src={epFileUrl(ep.id, ep.edit.final)} /> : <div className="scast__no">No cut yet</div>}{ep.edit.final && <div className="sgate__t"><b>Cut v{ep.edit.version}</b><small>{ep.edit.seconds?.toFixed(1)} s · {ep.edit.lufs} LUFS · peak {ep.edit.peak} dB</small><a className="link-btn" href={epFileUrl(ep.id, ep.edit.final, true)}><Download size={13} aria-hidden /> Download</a></div>}</div>
        <div className="sedit__o">
          <Checks list={ep.edit.checks} title="The cut" />
          {(need || ['ready', 'stale', 'failed'].includes(ep.stages.edit.status)) && (
            <div className="sbox">
              <h3>Change the cut</h3>
              <label className="sfield"><span>Theme under the voices: {m} dB</span><input type="range" min={-26} max={-4} value={m} onChange={(e) => setM(Number(e.target.value))} /></label>
              {!ep.studio && <div className="sgrid2"><label className="sfield"><span>Trim the start (s)</span><input className="text-input" inputMode="decimal" value={a} onChange={(e) => setA(e.target.value)} /></label><label className="sfield"><span>Trim the end (s)</span><input className="text-input" inputMode="decimal" value={z} onChange={(e) => setZ(e.target.value)} /></label></div>}
              {!ep.studio && <details><summary>Drop shots ({drop.length})</summary><div className="sdrop">{ep.script!.parts.map((p, i) => <div key={i}><b>Part {i + 1}</b>{p.shots.map((x) => <label key={x.n} title={x.line || x.picture}><input type="checkbox" checked={has(i + 1, x.n)} onChange={(e) => setDrop(e.target.checked ? [...drop, { part: i + 1, shot: x.n }] : drop.filter((d) => !(d.part === i + 1 && d.shot === x.n)))} /> {x.n}</label>)}</div>)}</div></details>}
              <details><summary>Brighten dark shots ({lift.length})</summary><div className="sdrop">{ep.script!.parts.map((p, i) => <div key={i}><b>Part {i + 1}</b>{p.shots.map((x) => <label key={x.n} title={x.line || x.picture}><input type="checkbox" checked={lift.some((d) => d.part === i + 1 && d.shot === x.n)} onChange={(e) => setLift(e.target.checked ? [...lift, { part: i + 1, shot: x.n }] : lift.filter((d) => !(d.part === i + 1 && d.shot === x.n)))} /> {x.n}</label>)}</div>)}</div></details>
              <details><summary>Screens on the devices</summary><div className="sscr">{ep.screens.map((q) => { const v = scr[q.id] ?? { on: true }, st = ep.edit.screenStats?.[q.id]; const set = (w: object) => setScr({ ...scr, [q.id]: { ...v, ...w } }); return <div key={q.id}><label><input type="checkbox" checked={v.on} onChange={(e) => set({ on: e.target.checked })} /> {q.id.toUpperCase()} {q.title}</label><input className="text-input" placeholder={`from ${st?.f0 ?? '?'}`} value={v.f0 ?? ''} aria-label="First frame" onChange={(e) => set({ f0: e.target.value === '' ? undefined : Number(e.target.value) })} /><input className="text-input" placeholder={`to ${st?.f1 ?? '?'}`} value={v.f1 ?? ''} aria-label="Last frame" onChange={(e) => set({ f1: e.target.value === '' ? undefined : Number(e.target.value) })} />{q.id !== 's2' && <select className="text-input" value={v.motion ?? ''} aria-label="Movement" onChange={(e) => set({ motion: e.target.value || undefined })}><option value="">auto</option><option value="track">follow</option><option value="static">still</option></select>}</div>; })}</div></details>
              <details><summary>Caption words</summary><textarea className="text-input" rows={3} value={fix} placeholder={'heard = shown\nbraids = brakes'} aria-label="Caption fixes" onChange={(e) => setFix(e.target.value)} /></details>
              <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={save}><RefreshCw size={13} aria-hidden /> Make the cut again</button>
            </div>
          )}
        </div>
      </div>
      {ep.edit.previews && ep.edit.previews.length > 0 && <details className="sbox"><summary>How the screens sit on the devices</summary><div className="sprev">{ep.edit.previews.map((p) => <img key={p} src={`${epFileUrl(ep.id, p)}&v=${ep.edit.version}`} alt="" loading="lazy" />)}</div></details>}
      {need && <Approve label="Approve the cut" busy={busy || (bad.length > 0 && !anyway)} on={() => void act(() => socialApi.approve(ep.id, 'edit', { anyway }))} warn={bad.length ? bad.map((c) => c.label).join(', ') : null}><span>Covers are pulled from it next. Free.</span>{bad.length > 0 && <label className="sswitch"><input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} /> Approve anyway</label>}</Approve>}
    </>
  );
}

// ---------- 9 cover ----------
function Cover({ ep, busy, act }: P) {
  const need = waiting(ep, 'cover');
  const [sel, setSel] = useState<string | null>(ep.cover.picked);
  const [t, setT] = useState('');
  return (
    <>
      <div className="scovers">{ep.cover.candidates.map((c, i) => <button key={c.file} type="button" className={`scover${(need ? sel : ep.cover.picked) === c.file ? ' is-on' : ''}`} disabled={!need} aria-pressed={sel === c.file} onClick={() => setSel(c.file)}><img src={epFileUrl(ep.id, c.file)} alt={`Frame at ${c.t.toFixed(1)} seconds`} loading="lazy" /><span>{i + 1} · {c.t.toFixed(2)} s</span></button>)}</div>
      {need && <><form className="sretake" onSubmit={(e) => { e.preventDefault(); void act(() => socialApi.cover(ep.id, Number(t)), false).then(() => setT('')); }}><input className="text-input" inputMode="decimal" value={t} placeholder="Another moment, in seconds (e.g. 2.9)" aria-label="Time in seconds" onChange={(e) => setT(e.target.value)} /><button type="submit" className="btn btn--secondary btn--sm" disabled={busy || !(Number(t) >= 0) || t === ''}>Add that frame</button></form>
        <Approve label="Use this cover" busy={busy || !sel} on={() => void act(() => socialApi.approve(ep.id, 'cover', { file: sel }))}><span>Clean frames: no captions, no clock.</span></Approve></>}
    </>
  );
}

// ---------- 10 captions ----------
const TEXTS = [['instagram', 'Instagram caption', 9], ['facebook', 'Facebook caption', 9], ['commentInstagram', 'First comment, Instagram', 3], ['commentFacebook', 'First comment, Facebook', 3], ['whatsapp', 'WhatsApp Status line', 2], ['youtubeComment', 'YouTube pinned comment', 3], ['altText', 'Alt text', 2], ['youtubeTitle', 'YouTube title', 1], ['youtubeDescription', 'YouTube description', 9]] as const;
function Package({ ep, busy, act, slots }: P) {
  const p = ep.pack, need = waiting(ep, 'package');
  const [f, setF] = useState<Record<string, string>>({});
  useEffect(() => { setF({}); }, [ep.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = Object.keys(f).length > 0;
  const free = useMemo(() => slots.filter((s) => !s.taken), [slots]);
  if (!p) return null;
  const slot = slots.find((s) => s.at === p.slot);
  return (
    <>
      <Checks list={p.checks} title="Caption rules" />
      {ep.aiConfirmed !== 'yes' && <div className="sbox is-warn"><b>Not confirmed: does one of your AI Employees really do this?</b><p>{ep.script?.aiEmployee.howItWorks}</p><button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void act(() => socialApi.aiEmployee(ep.id), false)}>Yes, it does</button></div>}
      <div className="sgrid2">
        <div className="sbox"><h3>When</h3>{need ? <select className="text-input" value={p.slot ?? ''} aria-label="Slot" disabled={busy} onChange={(e) => void act(() => socialApi.pack(ep.id, { slot: e.target.value }), false)}><option value="" disabled>Choose a slot</option>{free.map((s) => <option key={s.at} value={s.at}>{s.label} ({s.us})</option>)}</select> : <p>{slot ? `${slot.label} (${slot.us})` : p.slot?.replace('T', ' ')}</p>}<small>The first free slot is chosen for you.</small></div>
        <div className="sbox"><h3>Where</h3>{(['instagram', 'facebook', 'youtube', 'whatsapp'] as const).map((k) => <label key={k} className="sswitch"><input type="checkbox" disabled={!need || busy} checked={p.platforms.includes(k)} onChange={(e) => void act(() => socialApi.pack(ep.id, { platforms: e.target.checked ? [...p.platforms, k] : p.platforms.filter((x) => x !== k) }), false)} /> {({ instagram: 'Instagram', facebook: 'Facebook Page', youtube: 'YouTube Shorts', whatsapp: 'WhatsApp Status' } as const)[k]}</label>)}{p.platforms.includes('whatsapp') && <small>A copy under 10 MB and the line are prepared. You (or your Claude session) post it to My Status.</small>}</div>
      </div>
      {TEXTS.map(([k, label, rows]) => <label key={k} className="sfield"><span>{label} <small>{(f[k] ?? p[k] ?? '').length}</small><CopyBtn text={f[k] ?? p[k] ?? ''} /></span><textarea className="text-input" rows={rows} readOnly={!need} value={f[k] ?? p[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>)}
      <div className="sgrid2"><label className="sfield"><span>Facebook tags</span><textarea className="text-input" rows={2} readOnly={!need} value={f.facebookTags ?? p.facebookTags.join(', ')} onChange={(e) => setF({ ...f, facebookTags: e.target.value })} /></label><label className="sfield"><span>YouTube tags</span><textarea className="text-input" rows={2} readOnly={!need} value={f.youtubeTags ?? p.youtubeTags.join(', ')} onChange={(e) => setF({ ...f, youtubeTags: e.target.value })} /></label></div>
      <div className="sbox"><h3>Keywords used</h3><ul>{p.keywordPlaces.map((k) => <li key={k}>{k}</li>)}</ul></div>
      {need && dirty && <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void act(() => socialApi.pack(ep.id, { ...f, ...(f.facebookTags !== undefined ? { facebookTags: f.facebookTags.split(',') } : {}), ...(f.youtubeTags !== undefined ? { youtubeTags: f.youtubeTags.split(',') } : {}) }), false)}>Save changes</button>}
      {need && <Approve label="Approve the captions" busy={busy || dirty || !p.slot} on={() => void act(() => socialApi.approve(ep.id, 'package', {}))} warn={dirty ? 'Save your changes first' : mustBad(p.checks)[0]?.label ?? null}><span>This makes the publish pack. Nothing is posted.</span></Approve>}
    </>
  );
}

// ---------- 11 schedule ----------
function Schedule({ ep, busy, act, slots }: P) {
  const p = ep.pack;
  const [sure, setSure] = useState(false);
  const [links, setLinks] = useState<Record<string, string>>({});
  if (!p?.folder || ep.stages.package.status !== 'done') return <p className="social__fine">Approve the captions first.</p>;
  const slot = slots.find((s) => s.at === p.slot);
  const NAME: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook Page', youtube: 'YouTube Shorts', whatsapp: 'WhatsApp Status' };
  const left = p.platforms.filter((k) => k !== 'whatsapp' && !['scheduled', 'live'].includes(ep.schedule.results[k]?.status ?? ''));
  const files = [['reel-v1.mp4', 'The reel'], ['cover.jpg', 'Cover'], ['caption-us-ig.txt', 'Instagram caption'], ['caption-us-fb.txt', 'Facebook caption'], ['youtube.txt', 'YouTube texts'], ['comment-ig.txt', 'Instagram comment'], ['comment-fb.txt', 'Facebook comment'], ['comment-youtube.txt', 'YouTube pinned comment'], ...(p.platforms.includes('whatsapp') ? [['whatsapp-status.mp4', 'WhatsApp copy (under 10 MB)'], ['caption-whatsapp.txt', 'WhatsApp line']] : []), ['alt-text.txt', 'Alt text'], ['keywords.json', 'Keywords and tags']];
  return (
    <>
      <div className="sedit">
        <div className="sedit__v"><video controls preload="none" poster={ep.cover.picked ? epFileUrl(ep.id, ep.cover.picked) : undefined} playsInline src={ep.edit.final ? epFileUrl(ep.id, ep.edit.final) : undefined} /></div>
        <div className="sedit__o">
          <div className="sbox"><h3>{slot ? slot.label : p.slot?.replace('T', ' ')}</h3><small>{slot?.us}</small><p>{p.platforms.map((x) => NAME[x]).join(', ')}</p><pre className="sprompt is-short">{p.instagram}</pre></div>
          <div className="sbox"><h3>Publish pack</h3><ul className="sfiles">{files.map(([f, l]) => <li key={f}><a href={epFileUrl(ep.id, `${p.folder}/${f}`, true)}><Download size={13} aria-hidden /> {l}</a></li>)}</ul></div>
        </div>
      </div>
      <ul className="splat">{p.platforms.map((k) => { const r = ep.schedule.results[k]; return (
        <li key={k} className={`is-${r?.status ?? 'none'}`}><b>{NAME[k]}</b><span className={`spill is-${r?.status === 'scheduled' || r?.status === 'live' ? 'done' : r?.status === 'failed' ? 'failed' : r ? 'running' : 'idle'}`}>{r ? ({ asked: 'Zubi has been asked', scheduled: 'Scheduled', live: 'Live', failed: 'Not done' } as Record<string, string>)[r.status] : k === 'whatsapp' ? 'Yours to post' : 'Not scheduled'}</span>{r?.link && <a href={r.link} target="_blank" rel="noreferrer">Open</a>}{r?.note && <small>{r.note}</small>}
          <span className="splat__acts"><input className="text-input" placeholder="Link (optional)" value={links[k] ?? ''} aria-label={`${NAME[k]} link`} onChange={(e) => setLinks({ ...links, [k]: e.target.value })} />{r?.status !== 'scheduled' && r?.status !== 'live' && <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void act(() => socialApi.mark(ep.id, { platform: k, status: 'scheduled', link: links[k] }), false)}>Mark scheduled</button>}{r?.status === 'scheduled' && <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void act(() => socialApi.mark(ep.id, { platform: k, status: 'live', link: links[k] }), false)}>Mark live</button>}</span></li>
      ); })}</ul>
      {ep.stages.schedule.status !== 'done' && left.length > 0 && (
        <div className="sgate">
          <div className="sgate__t"><span>Zubi schedules it in Meta Business Suite and YouTube Studio on her own screen, with the AI label on. You have to be signed in there. Or download the pack and schedule it yourself, then mark it here. WhatsApp Status is always yours: the file and line are in the pack.</span>{sure && <small className="sgate__w"><AlertTriangle size={12} aria-hidden /> This asks Zubi to schedule public posts with exactly the captions and cover shown above.</small>}</div>
          {sure ? <><button type="button" className="btn btn--secondary" onClick={() => setSure(false)}><X size={13} aria-hidden /> Not yet</button><button type="button" className="btn btn--primary" disabled={busy} onClick={() => void act(() => socialApi.schedule(ep.id, { method: 'zubi', confirm: true }), false).then(() => setSure(false))}>Yes, schedule it</button></> : <button type="button" className="btn btn--primary" disabled={busy} onClick={() => setSure(true)}>{ep.schedule.askedAt ? 'Ask Zubi again' : 'Ask Zubi to schedule it'}</button>}
        </div>
      )}
      <p className="social__fine">After it’s live: check each one, then post the first comments from the pack. Comments are never posted for you.</p>
    </>
  );
}

const PANELS: Record<StageId, (p: P) => ReactNode> = { story: Story, script: ScriptPanel, cast: CastPanel, screens: Screens, storyboard: Storyboard, render: Render, review: ReviewPanel, edit: EditPanel, cover: Cover, package: Package, schedule: Schedule };
