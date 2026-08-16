/**
 * ViewToggle — single-button toggle between Agent (focused) and Split
 * (side-by-side panes) view. Tap / click toggles between the two modes.
 */

import { User, Columns2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatShortcut } from '@/lib/keyboard-shortcut'
import { usePlatform } from '@/hooks/use-platform'

export type ViewMode = 'agent' | 'split'

export interface ViewToggleProps {
  value: ViewMode
  onValueChange: (mode: ViewMode) => void
  className?: string
}

export function ViewToggle({
  value,
  onValueChange,
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
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={() => onValueChange(nextMode)}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 md:h-7 md:w-7 md:rounded-sm',
        className,
      )}
    >
      <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
    </button>
  )
}
