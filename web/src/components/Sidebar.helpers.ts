import type {
  CodingWorkspaceTreeRepository,
  CodingWorkspaceTreeWorktree,
  SessionResponse,
} from '@/api/types'

export function toggleExpandedPath(current: Set<string>, path: string): Set<string> {
  const next = new Set(current)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

export function addExpandedPaths(
  current: Set<string>,
  paths: Array<string | null | undefined>,
): Set<string> {
  const next = new Set(current)
  for (const path of paths) {
    if (path) next.add(path)
  }
  return next
}

export function buildWorktreeSourceByDirectory(
  workspaceTree: CodingWorkspaceTreeRepository[],
): Map<string, string> {
  const worktreeSourceByDirectory = new Map<string, string>()
  for (const repo of workspaceTree) {
    for (const item of repo.worktrees) {
      worktreeSourceByDirectory.set(item.path, repo.path)
    }
  }
  return worktreeSourceByDirectory
}

export function sourceWorkspacePaths(
  workspaceTree: CodingWorkspaceTreeRepository[],
  removedWorktreePaths: Set<string>,
): string[] {
  return workspaceTree
    .map((repo) => repo.path)
    .filter((path) => !removedWorktreePaths.has(path))
}

export function groupSessionsByWorkspace(
  sessions: SessionResponse[],
): Map<string, SessionResponse[]> {
  const byWorkspace = new Map<string, SessionResponse[]>()
  for (const session of sessions) {
    if (!session.workspace) continue
    const existing = byWorkspace.get(session.workspace)
    if (existing) existing.push(session)
    else byWorkspace.set(session.workspace, [session])
  }
  return byWorkspace
}

export function visibleNestedWorktrees(
  repository: CodingWorkspaceTreeRepository | undefined,
  removedWorktreePaths: Set<string>,
): CodingWorkspaceTreeWorktree[] {
  return (repository?.worktrees ?? []).filter(
    (item) => !removedWorktreePaths.has(item.path),
  )
}

/**
 * The checkouts a repository row lists: all of them (its own path, then each
 * visible worktree), or the one ``selectedPath`` names. A selection that no
 * longer exists falls back to all.
 */
export function repositoryCheckouts(
  path: string,
  repository: CodingWorkspaceTreeRepository | undefined,
  removedWorktreePaths: Set<string>,
  selectedPath: string | undefined,
): {
  worktrees: CodingWorkspaceTreeWorktree[]
  /** The one checkout shown, or ``null`` for all of them. */
  selected: string | null
  selectedWorktree: CodingWorkspaceTreeWorktree | null
  listPaths: string[]
  worktreeNames: Map<string, string>
} {
  const worktrees = visibleNestedWorktrees(repository, removedWorktreePaths)
  const selectedWorktree = worktrees.find((item) => item.path === selectedPath) ?? null
  const selected = selectedPath === path || selectedWorktree ? (selectedPath ?? null) : null
  return {
    worktrees,
    selected,
    selectedWorktree,
    listPaths: selected ? [selected] : [path, ...worktrees.map((item) => item.path)],
    worktreeNames: new Map(worktrees.map((item) => [item.path, item.name])),
  }
}

/** One headed group of the sidebar's flat session views. */
export interface SessionGroup {
  id: string
  label: string
  sessions: SessionResponse[]
}

/** The time a session sorts by: last touch, or creation. */
export function sessionSortTime(session: SessionResponse, sortBy: 'activity' | 'created'): string | null {
  return sortBy === 'activity' ? (session.updated_at ?? session.created_at) : session.created_at
}

/** Local midnight ``daysAgo`` calendar days before ``now`` (DST-safe). */
function localMidnight(now: Date, daysAgo: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime()
}

/**
 * Today · Yesterday · Previous 7 days · Previous 30 days · Older, by the
 * sort key and local midnight. Keeps the input order inside each group and
 * drops empty groups. Sessions without a time count as Older.
 */
export function groupSessionsByDate(
  sessions: readonly SessionResponse[],
  sortBy: 'activity' | 'created',
  now: Date = new Date(),
): SessionGroup[] {
  const today = localMidnight(now, 0)
  const yesterday = localMidnight(now, 1)
  const week = localMidnight(now, 7)
  const month = localMidnight(now, 30)
  const groups: SessionGroup[] = [
    { id: 'today', label: 'Today', sessions: [] },
    { id: 'yesterday', label: 'Yesterday', sessions: [] },
    { id: 'week', label: 'Previous 7 days', sessions: [] },
    { id: 'month', label: 'Previous 30 days', sessions: [] },
    { id: 'older', label: 'Older', sessions: [] },
  ]
  for (const session of sessions) {
    const raw = sessionSortTime(session, sortBy)
    const time = raw ? Date.parse(raw) : Number.NaN
    const index = Number.isNaN(time) ? 4
      : time >= today ? 0
        : time >= yesterday ? 1
          : time >= week ? 2
            : time >= month ? 3
              : 4
    groups[index].sessions.push(session)
  }
  return groups.filter((group) => group.sessions.length > 0)
}

/**
 * Needs you · Working · Recent. ``active`` is every session running or
 * waiting (one page, any age); ``recent`` the paged list, which may repeat
 * them. Keeps each input's order and drops empty groups.
 */
export function groupSessionsByStatus(
  recent: readonly SessionResponse[],
  active: readonly SessionResponse[],
): SessionGroup[] {
  const needsYou = active.filter((session) => session.needs_input === true)
  const working = active.filter((session) => session.needs_input !== true && session.running === true)
  const activeIds = new Set([...needsYou, ...working].map((session) => session.id))
  const groups: SessionGroup[] = [
    { id: 'needs_input', label: 'Needs you', sessions: needsYou },
    { id: 'running', label: 'Working', sessions: working },
    { id: 'recent', label: 'Recent', sessions: recent.filter((session) => !activeIds.has(session.id)) },
  ]
  return groups.filter((group) => group.sessions.length > 0)
}
