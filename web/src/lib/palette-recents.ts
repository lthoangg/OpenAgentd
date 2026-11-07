/**
 * What the command palette ran last, newest first: its Recent group on an
 * empty query. Command and session ids (``session:<id>``); the palette
 * resolves them against what it lists now, so a command that is gone, or a
 * session it does not know, is skipped rather than shown stale.
 */
export const PALETTE_RECENTS_KEY = 'oa.paletteRecents.v1'
const KEPT = 8

export function loadPaletteRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(PALETTE_RECENTS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(0, KEPT) : []
  } catch {
    return []
  }
}

/** Move ``id`` to the front. */
export function rememberPaletteRun(id: string): void {
  const next = [id, ...loadPaletteRecents().filter((entry) => entry !== id)].slice(0, KEPT)
  try {
    window.localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(next))
  } catch {
    // A full or blocked storage only loses the Recent group.
  }
}
