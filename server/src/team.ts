import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { getBot, getBotRow, updateRow } from './store.js';
import { assignEngine, primaryBotId, provisionEngine } from './engine.js';
import { enqueue } from './agent/loop.js';
import { isPropId } from './avatar-props.js';
import { isGender, type Gender } from './gender.js';
import type { AvatarColor, AvatarShape } from './types.js';

/**
 * Adding a team member: one path for the app's "+" button and for Zubi's create_team_member tool, so a new bot is
 * always a HeyZubi bot with its own Hermes profile (made on its engine's first start, then given the same name,
 * mascot and description in Hermes).
 */

/** Thrown for things the user can fix; the message is shown to them. */
export class UserError extends Error {}

export const SHAPES: AvatarShape[] = ['blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex', 'gem', 'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf', 'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star'];
export const COLORS: AvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'lime', 'cyan', 'blue', 'violet', 'magenta', 'gray'];

export function hashPick<T>(id: string, list: T[]): T {
  let h = 0x811c9dc5;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return list[h % list.length];
}

export const agentCount = () => (db.prepare("SELECT COUNT(*) n FROM bots WHERE COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0").get() as any).n as number;

export interface NewBot {
  name: string; label?: string; description?: string; instructions?: string; avatarShape?: string; avatarColor?: string;
  mode?: string; isPrimary?: boolean; team?: string | null; isManager?: boolean; avatarProp?: string | null; gender?: Gender | null;
}

export function createBot(userId: string, b: NewBot) {
  // Every bot needs a screen of its own on the one shared computer.
  if (agentCount() >= env.maxBots) throw new UserError(`The team is full: the computer has room for ${env.maxBots} bots. Remove one to add another.`);
  const id = newId('bot');
  const shape = SHAPES.includes(b.avatarShape as AvatarShape) ? b.avatarShape : hashPick(id, SHAPES.slice(0, 13));
  const color = COLORS.includes(b.avatarColor as AvatarColor) ? b.avatarColor : hashPick(id, COLORS.filter((c) => c !== 'black'));
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, userId, b.name.trim().slice(0, 60) || 'New Bot', b.label ?? '', b.description ?? '', b.instructions ?? '', shape, color, b.mode === 'teammate' ? 'teammate' : 'personal', b.isPrimary ? 1 : 0, now(), now());
  if (b.team && !b.isPrimary) db.prepare('UPDATE bots SET team=?, is_manager=? WHERE id=?').run(String(b.team).slice(0, 40), b.isManager ? 1 : 0, id);
  if (isPropId(b.avatarProp)) db.prepare('UPDATE bots SET avatar_prop=? WHERE id=?').run(b.avatarProp, id);
  if (isGender(b.gender)) db.prepare('UPDATE bots SET gender=? WHERE id=?').run(b.gender, id);
  // The usual call voices are women's; a man gets a man's (the owner can change it in its settings).
  if (b.gender === 'male') db.prepare("UPDATE bots SET voice='orion', gemini_voice='Puck' WHERE id=?").run(id);
  // The first bot is the agent that already runs on the computer; the others get an engine of their own.
  if (assignEngine(id) === 'managed') provisionEngine(id);
  hub.emit(userId, { type: 'roster' });
  return getBot(id)!;
}

/**
 * A team member just signed in to Claude (from its card in Zubi's chat or from its own settings): the card in Zubi's
 * chat shows it done, and Zubi is told so it can say hello to the new member and guide the owner's next step.
 */
export function teammateSignedIn(botId: string) {
  const zubi = primaryBotId();
  const bot = getBotRow(botId);
  if (!zubi || !bot || zubi === botId) return;
  const rows = db.prepare("SELECT seq, body FROM rows WHERE bot_id=? AND generation=(SELECT generation FROM bots WHERE id=?) AND kind='card' AND body LIKE ? ORDER BY seq DESC LIMIT 5").all(zubi, zubi, `%"teammateId":"${botId}"%`) as any[];
  let card = false;
  for (const r of rows) {
    let body: any;
    try { body = JSON.parse(r.body); } catch { continue; }
    if (body?.card !== 'teammate' || body.teammateId !== botId) continue;
    card = true;
    if (body.status !== 'ready') updateRow(zubi, r.seq, { ...body, status: 'ready' });
  }
  if (card) {
    enqueue(zubi, {
      type: 'system', owner: true,
      text: `The owner signed ${bot.name} in to Claude with its own sign-in. Check ${bot.name} answers: send it a one-line hello with send_to_bot. When its reply comes, tell the owner in two or three short lines that ${bot.name} is ready, what it can do first, and that it is in the sidebar.`,
    });
  }
}
