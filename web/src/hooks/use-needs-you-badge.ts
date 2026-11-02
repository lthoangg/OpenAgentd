import { useEffect, useRef } from 'react'
import { needsYouSessions } from '@/lib/active-sessions'
import { requestDesktopAttention, syncDesktopBadgeCount } from '@/lib/window-title'
import { useActiveSessionsQuery } from '@/queries/useSessionsQuery'

/**
 * How many sessions wait on the user. Read-only: a screen that only shows the
 * number (a window title) uses this and leaves the badge to
 * ``useNeedsYouBadge``, which the app root runs once.
 */
export function useNeedsYouCount(): number {
  const { data } = useActiveSessionsQuery()
  return needsYouSessions(data).length
}

/**
 * How many sessions wait on the user, mirrored onto the app badge and the
 * tab/window title. When the count rises after the first load, the window
 * also asks the OS for attention (see ``requestDesktopAttention``); sessions
 * already waiting at launch do not. Mounted once, at the app root, so the
 * badge follows the user to every route.
 */
export function useNeedsYouBadge(): number {
  const { data } = useActiveSessionsQuery()
  const count = needsYouSessions(data).length
  const loaded = data !== undefined
  const seen = useRef<number | null>(null)
  useEffect(() => {
    // Before the first answer the count is a guess of zero, which would wipe
    // the badge another window just set.
    if (!loaded) return
    void syncDesktopBadgeCount(count)
    const before = seen.current
    seen.current = count
    if (before !== null && count > before) void requestDesktopAttention()
  }, [count, loaded])
  return count
}
