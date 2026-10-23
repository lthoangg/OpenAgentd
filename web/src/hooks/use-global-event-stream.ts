import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { sharedGlobalEventStream } from '@/api/stream-hub'
import { onApiBaseUrlChange } from '@/api/base-url'
import { backgroundSuspendsSockets } from '@/hooks/use-platform'
import { sendDesktopNotification } from '@/lib/desktop-notifications'
import { haptic } from '@/lib/haptics'
import { queryKeys } from '@/queries'
import { appendSubagent, bumpSessionActivity, patchSessionRunning, patchSessionTitle } from '@/stores/cache-invalidation-bridge'
import { useAgentStore } from '@/stores/useAgentStore'
import { useLspInstallStore } from '@/stores/useLspInstallStore'
import { useUnreadStore } from '@/stores/useUnreadStore'
import { markAutoTitle } from '@/lib/auto-title'
import { forgetPrefetchedHistory } from '@/lib/session-prefetch'

const notifiedIds = new Set<string>()
const MAX_NOTIFIED_IDS = 200
/**
 * How long a reconnected global stream must stay up before it resyncs. A proxy
 * or server that accepts the stream and drops it at once would otherwise
 * refetch every loaded session-list page and the whole current session on
 * every attempt.
 */
export const GLOBAL_RECONNECT_SETTLE_MS = 1_000

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
  queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
  queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list() })
  // MCP status is pushed instead of polled on v3; resync what a gap missed.
  queryClient.invalidateQueries({ queryKey: queryKeys.mcp.all() })
}

/**
 * Query prefixes behind each `config_changed` resource (v3 watches the config
 * dirs). Prefix keys on purpose: e.g. `['agents']` also covers the registry,
 * and `['settings']` covers providers and every settings page.
 */
const CONFIG_RESOURCE_KEYS: Record<string, readonly (readonly unknown[])[]> = {
  agents: [queryKeys.agents(), queryKeys.agentFiles.all()],
  skills: [queryKeys.skillFiles.all()],
  commands: [['commands']],
  snippets: [['snippets']],
  mcp: [queryKeys.mcp.all()],
  plugins: [queryKeys.plugins(), queryKeys.settings.providers()],
  settings: [['settings']],
}

/**
 * A turn started/finished/suspended somewhere — possibly in another window or a
 * scheduled task. ``running`` and ``needs_input`` are the only turn-dependent
 * fields on a session row, so patch them in place; only fall back to a list
 * refetch when the session is not in any cached page yet (a scheduled task may
 * have just created it). The active list is the exception: a session joining
 * or leaving it cannot be patched in, and it is a single small page.
 * A turn event is also activity: the row's ``updated_at`` and its place in
 * activity-sorted lists follow it (``bumpSessionActivity``).
 */
function markSessionRunning(
  queryClient: QueryClient,
  sessionId: string,
  running: boolean,
  needsInput: boolean = false,
): void {
  if (!patchSessionRunning(queryClient, sessionId, running, needsInput)) {
    queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
    return
  }
  bumpSessionActivity(queryClient, sessionId)
  queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.active() })
}

