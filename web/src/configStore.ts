import { create } from 'zustand';
import type { ServerEvent } from '@shared/types';
import { useStore } from './store';
import { lsGet, lsSet } from './lib/storage';

/** UI state for bot settings, app settings, the Tasks view and the theme. Kept apart from store.ts on purpose. */

export type Theme = 'system' | 'light' | 'dark' | 'navy';
export type BotSettingsTab = 'general' | 'skills' | 'memories' | 'routines';
export type AppSection = 'status' | 'general' | 'teams' | 'computer' | 'permissions' | 'apps' | 'api' | 'desktop' | 'account';
export type MainView = 'chat' | 'tasks' | 'generations';

interface ConfigUI {
  botSettings: { botId: string; tab: BotSettingsTab } | null;
  appSettings: AppSection | null;
  view: MainView;
  theme: Theme;
  /** Bumped by server events (tasks, memories) so open views refetch. Keys: 'tasks', 'memories:<botId>'. */
  versions: Record<string, number>;
  openBotSettings(botId: string, tab?: BotSettingsTab): void;
  closeBotSettings(): void;
  openAppSettings(section?: AppSection): void;
  closeAppSettings(): void;
  setView(v: MainView): void;
  setTheme(t: Theme): void;
  bump(key: string): void;
}

const LS_THEME = 'theme';
const readTheme = (): Theme => {
  const t = lsGet(LS_THEME);
  return t === 'light' || t === 'dark' || t === 'navy' ? t : 'system';
};

const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/** Navy (from Zubi HQ) is a dark theme with a navy palette: it keeps every dark-theme rule and swaps the surfaces. */
export function applyTheme(t: Theme) {
  const resolved = t === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : t === 'navy' ? 'dark' : t;
  document.documentElement.dataset.theme = resolved;
  if (t === 'navy') document.documentElement.dataset.palette = 'navy';
  else delete document.documentElement.dataset.palette;
  document.documentElement.style.colorScheme = resolved;
}

export const useConfigUI = create<ConfigUI>((set, get) => ({
  botSettings: null,
  appSettings: null,
  view: 'chat',
  theme: readTheme(),
  versions: {},
  openBotSettings: (botId, tab = 'general') => set({ botSettings: { botId, tab } }),
  closeBotSettings: () => set({ botSettings: null }),
  openAppSettings: (section = 'status') => set({ appSettings: section }),
  closeAppSettings: () => set({ appSettings: null }),
  setView: (view) => set({ view }),
  setTheme: (theme) => {
    lsSet(LS_THEME, theme);
    applyTheme(theme);
    set({ theme });
  },
  bump: (key) => set({ versions: { ...get().versions, [key]: (get().versions[key] ?? 0) + 1 } }),
}));

// Apply the saved theme as early as possible, and follow the OS while on "system".
applyTheme(readTheme());
darkQuery?.addEventListener?.('change', () => { if (useConfigUI.getState().theme === 'system') applyTheme('system'); });

// store.ts forwards events it doesn't handle itself as a DOM event.
window.addEventListener('heyzubi:event', (e) => {
  const ev = (e as CustomEvent<ServerEvent>).detail;
  const { bump } = useConfigUI.getState();
  if (ev.type === 'tasks') { bump('tasks'); bump(`tasks:${ev.botId}`); }
  if (ev.type === 'memories') bump(`memories:${ev.botId}`);
});

// Picking a bot anywhere (sidebar, search) goes back to its chat.
useStore.subscribe((s, prev) => {
  if (s.selectedBotId !== prev.selectedBotId && useConfigUI.getState().view !== 'chat') useConfigUI.getState().setView('chat');
});

export const useVersion = (key: string) => useConfigUI((s) => s.versions[key] ?? 0);
