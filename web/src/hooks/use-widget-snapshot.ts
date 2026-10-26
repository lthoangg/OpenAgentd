import { useEffect, useRef } from 'react'
import { useScheduledTasksQuery } from '@/queries'
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
  const ready = active.isSuccess && recent.isSuccess
  const latest = useRef<WidgetSnapshot | null>(null)
  const pushedKey = useRef<string | null>(null)

  useEffect(() => {
    if (!ready) return
    const snapshot = buildWidgetSnapshot({ active: active.data, recent: recent.data, tasks: tasks.data?.tasks, now: new Date() })
    latest.current = snapshot
    const key = contentKey(snapshot)
    if (key === pushedKey.current) return
    const timer = setTimeout(() => {
      // A background flush may have pushed this content already.
      if (key === pushedKey.current) return
      pushedKey.current = key
      void pushWidgetSnapshot({ ...snapshot, updatedAt: new Date().toISOString() })
    }, WIDGET_PUSH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [ready, active.data, recent.data, tasks.data])

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState !== 'hidden' || !latest.current) return
      pushedKey.current = contentKey(latest.current)
      void pushWidgetSnapshot({ ...latest.current, updatedAt: new Date().toISOString() })
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
