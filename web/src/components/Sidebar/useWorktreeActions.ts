/**
 * A repository's worktrees from the sidebar: create one (and open a session
 * in it), rename one, and delete a managed one after a confirmation that says
 * what happens to its branch. ``removedWorktreePaths`` keeps a deleted
 * worktree off the rows even while a stale tree still lists it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { listWorktrees, removeWorktree } from '@/api/client'
import type { WorktreeInfo, WorktreeRemoveResponse } from '@/api/types'
import {
  loadWorktreesForSource,
  recoverCreatedWorktreeAfterTransientError,
  removeManagedWorktree,
  submitWorktreeSession,
} from './worktrees'
import {
  beginWorktreeTitleEdit,
  buildOpenWorktreeDialogState,
  submitWorktreeRename,
} from './worktree-dialog'

export type WorktreeActions = ReturnType<typeof useWorktreeActions>

export function useWorktreeActions({
  worktreeSourceByDirectory,
  refreshWorkspaceTree,
  onMobileClose,
  setError,
  onRemoved,
}: {
  /** Worktree directory → the repository it belongs to. */
  worktreeSourceByDirectory: Map<string, string>
  refreshWorkspaceTree: () => Promise<void>
  onMobileClose?: () => void
  /** The sidebar's one error line, which the worktree dialogs show. */
  setError: (error: string | null) => void
  /** A managed worktree was deleted from disk. */
  onRemoved: (directory: string) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [worktreeEditTarget, setWorktreeEditTarget] = useState<WorktreeInfo | null>(null)
  const [worktreeEditTitle, setWorktreeEditTitle] = useState('')
  const [worktreeEditLoading, setWorktreeEditLoading] = useState(false)
  const worktreeEditInputRef = useRef<HTMLInputElement>(null)
  const [worktreeTarget, setWorktreeTarget] = useState<string | null>(null)
  const [worktreeName, setWorktreeName] = useState('')
  const [worktreeBranch, setWorktreeBranch] = useState('')
  const [worktreeLoading, setWorktreeLoading] = useState(false)
  const [worktreeRemoving, setWorktreeRemoving] = useState<string | null>(null)
  const [removedWorktreePaths, setRemovedWorktreePaths] = useState<Set<string>>(() => new Set())
  // Managed-worktree pending removal — null when no confirmation is open.
  // Removing a managed worktree deletes it from disk (git worktree remove),
  // which can drop uncommitted work, so it must be confirmed (error
  // prevention) like session-delete and workspace-removal already are.
  const [removeWorktreeTarget, setRemoveWorktreeTargetState] = useState<WorktreeInfo | null>(null)
  // What the removal does to the worktree's branch (a dry run), for the dialog.
  const [removeWorktreePreview, setRemoveWorktreePreview] = useState<WorktreeRemoveResponse | null>(null)
  const removeWorktreeAsked = useRef<string | null>(null)
  const setRemoveWorktreeTarget = (item: WorktreeInfo | null) => {
    setRemoveWorktreeTargetState(item)
    setRemoveWorktreePreview(null)
    removeWorktreeAsked.current = item?.directory ?? null
    const source = item?.managed ? worktreeSourceByDirectory.get(item.directory) ?? worktreeTarget : null
    if (!item || !source) return
    // The dialog stands without the answer; it only loses the branch line.
    removeWorktree(source, item.directory, { dryRun: true })
      .then((preview) => { if (removeWorktreeAsked.current === item.directory) setRemoveWorktreePreview(preview) })
      .catch(() => {})
  }

  useEffect(() => {
    if (worktreeEditTarget) worktreeEditInputRef.current?.focus()
  }, [worktreeEditTarget])

  const loadWorktreesForTarget = useCallback((path: string) => loadWorktreesForSource(path, listWorktrees), [])

  const openWorktreeDialog = (path: string) => {
    const nextState = buildOpenWorktreeDialogState(path)
    setWorktreeTarget(nextState.target)
    setWorktreeName(nextState.name)
    setWorktreeBranch(nextState.branch)
    setWorktreeRemoving(nextState.removing)
    setError(nextState.error)
  }

  const handleRemoveWorktree = async (item: WorktreeInfo) => {
    if (!item.managed) return
    const directory = item.directory
    setWorktreeRemoving(directory)
    setError(null)
    try {
      const result = await removeManagedWorktree(item, {
        worktreeTarget,
        worktreeSourceByDirectory,
        loadWorktreesForSource: loadWorktreesForTarget,
        refreshWorkspaceTree,
      })
      if (!result) return
      setRemovedWorktreePaths((current) => new Set(current).add(result.removedDirectory))
      onRemoved(result.removedDirectory)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove worktree")
    } finally {
      setWorktreeRemoving(null)
    }
  }

  // Commit the removal from the confirmation dialog.
  const confirmRemoveWorktree = () => {
    const target = removeWorktreeTarget
    setRemoveWorktreeTarget(null)
    if (target) void handleRemoveWorktree(target)
  }

  const submitWorktree = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!worktreeTarget) return
    setWorktreeLoading(true)
    setError(null)
    try {
      await submitWorktreeSession({
        worktreeTarget,
        worktreeName,
        worktreeBranch,
        queryClient,
        refreshWorkspaceTree,
        navigate,
        onMobileClose,
        loadWorktreesForSource: loadWorktreesForTarget,
      })
      setWorktreeTarget(null)
    } catch (err) {
      const recovered = await recoverCreatedWorktreeAfterTransientError({
        error: err,
        worktreeTarget,
        worktreeName,
        loadWorktreesForSource: loadWorktreesForTarget,
        refreshWorkspaceTree,
        navigate: ({ to }) => navigate({ to }),
        onMobileClose,
      })
      if (recovered) {
        setWorktreeTarget(null)
        setError(null)
        return
      }
      setError(err instanceof Error ? err.message : "Couldn't create worktree")
    } finally {
      setWorktreeLoading(false)
    }
  }

  const handleWorktreeEdit = (item: WorktreeInfo) => {
    const nextState = beginWorktreeTitleEdit(item)
    setWorktreeEditTarget(nextState.target)
    setWorktreeEditTitle(nextState.title)
  }

  const submitWorktreeTitle = async (e: React.FormEvent) => {
    e.preventDefault()
    setWorktreeEditLoading(true)
    setError(null)
    try {
      const renamed = await submitWorktreeRename({
        target: worktreeEditTarget,
        title: worktreeEditTitle,
        refreshWorkspaceTree,
      })
      if (!renamed) return
      setWorktreeEditTarget(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't rename worktree")
    } finally {
      setWorktreeEditLoading(false)
    }
  }

  return {
    worktreeTarget,
    setWorktreeTarget,
    worktreeName,
    setWorktreeName,
    worktreeBranch,
    setWorktreeBranch,
    worktreeLoading,
    worktreeRemoving,
    removedWorktreePaths,
    removeWorktreeTarget,
    removeWorktreePreview,
    setRemoveWorktreeTarget,
    confirmRemoveWorktree,
    worktreeEditTarget,
    setWorktreeEditTarget,
    worktreeEditTitle,
    setWorktreeEditTitle,
    worktreeEditLoading,
    worktreeEditInputRef,
    openWorktreeDialog,
    submitWorktree,
    handleWorktreeEdit,
    submitWorktreeTitle,
  }
}
