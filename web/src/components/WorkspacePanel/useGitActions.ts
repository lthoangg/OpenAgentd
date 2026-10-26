/**
 * Git write actions for the review dock: undo the last commit, revert a
 * commit, and discard a file's working changes. Each reports through a toast
 * and hands refetching back to the dock, which owns the queries.
 */
import { useState } from 'react'

import { discardCodingWorkspaceFile, revertCodingWorkspaceCommit, undoCodingWorkspaceLastCommit } from '@/api/client'
import { outcomeHapticFeedback } from '@/lib/haptics'
import { useToastStore } from '@/stores/useToastStore'

import type { ChangedFileInfo } from './diff-helpers'

interface GitActionsOptions {
  workspace: string
  /** A commit action succeeded: close its menus and refetch history, diff and files. */
  onCommitChanged: () => void
  /** A discard succeeded: refetch the diff and the file listing. */
  onWorkingTreeChanged: () => void
}

export function useGitActions({ workspace, onCommitChanged, onWorkingTreeChanged }: GitActionsOptions) {
  const pushToast = useToastStore((s) => s.push)
  const [gitActionPending, setGitActionPending] = useState(false)
  const [discardTarget, setDiscardTarget] = useState<ChangedFileInfo | null>(null)
  const [discarding, setDiscarding] = useState(false)

  const runCommitAction = async (
    action: () => Promise<unknown>,
    success: { title: string; description: string },
    failureTitle: string,
  ) => {
    setGitActionPending(true)
    try {
      await action()
      outcomeHapticFeedback('success')
      pushToast({ tone: 'success', ...success })
      onCommitChanged()
    } catch (err) {
      outcomeHapticFeedback('error')
      pushToast({ tone: 'error', title: failureTitle, description: err instanceof Error ? err.message : String(err) })
    } finally {
      setGitActionPending(false)
    }
  }

  const handleUndoCommit = () => void runCommitAction(
    () => undoCodingWorkspaceLastCommit(workspace),
    { title: 'Commit undone', description: 'The last commit was undone. Changes have been kept in your working copy.' },
    'Failed to undo commit',
  )

  const handleRevertCommit = (sha: string, shortSha: string) => void runCommitAction(
    () => revertCodingWorkspaceCommit(workspace, sha),
    { title: 'Commit reverted', description: `Successfully created revert commit for ${shortSha}.` },
    'Failed to revert commit',
  )

  const handleConfirmDiscard = async () => {
    if (!discardTarget) return
    setDiscarding(true)
    try {
      await discardCodingWorkspaceFile(workspace, discardTarget.path, discardTarget.status)
      outcomeHapticFeedback('success')
      pushToast({
        tone: 'success',
        title: 'Changes discarded',
        description: `Reverted ${discardTarget.path} to its state in HEAD.`,
      })
      setDiscardTarget(null)
      onWorkingTreeChanged()
    } catch (err) {
      outcomeHapticFeedback('error')
      pushToast({
        tone: 'error',
        title: 'Failed to discard changes',
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDiscarding(false)
    }
  }

  return {
    gitActionPending,
    handleUndoCommit,
    handleRevertCommit,
    discardTarget,
    setDiscardTarget,
    discarding,
    handleConfirmDiscard,
  }
}
