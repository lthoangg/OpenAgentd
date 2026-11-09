import { pathBasename, sameWorkspacePath, workspaceLabel, getChatWorkspaceEntry } from '@/utils/workspace'

/** A workspace label in two parts: the repository, and the checkout when it is a worktree or subfolder. */
export interface CheckoutLabel {
  workspace: string
  checkout: string | null
}

/**
 * The label for ``path`` from the workspace tree's repositories: a worktree
 * or subfolder of a repository reads as its repository plus its own name
 * (``openagentd`` + ``fix-login``); the repository itself, the chat root and
 * any path the tree does not know keep the one-part ``workspaceLabel``.
 */
export function checkoutLabel(
  path: string,
  repositories: ReadonlyArray<{ path: string; name: string; worktrees: ReadonlyArray<{ path: string; name: string }> }> | null | undefined,
  chat: { path: string; name: string } | null = getChatWorkspaceEntry(),
): CheckoutLabel {
  for (const repo of repositories ?? []) {
    if (sameWorkspacePath(path, repo.path)) return { workspace: repo.name || pathBasename(repo.path), checkout: null }
    const item = repo.worktrees.find((w) => sameWorkspacePath(path, w.path))
    if (item) return { workspace: repo.name || pathBasename(repo.path), checkout: item.name || pathBasename(item.path) }
  }
  return { workspace: workspaceLabel(path, chat), checkout: null }
}

/** ``"repo (checkout)"``, or just ``"repo"`` for a main checkout. */
export function formatCheckoutLabel(label: CheckoutLabel): string {
  return label.checkout ? `${label.workspace} (${label.checkout})` : label.workspace
}
