import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { globalEventStream } from '@/api/global-events'
import { onApiBaseUrlChange } from '@/api/base-url'
import { sendDesktopNotification } from '@/lib/desktop-notifications'
import { queryKeys } from '@/queries'
import { patchSessionRunning, patchSessionTitle } from '@/stores/cache-invalidation-bridge'
import { useTeamStore } from '@/stores/useTeamStore'
import { useLspInstallStore } from '@/stores/useLspInstallStore'

const notifiedIds = new Set<string>()
const MAX_NOTIFIED_IDS = 200

export function resetGlobalNotificationDedupe(): void {
  notifiedIds.clear()
}

function rememberNotification(id: string): boolean {
  if (notifiedIds.has(id)) return false
  notifiedIds.add(id)
  if (notifiedIds.size > MAX_NOTIFIED_IDS) notifiedIds.delete(notifiedIds.values().next().value!)
  return true
}

/**
 * Full resync after a (re)connect, where arbitrary events may have been missed.
 * Turn events must NOT use this — see ``markSessionRunning``.
 */
export function invalidateGlobalEventQueries(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: queryKeys.team.sessions.all() })
  queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list() })
}

/**
 * A turn started/finished somewhere — possibly in another window or a scheduled
 * task. ``running`` is the only turn-dependent field on a session row, so patch
 * it in place; only fall back to a list refetch when the session is not in any
 * cached page yet (a scheduled task may have just created it).
 */
function markSessionRunning(
  queryClient: QueryClient,
  sessionId: string,
  running: boolean,
): void {
  if (!patchSessionRunning(queryClient, sessionId, running)) {
    queryClient.invalidateQueries({ queryKey: queryKeys.team.sessions.all() })
  }
}

export async function handleGlobalEvent(
  queryClient: QueryClient,
  type: string,
  data: unknown,
  connectionGeneration: number,
  currentConnectionGeneration: () => number,
): Promise<boolean> {
  if (connectionGeneration !== currentConnectionGeneration() || !data || typeof data !== 'object') return false
  const event = data as Record<string, unknown>

  if (type === 'session_turn_started') {
    const sessionId = typeof event.session_id === 'string' ? event.session_id : null
    // Only the scheduler publishes this event, so its task bookkeeping
    // (last_run_at / next_run_at) is worth refreshing here.
    queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list() })
    if (!sessionId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.team.sessions.all() })
      return false
    }
    markSessionRunning(queryClient, sessionId, true)

    const before = useTeamStore.getState()
    if (before.sessionId !== sessionId) return true
    const sessionGeneration = before._sessionGeneration
    await before.loadSession(sessionId, before._workspace)
    const after = useTeamStore.getState()
    if (connectionGeneration !== currentConnectionGeneration()) return false
    if (after.sessionId !== sessionId || after._sessionGeneration !== sessionGeneration) return false
    after.connectStream()
    return true
  }

  if (type === 'session_turn_completed') {
    const sessionId = typeof event.session_id === 'string' ? event.session_id : null
    if (!sessionId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.team.sessions.all() })
      return false
    }
    // No scheduler invalidation here: this fires on *every* interactive turn,
    // and a turn that actually touched the scheduler already enqueues a
    // `scheduler` invalidation from the tool_end reducer.
    markSessionRunning(queryClient, sessionId, false)

    const before = useTeamStore.getState()
    if (before.sessionId !== sessionId) return true
    // The live stream already delivered this turn; reconcile only the tail it
    // produced rather than re-downloading the whole page (over a megabyte on an
    // active session). Falls back to a full load when a delta cannot be applied.
    await before.reconcileTurnTail(sessionId, before._workspace)
    return true
  }

  if (type === 'title_update') {
    const sessionId = typeof event.session_id === 'string' ? event.session_id : null
    const title = typeof event.title === 'string' ? event.title : null
    if (!sessionId || title === null) return false
    if (useTeamStore.getState().sessionId === sessionId) useTeamStore.setState({ sessionTitle: title })
    patchSessionTitle(queryClient, sessionId, title)
    return true
  }

  if (type === 'lsp_install_required') {
    const component = event.component
    const workspace = event.workspace
    const downloadsEnabled = event.downloads_enabled
    const languageServerVersion = event.language_server_version
    const typeScriptVersion = event.typescript_version
    if (
      component !== 'typescript' ||
      typeof workspace !== 'string' ||
      downloadsEnabled !== true ||
      typeof languageServerVersion !== 'string' ||
      typeof typeScriptVersion !== 'string'
    ) return false
    useLspInstallStore.getState().requestInstall({ workspace, languageServerVersion, typeScriptVersion })
    return true
  }

  if (type === 'desktop_notification') {
    const id = typeof event.notification_id === 'string' ? event.notification_id : null
    const kind = event.kind
    if (!id || (kind !== 'assistant_done' && kind !== 'reminder_fired')) return false
    if (!rememberNotification(id)) return true
    if (typeof event.title !== 'string' || typeof event.body !== 'string') return false
    const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined
    const mode = event.metadata && typeof event.metadata === 'object'
      && (event.metadata as Record<string, unknown>).mode === 'coding'
      ? 'coding'
      : 'normal'
    await sendDesktopNotification({ kind, sessionId, mode, title: event.title, body: event.body })
    return true
  }

  return false
}

