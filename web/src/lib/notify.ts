// Desktop notifications (from Theo): when a bot finishes or starts waiting for the owner's OK while HeyZubi
// isn't the window in front, a notification says so; clicking it opens that chat. Off until the owner turns
// it on (Settings → General), which asks the browser for permission.
import { lsGet, lsSet } from './storage';
import { sortedRows, useStore } from '../store';

const KEY = 'notify';
export const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window;
export const notifyEnabled = () => notifySupported() && lsGet(KEY) === '1' && Notification.permission === 'granted';

/** Turn notifications on (asks for permission) or off. Returns whether they're on now. */
export async function setNotify(on: boolean): Promise<boolean> {
  if (!notifySupported()) return false;
  if (!on) { lsSet(KEY, '0'); return false; }
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  lsSet(KEY, perm === 'granted' ? '1' : '0');
  return perm === 'granted';
}

const away = () => document.hidden || !document.hasFocus();

function show(botId: string, title: string, body: string) {
  try {
    const n = new Notification(title, { body: body.slice(0, 180), tag: `heyzubi-${botId}`, icon: '/favicon.svg' });
    n.onclick = () => {
      window.focus();
      const st = useStore.getState();
      if (st.selectedBotId !== botId) void st.selectBot(botId);
      n.close();
    };
  } catch { /* the browser refused (e.g. inside another site's frame) */ }
}

/** Watch every bot's live state; called once when the app starts. */
export function startNotifications(): () => void {
  return useStore.subscribe((s, prev) => {
    if (!notifyEnabled() || !away()) return;
    for (const [botId, live] of Object.entries(s.live)) {
      const before = prev.live[botId];
      if (!live || live === before) continue;
      const bot = s.bots.find((b) => b.id === botId);
      const name = bot?.name ?? 'Your bot';
      if (live.awaiting && !before?.awaiting) {
        show(botId, `${name} needs your OK`, live.awaiting.reason || 'Something is waiting for you in the chat.');
      } else if (before?.isRunning && !live.isRunning && !live.awaiting) {
        const rows = sortedRows(s.transcripts[botId]);
        const last = [...rows].reverse().find((r) => r.body.type === 'message' && r.body.role === 'assistant' && !r.body.streaming);
        const text = last && last.body.type === 'message' ? last.body.text.replace(/\s+/g, ' ').trim() : '';
        show(botId, `${name} is done`, text || 'Open the chat to see the result.');
      }
    }
  });
}
