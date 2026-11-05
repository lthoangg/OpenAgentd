/**
 * TranscriptDivider — the one divider of the transcript: a hairline, a
 * centred label, a hairline. It marks something the session did rather than
 * something anyone said (a goal turn, a server restart, a compaction), so
 * the three share this row and differ only in their words.
 *
 * Collapsible when it has a body: pass ``onToggle`` and the label becomes a
 * toggle with a chevron (``aria-expanded`` / ``aria-controls``); the caller
 * renders the body, usually in a ``Collapsible``, under the row. Without
 * ``onToggle`` the label is plain text. ``hint`` adds a hover hint to the
 * toggle for desktop (touch has the toggle itself), and is ``null`` while it
 * has nothing to add, so the toggle does not remount.
 */
import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react'
import { ChevronRight } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const MUTED = 'text-(--color-text-muted)'

const TOGGLE_CLASS =
  'inline-flex min-w-0 items-center gap-1.5 rounded-xs px-1 text-center text-xs transition-colors duration-(--motion-instant) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:min-h-9'

function Rule() {
  return <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-(--color-border)" />
}

export interface TranscriptDividerProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children' | 'onToggle'> {
  /** The centred words. */
  label: ReactNode
  /** Text colour class for the label; muted by default. */
  tone?: string
  /** Makes the label a toggle: whether the body under the row is open. */
  open?: boolean
  /** Presence makes the label a toggle; called with the pressed control. */
  onToggle?: (control: HTMLElement) => void
  /** The id of the body the toggle opens. */
  controls?: string
  toggleRef?: Ref<HTMLButtonElement>
  /** Hover hint for the toggle; ``null`` for none right now, ``undefined`` for never. */
  hint?: ReactNode
  /** Marks a plain label as a live status (a running compaction). */
  labelRole?: 'status'
}

export function TranscriptDivider({
  label,
  tone = MUTED,
  open = false,
  onToggle,
  controls,
  toggleRef,
  hint,
  labelRole,
  className,
  ...rowProps
}: TranscriptDividerProps) {
  let center: ReactNode
  if (onToggle) {
    const toggle = (
      <button
        ref={toggleRef}
        type="button"
        onClick={(event) => onToggle(event.currentTarget)}
        aria-expanded={open}
        aria-controls={controls}
        className={cn(TOGGLE_CLASS, tone)}
      >
        {label}
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={cn('shrink-0 text-(--color-text-subtle) transition-transform duration-(--motion-fast) ease-(--ease-out)', open && 'rotate-90')}
        />
      </button>
    )
    center =
      hint === undefined ? (
        toggle
      ) : (
        <Tooltip className="shrink">
          <TooltipTrigger render={toggle} />
          {hint ? <TooltipContent className="max-w-sm leading-relaxed">{hint}</TooltipContent> : null}
        </Tooltip>
      )
  } else {
    center = (
      <span role={labelRole} className={cn('min-w-0 px-1 text-center text-xs', tone)}>
        {label}
      </span>
    )
  }
  return (
    <div className={cn('flex items-center gap-3 select-none', className)} {...rowProps}>
      <Rule />
      {center}
      <Rule />
    </div>
  )
}
