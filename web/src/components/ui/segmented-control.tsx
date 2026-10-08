/**
 * SegmentedControl — pick one of a few options (DESIGN.md → Segmented
 * Controls & Connected Tabs).
 *
 *   <SegmentedControl
 *     label="Theme"
 *     value={preference}
 *     onChange={setPreference}
 *     options={[{ value: 'light', label: 'Light' }, …]}
 *   />
 *
 * Radio semantics: a ``radiogroup`` of ``radio`` buttons with a roving tab
 * stop; arrows, Home and End move and select. The track is a keycap well and
 * the chosen segment is a card fill — no shadow, no border colour.
 *
 * ``segmentedTrackClass`` / ``segmentedItemClass`` expose the same look for
 * controls that need other semantics (e.g. a toggle-button group).
 */
import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type SegmentedSize = 'sm' | 'default' | 'composer'

const TRACK_SIZE: Record<SegmentedSize, string> = {
  // 24px dense toolbar variant.
  sm: 'h-6',
  // 32px, growing to a 44px target on touch.
  default: 'h-8 pointer-coarse:h-11',
  // Composer toolbar: matches the 32px attach/send buttons beside it on every
  // pointer (28px on desktop), so the row stays one height.
  composer: 'h-8 md:h-7',
}

const ITEM_SIZE: Record<SegmentedSize, string> = {
  sm: 'px-2 text-xs [&_svg:not([class*=size-])]:size-3',
  default: 'px-2.5 text-xs [&_svg:not([class*=size-])]:size-3.5',
  composer: 'px-2.5 text-xs [&_svg:not([class*=size-])]:size-3.5',
}

/** Track (container) classes. */
export function segmentedTrackClass({ size = 'default', fill = false }: { size?: SegmentedSize; fill?: boolean } = {}): string {
  return cn(
    'inline-flex max-w-full shrink-0 items-center gap-0.5 overflow-x-auto rounded-sm border border-(--color-border) bg-(--bg-key) p-0.5 scrollbar-none',
    TRACK_SIZE[size],
    fill && 'flex w-full',
  )
}

/** Segment (button) classes. */
export function segmentedItemClass({
  active,
  size = 'default',
  fill = false,
  iconOnly = false,
  dimDisabled = true,
}: {
  active: boolean
  size?: SegmentedSize
  fill?: boolean
  iconOnly?: boolean
  /** Fade a disabled segment. Off for a chosen segment that is disabled only because it is already chosen. */
  dimDisabled?: boolean
}): string {
  return cn(
    'inline-flex h-full items-center justify-center gap-1.5 rounded-xs border border-transparent font-medium whitespace-nowrap select-none',
    'transition-colors duration-(--motion-instant)',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
    dimDisabled ? 'disabled:cursor-not-allowed disabled:opacity-50' : 'disabled:cursor-default',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
    ITEM_SIZE[size],
    iconOnly && 'aspect-square px-0',
    fill && 'flex-1',
    active
      ? 'bg-(--bg-card) text-(--color-text)'
      : 'text-(--color-text-muted) hover:text-(--color-text-2)',
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  /** Visible label. Omit for an icon-only segment (then set ``ariaLabel``). */
  label?: ReactNode
  icon?: ReactNode
  /** Accessible name when the label is not plain text or is absent. */
  ariaLabel?: string
  title?: string
  /** Tooltip content shown on hover/keyboard focus. */
  tooltip?: ReactNode
  disabled?: boolean
  className?: string
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group. */
  label: string
  value: T
  onChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  size?: SegmentedSize
  /** Stretch to the container width with equal segments. */
  fill?: boolean
  disabled?: boolean
  className?: string
  itemClassName?: string
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right'
}

const PREVIOUS_KEYS = new Set(['ArrowLeft', 'ArrowUp'])
const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown'])

export function SegmentedControl<T extends string>({
  label,
  value,
  onChange,
  options,
  size = 'default',
  fill = false,
  disabled = false,
  className,
  itemClassName,
  tooltipSide,
}: SegmentedControlProps<T>) {
  const enabled = options.filter((option) => !disabled && !option.disabled)
  // The chosen segment is the tab stop; fall back to the first enabled one.
  const tabStop = enabled.some((option) => option.value === value) ? value : enabled[0]?.value

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: T) => {
    if (!enabled.length) return
    const index = enabled.findIndex((option) => option.value === current)
    let next: number
    if (PREVIOUS_KEYS.has(event.key)) next = (index - 1 + enabled.length) % enabled.length
    else if (NEXT_KEYS.has(event.key)) next = (index + 1) % enabled.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = enabled.length - 1
    else return
    event.preventDefault()
    const target = enabled[next]
    const group = event.currentTarget.closest('[role="radiogroup"]')
    const segments = Array.from(group?.querySelectorAll<HTMLButtonElement>('[data-segment-value]') ?? [])
    segments.find((segment) => segment.dataset.segmentValue === target.value)?.focus()
    if (target.value !== value) onChange(target.value)
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-slot="segmented-control"
      className={cn(segmentedTrackClass({ size, fill }), className)}
    >
      {options.map((option) => {
        const active = option.value === value
        const button = (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.ariaLabel}
            title={option.title}
            data-segment-value={option.value}
            disabled={disabled || option.disabled}
            tabIndex={option.value === tabStop ? 0 : -1}
            onClick={() => {
              if (!active) onChange(option.value)
            }}
            onKeyDown={(event) => handleKeyDown(event, option.value)}
            className={cn(
              segmentedItemClass({ active, size, fill, iconOnly: option.label == null }),
              itemClassName,
              option.className,
            )}
          >
            {option.icon}
            {option.label}
          </button>
        )
        if (!option.tooltip) return button
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger render={button} />
            <TooltipContent side={tooltipSide}>{option.tooltip}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
