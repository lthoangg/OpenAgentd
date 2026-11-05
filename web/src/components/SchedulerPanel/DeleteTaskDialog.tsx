/**
 * The confirmation before a scheduled task is deleted, shared by the task
 * list's row menu and the task's own detail header. A confirm has no ×:
 * Cancel dismisses, and the action is a verb and a noun.
 */
import { Loader2 } from 'lucide-react'
import type { ScheduledTaskResponse } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDeleteScheduledTaskMutation } from '@/queries'

export function DeleteTaskDialog({
  task,
  open,
  onOpenChange,
  onDeleted,
}: {
  task: ScheduledTaskResponse
  open: boolean
  onOpenChange: (open: boolean) => void
  /** After the task is gone: the host leaves the pane that showed it. */
  onDeleted: () => void
}) {
  const deleteMutation = useDeleteScheduledTaskMutation()
  const deleteTask = () => {
    deleteMutation.mutate(task.slug, {
      onSuccess: () => {
        onOpenChange(false)
        onDeleted()
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete scheduled task</DialogTitle>
          <DialogDescription>
            &ldquo;{task.name}&rdquo; will be permanently deleted. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="default" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={deleteTask} disabled={deleteMutation.isPending}>
            {deleteMutation.isPending && <Loader2 size={13} className="animate-spin" />}
            Delete task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
