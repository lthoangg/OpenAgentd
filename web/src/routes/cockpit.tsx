import { useRef, useEffect, useLayoutEffect } from 'react'
import { Outlet, useParams, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AgentChatView } from '@/components/AgentChatView'
import { getSession, resolveSession } from '@/api/client'
import { useAgentStore } from '@/stores/useAgentStore'
import { applyCacheInvalidations, patchSessionTitle } from '@/stores/cache-invalidation-bridge'
import { initBroadcastSync, broadcastMessage } from '@/lib/broadcast-sync'
import { queryKeys } from '@/queries'
import { loadLastWorkspace, removeWorkspace, saveLastWorkspace, shouldRestoreLastWorkspace, workspaceFromSession, workspaceLabel } from '@/utils/workspace'
import { syncDesktopWindowTitle } from '@/lib/window-title'
import { useNeedsYouBadge } from '@/hooks/use-needs-you-badge'
import { useChatWorkspace } from '@/queries/useChatWorkspace'
import { clearFreshDesktopWindow, isFreshDesktopWindow } from '@/lib/fresh-window'

/**
 * The app layout for / (new session) and /<session id>.
 * Stays mounted across URL changes — handles navigation when a new
 * agent session_id arrives from POST /agent/chat.
 */
function AgentLayoutBase() {
  const params = useParams({ strict: false }) as Record<string, string>
  const sessionId = params.sessionId as string | undefined
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const cachedSessionPages = queryClient.getQueryData<{
    pages: Array<{
      data: Array<{
        id: string
        workspace?: string | null
        subagents?: Array<{ id: string; workspace?: string | null }>
      }>
    }>
  }>(queryKeys.session.sessions.infinite())
  const cachedSession = sessionId
    ? cachedSessionPages?.pages
      .flatMap((page) => page.data)
      .flatMap((session) => [session, ...(session.subagents ?? []).map((sub) => ({ id: sub.id, workspace: sub.workspace ?? session.workspace }))])
      .find((session) => session.id === sessionId)
    : undefined
  const sessionQuery = useQuery({
    queryKey: queryKeys.session.sessions.detail(sessionId ?? ''),
    queryFn: () => getSession(sessionId as string),
    enabled: Boolean(sessionId) && !cachedSession?.workspace,
    staleTime: 30_000,
  })
  const workspace = workspaceFromSession(sessionId, cachedSession?.workspace ?? sessionQuery.data?.workspace)
  const chatWorkspace = useChatWorkspace()
  const workspaceName = workspace ? workspaceLabel(workspace, chatWorkspace) : null
  const needsYou = useNeedsYouBadge()

  const navigateRef = useRef(navigate)
  const sessionIdRef = useRef(sessionId)
  const workspaceRef = useRef<string | null>(null)
  useEffect(() => {
    navigateRef.current = navigate
    sessionIdRef.current = sessionId
    workspaceRef.current = workspace
  })

  useEffect(() => {
    if (workspace) saveLastWorkspace(workspace)
  }, [workspace])

  // A New Window stays on its empty new session until it opens one.
  useEffect(() => {
    if (sessionId) clearFreshDesktopWindow()
  }, [sessionId])

  useEffect(() => {
    syncDesktopWindowTitle({ workspace, workspaceName, needsYou, sessionTitle: useAgentStore.getState().sessionTitle })
    return useAgentStore.subscribe((state, prev) => {
      if (state.sessionTitle !== prev.sessionTitle) {
        syncDesktopWindowTitle({ workspace, workspaceName, needsYou, sessionTitle: state.sessionTitle })
      }
    })
  }, [workspace, workspaceName, needsYou])

  useEffect(() => {
    if (sessionId) return
    let cancelled = false
    const restore = window.setTimeout(() => {
      if (!shouldRestoreLastWorkspace(sessionId, window.location.pathname, isFreshDesktopWindow())) return
      const lastWorkspace = loadLastWorkspace()
      if (!lastWorkspace) return
      ;(async () => {
        const current = useAgentStore.getState()
        try {
          const session = await resolveSession({
            workspace: lastWorkspace.path,
            model: current.sessionModel,
            thinkingLevel: current.sessionThinkingLevel,
          })
          if (cancelled || sessionIdRef.current) return
          // Re-read live state: the user may have changed the session model
          // or thinking level (via Session Settings) while this request was
          // in flight. Falling back to the pre-request snapshot (`current`)
          // here would silently clobber that choice the moment it resolves.
          const latest = useAgentStore.getState()
          latest.beginResolvedSession(session.id, {
            workspace: session.workspace ?? lastWorkspace.path,
            interactionMode: session.interaction_mode,
            model: session.model ?? latest.sessionModel,
            thinkingLevel: session.thinking_level ?? latest.sessionThinkingLevel,
          })
          void queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
          navigate({
            to: '/$sessionId',
            params: { sessionId: session.id },
            replace: true,
          })
        } catch {
          if (cancelled) return
          removeWorkspace(lastWorkspace.path)
          useAgentStore.setState((state) => {
            state.error = null
          })
        }
      })()
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(restore)
    }
  }, [navigate, queryClient, sessionId])

  // Keep ``useAgentStore._workspace`` in sync with the URL-derived
  // workspace path the moment we render the layout. The SSE reducer
  // reads this field to decide whether to fire ``coding_workspace`` or
  // ``workspace_files`` cache-invalidation events on ``tool_end``;
  // doing it here (instead of waiting for the async ``loadSession``
  // round-trip in ``AgentChatView``) closes the race window where the
  // first turn's tool events would otherwise see ``_workspace = null``
  // and invalidate the wrong query key, leaving the workspace panel's
  // Files / Diff views stale until the next manual refresh.
  useLayoutEffect(() => {
    useAgentStore.setState((state) => {
      state._workspace = workspace ?? null
    })
  }, [workspace])

  useEffect(() => {
    if (sessionId) return
    if (!workspace) return
    let cancelled = false
    ;(async () => {
      const current = useAgentStore.getState()
      const model = current.sessionModel
      const thinkingLevel = current.sessionThinkingLevel
      try {
        const session = await resolveSession({
          workspace,
          model,
          thinkingLevel,
        })
        if (cancelled || sessionIdRef.current) return
        // Re-read live state: the resolve request above may have been in
        // flight while the user changed the session model or thinking level
        // via Session Settings. Using the pre-request snapshot here would
        // overwrite that choice the instant the resolve completes.
        const latest = useAgentStore.getState()
        latest.beginResolvedSession(session.id, {
          workspace: session.workspace ?? workspace,
          interactionMode: session.interaction_mode,
          model: session.model ?? latest.sessionModel,
          thinkingLevel: session.thinking_level ?? latest.sessionThinkingLevel,
        })
        void queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
        if (workspace) saveLastWorkspace(workspace)
        navigate({
          to: '/$sessionId',
          params: { sessionId: session.id },
          replace: true,
        })
      } catch (err) {
        if (cancelled) return
        useAgentStore.setState((state) => {
          state.error = err instanceof Error ? err.message : 'Failed to resolve session'
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [navigate, queryClient, sessionId, workspace])

  // When agent store gets a new sessionId, navigate to the matching session route.
  useEffect(() => initBroadcastSync(queryClient), [queryClient])
  useEffect(() => {
    return useAgentStore.subscribe((state, prev) => {
      if (state.sessionId && state.sessionId !== prev.sessionId && !sessionIdRef.current) {
        // Also refetches the active infinite list (it is under this prefix);
        // a separate refetchQueries would only cancel and resend it.
        void queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
        const workspace = workspaceRef.current
        if (workspace) saveLastWorkspace(workspace)
        navigateRef.current({
          to: '/$sessionId',
          params: { sessionId: state.sessionId },
          replace: true,
        })
      }

      // When title_update arrives, patch the cached session list
      // in-place — no re-fetch. See ``patchSessionTitle``.
      //
      // Do NOT add an invalidateQueries call here. ``patchSessionTitle``
      // uses ``setQueriesData`` with the ``sessions.all()`` prefix, so it
      // already covers the infinite list *and* every workspace-scoped list
      // across all loaded pages. Invalidating afterwards refetches exactly
      // what was just patched — and because the list is an infinite query,
      // TanStack refetches every loaded page *sequentially*, so a single
      // auto-generated title costs N round trips. Titles are the only field
      // that changes here and list order is by ``created_at``, so no
      // re-sort is possible either.
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
        const events = useAgentStore.getState()._drainCacheInvalidations()
        if (events.length > 0) {
          applyCacheInvalidations(queryClient, events)
          broadcastMessage({ type: 'cache_invalidated', events })
        }
      }
    })
  }, [queryClient])

  return (
    <>
      <AgentChatView
        sessionId={sessionId}
        workspace={workspace}
        sessionLoading={Boolean(sessionId) && !workspace && sessionQuery.isLoading}
      />
      <Outlet />
    </>
  )
}

export function AppLayout() {
  return <AgentLayoutBase />
}
