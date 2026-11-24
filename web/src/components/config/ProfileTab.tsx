import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Bot } from '@shared/types';
import { configApi, type HermesProfile, type HermesProfileChanges } from '../../lib/configApi';
import { Field, Switch } from './ui';

/**
 * The bot's Hermes profile, as the Hermes app's Edit Profile has it: description, soul (SOUL.md), model, skills,
 * toolsets and MCP servers. It is read from the profile each time and saved through Hermes itself, so a change made
 * in either app shows in the other. Name and character are set on the General tab and carried to Hermes from there.
 */
export function ProfileTab({ bot }: { bot: Bot }) {
  const [base, setBase] = useState<HermesProfile | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<HermesProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [skillFilter, setSkillFilter] = useState('');

  const load = useCallback(() => {
    setError(null);
    configApi.profile(bot.id)
      .then(({ profile }) => { setBase(profile); setDraft(profile ? structuredClone(profile) : null); })
      .catch((e) => setError((e as Error).message));
  }, [bot.id]);
  useEffect(() => { setBase(undefined); setDraft(null); load(); }, [load]);

  const changes = useMemo<HermesProfileChanges>(() => {
    if (!base || !draft) return {};
    const out: HermesProfileChanges = {};
    if (draft.description !== base.description) out.description = draft.description;
    if (draft.soul !== base.soul) out.soul = draft.soul;
    if (draft.model.default !== base.model.default || draft.model.provider !== base.model.provider) { out.model = draft.model.default; out.provider = draft.model.provider; }
    const flags = <T extends { name: string; enabled: boolean }>(a: T[], b: T[]) => a.some((x, i) => x.enabled !== b[i]?.enabled);
    if (flags(draft.skills, base.skills)) out.disabled_skills = draft.skills.filter((s) => !s.enabled).map((s) => s.name);
    if (flags(draft.toolsets, base.toolsets)) {
      const on = draft.toolsets.filter((t) => t.enabled);
      // All on (or none) clears Hermes's pin, as its own editor does.
      out.enabled_toolsets = on.length === draft.toolsets.length || on.length === 0 ? [] : on.map((t) => t.name);
    }
    if (flags(draft.mcp_servers, base.mcp_servers)) out.enabled_mcp_servers = draft.mcp_servers.filter((m) => m.enabled).map((m) => m.name);
    return out;
  }, [base, draft]);
  const dirty = Object.keys(changes).length > 0;

  const flash = (text: string, tone: 'ok' | 'error' = 'ok') => { setNote({ text, tone }); setTimeout(() => setNote(null), 3200); };

  const save = async (confirmModel = false) => {
    if (!dirty) return;
    setSaving(true);
    setConfirm(null);
    try {
      const r = await configApi.saveProfile(bot.id, { ...changes, ...(confirmModel ? { confirm_expensive_model: true } : {}) });
      if ('confirmRequired' in r && r.confirmRequired) { setConfirm(r.message); return; }
      if ('profile' in r) {
        setBase(r.profile);
        setDraft(structuredClone(r.profile));
        flash(r.ok ? `Saved to ${bot.name}’s Hermes profile` : `Saved, except: ${r.failed.join(', ')}`, r.ok ? 'ok' : 'error');
      }
    } catch (e) {
      flash((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (error) return <div className="cfg-page"><div className="cfg-error">Couldn’t read the Hermes profile: {error}</div><button type="button" className="cfg-btn cfg-btn--secondary" onClick={load}>Try again</button></div>;
  if (base === undefined || (base && !draft)) return <div className="cfg-page"><div className="cfg-empty">Reading {bot.name}’s Hermes profile…</div></div>;
  if (base === null || !draft) {
    return (
      <div className="cfg-page">
        <div className="cfg-empty">{bot.name} isn’t a Hermes profile, so there is nothing to edit here. Team members added from now on are Hermes profiles.</div>
      </div>
    );
  }

  const put = (p: Partial<HermesProfile>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const toggle = <K extends 'skills' | 'toolsets' | 'mcp_servers'>(key: K, name: string, on: boolean) =>
    setDraft((d) => (d ? { ...d, [key]: (d[key] as { name: string; enabled: boolean }[]).map((x) => (x.name === name ? { ...x, enabled: on } : x)) } : d));
  const skills = draft.skills.filter((s) => !skillFilter || s.name.toLowerCase().includes(skillFilter.toLowerCase()));
  const skillsOn = draft.skills.filter((s) => s.enabled).length;

  return (
    <div className="cfg-page hp">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Hermes profile <span className="hp__id">{draft.name}</span></div>
          <div className="cfg-page__sub">The same profile the Hermes app edits: a change made there shows here, and Save here updates Hermes. Name and look are on the General tab.</div>
        </div>
        <div className="hp__actions">
          {note && <span className={`cfg-note cfg-note--${note.tone}`}>{note.text}</span>}
          <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!dirty || saving} onClick={() => { setDraft(structuredClone(base)); setConfirm(null); }}>Undo changes</button>
          <button type="button" className="cfg-btn cfg-btn--primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>

      {confirm && (
        <div className="hp__confirm" role="alert">
          <div><b>Hermes asks before switching to this model.</b> {confirm}</div>
          <div className="hp__confirm-actions">
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setConfirm(null)}>Keep the current model</button>
            <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => void save(true)}>Switch anyway</button>
          </div>
        </div>
      )}

      <section className="cfg-section">
        <Field label="Description" htmlFor="hp-desc" hint="What this team member owns and where its limits are. Hermes's task board uses it to decide who gets a task.">
          <textarea id="hp-desc" className="text-input cfg-textarea" rows={4} maxLength={4000} value={draft.description} onChange={(e) => put({ description: e.target.value })} />
        </Field>
      </section>

      <section className="cfg-section">
        <Field label="Soul (SOUL.md)" htmlFor="hp-soul" hint="Who this team member is and how it works. Read at the start of every conversation, in HeyZubi and in Hermes.">
          <textarea id="hp-soul" className="text-input cfg-textarea hp__soul" rows={16} spellCheck={false} value={draft.soul} onChange={(e) => put({ soul: e.target.value })} />
        </Field>
      </section>

      <section className="cfg-section cfg-grid">
        <Field label="Model provider" htmlFor="hp-provider" hint="Hermes's default for this profile, e.g. anthropic.">
          <input id="hp-provider" className="text-input" value={draft.model.provider} maxLength={80} onChange={(e) => put({ model: { ...draft.model, provider: e.target.value } })} />
        </Field>
        <Field label="Model" htmlFor="hp-model" hint="e.g. claude-sonnet-5-5. The Engine panel can still pick another just for HeyZubi chats.">
          <input id="hp-model" className="text-input" value={draft.model.default} maxLength={160} onChange={(e) => put({ model: { ...draft.model, default: e.target.value } })} />
        </Field>
      </section>

      <section className="cfg-section">
        <div className="hp__list-head">
          <div className="cfg-field__label">Toolsets</div>
          <span className="cfg-field__hint">{draft.toolsets.filter((t) => t.enabled).length} of {draft.toolsets.length} on</span>
        </div>
        <div className="hp__list">
          {draft.toolsets.map((t) => (
            <div key={t.name} className="hp__row">
              <div className="hp__row-text"><div className="hp__row-title">{t.label || t.name}</div><div className="hp__row-sub">{t.description}{t.tool_count ? ` · ${t.tool_count} tools` : ''}</div></div>
              <Switch on={t.enabled} label={`${t.label || t.name} toolset`} onChange={(on) => toggle('toolsets', t.name, on)} />
            </div>
          ))}
        </div>
      </section>

      <section className="cfg-section">
        <div className="hp__list-head">
          <div className="cfg-field__label">MCP servers</div>
          <span className="cfg-field__hint">{draft.mcp_servers.length ? `${draft.mcp_servers.filter((m) => m.enabled).length} of ${draft.mcp_servers.length} on` : 'None set up'}</span>
        </div>
        <div className="hp__list">
          {draft.mcp_servers.map((m) => (
            <div key={m.name} className="hp__row">
              <div className="hp__row-text"><div className="hp__row-title">{m.name}</div><div className="hp__row-sub">{m.transport === 'stdio' ? 'Runs on the computer' : 'Over the network'}{m.name === 'hq' ? ' · HeyZubi’s own tools' : ''}</div></div>
              <Switch on={m.enabled} label={`${m.name} MCP server`} onChange={(on) => toggle('mcp_servers', m.name, on)} />
            </div>
          ))}
        </div>
      </section>

      <section className="cfg-section">
        <div className="hp__list-head">
          <div className="cfg-field__label">Skills</div>
          <span className="cfg-field__hint">{skillsOn} of {draft.skills.length} on</span>
          <input className="text-input hp__filter" placeholder="Find a skill" value={skillFilter} onChange={(e) => setSkillFilter(e.target.value)} aria-label="Find a skill" />
        </div>
        <div className="hp__list hp__list--skills">
          {skills.map((s) => (
            <div key={s.name} className="hp__row hp__row--compact">
              <div className="hp__row-title">{s.name}</div>
              <Switch on={s.enabled} label={`${s.name} skill`} onChange={(on) => toggle('skills', s.name, on)} />
            </div>
          ))}
          {!skills.length && <div className="cfg-empty">No skill matches “{skillFilter}”.</div>}
        </div>
      </section>
    </div>
  );
}
