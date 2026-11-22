/** Per-browser settings in localStorage under `heyzubi.<name>`. Values saved before the project was renamed (`bothq.<name>`, `grokbot.<name>`) are still read. */
export function lsGet(name: string): string | null {
  try { return localStorage.getItem(`heyzubi.${name}`) ?? localStorage.getItem(`bothq.${name}`) ?? localStorage.getItem(`grokbot.${name}`); } catch { return null; }
}

export function lsSet(name: string, value: string) {
  try { localStorage.setItem(`heyzubi.${name}`, value); } catch { /* storage unavailable */ }
}
