/**
 * CommandCenterButton — the header's centered palette entry (VS Code's
 * "Command Center"). Icon-only at ``md``; a labelled search pill from ``lg``.
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
            className="flex h-7 w-7 shrink-0 items-center justify-center gap-2 rounded-sm border border-transparent pointer-coarse:h-9 pointer-coarse:min-w-9 text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:border-(--color-border) hover:bg-(--bg-card) hover:text-(--color-text) lg:w-full lg:max-w-80 lg:justify-start lg:border-(--color-border-subtle) lg:bg-(--bg-page) lg:px-2.5"
          >
            <Search size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
            <span className="hidden min-w-0 flex-1 truncate text-left text-xs lg:inline">Search or run a command</span>
            <kbd className="hidden shrink-0 rounded-xs border border-(--color-border) bg-(--bg-card) px-1.5 font-mono text-meta leading-4 text-(--color-text-muted) lg:inline">
              {shortcut}
            </kbd>
          </button>
        }
      />
      <TooltipContent>{`Command palette (${shortcut})`}</TooltipContent>
    </Tooltip>
  )
}