export async function handleGlobalEvent(
  queryClient: QueryClient,
  type: string,
  data: unknown,
  connectionGeneration: number,
  currentConnectionGeneration: () => number,
): Promise<boolean> {
  if (connectionGeneration !== currentConnectionGeneration() || !data || typeof data !== 'object') return false
  if (isSessionStreamFrame(type)) return false
  const event = data as Record<string, unknown>

  if (type === 'session_turn_started') {
    const sessionId = typeof event.session_id === 'string' ? event.session_id : null
    // A page prefetched before this turn no longer matches the server.
    if (sessionId) forgetPrefetchedHistory(sessionId)
    if (event.source === 'scheduled_task' || event.task_slug) {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list() })
    }
    if (!sessionId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
      return false
    }
    markSessionRunning(queryClient, sessionId, true)
    // A subagent turn starting (a follow-up from its lead, or an answer to
    // its question) changes what the lead's member list reports; the row
    // reads it from there while that lead or one of its subagents is open.
    const parentSessionId = typeof event.parent_session_id === 'string' ? event.parent_session_id : null
    if (parentSessionId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.session.subagents(parentSessionId) })
    }

    const before = useAgentStore.getState()
    if (before.sessionId !== sessionId) return true
    if (before.isConnected && before.isAgentWorking) {
      // Connected is what the store believes, not proof: a feed can go quiet
      // with no error. Expect updates now, and recover if none arrive.
      before.expectStreamActivity()
      return true
    }
    const sessionGeneration = before._sessionGeneration
    const targetWorkspace = (typeof event.workspace === 'string' && event.workspace)
      ? event.workspace
      : before._workspace
    await before.loadSession(sessionId, targetWorkspace)
    const after = useAgentStore.getState()
    if (connectionGeneration !== currentConnectionGeneration()) return false
    if (after.sessionId !== sessionId || after._sessionGeneration !== sessionGeneration) return false
    after.connectStream()
    return true
  }

  if (type === 'session_turn_completed') {
    const sessionId = typeof event.session_id === 'string' ? event.session_id : null
    if (sessionId) forgetPrefetchedHistory(sessionId)
    if (!sessionId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
      return false
    }
    // No scheduler invalidation here: this fires on *every* interactive turn,
    // and a turn that actually touched the scheduler already enqueues a
    // `scheduler` invalidation from the tool_end reducer.
    markSessionRunning(queryClient, sessionId, false)
    const parentSessionId = typeof event.parent_session_id === 'string' ? event.parent_session_id : null
    if (parentSessionId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.session.subagents(parentSessionId) })
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.session.subagents(sessionId) })

    const before = useAgentStore.getState()
    // Subagent output surfaces through its lead, a stopped turn is the
    // user's own doing, and an idle compaction only summarises what was
    // already read; none has anything new to read.
    const shown = before.sessionId === sessionId && document.visibilityState === 'visible'
    if (!parentSessionId && event.status !== 'stopped' && event.idle_compaction !== true && !shown) {
      useUnreadStore.getState().markUnread(sessionId)
    }
    if (before.sessionId !== sessionId) return true
    // This notification travels over a *separate* global SSE connection from
    // the session's own agent stream, so it carries no ordering guarantee
    // against that stream's trailing `done` event — it can arrive first. That
    // is safe: while the turn still looks live locally, reconcileTurnTail
    // delegates to loadSession, which now takes the server's run state over the
    // stale client flag and adopts the finished turn without duplicating it.
    //
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
    // Before the title reaches any view, so the header and sidebar row can
    // tell it landed from the server and animate it in.
    markAutoTitle(sessionId, title)
    if (useAgentStore.getState().sessionId === sessionId) useAgentStore.setState({ sessionTitle: title })
    patchSessionTitle(queryClient, sessionId, title)
    return true
  }

  if (type === 'subagent_spawned') {
    const leadId = typeof event.lead_session_id === 'string' ? event.lead_session_id : null
    const subSessionId = typeof event.session_id === 'string' ? event.session_id : null
    const handle = typeof event.handle === 'string' ? event.handle : null
    const title = typeof event.title === 'string' ? event.title : (handle ?? 'Subagent')
    const workspace = typeof event.workspace === 'string' ? event.workspace : ''
    if (leadId && subSessionId) {
      appendSubagent(queryClient, leadId, {
        id: subSessionId,
        title,
        agent_name: handle,
        workspace,
        running: true,
      })
      queryClient.invalidateQueries({ queryKey: queryKeys.session.subagents(leadId) })
    } else {
      queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
    }
    return true
  }

  if (type === 'subagent_status') {
    const leadId = typeof event.lead_session_id === 'string' ? event.lead_session_id : null
    const subSessionId = typeof event.session_id === 'string' ? event.session_id : null
    const status = typeof event.status === 'string' ? event.status : null
    if (subSessionId && status) {
      const isWorking = status === 'working'
      const isWaiting = status === 'waiting_lead'
      const found = patchSessionRunning(queryClient, subSessionId, isWorking, isWaiting)
      if (!found) {
        queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
      }
    }
    if (leadId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.session.subagents(leadId) })
    }
    return true
  }

  if (type === 'workspace_files_changed') {
    // Something outside the agent (editor, terminal, git) changed a watched
    // workspace. The server reports the resolved path plus every spelling the
    // UI used to ask for it, since those are the query keys.
    const names = [event.workspace, ...(Array.isArray(event.aliases) ? event.aliases : [])]
    const workspaces = new Set(names.filter((w): w is string => typeof w === 'string' && w.length > 0))
    for (const workspace of workspaces) {
      queryClient.invalidateQueries({ queryKey: queryKeys.coding.files(workspace) })
      queryClient.invalidateQueries({ queryKey: queryKeys.coding.diff(workspace) })
      queryClient.invalidateQueries({ queryKey: queryKeys.coding.status(workspace) })
      if (event.git === true) {
        queryClient.invalidateQueries({ queryKey: ['coding-workspace-history', workspace] })
      }
    }
    const sessionIds = Array.isArray(event.session_ids) ? event.session_ids : []
    for (const sessionId of sessionIds) {
      if (typeof sessionId === 'string') queryClient.invalidateQueries({ queryKey: queryKeys.session.files(sessionId) })
    }
    return workspaces.size > 0 || sessionIds.length > 0
  }

  if (type === 'config_changed') {
    // Agents, skills, MCP config, plugins… edited outside this window.
    const resources = Array.isArray(event.resources) ? event.resources : []
    let known = false
    for (const resource of resources) {
      const keys = typeof resource === 'string' ? CONFIG_RESOURCE_KEYS[resource] : undefined
      if (!keys) continue
      known = true
      for (const queryKey of keys) queryClient.invalidateQueries({ queryKey })
    }
    return known
  }

  if (type === 'mcp_status_changed') {
    // A server settled (ready / error / stopped); replaces polling while it starts.
    if (typeof event.name !== 'string') return false
    queryClient.invalidateQueries({ queryKey: queryKeys.mcp.all() })
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
    if (
      !id ||
      (kind !== 'assistant_done' && kind !== 'reminder_fired' && kind !== 'input_needed')
    ) return false
    if (!rememberNotification(id)) return true
    if (typeof event.title !== 'string' || typeof event.body !== 'string') return false
    const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined
    // A question stops the agent until it is answered, so it must reach the user
    // even in a focused window — unless they are already looking at the session
    // that asked, where the card itself is the notification. ``force`` skips the
    // window-focus check only; the user's notification setting still applies.
    // Badge the row in every window's session list. The question card itself
    // only reaches clients attached to that session's stream; this is what tells
    // someone working elsewhere that a session is stopped and waiting on them.
    if (kind === 'input_needed' && sessionId) {
      markSessionRunning(queryClient, sessionId, true, true)
      // Phones: a light tap says an agent stopped for you (no-op elsewhere).
      haptic('tick')
      // The card for the session on screen arrives on its own feed. If that
      // feed missed it, this is the one signal left: fetch it.
      const metadata = event.metadata as Record<string, unknown> | undefined
      const questionId = typeof metadata?.question_id === 'string' ? metadata.question_id : null
      const store = useAgentStore.getState()
      if (questionId && store.sessionId === sessionId) store.expectQuestion(questionId)
    }
    // Mobile has no window focus to check, so it skips by this instead.
    const sessionOnScreen = sessionId !== undefined && useAgentStore.getState().sessionId === sessionId
    await sendDesktopNotification(
      { kind, notificationId: id, sessionId, title: event.title, body: event.body },
      { force: kind === 'input_needed' && !sessionOnScreen, sessionOnScreen },
    )
    return true
  }

  return false
}

