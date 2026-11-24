import { create } from 'zustand';
import type { ServerEvent } from '@shared/types';
import { useStore } from './store';
import { lsGet, lsSet } from './lib/storage';

/** UI state for bot settings, app settings, the Tasks view and the theme. Kept apart from store.ts on purpose. */

/**
 * Pearl and Sand (light) and Obsidian (dark) are the current themes; System follows the device with Pearl or Obsidian.
 * 'light', 'dark' and 'navy' are the earlier purple look, kept as the Legacy themes.
 */
export type Theme = 'system' | 'pearl' | 'sand' | 'obsidian' | 'light' | 'dark' | 'navy';

/** How each theme is built from the stylesheets: a light or dark base, an optional palette, and the refreshed look. */
export const THEMES: Record<Exclude<Theme, 'system'>, { base: 'light' | 'dark'; palette?: string; refresh?: boolean; label: string }> = {
  pearl: { base: 'light', palette: 'pearl', refresh: true, label: 'Pearl' },
  sand: { base: 'light', palette: 'sand', refresh: true, label: 'Sand' },
  obsidian: { base: 'dark', palette: 'obsidian', refresh: true, label: 'Obsidian' },
  light: { base: 'light', label: 'Legacy light' },
  dark: { base: 'dark', label: 'Legacy dark' },
  navy: { base: 'dark', palette: 'navy', label: 'Navy' },
};
export type BotSettingsTab = 'general' | 'profile' | 'skills' | 'memories' | 'routines';
export type AppSection = 'status' | 'usage' | 'products' | 'pointer' | 'dictation' | 'general' | 'teams' | 'computer' | 'permissions' | 'apps' | 'api' | 'desktop' | 'account';
export type MainView = 'chat' | 'tasks' | 'generations' | 'board' | 'routines';

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
  return t && t !== 'system' && t in THEMES ? (t as Theme) : 'system';
};

const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/** The theme actually shown: System picks Pearl or Obsidian from the device setting. */
export const resolveTheme = (t: Theme): Exclude<Theme, 'system'> => (t === 'system' ? (darkQuery?.matches ? 'obsidian' : 'pearl') : t);

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

// Apply the saved theme as early as possible, and follow the OS while on "system".
applyTheme(readTheme());
darkQuery?.addEventListener?.('change', () => { if (useConfigUI.getState().theme === 'system') applyTheme('system'); });

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
