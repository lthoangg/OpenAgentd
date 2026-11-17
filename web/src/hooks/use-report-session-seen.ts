import { useEffect } from 'react'
import { pageHasAttention, reportSessionSeen } from '@/api/client/session-seen'

/**
 * Reports the session on screen as seen to its server whenever the person
 * looks at it: when it opens, and when its window comes back on screen or
 * into focus. A notification it raised then stays off the phone.
 */
export function useReportSessionSeen(sessionId: string | null | undefined): void {
  useEffect(() => {
    if (!sessionId) return
    const report = () => { if (pageHasAttention()) reportSessionSeen(sessionId) }
    report()
    document.addEventListener('visibilitychange', report)
    window.addEventListener('focus', report)
    return () => {
      document.removeEventListener('visibilitychange', report)
      window.removeEventListener('focus', report)
    }
  }, [sessionId])
}
