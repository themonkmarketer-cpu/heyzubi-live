import { create } from 'zustand';
import type { ServerEvent } from '@shared/types';
import { useStore } from './store';
import { lsGet, lsSet } from './lib/storage';

/** UI state for bot settings, app settings, the Tasks view and the theme. Kept apart from store.ts on purpose. */

/**
 * Legacy dark (the earlier purple look) is the default. Midnight and Forest (dark), Sandstone and Silver (light) are
 * palettes on the same light or dark base (themes.css). An older saved theme (Pearl, Sand, Obsidian, Navy, Legacy
 * light, System) falls back to Legacy dark.
 */
export type Theme = 'dark' | 'midnight' | 'forest' | 'sandstone' | 'silver';
export const DEFAULT_THEME: Theme = 'dark';

/** How each theme is built from the stylesheets: a light or dark base, an optional palette, and the refreshed look. */
export const THEMES: Record<Theme, { base: 'light' | 'dark'; palette?: string; refresh?: boolean; label: string; hint: string }> = {
  dark: { base: 'dark', label: 'Legacy dark', hint: 'The original HeyZubi purple dark' },
  midnight: { base: 'dark', palette: 'midnight', refresh: true, label: 'Midnight', hint: 'Deep navy' },
  forest: { base: 'dark', palette: 'forest', refresh: true, label: 'Forest', hint: 'Deep green to mint' },
  sandstone: { base: 'light', palette: 'sandstone', refresh: true, label: 'Sandstone', hint: 'Warm cream' },
  silver: { base: 'light', palette: 'silver', refresh: true, label: 'Silver', hint: 'Quiet greys' },
};
export const THEME_ORDER: Theme[] = ['dark', 'midnight', 'forest', 'sandstone', 'silver'];
export type BotSettingsTab = 'general' | 'profile' | 'skills' | 'memories' | 'routines';
export type AppSection = 'status' | 'usage' | 'products' | 'pointer' | 'dictation' | 'general' | 'teams' | 'computer' | 'permissions' | 'apps' | 'api' | 'desktop' | 'account' | 'access' | 'deleted' | 'shares';
export type MainView = 'chat' | 'tasks' | 'generations' | 'board' | 'routines' | 'social' | 'usage';

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
  return t && t in THEMES ? (t as Theme) : DEFAULT_THEME;
};

/** The theme actually shown (every theme is shown as it is). */
export const resolveTheme = (t: Theme): Theme => (t in THEMES ? t : DEFAULT_THEME);

/**
 * Sets the page's theme attributes: data-theme (the light or dark base every rule keys on), data-palette (the
 * surfaces), data-look="refresh" (the calmer Pearl/Sand/Obsidian rules in themes.css). index.html does the same
 * before the app loads, so the right theme shows from the first paint.
 */
export function applyTheme(t: Theme) {
  const def = THEMES[resolveTheme(t)];
  const root = document.documentElement;
  root.dataset.theme = def.base;
  if (def.palette) root.dataset.palette = def.palette; else delete root.dataset.palette;
  if (def.refresh) root.dataset.look = 'refresh'; else delete root.dataset.look;
  root.style.colorScheme = def.base;
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

// Apply the saved theme as early as possible.
applyTheme(readTheme());

// store.ts forwards events it doesn't handle itself as a DOM event.
window.addEventListener('heyzubi:event', (e) => {
  const ev = (e as CustomEvent<ServerEvent>).detail;
  const { bump } = useConfigUI.getState();
  if (ev.type === 'tasks') { bump('tasks'); bump(`tasks:${ev.botId}`); }
  if (ev.type === 'memories') bump(`memories:${ev.botId}`);
  if (ev.type === 'routines') bump('routines');
});

// Picking a bot anywhere (sidebar, search) goes back to its chat.
useStore.subscribe((s, prev) => {
  if (s.selectedBotId !== prev.selectedBotId && useConfigUI.getState().view !== 'chat') useConfigUI.getState().setView('chat');
});

export const useVersion = (key: string) => useConfigUI((s) => s.versions[key] ?? 0);