export async function reconcileCurrentSession(
  connectionGeneration: number,
  currentConnectionGeneration: () => number,
): Promise<void> {
  const before = useTeamStore.getState()
  const sessionId = before.sessionId
  if (!sessionId) return
  const sessionGeneration = before._sessionGeneration
  await before.loadSession(sessionId, before._workspace)
  const after = useTeamStore.getState()
  if (connectionGeneration !== currentConnectionGeneration()) return
  if (after.sessionId !== sessionId || after._sessionGeneration !== sessionGeneration) return
  if (after.isTeamWorking) after.connectStream()
}

/** App-lifetime feed for session changes occurring outside this window. */
export function useGlobalEventStream(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    let disposed = false
    let connectionGeneration = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    let controller: AbortController | null = null

    const connect = (): number | null => {
      if (disposed) return null
      const generation = ++connectionGeneration
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      controller?.abort()
      controller = new AbortController()
      globalEventStream({
        onOpen: () => {
          if (disposed || generation !== connectionGeneration) return
          attempts = 0
          invalidateGlobalEventQueries(queryClient)
          void reconcileCurrentSession(generation, () => connectionGeneration)
        },
        onEvent: (type, data) => {
          void handleGlobalEvent(queryClient, type, data, generation, () => connectionGeneration)
            .then((valid) => { if (valid && generation === connectionGeneration) attempts = 0 })
        },
        onError: (error) => {
          if (disposed || generation !== connectionGeneration) return
          // Old servers do not have this optional endpoint; leave them alone.
          if (/GET \/events\/stream failed: 404/.test(error.message)) return
          const delay = Math.min(30_000, 1_500 * 2 ** attempts++)
          retryTimer = setTimeout(connect, delay)
        },
        onDone: () => {
          if (disposed || generation !== connectionGeneration) return
          const delay = Math.min(30_000, 1_500 * 2 ** attempts++)
          retryTimer = setTimeout(connect, delay)
        },
      }, controller.signal)
      return generation
    }

    connect()
    const unsubscribeApiBaseUrl = onApiBaseUrlChange(connect)
    const resume = () => {
      connect()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') resume()
    }
    window.addEventListener('pageshow', resume)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      connectionGeneration += 1
      controller?.abort()
      if (retryTimer) clearTimeout(retryTimer)
      unsubscribeApiBaseUrl()
      window.removeEventListener('pageshow', resume)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [queryClient])
}

export function GlobalEventStream(): null {
  useGlobalEventStream()
  return null
}
