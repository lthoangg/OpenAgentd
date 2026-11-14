import { useEffect, useRef } from 'react'
import { apiBaseUrl } from '@/api/base-url'
import { useScheduledTasksQuery } from '@/queries'
import { useChatWorkspace } from '@/queries/useChatWorkspace'
import { useActiveSessionsQuery, useSessionsQuery } from '@/queries/useSessionsQuery'
import { buildWidgetSnapshot, pushWidgetSnapshot, type WidgetSnapshot } from '@/lib/widget-snapshot'

/** Coalesces the burst of list patches one turn produces. */
export const WIDGET_PUSH_DEBOUNCE_MS = 1000

function contentKey(snapshot: WidgetSnapshot): string {
  const { updatedAt: _updatedAt, ...content } = snapshot
  return JSON.stringify(content)
}

/**
 * Keep the home-screen widgets in step with the app: push a snapshot when
 * what they show changes, and again as the app goes to the background so
 * their "as of" time is the moment you left. Mount only in the phone apps.
 */
export function useWidgetSnapshot(): void {
  const active = useActiveSessionsQuery()
  const recent = useSessionsQuery()
  const tasks = useScheduledTasksQuery()
  // From the workspace tree the sidebar already loads: no extra request.
  const chat = useChatWorkspace()
  const ready = active.isSuccess && recent.isSuccess
  /** The last snapshot built, and the server address its lists were read from. */
  const latest = useRef<{ snapshot: WidgetSnapshot; builtOn: string } | null>(null)
  const pushedKey = useRef<string | null>(null)

  // The key is taken before the push, so a second trigger meanwhile sends
  // nothing twice; a push that did not get there gives it back, and the
  // next change (or leaving the app) sends that content again. A snapshot
  // built on a server the app has since left is not sent: the push would
  // file that server's sessions under the new one's token.
  const push = (snapshot: WidgetSnapshot, key: string, builtOn: string) => {
    if (builtOn !== apiBaseUrl()) return
    pushedKey.current = key
    void pushWidgetSnapshot({ ...snapshot, updatedAt: new Date().toISOString() }, builtOn).then((sent) => {
      if (!sent && pushedKey.current === key) pushedKey.current = null
    })
  }
  const pushRef = useRef(push)
  pushRef.current = push

  useEffect(() => {
    if (!ready) return
    const snapshot = buildWidgetSnapshot({ active: active.data, recent: recent.data, tasks: tasks.data?.tasks, now: new Date(), chat })
    const builtOn = apiBaseUrl()
    latest.current = { snapshot, builtOn }
    const key = contentKey(snapshot)
    if (key === pushedKey.current) return
    const timer = setTimeout(() => {
      // A background flush may have pushed this content already.
      if (key === pushedKey.current) return
      pushRef.current(snapshot, key, builtOn)
    }, WIDGET_PUSH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [ready, active.data, recent.data, tasks.data, chat])

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState !== 'hidden' || !latest.current) return
      const { snapshot, builtOn } = latest.current
      pushRef.current(snapshot, contentKey(snapshot), builtOn)
    }
    document.addEventListener('visibilitychange', flush)
    return () => document.removeEventListener('visibilitychange', flush)
  }, [])
}

/** Renders nothing; lets the root mount the sync only where widgets exist. */
export function WidgetSnapshotSync(): null {
  useWidgetSnapshot()
  return null
}
