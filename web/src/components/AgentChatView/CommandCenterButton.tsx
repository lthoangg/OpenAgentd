/**
 * CommandCenterButton — the header's centered palette entry (VS Code's
 * "Command Center"). Icon-only below ``md``; from ``md`` a labelled search
 * pill (icon, "Command palette", the shortcut) so the entry reads as a
 * search box rather than an unlabelled glyph.
 *
 * A control, so no border: the pill is a keycap wash like any secondary
 * action, and the shortcut sits on it as plain muted text.
 *
 * Kept at a fixed ``h-7`` inside the 36 px header (``size-9`` on touch, as
 * the other header controls): a taller control would grow the header and
 * push the macOS traffic lights off-centre. It is a button, so
 * ``useTauriDrag`` never starts a window drag from it and the empty header
 * on either side stays draggable.
 *
 * On touch it grows to 36 px with ``pointer-coarse:h-9`` and ``min-w-9``,
 * not ``size-9``: ``pointer-coarse:`` sorts after ``md:``, so a coarse width
 * would shrink the pill's ``md:w-full`` to 36 px on tablets.
 */
import { Search } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'

export function CommandCenterButton({ onClick }: { onClick: () => void }) {
  const { os } = usePlatform()
  const shortcut = shortcutLabel(APP_SHORTCUTS.commandPalette, os)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            aria-label={`Command palette (${shortcut})`}
            className="flex h-7 w-7 shrink-0 items-center justify-center gap-2 rounded-sm text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) pointer-coarse:h-9 pointer-coarse:min-w-9 md:w-full md:max-w-80 md:justify-start md:bg-(--bg-key) md:px-2.5 md:hover:bg-(--color-border-subtle) md:dark:hover:bg-(--color-border)"
          >
            <Search size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
            <span className="hidden min-w-0 flex-1 truncate text-left text-xs md:inline">Command palette</span>
            <kbd className="hidden shrink-0 font-mono text-meta leading-4 text-(--color-text-muted) md:inline">
              {shortcut}
            </kbd>
          </button>
        }
      />
      <TooltipContent>{`Command palette (${shortcut})`}</TooltipContent>
    </Tooltip>
  )
}
