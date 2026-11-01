/**
 * CommandCenterButton — the header's centered palette entry (VS Code's
 * "Command Center"). Icon-only below ``md``; from ``md`` a labelled search
 * pill (icon, "Search or run a command", the shortcut) so the entry reads as
 * a search box rather than an unlabelled glyph.
 *
 * A control, so no border: the pill is a keycap wash like any secondary
 * action, and the shortcut sits on it as plain muted text.
 *
 * Kept at a fixed ``h-7`` inside the 36 px header: a taller control would
 * grow the header and push the macOS traffic lights off-centre. It is a
 * button, so ``useTauriDrag`` never starts a window drag from it and the
 * empty header on either side stays draggable.
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
            aria-label={`Search or run a command (${shortcut})`}
            className="flex h-7 w-7 shrink-0 items-center justify-center gap-2 rounded-sm text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) pointer-coarse:h-9 pointer-coarse:min-w-9 md:w-full md:max-w-80 md:justify-start md:bg-(--bg-key) md:px-2.5 md:hover:bg-(--color-border-subtle) md:dark:hover:bg-(--color-border)"
          >
            <Search size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
            <span className="hidden min-w-0 flex-1 truncate text-left text-xs md:inline">Search or run a command</span>
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
