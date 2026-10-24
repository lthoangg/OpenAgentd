import { useState } from 'react'
import type { SessionGoal } from '@/api/types'
import { InlineCodeText } from '@/components/InlineCodeText'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** Confirm a new `/goal` that would clear the session's live one. */
export function GoalReplaceDialog({ current, onConfirm, onCancel }: {
  /** The live goal the new one replaces; ``null`` keeps the dialog closed. */
  current: SessionGoal | null
  onConfirm: () => void
  onCancel: () => void
}) {
  // The goal stays on screen while the dialog plays its exit.
  const [shown, setShown] = useState(current)
  if (current !== null && current !== shown) setShown(current)
  return (
    <Dialog open={current !== null} onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Replace the current goal?</DialogTitle>
          <DialogDescription>
            The session already has a {shown?.status === 'paused' ? 'paused' : 'running'} goal
            {shown ? ` (${shown.turns_used} of ${shown.max_turns} turns used)` : ''}. The new goal clears it.
          </DialogDescription>
        </DialogHeader>
        {shown && (
          <p className="max-h-28 overflow-y-auto rounded-xs border border-(--color-border-subtle) bg-(--bg-page) px-2.5 py-2 text-xs whitespace-pre-wrap text-(--color-text-2)">
            <InlineCodeText text={shown.objective} />
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="default" onClick={onCancel}>Keep current goal</Button>
          <Button type="button" variant="primary" onClick={onConfirm}>Replace goal</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
