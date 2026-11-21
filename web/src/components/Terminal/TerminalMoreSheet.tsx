/**
 * TerminalMoreSheet — the key bar's More: the keys a phone keyboard lacks or
 * hides two pages deep, and nothing else (Termius's extended keyboard, cut
 * to what a shell uses). Alt is sticky like Ctrl; Shift+Tab steps an agent's
 * modes back. Keys the bar or a gesture already gives (^D is Ctrl then d,
 * Home is Ctrl then a, PgUp is a swipe) are not repeated here.
 *
 * A key closes the sheet; the parent sends it and gives the keyboard back if
 * it was up. After a pinch changed the terminal's text size, a row shows the
 * size with Reset, back to the app's Text size.
 */
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Button } from '@/components/ui/button'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

interface TerminalMoreSheetProps {
  open: boolean
  onClose: () => void
  /** Send one key's bytes (the parent applies modifiers and refocuses). */
  onKey: (data: string) => void
  altArmed: boolean
  onAltToggle: () => void
  /** The size a pinch set, or ``null`` while the terminal follows Text size. */
  fontPx: number | null
  onResetFont: () => void
}

const KEYS = [
  { label: '⇧Tab', name: 'Shift+Tab', seq: '\x1b[Z' },
  { label: '|', name: 'Symbol |', seq: '|' },
  { label: '~', name: 'Symbol ~', seq: '~' },
  { label: '\\', name: 'Symbol \\', seq: '\\' },
  { label: '`', name: 'Symbol `', seq: '`' },
] as const

function keyClass(armed: boolean): string {
  return cn(
    'flex h-11 min-w-0 items-center justify-center rounded-md text-sm font-medium select-none active:bg-(--bg-key)',
    armed ? 'bg-(--color-fill-selected) text-(--color-text-on-selected)' : 'bg-(--color-surface-2) text-(--color-text)',
  )
}

export function TerminalMoreSheet({ open, onClose, onKey, altArmed, onAltToggle, fontPx, onResetFont }: TerminalMoreSheetProps) {
  const press = (run: () => void) => () => {
    haptic('tick')
    onClose()
    run()
  }
  return (
    <BottomSheet open={open} onClose={onClose} label="More keys">
      <div className="flex flex-col gap-2 px-2 pb-2" data-swipe-ignore>
        <div className="rounded-md bg-(--bg-card)">
          <p className="px-3 pt-1 pb-2 text-sm font-semibold text-(--color-text)">More keys</p>
          <div role="group" aria-label="Keys" className="grid grid-cols-6 gap-1 px-2 pb-2">
            <button type="button" aria-pressed={altArmed} className={keyClass(altArmed)} onClick={press(onAltToggle)}>
              Alt
            </button>
            {KEYS.map(({ label, name, seq }) => (
              <button key={seq} type="button" aria-label={name} className={cn(keyClass(false), 'font-mono')} onClick={press(() => onKey(seq))}>
                {label}
              </button>
            ))}
          </div>
          {fontPx !== null && (
            <div className="flex min-h-(--phone-control) items-center gap-3 border-t border-(--color-border) py-1 pr-1 pl-3">
              <span className="min-w-0 flex-1 truncate text-sm text-(--color-text)">Terminal text</span>
              <span className="shrink-0 tabular-nums text-sm text-(--color-text-muted)">{fontPx} px</span>
              <Button type="button" variant="ghost" size="sm" onClick={press(onResetFont)}>
                Reset
              </Button>
            </div>
          )}
        </div>
      </div>
    </BottomSheet>
  )
}
