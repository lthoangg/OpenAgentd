/**
 * A session waiting to be opened: a tapped notification or a link asked for
 * it, maybe on another server. It is kept in sessionStorage, which outlives
 * the reload a server switch does, and opened by the root route (on startup,
 * or at once through `PENDING_OPEN_EVENT`).
 */
import { pageUnloading } from '@/lib/page-unload'

const PENDING_KEY = 'oa-pending-session-open'
/** A switch that takes longer than this no longer opens the session. */
export const PENDING_OPEN_MAX_AGE_MS = 120_000
/** Fired when a session is waiting to be opened (no reload needed). */
export const PENDING_OPEN_EVENT = 'openagentd:pending-session-open'

/**
 * Keep this session for the page a server switch is about to reload onto.
 * This page is not told: it would take the session and open it here, on its
 * way out, and the reloaded page would find nothing. False when it could
 * not be kept.
 */
export function holdSessionOpen(sessionId: string): boolean {
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ sessionId, at: Date.now() }))
    return true
  } catch {
    return false
  }
}

/** Ask the app to open this session as soon as it can. */
export function requestSessionOpen(sessionId: string): void {
  if (holdSessionOpen(sessionId)) window.dispatchEvent(new Event(PENDING_OPEN_EVENT))
}

/**
 * The session waiting to be opened, once; null when none or too old. A page
 * that is reloading takes nothing: the session is for the page after it.
 */
export function takePendingSessionOpen(now: number = Date.now()): string | null {
  if (pageUnloading()) return null
  let raw: string | null = null
  try {
    raw = window.sessionStorage.getItem(PENDING_KEY)
    if (raw === null) return null
    window.sessionStorage.removeItem(PENDING_KEY)
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { sessionId?: unknown; at?: unknown } | null
    if (!parsed || typeof parsed.sessionId !== 'string' || !parsed.sessionId || typeof parsed.at !== 'number') return null
    if (now - parsed.at > PENDING_OPEN_MAX_AGE_MS || parsed.at > now + 5_000) return null
    return parsed.sessionId
  } catch {
    return null
  }
}
