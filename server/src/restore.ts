import { Hono } from 'hono';
import { db, now } from './db.js';
import { interrupt } from './agent/loop.js';
import { forgetBotFiles, releaseScreen } from './computer.js';
import { engineKind, provisionEngine, removeEngine, stopGateway } from './engine.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { scheduleRoutine, unscheduleRoutine } from './routines.js';
import { getBotRow, listRoutines } from './store.js';
import { deleteEventTrigger } from './triggers.js';

/**
 * Delete with restore. Deleting a team member or group chat moves it to Recently deleted for 7 days: it leaves the
 * team, its routines stop and its agent is stopped, but its chat, memory, skills, Library and Hermes profile stay.
 * Restore brings it back as it was. After 7 days it is removed for good, as deletion used to do at once (its Hermes
 * profile is still exported to a backup first).
 */

export const KEEP_DAYS = 7;
const KEEP_MS = KEEP_DAYS * 86_400_000;

/** Move a bot to Recently deleted. */
export async function softDelete(botId: string) {
  const b = getBotRow(botId);
  if (!b) return;
  interrupt(b.id);
  for (const r of listRoutines(b.id)) unscheduleRoutine(r.id);
  db.prepare('UPDATE bots SET hidden=1, deleted_at=? WHERE id=?').run(now(), b.id);
  if (b.kind !== 'room' && engineKind(b.id) === 'managed') await stopGateway(b.id).catch((e) => console.warn('[restore] stop failed', e?.message ?? e));
  hub.emit(b.user_id, { type: 'roster' });
}

/** Remove a bot for good (what deletion did before Recently deleted existed). */
export async function purge(botId: string) {
  const b = getBotRow(botId);
  if (!b) return;
  for (const r of listRoutines(b.id)) { unscheduleRoutine(r.id); await deleteEventTrigger(r.id).catch(() => {}); }
  if (b.kind !== 'room') {
    await removeEngine(b.id).catch((e) => console.warn('[engine] remove failed', e?.message ?? e));
    await releaseScreen(b.id).catch((e) => console.warn('[computer] release failed', e?.message ?? e));
    await forgetBotFiles(b.id).catch((e) => console.warn('[computer] cleanup failed', e?.message ?? e));
  }
  db.prepare('DELETE FROM screens WHERE bot_id=?').run(b.id);
  db.prepare('DELETE FROM bots WHERE id=?').run(b.id);
  hub.emit(b.user_id, { type: 'roster' });
}

export const deletedApi = new Hono<AuthVars>();
deletedApi.use('*', requireUser);

deletedApi.get('/', (c) => c.json({
  keepDays: KEEP_DAYS,
  bots: (db.prepare('SELECT id, name, label, kind, avatar_shape, avatar_color, deleted_at FROM bots WHERE user_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(c.get('user').id) as any[])
    .map((b) => ({ id: b.id, name: b.name, label: b.label, kind: b.kind ?? 'agent', avatarShape: b.avatar_shape, avatarColor: b.avatar_color, deletedAt: b.deleted_at, goneAt: b.deleted_at + KEEP_MS })),
}));

/** Bring a bot back from Recently deleted. */
deletedApi.post('/:id/restore', (c) => {
  const b = getBotRow(c.req.param('id'));
  if (!b || b.user_id !== c.get('user').id || !b.deleted_at) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET hidden=0, deleted_at=NULL, updated_at=? WHERE id=?').run(now(), b.id);
  for (const r of listRoutines(b.id)) if (r.enabled && !String(r.schedule).startsWith('event:')) scheduleRoutine(r);
  if (b.kind !== 'room' && engineKind(b.id) === 'managed') provisionEngine(b.id);
  hub.emit(b.user_id, { type: 'roster' });
  return c.json({ ok: true, id: b.id });
});

/** Remove one for good now, without waiting the 7 days. */
deletedApi.delete('/:id', async (c) => {
  const b = getBotRow(c.req.param('id'));
  if (!b || b.user_id !== c.get('user').id || !b.deleted_at) return c.json({ error: 'not found' }, 404);
  await purge(b.id);
  return c.json({ ok: true });
});

export function initRestore() {
  const sweep = () => {
    for (const b of db.prepare('SELECT id FROM bots WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(now() - KEEP_MS) as any[]) {
      purge(b.id).catch((e) => console.warn('[restore] purge failed', e?.message ?? e));
    }
  };
  setTimeout(sweep, 5 * 60_000).unref();
  setInterval(sweep, 60 * 60_000).unref();
}
