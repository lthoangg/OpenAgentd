/**
 * SidebarConfirmDialogs — the three destructive-action confirmation
 * dialogs for the sidebar (delete session · remove worktree).
 * Extracted from Sidebar.tsx as a purely
 * presentational component driven by props, so the main component stays
 * focused on state/orchestration (house pattern — see Sidebar.*.ts).
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

interface SidebarConfirmDialogsProps {
  deleteTarget: SessionResponse | null
  setDeleteTarget: (value: SessionResponse | null) => void
  onConfirmSessionDelete: () => void
  removeWorktreeTarget: WorktreeInfo | null
  setRemoveWorktreeTarget: (value: WorktreeInfo | null) => void
  onConfirmRemoveWorktree: () => void
}

export function SidebarConfirmDialogs({
  deleteTarget,
  setDeleteTarget,
  onConfirmSessionDelete,
  removeWorktreeTarget,
  setRemoveWorktreeTarget,
  onConfirmRemoveWorktree,
}: SidebarConfirmDialogsProps) {
  return (
    <>
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete this session?</DialogTitle>
            <DialogDescription>
              &quot;{deleteTarget?.title || 'Untitled'}&quot; and its messages are deleted for good. You can undo it for a few seconds.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="default" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button type="button" variant="danger" onClick={onConfirmSessionDelete}>Delete session</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeWorktreeTarget !== null}
        onOpenChange={(open) => { if (!open) setRemoveWorktreeTarget(null) }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete this worktree?</DialogTitle>
            <DialogDescription>
              &quot;{removeWorktreeTarget ? workspaceLabel(removeWorktreeTarget.directory) : ''}&quot; will be
              deleted from disk. Any uncommitted changes in this worktree will be lost. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="default" onClick={() => setRemoveWorktreeTarget(null)}>Cancel</Button>
            <Button type="button" variant="danger" onClick={onConfirmRemoveWorktree}>Delete worktree</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
