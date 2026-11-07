import { useCallback, useMemo, useRef, useEffect, useLayoutEffect, useState } from 'react'
import { Outlet, useLocation, useParams, useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AgentChatView } from '@/components/AgentChatView'
import { getSession, validateWorkspace } from '@/api/client'
import { isMissingSessionError } from '@/lib/session-errors'
import { latestTopLevelSession } from '@/components/Sidebar.workspace'
import { useAgentStore } from '@/stores/useAgentStore'
import { applyCacheInvalidations, patchSessionTitle } from '@/stores/cache-invalidation-bridge'
import { initBroadcastSync, broadcastMessage } from '@/lib/broadcast-sync'
import { queryKeys } from '@/queries'
import { loadLastWorkspace, removeWorkspace, saveLastWorkspace, shouldRestoreLastWorkspace, workspaceFromSession, workspaceLabel } from '@/utils/workspace'
import { startNewSession } from '@/lib/new-session'
import { syncDesktopWindowTitle } from '@/lib/window-title'
import { useNeedsYouCount } from '@/hooks/use-needs-you-badge'
import { useChatWorkspace } from '@/queries/useChatWorkspace'
import { clearFreshDesktopWindow, isFreshDesktopWindow } from '@/lib/fresh-window'
import { useIsPhone } from '@/hooks/use-is-phone'
import { moveAppToBackground, useBackHandler } from '@/lib/back-button'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useServersScreenStore } from '@/stores/useServersScreenStore'

/**
 * The app layout for / (new session), /<session id> and, on a phone,
 * /sessions (the session list, with the chat pushed over it) and /servers
 * (the saved servers, with Sessions pushed over them).
 * Stays mounted across URL changes — handles navigation when a new
 * agent session_id arrives from POST /agent/chat.
 */
function AgentLayoutBase() {
  const params = useParams({ strict: false }) as Record<string, string>
  const routeSessionId = params.sessionId as string | undefined
  const search = useSearch({ strict: false }) as { workspace?: string }
  // `/?workspace=<path>`: a new-session draft there (nothing saved yet).
  const routeDraftWorkspace = routeSessionId ? null : (search.workspace ?? null)
  const pathname = useLocation({ select: (location) => location.pathname })
  // Read from the location itself, so it always agrees with ``pathname``:
  // while a navigation is pending the location has moved on but the
  // matched route's search (``search`` above) has not.
  const locationHasDraft = useLocation({ select: (location) => Boolean((location.search as { workspace?: unknown }).workspace) })
  const navigate = useNavigate()
  // A phone is a navigation stack: with no chat in the route (/sessions, or a
  // bare / on its way there) the Sessions screen is on top. The chat it was
  // popped from stays under it, so the pop slides the real chat away and
  // pushing it again neither reloads nor remounts it.
  const isPhone = useIsPhone()
  const atSessions = isPhone && !routeSessionId && !routeDraftWorkspace
  // /servers is under Sessions: Sessions and the kept chat stay mounted on it.
  const atServers = atSessions && pathname === '/servers'
  const [kept, setKept] = useState({ sessionId: routeSessionId, draftWorkspace: routeDraftWorkspace })
  if (!atSessions && (kept.sessionId !== routeSessionId || kept.draftWorkspace !== routeDraftWorkspace)) {
    setKept({ sessionId: routeSessionId, draftWorkspace: routeDraftWorkspace })
  }
  const sessionId = atSessions ? kept.sessionId : routeSessionId
  const draftWorkspace = atSessions ? kept.draftWorkspace : routeDraftWorkspace
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
    // A session the server does not have will not appear on a retry.
    retry: (failures, error) => !isMissingSessionError(error) && failures < 3,
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
  // Only the number, for the title: the app root runs the badge itself.
  const needsYou = useNeedsYouCount()

  const navigateRef = useRef(navigate)
  const sessionIdRef = useRef(sessionId)
  const workspaceRef = useRef<string | null>(null)
  const atSessionsRef = useRef(atSessions)
  useEffect(() => {
    navigateRef.current = navigate
    sessionIdRef.current = sessionId
    workspaceRef.current = workspace
    atSessionsRef.current = atSessions
  })

  // Back from a phone chat goes up a level, to Sessions, whatever the
  // history holds (a notification or a link may have opened the chat).
  const backToSessions = useCallback(() => { void navigate({ to: '/sessions', replace: true }) }, [navigate])
  // And from Sessions down to Servers; Servers' "Sessions ›" comes back up.
  const backToServers = useCallback(() => { void navigate({ to: '/servers', replace: true }) }, [navigate])
  const phoneStack = useMemo(
    () => (isPhone
      ? { atSessions, atServers, onBack: backToSessions, onBackToServers: backToServers, onOpenSessions: backToSessions }
      : undefined),
    [atSessions, atServers, backToSessions, backToServers, isPhone],
  )
  // A bare / on a phone is the Sessions screen: name it in the URL. Only a
  // bare one: a push from Sessions to a chat or a draft passes through a
  // render where the location is already there but the route is not.
  useEffect(() => {
    const bare = pathname === '/' || pathname === '/index.html'
    if (atSessions && bare && !locationHasDraft) navigate({ to: '/sessions', replace: true })
  }, [atSessions, locationHasDraft, navigate, pathname])
  // Desktop and tablets list sessions in the sidebar: /sessions shows it.
  // They switch servers from the server chip, so /servers is just /.
  useEffect(() => {
    if (isPhone || (pathname !== '/sessions' && pathname !== '/servers')) return
    if (pathname === '/sessions') useLayoutStore.getState().setSidebarCollapsed(false, false)
    navigate({ to: '/', replace: true })
  }, [isPhone, navigate, pathname])
  // Servers is the phone's bottom level: Android Back there leaves the app
  // rather than walking back through the chats it has shown. On Sessions,
  // Back goes down to Servers (the stack over Servers registers it).
  useBackHandler(atServers, moveAppToBackground)
  // The banner, the server chip or a scanned link asked for Servers.
  const serversRequest = useServersScreenStore((state) => state.request)
  useEffect(() => {
    if (serversRequest && isPhone) void navigate({ to: '/servers' })
  }, [serversRequest, isPhone, navigate])

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
  // on a draft. Drafts (`?workspace=`) and sessions stay put, and so does a
  // phone, whose first screen is Sessions.
  const chatPath = chatWorkspace?.path ?? null
  useEffect(() => {
    if (sessionId || draftWorkspace || atSessions || pathname === '/sessions' || pathname === '/servers') return
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
  }, [navigate, sessionId, draftWorkspace, chatPath, atSessions, pathname])

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
        // A draft popped back to Sessions before its first reply named the
        // session: it becomes the chat kept under the list, not a push.
        if (atSessionsRef.current) {
          setKept({ sessionId: state.sessionId, draftWorkspace: null })
        } else {
          navigateRef.current({
            to: '/$sessionId',
            params: { sessionId: state.sessionId },
            replace: true,
          })
        }
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
        sessionNotFound={Boolean(sessionId) && !workspace && isMissingSessionError(sessionQuery.error)}
        phoneStack={phoneStack}
      />
      <Outlet />
    </>
  )
}

export function AppLayout() {
  return <AgentLayoutBase />
}
