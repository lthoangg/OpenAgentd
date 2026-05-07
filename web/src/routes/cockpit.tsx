import { useRef, useEffect } from 'react'
import { Outlet, useParams, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { TeamChatView } from '@/components/TeamChatView'
import { useTeamStore } from '@/stores/useTeamStore'
import { applyCacheInvalidations, patchSessionTitle } from '@/stores/cache-invalidation-bridge'
import { queryKeys } from '@/queries'

/**
 * Layout route for /cockpit and /cockpit/$sessionId.
 * Stays mounted across URL changes — handles navigation when a new
 * team session_id arrives from POST /team/chat.
 */
export function TeamLayout() {
  const params = useParams({ strict: false }) as Record<string, string>
  const sessionId = params.sessionId as string | undefined
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const navigateRef = useRef(navigate)
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    navigateRef.current = navigate
    sessionIdRef.current = sessionId
  })

  // When team store gets a new sessionId, navigate to /cockpit/$sessionId
  useEffect(() => {
    return useTeamStore.subscribe((state, prev) => {
      if (state.sessionId && state.sessionId !== prev.sessionId && !sessionIdRef.current) {
        queryClient.invalidateQueries({ queryKey: queryKeys.team.sessions.all() })
        navigateRef.current({
          to: '/cockpit/$sessionId',
          params: { sessionId: state.sessionId },
          replace: true,
        })
      }

      // When title_update arrives, patch the cached team session list
      // in-place — no re-fetch. See ``patchSessionTitle``.
      if (state.sessionTitle && state.sessionTitle !== prev.sessionTitle && state.sessionId) {
        patchSessionTitle(queryClient, state.sessionId, state.sessionTitle)
      }

      // Cache-invalidation bridge: the SSE reducer enqueues domain
      // events on ``cacheInvalidations`` (memory, workspace_files,
      // scheduler, todos) rather than calling
      // ``queryClient.invalidateQueries`` directly, so the store
      // stays free of TanStack imports.  Drain the queue and hand
      // the events to the bridge helper, which owns the mapping.
      if (state.cacheInvalidations !== prev.cacheInvalidations && state.cacheInvalidations.length > 0) {
        applyCacheInvalidations(queryClient, useTeamStore.getState()._drainCacheInvalidations())
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <TeamChatView sessionId={sessionId} />
      <Outlet />
    </>
  )
}
