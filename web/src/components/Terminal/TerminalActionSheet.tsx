/**
 * TerminalActionSheet — mobile long-press menu for the terminal surface.
 *
 * Touch has no native context menu and xterm's own touch handling already
 * owns tap/drag (scroll, drag-to-select), so a long-press on the surface
 * opens this instead: Select All / Copy (current selection) / Paste
 * (clipboard → PTY input). Fed pure callbacks so it has no xterm import
 * and can be unit-tested without the terminal renderer.
 */
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface TerminalActionSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  hasSelection: boolean
  onSelectAll: () => void
  onCopy: () => void
  onPaste: () => void
}

export function TerminalActionSheet({
  open,
  onOpenChange,
  hasSelection,
  onSelectAll,
  onCopy,
  onPaste,
}: TerminalActionSheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Terminal</DialogTitle>
          <DialogDescription>Choose an action.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
          <Button type="button" variant="ghost" className="justify-start" onClick={onSelectAll}>
            Select All
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            onClick={onCopy}
            disabled={!hasSelection}
          >
            Copy
          </Button>
          <Button type="button" variant="ghost" className="justify-start" onClick={onPaste}>
            Paste
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
