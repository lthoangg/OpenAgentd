/**
 * Remembers the Review panel's tabs and groups per session, so switching
 * back to a session shows its diffs, plan and files where they were.
 *
 * One localStorage entry holds the most recent ``MAX_ENTRIES`` sessions; a
 * new-session draft's tabs live only in memory and carry over to the session
 * its first message starts.
 */
import { type DockGroups, restoreDockGroups, serializeDockGroups } from './dock-groups'

export const DOCK_MEMORY_KEY = 'oa.dockTabs.v1'
const MAX_ENTRIES = 40

interface Entry {
  at: number
  state: unknown
}

/** The memory key for a session, or for the draft of a workspace. */
export function dockMemoryKey(sessionId: string | null | undefined, workspace: string): string {
  return sessionId ? `session:${sessionId}` : `draft:${workspace}`
}

function readAll(): Record<string, Entry> {
  try {
    const raw = localStorage.getItem(DOCK_MEMORY_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, Entry> : {}
  } catch {
    return {}
  }
}

export function loadDockGroups(key: string): DockGroups | null {
  if (!key.startsWith('session:')) return null
  return restoreDockGroups(readAll()[key]?.state)
}

export function saveDockGroups(key: string, state: DockGroups): void {
  if (!key.startsWith('session:')) return
  try {
    const all = readAll()
    // Nothing open: forget the session rather than spend a slot on it.
    if (state.tabs.length === 0) delete all[key]
    else all[key] = { at: Date.now(), state: serializeDockGroups(state) }
    const keys = Object.keys(all).sort((a, b) => (all[b]?.at ?? 0) - (all[a]?.at ?? 0))
    for (const stale of keys.slice(MAX_ENTRIES)) delete all[stale]
    localStorage.setItem(DOCK_MEMORY_KEY, JSON.stringify(all))
  } catch {
    // Storage full or unavailable: the tabs simply are not remembered.
  }
}
