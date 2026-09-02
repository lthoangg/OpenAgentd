import type { QueryClient } from '@tanstack/react-query'
import type { SessionResolveResponse } from '@/api/types'
import { resolveSession, setCodingWorkspaceVisibility } from '@/api/client'
import { queryKeys } from '@/queries'
import { prependSession, prependWorkspaceSession } from '@/stores/cache-invalidation-bridge'
import { useAgentStore } from '@/stores/useAgentStore'
import { saveLastCodingWorkspace } from '@/utils/workspace'

export async function selectCodingWorkspace(options: {
  path: string
  requestedCreate: boolean
  currentSessionId?: string
  currentWorkspace?: string | null
  queryClient: QueryClient
  refreshWorkspaceTree: () => Promise<void>
  navigate: (args: { to: string; params: { sessionId: string } }) => void
  resolveSessionFn?: typeof resolveSession
}): Promise<{ skipped: boolean }> {
  const state = useAgentStore.getState()
  const create = options.requestedCreate && !(
    state.isEmptyIdleSession() &&
    state.sessionId === options.currentSessionId &&
    options.currentWorkspace === options.path
  )
  if (options.requestedCreate && !create) return { skipped: true }

  saveLastCodingWorkspace(options.path)
  state.beginResolvedSession(null, {
    workspace: options.path,
    model: state.sessionModel,
    thinkingLevel: state.sessionThinkingLevel,
  })
  const session = await (options.resolveSessionFn ?? resolveSession)({
    workspace: options.path,
    model: state.sessionModel,
    thinkingLevel: state.sessionThinkingLevel,
    create,
  })
  await applyResolvedWorkspaceSession({
    session,
    path: options.path,
    queryClient: options.queryClient,
    refreshWorkspaceTree: options.refreshWorkspaceTree,
    navigate: options.navigate,
    create,
  })
  return { skipped: false }
}

export async function applyResolvedWorkspaceSession(options: {
  session: SessionResolveResponse
  path: string
  queryClient: QueryClient
  refreshWorkspaceTree: () => Promise<void>
  navigate: (args: { to: string; params: { sessionId: string } }) => void
  create: boolean
}): Promise<void> {
  const state = useAgentStore.getState()
  state.beginResolvedSession(options.session.id, {
    workspace: options.session.workspace ?? options.path,
    model: options.session.model ?? state.sessionModel,
    thinkingLevel: options.session.thinking_level ?? state.sessionThinkingLevel,
    skipInitialRestore: options.create && options.session.created,
  })
  if (options.create && options.session.created) {
    prependSession(options.queryClient, options.session)
    prependWorkspaceSession(options.queryClient, options.path, options.session)
  }
  await options.refreshWorkspaceTree()
  options.navigate({ to: '/coding/$sessionId', params: { sessionId: options.session.id } })
}

export async function confirmWorkspaceRemoval(options: {
  path: string
  activeWorkspace: string | null
  expandedWorkspaces: Set<string>
  queryClient: QueryClient
  refreshWorkspaceTree: () => Promise<void>
  navigate: (args: { to: '/coding'; replace: true }) => void
  setCodingWorkspaceVisibilityFn?: typeof setCodingWorkspaceVisibility
}): Promise<Set<string>> {
  await (options.setCodingWorkspaceVisibilityFn ?? setCodingWorkspaceVisibility)(options.path, true)
  await options.queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
  await options.refreshWorkspaceTree()
  const next = new Set(options.expandedWorkspaces)
  next.delete(options.path)
  if (options.path === options.activeWorkspace) {
    options.navigate({ to: '/coding', replace: true })
  }
  return next
}
