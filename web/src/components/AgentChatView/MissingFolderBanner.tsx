/**
 * MissingFolderBanner — the notice above a session whose folder was moved or
 * deleted from disk. The saved transcript stays readable below it; only a new
 * turn needs the folder, so the banner offers to open another folder or hide
 * the stale workspace from the sidebar.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { TriangleAlert } from 'lucide-react'

import { getCodingWorkspaceTree, setCodingWorkspaceVisibility } from '@/api/client'
import { ActionSheet } from '@/components/ui/action-sheet'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { useIsPhone } from '@/hooks/use-is-phone'
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
  const isPhone = useIsPhone()
  const [sheetOpen, setSheetOpen] = useState(false)

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

  // A phone: one line under the bar, one action; the rest in a sheet
  // (Phone system → Notices).
  if (isPhone) {
    return (
      <>
        <div role="status" className="flex min-h-11 items-center gap-2 border-b border-(--color-border-subtle) bg-(--bg-card) px-4 text-subhead">
          <TriangleAlert size={16} aria-hidden="true" className="shrink-0 text-(--accent-orange-text)" />
          <span className="min-w-0 flex-1 truncate text-(--color-text)">Folder was moved or deleted</span>
          <Button size="sm" variant="ghost" onClick={() => setSheetOpen(true)}>Fix</Button>
        </div>
        <ActionSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title="This session's folder was moved or deleted."
          description={`${workspace} is not on disk. You can read this session, but new messages need the folder back.`}
          items={[
            { id: 'open', label: 'Open workspace…', run: onOpenFolder },
            { id: 'hide', label: 'Hide from sidebar', run: () => { void hideWorkspace() } },
          ]}
        />
      </>
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-3">
      <Callout
        tone="warning"
        role="status"
        title="This session's folder was moved or deleted."
        action={(
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onOpenFolder}>Open workspace…</Button>
            <Button size="sm" variant="ghost" onClick={() => { void hideWorkspace() }}>Hide from sidebar</Button>
          </div>
        )}
      >
        <span className="font-mono [overflow-wrap:anywhere]">{workspace}</span> is not on disk. You can read this session, but new messages need the folder back.
      </Callout>
    </div>
  )
}
