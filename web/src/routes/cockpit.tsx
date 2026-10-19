import { useRef, useEffect, useLayoutEffect, useState } from 'react'
import { Outlet, useParams, useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AgentChatView } from '@/components/AgentChatView'
import { getSession, validateWorkspace } from '@/api/client'
import { latestTopLevelSession } from '@/components/Sidebar.workspace'
import { useAgentStore } from '@/stores/useAgentStore'
import { applyCacheInvalidations, patchSessionTitle } from '@/stores/cache-invalidation-bridge'
import { initBroadcastSync, broadcastMessage } from '@/lib/broadcast-sync'
import { queryKeys } from '@/queries'
import { loadLastWorkspace, removeWorkspace, saveLastWorkspace, shouldRestoreLastWorkspace, workspaceFromSession, workspaceLabel } from '@/utils/workspace'
import { startNewSession } from '@/lib/new-session'
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
  const search = useSearch({ strict: false }) as { workspace?: string }
  // `/?workspace=<path>`: a new-session draft there (nothing saved yet).
  const draftWorkspace = sessionId ? null : (search.workspace ?? null)
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
  // The session a draft's first message just created. The router lands on
  // its id before the session list refetch or `getSession` knows it, and a
  // `null` workspace in that gap unmounts the chat, the composer and the
  // dock behind an "Opening session…" spinner.
  const [adopted, setAdopted] = useState<{ id: string; workspace: string } | null>(null)
  const adoptedWorkspace = sessionId && adopted?.id === sessionId ? adopted.workspace : null
  const workspace = sessionId
    ? workspaceFromSession(sessionId, cachedSession?.workspace ?? sessionQuery.data?.workspace ?? adoptedWorkspace)
    : draftWorkspace
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

  // The bare route picks where to go: the last workspace's latest session,
  // else a new-session draft there, else a Chat draft. A New Window starts
  // on a draft. Drafts (`?workspace=`) and sessions stay put.
  const chatPath = chatWorkspace?.path ?? null
  useEffect(() => {
    if (sessionId || draftWorkspace) return
    let cancelled = false
    const openDraft = (path: string) => {
      startNewSession({ navigate: navigateRef.current, workspace: path, replace: true })
    }
    const restore = window.setTimeout(() => {
      const fresh = isFreshDesktopWindow()
      const lastWorkspace = loadLastWorkspace()
      if (!shouldRestoreLastWorkspace(sessionId, window.location.pathname, fresh, draftWorkspace) || !lastWorkspace) {
        if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') return
        const target = lastWorkspace?.path ?? chatPath
        // Without a last workspace, wait for the tree to name Chat.
        if (target) openDraft(target)
        return
      }
      ;(async () => {
        try {
          const latest = await latestTopLevelSession(lastWorkspace.path)
          if (cancelled || sessionIdRef.current) return
          if (!latest) {
            // Reject a folder that is gone before offering a draft there.
            await validateWorkspace(lastWorkspace.path)
            if (cancelled || sessionIdRef.current) return
            openDraft(lastWorkspace.path)
            return
          }
          const current = useAgentStore.getState()
          current.beginResolvedSession(latest.id, {
            workspace: latest.workspace ?? lastWorkspace.path,
            interactionMode: latest.interaction_mode,
            model: latest.model ?? current.sessionModel,
            thinkingLevel: latest.thinking_level ?? current.sessionThinkingLevel,
          })
          navigate({
            to: '/$sessionId',
            params: { sessionId: latest.id },
            replace: true,
          })
        } catch {
          if (cancelled) return
          removeWorkspace(lastWorkspace.path)
          useAgentStore.setState((state) => {
            state.error = null
          })
          if (chatPath) openDraft(chatPath)
        }
      })()
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(restore)
    }
  }, [navigate, sessionId, draftWorkspace, chatPath])

  // Leaving a session for a draft by history (Back) skips
  // `startNewSession`, so the store still holds that session: reset it, or
  // the draft would show and send to the session just left.
  const previousRouteSessionRef = useRef(sessionId)
  useLayoutEffect(() => {
    const previous = previousRouteSessionRef.current
    previousRouteSessionRef.current = sessionId
    if (sessionId || !draftWorkspace || !previous) return
    const state = useAgentStore.getState()
    if (state.sessionId !== previous) return
    const { sessionModel, sessionThinkingLevel } = state
    state.newSession()
    useAgentStore.getState().beginResolvedSession(null, { workspace: draftWorkspace, model: sessionModel, thinkingLevel: sessionThinkingLevel })
  }, [sessionId, draftWorkspace])

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

  // When agent store gets a new sessionId, navigate to the matching session route.
  useEffect(() => initBroadcastSync(queryClient), [queryClient])
  useEffect(() => {
    return useAgentStore.subscribe((state, prev) => {
      if (state.sessionId && state.sessionId !== prev.sessionId && !sessionIdRef.current) {
        // Also refetches the active infinite list (it is under this prefix);
        // a separate refetchQueries would only cancel and resend it.
        void queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
        const workspace = workspaceRef.current
        if (workspace) {
          saveLastWorkspace(workspace)
          setAdopted({ id: state.sessionId, workspace })
        }
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