/** Never reaches here: the stream hub routes these to the session that asked. */
function isSessionStreamFrame(type: string): boolean {
  return type === 'session_event' || type === 'session_stream_end'
}

export async function reconcileCurrentSession(
  connectionGeneration: number,
  currentConnectionGeneration: () => number,
): Promise<void> {
  const before = useAgentStore.getState()
  const sessionId = before.sessionId
  if (!sessionId) return
  const sessionGeneration = before._sessionGeneration
  await before.loadSession(sessionId, before._workspace)
  const after = useAgentStore.getState()
  if (connectionGeneration !== currentConnectionGeneration()) return
  if (after.sessionId !== sessionId || after._sessionGeneration !== sessionGeneration) return
  if (!after.isAgentWorking) return
  // A turn suspended on the user (ask_user, plan review) produces nothing to
  // replay, so a stream that is still attached stays as it is. Re-attaching
  // it tore the stream down on every resync while the question stayed open.
  if (after.isConnected && waitsOnlyOnUser(after)) return
  after.connectStream()
}

/** An open question, and no agent still producing output. */
function waitsOnlyOnUser(state: ReturnType<typeof useAgentStore.getState>): boolean {
  return state.pendingQuestion !== null && !Object.values(state.agentStreams).some((s) => s.status === 'working')
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
    // True between onOpen and the next onError/onDone: the socket is known live.
    let opened = false
    // The first connection resyncs at once (it may follow a startup gap);
    // later ones wait for ``settleTimer`` so a flapping link stays quiet.
    let everOpened = false
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const clearSettleTimer = () => {
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
    }
    const resync = (generation: number) => {
      invalidateGlobalEventQueries(queryClient)
      void reconcileCurrentSession(generation, () => connectionGeneration)
    }
    // The health dot follows this connection instead of a fast poll: a drop
    // rechecks at once, and an open rechecks only a failed check (the first
    // open follows the dot's own startup fetch, so a healthy one is current).
    const recheckHealth = () => { void queryClient.invalidateQueries({ queryKey: queryKeys.health() }) }
    const recheckFailedHealth = () => {
      if (queryClient.getQueryState(queryKeys.health())?.status === 'error') recheckHealth()
    }

    const connect = (): number | null => {
      if (disposed) return null
      const generation = ++connectionGeneration
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      clearSettleTimer()
      controller?.abort()
      controller = new AbortController()
      opened = false
      sharedGlobalEventStream({
        onOpen: () => {
          if (disposed || generation !== connectionGeneration) return
          opened = true
          recheckFailedHealth()
          // The backoff resets on the first real event, or once the link has
          // stayed up — never merely because the response opened.
          if (!everOpened) {
            everOpened = true
            resync(generation)
            return
          }
          settleTimer = setTimeout(() => {
            settleTimer = null
            if (disposed || generation !== connectionGeneration || !opened) return
            attempts = 0
            resync(generation)
          }, GLOBAL_RECONNECT_SETTLE_MS)
        },
        onEvent: (type, data) => {
          void handleGlobalEvent(queryClient, type, data, generation, () => connectionGeneration)
            .then((valid) => { if (valid && generation === connectionGeneration) attempts = 0 })
        },
        onError: (error) => {
          if (disposed || generation !== connectionGeneration) return
          opened = false
          clearSettleTimer()
          recheckHealth()
          // Old servers do not have this optional endpoint; leave them alone.
          if (/GET \/events\/stream failed: 404/.test(error.message)) return
          const delay = Math.min(30_000, 1_500 * 2 ** attempts++)
          retryTimer = setTimeout(connect, delay)
        },
        onDone: () => {
          if (disposed || generation !== connectionGeneration) return
          opened = false
          clearSettleTimer()
          recheckHealth()
          const delay = Math.min(30_000, 1_500 * 2 ** attempts++)
          retryTimer = setTimeout(connect, delay)
        },
      }, controller.signal)
      return generation
    }

    connect()
    const unsubscribeApiBaseUrl = onApiBaseUrlChange(connect)
    const resume = () => {
      // A resume is a hint that the network or page came back. If the socket
      // is still open and nothing is waiting to retry, there is nothing to
      // recover; reconnecting would tear down a live stream and refetch every
      // global query on the next onOpen — on desktop that is every alt-tab.
      if (opened && retryTimer === null && !backgroundSuspendsSockets()) return
      connect()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') resume()
    }
    window.addEventListener('online', resume)
    window.addEventListener('pageshow', resume)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      connectionGeneration += 1
      controller?.abort()
      if (retryTimer) clearTimeout(retryTimer)
      clearSettleTimer()
      unsubscribeApiBaseUrl()
      window.removeEventListener('online', resume)
      window.removeEventListener('pageshow', resume)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [queryClient])
}

export function GlobalEventStream(): null {
  useGlobalEventStream()
  return null
}
