import type { QueryClient } from '@tanstack/react-query'
import type { WorktreeInfo } from '@/api/types'
import { removeWorktree, resolveTeamSession } from '@/api/client'
import { prependSession, prependWorkspaceSession } from '@/stores/cache-invalidation-bridge'
import { useTeamStore } from '@/stores/useTeamStore'
import { saveLastCodingWorkspace } from '@/utils/workspace'
import { isTransientNetworkError } from '@/utils/errors'
import { worktreeNameSlug } from './CodingSidebar/utils'

export async function loadWorktreesForSource(
  path: string,
  listWorktreesFn: (path: string) => Promise<WorktreeInfo[]>,
): Promise<WorktreeInfo[]> {
  try {
    return await listWorktreesFn(path)
  } catch {
    return []
  }
}

export interface RemoveWorktreeResult {
  source: string | null
  removedDirectory: string
  refreshedItems: WorktreeInfo[]
}

export async function removeManagedWorktree(
  item: WorktreeInfo,
  options: {
    worktreeTarget: string | null
    worktreeSourceByDirectory: Map<string, string>
    loadWorktreesForSource: (path: string) => Promise<WorktreeInfo[]>
    refreshWorkspaceTree: () => Promise<void>
    removeWorktreeFn?: (sourceWorkspace: string, directory: string) => Promise<void>
  },
): Promise<RemoveWorktreeResult | null> {
  if (!item.managed) return null
  const directory = item.directory
  const source = options.worktreeSourceByDirectory.get(directory) ?? options.worktreeTarget
  if (!source) return null
  await (options.removeWorktreeFn ?? removeWorktree)(source, directory)
  const refreshedItems = await options.loadWorktreesForSource(source)
  await options.refreshWorkspaceTree()
  return {
    source,
    removedDirectory: directory,
    refreshedItems,
  }
}

export interface SubmitWorktreeResult {
  kind: 'created' | 'recovered'
  workspace: string
  sessionId?: string
}

export async function submitWorktreeSession(options: {
  worktreeTarget: string
  worktreeName: string
  worktreeBranch: string
  queryClient: QueryClient
  refreshWorkspaceTree: () => Promise<void>
  navigate: (args: { to: string; params?: { sessionId: string } }) => void
  onMobileClose?: () => void
  loadWorktreesForSource: (path: string) => Promise<WorktreeInfo[]>
}): Promise<SubmitWorktreeResult> {
  const state = useTeamStore.getState()
  const session = await resolveTeamSession({
    workspace: options.worktreeTarget,
    worktreeFrom: options.worktreeTarget,
    worktreeName: options.worktreeName || 'session',
    worktreeBranch: options.worktreeBranch || null,
    model: state.sessionModel,
    thinkingLevel: state.sessionThinkingLevel,
  })
  const path = session.workspace
  if (!path) throw new Error('Worktree session did not return a workspace')
  saveLastCodingWorkspace(path)
  const nextState = useTeamStore.getState()
  nextState.beginResolvedSession(session.id, {
    workspace: path,
    model: session.model ?? nextState.sessionModel,
    thinkingLevel: session.thinking_level ?? nextState.sessionThinkingLevel,
    skipInitialRestore: session.created,
  })
  prependSession(options.queryClient, session)
  prependWorkspaceSession(options.queryClient, path, session)
  await options.refreshWorkspaceTree()
  options.navigate({ to: '/coding/$sessionId', params: { sessionId: session.id } })
  options.onMobileClose?.()
  return { kind: 'created', workspace: path, sessionId: session.id }
}

export async function recoverCreatedWorktreeAfterTransientError(options: {
  error: unknown
  worktreeTarget: string
  worktreeName: string
  loadWorktreesForSource: (path: string) => Promise<WorktreeInfo[]>
  refreshWorkspaceTree: () => Promise<void>
  navigate: (args: { to: string }) => void
  onMobileClose?: () => void
}): Promise<SubmitWorktreeResult | null> {
  if (!isTransientNetworkError(options.error)) return null
  const expectedName = worktreeNameSlug(options.worktreeName || 'session')
  const items = await options.loadWorktreesForSource(options.worktreeTarget)
  const created = items.find((item) => item.name === expectedName)
  if (!created) return null
  saveLastCodingWorkspace(created.directory)
  await options.refreshWorkspaceTree()
  options.navigate({ to: '/coding' })
  options.onMobileClose?.()
  return { kind: 'recovered', workspace: created.directory }
}
