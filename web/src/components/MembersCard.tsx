import { useCallback, useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api, type RoomMember } from '../lib/api';
import { useStore } from '../store';
import { Icon } from './Icon';

/** Members of a group chat, with add/remove. Shown in the details panel for rooms. */
export function MembersCard({ room }: { room: Bot }) {
  const bots = useStore((s) => s.bots);
  const [members, setMembers] = useState<RoomMember[] | null>(null);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [researchId, setResearchId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.roomMembers(room.id).then((r) => { setMembers(r.members); setLeadId(r.leadId ?? null); setResearchId(r.researchId ?? null); }).catch((e) => setError((e as Error).message));
  }, [room.id]);
  useEffect(load, [load]);

  const save = async (ids: string[]) => {
    setError(null);
    try { await api.setRoomMembers(room.id, ids); load(); } catch (e) { setError((e as Error).message); }
  };

  const ids = members?.map((m) => m.id) ?? [];
  const lead = members?.find((m) => m.id === leadId);
  const setLead = async (id: string | null) => {
    setError(null);
    try { const r = await api.setRoomLead(room.id, id); setLeadId(r.leadId); } catch (e) { setError((e as Error).message); }
  };
  const setResearch = async (id: string | null) => {
    setError(null);
    try { const r = await api.setRoomResearch(room.id, id); setResearchId(r.researchId); } catch (e) { setError((e as Error).message); }
  };
  const candidates = bots.filter((b) => b.kind !== 'room' && !ids.includes(b.id));

  return (
    <div className="panel-card members">
      {members === null ? <div className="panel-empty">Loading…</div> : members.length === 0 ? (
        <div className="panel-empty">No one from your team is in this group yet.</div>
      ) : members.map((m) => {
        const bot = bots.find((b) => b.id === m.id);
        return (
          <div key={m.id} className="panel-row members__row">
            {bot ? <BotAvatarFor bot={bot} size={24} /> : <span className="members__dot" />}
            <span className="members__text">
              <span className="members__name">{m.name}</span>
              {m.label && <span className="members__label">{m.label}</span>}
            </span>
            {m.id !== leadId && (
              <button
                type="button"
                className={`members__lead${m.id === researchId ? ' is-lead' : ''}`}
                onClick={() => void setResearch(m.id === researchId ? null : m.id)}
                aria-pressed={m.id === researchId}
                title={m.id === researchId ? `${m.name} does the research: goes first, and the others build on it. Click to stop.` : `Have ${m.name} do the research: goes first, and the others build on it. Works when the group has a lead.`}
              >
                Research
              </button>
            )}
            <button
              type="button"
              className={`members__lead${m.id === leadId ? ' is-lead' : ''}`}
              onClick={() => void setLead(m.id === leadId ? null : m.id)}
              aria-pressed={m.id === leadId}
              title={m.id === leadId ? `${m.name} leads: the others give their view, then ${m.name} wraps up. Click to have no lead.` : `Make ${m.name} the lead: the others give their view first, then ${m.name} wraps up one answer.`}
            >
              {m.id === leadId ? 'Lead' : 'Make lead'}
            </button>
            <button
              type="button"
              className="icon-btn members__remove"
              aria-label={`Remove ${m.name}`}
              title={`Remove ${m.name}`}
              onClick={() => save(ids.filter((x) => x !== m.id))}
              disabled={ids.length <= 2}
            >
              <Icon name="close" size={10} opacity={0.56} />
            </button>
          </div>
        );
      })}
      {adding ? (
        <div className="members__add">
          {candidates.length ? candidates.map((b) => (
            <button key={b.id} type="button" className="panel-row panel-row--link" onClick={() => { setAdding(false); save([...ids, b.id]); }}>
              <BotAvatarFor bot={b} size={20} />
              <span className="panel-row__title" style={{ flex: 1 }}>{b.name}</span>
            </button>
          )) : <div className="panel-empty">Your whole team is already here.</div>}
        </div>
      ) : (
        <button type="button" className="panel-row panel-row--action" onClick={() => setAdding(true)}>
          <Icon name="plus" size={12} opacity={0.56} /> Add a team member
        </button>
      )}
      {error && <div className="card__error">{error}</div>}
      <div className="members__hint">{lead ? `@mention a team member to ask just them. Otherwise everyone gives their honest view, then ${lead.name} wraps up one answer.` : '@mention a team member to ask just them; otherwise the group answers. Pick a lead to get one combined answer.'}</div>
    </div>
  );
}
