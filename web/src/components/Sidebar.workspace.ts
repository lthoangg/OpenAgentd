import type { QueryClient } from '@tanstack/react-query'
import type { SessionResponse } from '@/api/types'
import { listSessions, setCodingWorkspaceVisibility } from '@/api/client'
import { queryKeys } from '@/queries'
import { removeWorkspace, sameWorkspacePath, saveLastWorkspace } from '@/utils/workspace'
import { startNewSession, type NewSessionNavigate } from '@/lib/new-session'

/**
 * Open a folder on a new-session draft. A folder the sidebar does not list
 * yet is registered first (un-hidden), so its row is there before the first
 * message creates a session in it.
 */
export async function openWorkspaceDraft(options: {
  path: string
  /** Already a row in the sidebar tree (or the Chat workspace). */
  listed: boolean
  currentSessionId?: string
  currentWorkspace?: string | null
  refreshWorkspaceTree: () => Promise<void>
  navigate: NewSessionNavigate
  setCodingWorkspaceVisibilityFn?: typeof setCodingWorkspaceVisibility
}): Promise<void> {
  if (!options.listed) {
    await (options.setCodingWorkspaceVisibilityFn ?? setCodingWorkspaceVisibility)(options.path, false)
    await options.refreshWorkspaceTree()
  }
  startNewSession({
    navigate: options.navigate,
    workspace: options.path,
    current: { sessionId: options.currentSessionId, workspace: options.currentWorkspace },
  })
}

/** The newest top-level session in ``workspace``, or null (created order). */
export async function latestTopLevelSession(
  workspace: string,
  listSessionsFn: typeof listSessions = listSessions,
): Promise<SessionResponse | null> {
  const page = await listSessionsFn(null, 1, { workspace })
  return page.data.find((session) => !session.parent_session_id && sameWorkspacePath(session.workspace, workspace)) ?? null
}

/**
 * Switch to a workspace: its latest session, or a new-session draft when it
 * has none yet (nothing is created until the first message).
 */
export async function openWorkspaceLatest(options: {
  path: string
  currentSessionId?: string | null
  currentWorkspace?: string | null
  navigate: (args: { to: '/$sessionId'; params: { sessionId: string } } | { to: '/'; search: { workspace: string }; replace?: boolean }) => unknown
  listSessionsFn?: typeof listSessions
}): Promise<void> {
  const latest = await latestTopLevelSession(options.path, options.listSessionsFn)
  if (!latest) {
    startNewSession({
      navigate: options.navigate,
      workspace: options.path,
      current: { sessionId: options.currentSessionId, workspace: options.currentWorkspace },
    })
    return
  }
  saveLastWorkspace(options.path)
  options.navigate({ to: '/$sessionId', params: { sessionId: latest.id } })
}

/**
 * Hide a repository from the sidebar. Its sessions stay in the backend, and
 * reopening the folder un-hides it.
 *
 * - Its worktrees are hidden with it: the workspace tree keeps listing a
 *   hidden repository while any worktree under it is still visible.
 * - Every hidden path leaves the saved workspace list before the view leaves
 *   it. The empty route reopens the last workspace, and resolving a session
 *   there would un-hide the workspace straight away.
 *
 * Everything up to the first request runs synchronously, so callers may
 * fire and forget. Returns ``expandedWorkspaces`` without the hidden paths.
 */
export async function confirmWorkspaceRemoval(options: {
  path: string
  /** Worktrees listed under the repository. */
  worktreePaths?: readonly string[]
  activeWorkspace: string | null
  expandedWorkspaces: Set<string>
  queryClient: QueryClient
  refreshWorkspaceTree: () => Promise<void>
  navigate: (args: { to: '/'; replace: true }) => void
  setCodingWorkspaceVisibilityFn?: typeof setCodingWorkspaceVisibility
}): Promise<Set<string>> {
  const paths = [options.path, ...(options.worktreePaths ?? [])]
  for (const path of paths) removeWorkspace(path)
  if (options.activeWorkspace && paths.includes(options.activeWorkspace)) {
    options.navigate({ to: '/', replace: true })
  }
  const setVisibility = options.setCodingWorkspaceVisibilityFn ?? setCodingWorkspaceVisibility
  await Promise.all(paths.map((path) => setVisibility(path, true)))
  await options.queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
  await options.refreshWorkspaceTree()
  const next = new Set(options.expandedWorkspaces)
  for (const path of paths) next.delete(path)
  return next
}
