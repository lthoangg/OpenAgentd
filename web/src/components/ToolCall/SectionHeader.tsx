import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

interface SectionHeaderProps {
  /** The caption: "arguments", "terminal", "output", "result". */
  label: string
  /** Id of the details region the header closes. */
  controls?: string
  /** Closes the details; receives the pressed control so the view can stay put. */
  onCollapse: (control: HTMLElement) => void
  /** A Copy control, outside the toggle (a button cannot hold a button). */
  action?: ReactNode
  /** A rule above, between two stacked sections. */
  divided?: boolean
}

/**
 * Header of one section of an open tool row. The caption is the control: a
 * real button that closes the row's details, so the keyboard and screen
 * readers reach it like the row's own toggle. The header's other control,
 * Copy, sits beside it.
 */
export function SectionHeader({ label, controls, onCollapse, action, divided = false }: SectionHeaderProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-key) py-0.5 pr-1.5 pl-3',
        divided && 'border-t',
      )}
    >
      <button
        type="button"
        aria-expanded="true"
        aria-controls={controls}
        aria-label={`Collapse ${label}`}
        onClick={(event) => onCollapse(event.currentTarget)}
        className="flex min-h-6 min-w-0 flex-1 items-center self-stretch text-left text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring) pointer-coarse:min-h-9"
      >
        <span className="label-caps">{label}</span>
      </button>
      {action}
    </div>
  )
}
