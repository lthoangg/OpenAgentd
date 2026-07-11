/**
 * CodingSidebarConfirmDialogs — the three destructive-action confirmation
 * dialogs for the coding sidebar (delete session · remove workspace ·
 * remove worktree). Extracted from CodingSidebar.tsx as a purely
 * presentational component driven by props, so the main component stays
 * focused on state/orchestration (house pattern — see CodingSidebar.*.ts).
 *
 * Each dialog is a portal, so rendering them together here (rather than
 * inline at three call sites) has no visual/layout effect.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { workspaceLabel } from '@/utils/workspace'
import type { SessionResponse, WorktreeInfo } from '@/api/types'

interface CodingSidebarConfirmDialogsProps {
  deleteTarget: SessionResponse | null
  setDeleteTarget: (value: SessionResponse | null) => void
  onConfirmSessionDelete: () => void
  removeWorkspaceTarget: string | null
  setRemoveWorkspaceTarget: (value: string | null) => void
  onConfirmRemoveWorkspace: () => void
  removeWorktreeTarget: WorktreeInfo | null
  setRemoveWorktreeTarget: (value: WorktreeInfo | null) => void
  onConfirmRemoveWorktree: () => void
}

export function CodingSidebarConfirmDialogs({
  deleteTarget,
  setDeleteTarget,
  onConfirmSessionDelete,
  removeWorkspaceTarget,
  setRemoveWorkspaceTarget,
  onConfirmRemoveWorkspace,
  removeWorktreeTarget,
  setRemoveWorktreeTarget,
  onConfirmRemoveWorktree,
}: CodingSidebarConfirmDialogsProps) {
  return (
    <>
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete session</DialogTitle>
            <DialogDescription>
              &ldquo;{deleteTarget?.title || 'Untitled'}&rdquo; will be permanently deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="p-3">
            <Button type="button" variant="default" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button type="button" variant="danger" onClick={onConfirmSessionDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeWorkspaceTarget !== null}
        onOpenChange={(open) => { if (!open) setRemoveWorkspaceTarget(null) }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove workspace from sidebar</DialogTitle>
            <DialogDescription>
              &ldquo;{removeWorkspaceTarget ? workspaceLabel(removeWorkspaceTarget) : ''}&rdquo; will be hidden from
              the sidebar. Its sessions stay on disk — reopening this folder later restores the list.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="p-3">
            <Button type="button" variant="default" onClick={() => setRemoveWorkspaceTarget(null)}>Cancel</Button>
            <Button type="button" variant="danger" onClick={onConfirmRemoveWorkspace}>Remove from sidebar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeWorktreeTarget !== null}
        onOpenChange={(open) => { if (!open) setRemoveWorktreeTarget(null) }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove worktree</DialogTitle>
            <DialogDescription>
              &ldquo;{removeWorktreeTarget ? workspaceLabel(removeWorktreeTarget.directory) : ''}&rdquo; will be
              deleted from disk. Any uncommitted changes in this worktree will be lost. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="p-3">
            <Button type="button" variant="default" onClick={() => setRemoveWorktreeTarget(null)}>Cancel</Button>
            <Button type="button" variant="danger" onClick={onConfirmRemoveWorktree}>Remove worktree</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
