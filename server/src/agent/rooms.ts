import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendRow } from '../store.js';
import { runInBotQueue } from './loop.js';

/**
 * Group chats ("rooms").
 * A room is a bot row with kind='room' and a members list. It never runs its own agent loop:
 * a user message is dispatched to the members who should answer (@mentioned ones, else all,
 * capped), each member runs its normal loop with the group context and replies into the room
 * with post_to_group.
 */

const MAX_RESPONDERS = 3;

export function initRooms() {
  for (const col of ["kind TEXT NOT NULL DEFAULT 'agent'", 'members TEXT']) {
    try { db.exec(`ALTER TABLE bots ADD COLUMN ${col}`); } catch { /* exists */ }
  }
}

export const isRoom = (botId: string) => (db.prepare('SELECT kind FROM bots WHERE id=?').get(botId) as any)?.kind === 'room';

export function roomMembers(roomId: string): { id: string; name: string }[] {
  const r = db.prepare('SELECT members FROM bots WHERE id=?').get(roomId) as any;
  const ids: string[] = r?.members ? JSON.parse(r.members) : [];
  return ids.map((id) => db.prepare('SELECT id, name FROM bots WHERE id=?').get(id) as any).filter(Boolean);
}

export function createRoom(userId: string, name: string, memberIds: string[]) {
  const id = newId('room');
  db.prepare(
    `INSERT INTO bots(id,user_id,name,label,description,avatar_shape,avatar_color,kind,members,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'room',?,?,?)`,
  ).run(id, userId, name.slice(0, 60), 'Group', `Group chat with ${memberIds.length} Bots`, 'cloud', 'gray', JSON.stringify(memberIds), now(), now());
  hub.emit(userId, { type: 'roster' });
  return id;
}

/** Called instead of the agent loop when the user posts in a room. */
export function dispatchRoomMessage(roomId: string, text: string, enqueue: (botId: string, t: any) => void) {
  const room = db.prepare('SELECT * FROM bots WHERE id=?').get(roomId) as any;
  const members = roomMembers(roomId);
  if (!members.length) {
    appendRow(roomId, 'notice', { type: 'notice', text: 'This group has no team members yet.', tone: 'warn' });
    return;
  }
  const lower = text.toLowerCase();
  const mentioned = members.filter((m) => lower.includes(`@${m.name.toLowerCase()}`));
  const recentNow = () => (db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq DESC LIMIT 14").all(roomId, room.generation) as any[])
    .reverse()
    .map((r) => {
      const b = JSON.parse(r.body);
      return `${b.from?.name ?? (b.role === 'user' ? 'User' : 'Bot')}: ${String(b.text).slice(0, 600)}`;
    })
    .join('\n');

  // With a lead (from Theo's group head): the others give their honest view first, then the lead wraps up.
  const lead = room.lead_bot_id ? members.find((m) => m.id === room.lead_bot_id) : undefined;
  if (lead && !mentioned.length && members.length >= 2) {
    const others = members.filter((m) => m.id !== lead.id).slice(0, MAX_RESPONDERS);
    // A researcher goes first and posts its findings, so the others build on them instead of guessing.
    const research = others.find((m) => m.id === room.research_bot_id);
    const ask = (m: { id: string; name: string }, recent: string) => {
      enqueue(m.id, {
        type: 'system',
        owner: true, // the user posted in the group
        text:
          `[Group chat "${room.name}"] The owner wrote in this group, in their own words, and asked for your view: posting it here is what they asked for (nothing else is approved by that). Members: ${members.map((x) => x.name).join(', ')}. ${lead.name} leads this group and will give the user the combined answer.\n` +
          `Recent group messages:\n${recent}\n\n` +
          (m.id === research?.id
            ? 'You do the research for this group and go first. Look things up with your tools, then post what you found: the facts that matter, with sources, and what you could not find. Keep opinion to a line or two. '
            : `Give your view from your own role: what is missing, what is likely to go wrong, what you would do. Be specific, and disagree where you do; don't just agree. ${research ? `${research.name} does the research: build on those findings (above) instead of redoing them. ` : ''}`) +
          `Do not wrap up or summarise for the group: ${lead.name} does that. Reply by calling post_to_group with group_name "${room.name}" (use your tools first if the request needs real work). If you have nothing to add, call stay_silent.`,
      });
    };
    const finished = (ids: string[], minutes: number) => Promise.race([Promise.all(ids.map((id) => runInBotQueue(id, async () => {}))), new Promise((r) => setTimeout(r, minutes * 60_000))]);
    const rest = others.filter((m) => m !== research);
    const first = async () => { if (research) { ask(research, recentNow()); await finished([research.id], 10); } };
    // Once every member has finished (or after 15 minutes), the lead answers for the group.
    void first().then(() => {
      const recent = recentNow();
      for (const m of rest) ask(m, recent);
      return finished(rest.map((m) => m.id), 15);
    }).then(() => {
      enqueue(lead.id, {
        type: 'system',
        owner: true,
        text:
          `[Group chat "${room.name}"] The owner wrote in this group, in their own words, and asked for the group's answer: posting it here is what they asked for (nothing else is approved by that). You lead this group. ${others.map((x) => x.name).join(', ')} have given their views (below).\n` +
          `Recent group messages:\n${recentNow()}\n\n` +
          'Give the user one combined answer: the plan or decision, where the team agreed, where they disagreed and what you would do about it. Keep it short. ' +
          `Post it by calling post_to_group with group_name "${room.name}". Do not write a normal reply.`,
      });
    });
    return;
  }

  const responders = (mentioned.length ? mentioned : members).slice(0, MAX_RESPONDERS);
  const recent = recentNow();
  for (const m of responders) {
    enqueue(m.id, {
      type: 'system',
      owner: true, // the user posted in the group
      text:
        `[Group chat "${room.name}"] Members: ${members.map((x) => x.name).join(', ')}. ` +
        `${mentioned.length ? 'You were @mentioned.' : 'The user addressed the whole group.'}\n` +
        `Recent group messages:\n${recent}\n\n` +
        `Reply to the group by calling post_to_group with group_name "${room.name}" (use your tools first if the request needs real work). ` +
        `Keep it short and don't repeat what other team members already said. If you have nothing to add, call stay_silent. Do not write a normal reply.`,
    });
  }
}

export function postToRoom(fromBotId: string, roomName: string, text: string) {
  const from = db.prepare('SELECT id, user_id, name FROM bots WHERE id=?').get(fromBotId) as any;
  const room = db.prepare("SELECT * FROM bots WHERE user_id=? AND kind='room' AND lower(name)=lower(?)").get(from.user_id, roomName.trim()) as any;
  if (!room) return `No group named "${roomName}".`;
  const members: string[] = room.members ? JSON.parse(room.members) : [];
  if (!members.includes(fromBotId)) return `You're not a member of "${room.name}".`;
  appendRow(room.id, 'message', { type: 'message', role: 'assistant', text, from: { kind: 'bot', id: from.id, name: from.name } });
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(room.id);
  return 'Posted to the group.';
}
