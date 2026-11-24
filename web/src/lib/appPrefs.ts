import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * The owner's app-wide preferences (server: server/src/prefs.ts, GET/PATCH /api/prefs), loaded once and shared:
 * Settings › Products, Pointer Assistant and Dictation edit them; the chat's mic and the screen's Ask button follow
 * the product switches.
 */
export type Spark = 'always' | 'listening' | 'never';
export interface PointerPrefs { chord: string; spark: Spark; brain: 'grok' | 'claude'; model: string; voice: 'bot' | 'windows' | 'off'; windowsVoice: string }
export interface DictationPrefs { chord: string; mic: string; recognizer: 'auto' | 'windows'; language: string }
export interface AppPrefs {
  dictionary: string[];
  tidyDictation: boolean;
  products: { pointer: boolean; dictation: boolean | null };
  pointer: PointerPrefs;
  dictation: DictationPrefs;
}
export type PrefsPatch = Partial<Omit<AppPrefs, 'products' | 'pointer' | 'dictation' | 'dictionary'>> & {
  dictionary?: string[] | string;
  products?: Partial<{ pointer: boolean; dictation: boolean }>;
  pointer?: Partial<PointerPrefs>;
  dictation?: Partial<DictationPrefs>;
};

/** The hold-to-talk keys the Windows app knows (server/src/prefs.ts CHORDS, desktop/KeyboardHook.cs). */
export const CHORDS: { id: string; label: string }[] = [
  { id: 'ctrlWin', label: 'Ctrl + Win' }, { id: 'ctrlAlt', label: 'Ctrl + Alt' }, { id: 'ctrlShift', label: 'Ctrl + Shift' },
  { id: 'altShift', label: 'Alt + Shift' }, { id: 'winAlt', label: 'Win + Alt' }, { id: 'ctrlShiftSpace', label: 'Ctrl + Shift + Space' },
];
export const chordLabel = (id: string) => CHORDS.find((c) => c.id === id)?.label ?? id;

interface State {
  prefs: AppPrefs | null;
  load(): Promise<void>;
  /** Saves a change; resolves with an error message when the server refused it (the old value stays). */
  save(patch: PrefsPatch): Promise<string | null>;
}

let loading: Promise<void> | null = null;

export const useAppPrefs = create<State>((set) => ({
  prefs: null,
  load() {
    loading ??= fetch('/api/prefs', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => { if (p) set({ prefs: p }); })
      .catch(() => {})
      .finally(() => { loading = null; });
    return loading;
  },
  async save(patch) {
    try {
      const r = await fetch('/api/prefs', { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const j = await r.json().catch(() => null);
      if (!r.ok) return j?.error ?? `Couldn’t save (HTTP ${r.status}).`;
      set({ prefs: j });
      return null;
    } catch { return 'Couldn’t reach HeyZubi. Try again.'; }
  },
}));

/** The prefs, loading them the first time a component asks. */
export function usePrefs(): AppPrefs | null {
  const p = useAppPrefs((s) => s.prefs);
  useEffect(() => { if (!useAppPrefs.getState().prefs) void useAppPrefs.getState().load(); }, []);
  return p;
}
