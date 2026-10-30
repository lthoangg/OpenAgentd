/**
 * MissingFolderBanner — the notice above a session whose folder was moved or
 * deleted from disk. The saved transcript stays readable below it; only a new
 * turn needs the folder, so the banner offers to open another folder or hide
 * the stale workspace from the sidebar.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import { getCodingWorkspaceTree, setCodingWorkspaceVisibility } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { queryKeys } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { removeWorkspace } from '@/utils/workspace'

/** True when the workspace tree marks this folder (or worktree) as gone. */
export function useFolderMissing(workspace: string | null): boolean {
  const { data } = useQuery({
    queryKey: queryKeys.coding.tree(),
    queryFn: getCodingWorkspaceTree,
    enabled: Boolean(workspace),
    staleTime: 30_000,
  })
  if (!workspace || !data) return false
  return data.repositories.some((repo) => (
    (repo.path === workspace && repo.missing === true)
    || repo.worktrees.some((tree) => tree.path === workspace && tree.missing === true)
  ))
}

interface MissingFolderBannerProps {
  workspace: string
  onOpenFolder: () => void
}

export function MissingFolderBanner({ workspace, onOpenFolder }: MissingFolderBannerProps) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const pushToast = useToastStore((s) => s.push)

  const hideWorkspace = async () => {
    try {
      await setCodingWorkspaceVisibility(workspace, true)
      removeWorkspace(workspace)
      await queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
      await queryClient.invalidateQueries({ queryKey: queryKeys.coding.tree() })
      navigate({ to: '/', replace: true })
    } catch (err) {
      pushToast({ tone: 'error', title: 'Could not hide the workspace', description: err instanceof Error ? err.message : undefined })
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-3">
      <Callout
        tone="warning"
        role="status"
        title="This session's folder was moved or deleted."
        action={(
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onOpenFolder}>Open folder…</Button>
            <Button size="sm" variant="ghost" onClick={() => { void hideWorkspace() }}>Hide workspace</Button>
          </div>
        )}
      >
        <span className="font-mono [overflow-wrap:anywhere]">{workspace}</span> is not on disk. You can read this session, but new messages need the folder back.
      </Callout>
    </div>
  )
}
