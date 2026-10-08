/**
 * "See release notes" link plus the dialog it opens. Shared by the floating
 * update card and the Settings → Updates section so both show the same
 * Dialog (focus trap, Escape, focus return) instead of two hand-built modals.
 */
import { useState } from 'react'
import { fetchReleaseNotes, type ReleaseNotes } from '@/lib/updater'
import { openExternalUrl } from '@/lib/open-external'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { MarkdownBlock } from '@/utils/markdown'
import { cn } from '@/lib/utils'

interface ReleaseNotesButtonProps {
  version: string
  /** Shown until the GitHub release body loads, or if it fails. */
  fallbackNotes?: string | null
  /** Trigger overrides (margin, size). */
  className?: string
}

export function ReleaseNotesButton({ version, fallbackNotes, className }: ReleaseNotesButtonProps) {
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState<ReleaseNotes | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function openNotes() {
    setOpen(true)
    setError(null)
    try {
      setNotes(await fetchReleaseNotes(version))
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <>
      <button
        type="button"
        className={cn(
          'cursor-pointer text-xs font-medium text-(--color-accent) underline-offset-4 transition-colors hover:text-(--color-accent)/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
          className,
        )}
        onClick={() => void openNotes()}
      >
        See release notes
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          aria-label="Release notes"
          // Above the floating notices (z-60) the update card lives in.
          size="lg"
          padding="none"
          className="z-60 overflow-hidden"
        >
          <DialogHeader className="flex-row items-center justify-between gap-3 border-b border-(--color-border) px-4 py-3">
            <DialogTitle>Release notes</DialogTitle>
            <div className="flex items-center gap-2">
              {notes?.url ? (
                <a
                  className={buttonVariants({ variant: 'ghost', size: 'xs' })}
                  href={notes.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    event.preventDefault()
                    void openExternalUrl(notes.url)
                  }}
                >
                  View in GitHub
                </a>
              ) : null}
              <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </DialogHeader>
          <div className="max-h-[24rem] overflow-y-auto overscroll-contain touch-pan-y px-4 py-3 text-(--color-text)">
            <MarkdownBlock
              content={`${notes?.body ?? fallbackNotes ?? 'Loading release notes...'}${error ? `\n\nCould not load GitHub release notes: ${error}` : ''}`}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
