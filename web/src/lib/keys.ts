const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** A shortcut as this computer's keyboard names it: ⌘B on a Mac, Ctrl+B elsewhere (the app takes either key). */
export const keys = (key: string, shift = false) => (isMac ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`);
