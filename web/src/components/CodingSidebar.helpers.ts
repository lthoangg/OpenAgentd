import type {
  CodingWorkspaceTreeRepository,
  CodingWorkspaceTreeWorktree,
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

export function visibleNestedWorktrees(
  repository: CodingWorkspaceTreeRepository | undefined,
  removedWorktreePaths: Set<string>,
): CodingWorkspaceTreeWorktree[] {
  return (repository?.worktrees ?? []).filter(
    (item) => !removedWorktreePaths.has(item.path),
  )
}
