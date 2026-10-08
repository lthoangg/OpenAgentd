import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/**
 * ⌘W on a terminal with a running shell, or Close Others / Close to the
 * Right sweeping some up: stopping a shell cannot be undone.
 */
export function CloseTerminalDialog({ open, title, count = 1, onConfirm, onCancel }: {
  open: boolean
  title: string
  /** Running terminals being closed; more than one changes the wording. */
  count?: number
  onConfirm: () => void
  onCancel: () => void
}) {
  const many = count > 1
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{many ? `Close ${count} terminals?` : 'Close terminal?'}</DialogTitle>
          <DialogDescription>
            {many
              ? `${title} are still running. Closing them stops their shells and anything running in them.`
              : `${title} is still running. Closing it stops the shell and anything running in it.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={onConfirm} autoFocus>
            {many ? 'Close terminals' : 'Close terminal'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
