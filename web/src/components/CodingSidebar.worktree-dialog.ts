import type { WorktreeInfo } from '@/api/types'
import { renameWorktree } from '@/api/client'

export interface OpenWorktreeDialogState {
  target: string
  name: string
  branch: string
  options: WorktreeInfo[]
  removing: string | null
  error: string | null
}

export function buildOpenWorktreeDialogState(
  path: string,
  cachedItems: WorktreeInfo[] | undefined,
): OpenWorktreeDialogState {
  return {
    target: path,
    name: '',
    branch: '',
    options: cachedItems ?? [],
    removing: null,
    error: null,
  }
}

export function beginWorktreeTitleEdit(item: WorktreeInfo): { target: WorktreeInfo; title: string } {
  return {
    target: item,
    title: item.name,
  }
}

export function prepareWorktreeRename(
  target: WorktreeInfo | null,
  title: string,
): { directory: string; title: string } | null {
  if (!target) return null
  const trimmed = title.trim()
  if (!trimmed) return null
  return {
    directory: target.directory,
    title: trimmed,
  }
}

export async function submitWorktreeRename(options: {
  target: WorktreeInfo | null
  title: string
  refreshWorkspaceTree: () => Promise<void>
  renameWorktreeFn?: typeof renameWorktree
}): Promise<boolean> {
  const rename = prepareWorktreeRename(options.target, options.title)
  if (!rename) return false
  await (options.renameWorktreeFn ?? renameWorktree)(rename.directory, rename.title)
  await options.refreshWorkspaceTree()
  return true
}
