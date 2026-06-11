import { useRef, useEffect, useLayoutEffect } from 'react'
import { Outlet, useParams, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { TeamChatView } from '@/components/TeamChatView'
import { getTeamSession, resolveTeamSession } from '@/api/client'
import { useTeamStore } from '@/stores/useTeamStore'
import { applyCacheInvalidations, patchSessionTitle } from '@/stores/cache-invalidation-bridge'
import { queryKeys } from '@/queries'
import { loadLastCodingWorkspace, removeCodingWorkspace, saveLastCodingWorkspace, shouldRestoreLastCodingWorkspace, workspaceFromSession } from '@/utils/workspace'

/**
 * Layout route for /cockpit, /coding, and their session routes.
 * Stays mounted across URL changes — handles navigation when a new
 * team session_id arrives from POST /team/chat.
 */
function TeamLayoutBase({ forcedMode }: { forcedMode?: 'normal' | 'coding' }) {
  const params = useParams({ strict: false }) as Record<string, string>
  const sessionId = params.sessionId as string | undefined
  const mode = forcedMode ?? 'normal'
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workspaceRef = useRef<string | null>(null)
  const cachedSessionPages = queryClient.getQueryData<{
    pages: Array<{ data: Array<{ id: string; workspace?: string | null }> }>
  }>(queryKeys.team.sessions.infinite())
  const cachedSession = sessionId
    ? cachedSessionPages?.pages
      .flatMap((page) => page.data)
      .find((session) => session.id === sessionId)
    : undefined
  const sessionQuery = useQuery({
    queryKey: queryKeys.team.sessions.detail(sessionId ?? ''),
    queryFn: () => getTeamSession(sessionId as string),
    enabled: mode === 'coding' && Boolean(sessionId) && !cachedSession?.workspace,
    staleTime: 30_000,
  })
  const workspace = workspaceFromSession(mode, sessionId, cachedSession?.workspace ?? sessionQuery.data?.workspace)

  useEffect(() => {
    if (mode === 'coding' && workspace) saveLastCodingWorkspace(workspace)
  }, [mode, workspace])

  useEffect(() => {
    if (mode !== 'coding' || sessionId) return
    let cancelled = false
    const restore = window.setTimeout(() => {
      if (!shouldRestoreLastCodingWorkspace(mode, sessionId, window.location.pathname)) return
      const lastWorkspace = loadLastCodingWorkspace()
      if (!lastWorkspace) return
      ;(async () => {
        const current = useTeamStore.getState()
        try {
          const session = await resolveTeamSession({
            mode: 'coding',
            workspace: lastWorkspace.path,
            model: current.sessionModel,
            thinkingLevel: current.sessionThinkingLevel,
          })
          if (cancelled || sessionIdRef.current) return
          current.beginResolvedSession(session.id, {
            mode: 'coding',
            workspace: session.workspace ?? lastWorkspace.path,
            model: session.model ?? current.sessionModel,
            thinkingLevel: session.thinking_level ?? current.sessionThinkingLevel,
          })
          void queryClient.invalidateQueries({ queryKey: queryKeys.team.sessions.all() })
          navigate({
            to: '/coding/$sessionId',
            params: { sessionId: session.id },
            replace: true,
          })
        } catch {
          if (cancelled) return
          removeCodingWorkspace(lastWorkspace.path)
          useTeamStore.setState((state) => {
            state.error = null
          })
        }
      })()
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(restore)
    }
  }, [mode, navigate, queryClient, sessionId])

  const navigateRef = useRef(navigate)
  const sessionIdRef = useRef(sessionId)
  const modeRef = useRef(mode)
  useEffect(() => {
    navigateRef.current = navigate
    sessionIdRef.current = sessionId
    modeRef.current = mode
    workspaceRef.current = workspace
  })

  // Keep ``useTeamStore._workspace`` in sync with the URL-derived
  // workspace path the moment we render the layout. The SSE reducer
  // reads this field to decide whether to fire ``coding_workspace`` or
  // ``workspace_files`` cache-invalidation events on ``tool_end``;
  // doing it here (instead of waiting for the async ``loadSession``
  // round-trip in ``TeamChatView``) closes the race window where the
  // first turn's tool events would otherwise see ``_workspace = null``
  // and invalidate the wrong query key, leaving the Coding Workspace
  // sidebar Files / Diff panels stale until the next manual refresh.
  useLayoutEffect(() => {
    if (mode !== 'coding') return
    useTeamStore.setState((state) => {
      state._workspace = workspace ?? null
    })
  }, [mode, workspace])

  useEffect(() => {
    if (sessionId) return
    if (mode === 'coding' && !workspace) return
    let cancelled = false
    ;(async () => {
      const current = useTeamStore.getState()
      const model = current.sessionId ? current.sessionModel : null
      const thinkingLevel = current.sessionId ? current.sessionThinkingLevel : null
      try {
        const session = await resolveTeamSession({
          mode,
          workspace: mode === 'coding' ? workspace : null,
          model,
          thinkingLevel,
        })
        if (cancelled || sessionIdRef.current) return
        useTeamStore.getState().beginResolvedSession(session.id, {
          mode,
          workspace: session.workspace ?? workspace,
          model: session.model ?? model,
          thinkingLevel: session.thinking_level ?? thinkingLevel,
        })
        void queryClient.invalidateQueries({ queryKey: queryKeys.team.sessions.all() })
        if (mode === 'coding') {
          if (workspace) saveLastCodingWorkspace(workspace)
          navigate({
            to: '/coding/$sessionId',
            params: { sessionId: session.id },
            replace: true,
          })
        } else {
          navigate({
            to: '/cockpit/$sessionId',
            params: { sessionId: session.id },
            replace: true,
          })
        }
      } catch (err) {
        if (cancelled) return
        useTeamStore.setState((state) => {
          state.error = err instanceof Error ? err.message : 'Failed to resolve session'
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mode, navigate, queryClient, sessionId, workspace])

  // When team store gets a new sessionId, navigate to the matching session route.
  useEffect(() => {
    return useTeamStore.subscribe((state, prev) => {
      if (state.sessionId && state.sessionId !== prev.sessionId && !sessionIdRef.current) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.team.sessions.all() })
        void queryClient.refetchQueries({ queryKey: queryKeys.team.sessions.infinite(), type: 'active' })
        if (modeRef.current === 'coding') {
          const workspace = workspaceRef.current
          if (workspace) saveLastCodingWorkspace(workspace)
          navigateRef.current({
            to: '/coding/$sessionId',
            params: { sessionId: state.sessionId },
            replace: true,
          })
        } else {
          navigateRef.current({
            to: '/cockpit/$sessionId',
            params: { sessionId: state.sessionId },
            replace: true,
          })
        }
      }

      // When title_update arrives, patch the cached team session list
      // in-place — no re-fetch. See ``patchSessionTitle``.
      if (state.sessionTitle && state.sessionTitle !== prev.sessionTitle && state.sessionId) {
        patchSessionTitle(queryClient, state.sessionId, state.sessionTitle)
        void queryClient.invalidateQueries({ queryKey: queryKeys.team.sessions.infinite() })
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
      <TeamChatView
        sessionId={sessionId}
        mode={mode}
        workspace={workspace}
        codingSessionLoading={mode === 'coding' && Boolean(sessionId) && !workspace && sessionQuery.isLoading}
      />
      <Outlet />
    </>
  )
}

export function TeamLayout() {
  return <TeamLayoutBase />
}

export function CodingLayout() {
  return <TeamLayoutBase forcedMode="coding" />
}
