import { useEffect, useRef } from 'react'
import { needsYouSessions } from '@/lib/active-sessions'
import { requestDesktopAttention, syncDesktopBadgeCount } from '@/lib/window-title'
import { useActiveSessionsQuery } from '@/queries/useSessionsQuery'

/**
 * How many sessions wait on the user, mirrored onto the app icon badge.
 * When the count rises after the first load, the window also asks the OS
 * for attention (see ``requestDesktopAttention``); sessions already waiting
 * at launch do not.
 */
export function useNeedsYouBadge(): number {
  const { data } = useActiveSessionsQuery()
  const count = needsYouSessions(data).length
  const loaded = data !== undefined
  const seen = useRef<number | null>(null)
  useEffect(() => {
    void syncDesktopBadgeCount(count)
    if (!loaded) return
    const before = seen.current
    seen.current = count
    if (before !== null && count > before) void requestDesktopAttention()
  }, [count, loaded])
  return count
}
