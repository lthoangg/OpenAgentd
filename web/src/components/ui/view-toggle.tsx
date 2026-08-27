/**
 * ViewToggle — single-button toggle between Agent (focused) and Split
 * (side-by-side panes) view. Tap / click toggles between the two modes.
 */

import { User, Columns2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatShortcut } from '@/lib/keyboard-shortcut'
import { usePlatform } from '@/hooks/use-platform'

export type ViewMode = 'agent' | 'split'

export interface ViewToggleProps {
  value: ViewMode
  onValueChange: (mode: ViewMode) => void
  /** Compact layout for status bar / app footer. */
  compact?: boolean
  className?: string
}

export function ViewToggle({
  value,
  onValueChange,
  compact = false,
  className,
}: ViewToggleProps) {
  const { os } = usePlatform()
  const isAgent = value === 'agent'
  const nextMode: ViewMode = isAgent ? 'split' : 'agent'
  const Icon = isAgent ? User : Columns2
  const shortcut = formatShortcut('V', os, { shift: true })
  const label = isAgent ? 'Switch to split view' : 'Switch to agent view'
  const title = `${label} (${shortcut})`

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={() => onValueChange(nextMode)}
            className={cn(
              compact
                ? 'flex h-5 w-5 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40'
                : 'inline-flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 md:h-7 md:w-7 md:rounded-md',
              className,
            )}
          >
            <Icon size={compact ? 12 : 14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        }
      />
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}
