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
 * stop; arrows, Home and End move and select. The track is a keycap wash with
 * no border and no padding ring; the chosen segment fills it edge to edge with
 * the theme accent (Bark on paper, paper on dark) and inverts its text, like a
 * native segmented control. No shadow, no border. Once the segments have
 * widths, that fill is one element that slides from the old choice to the
 * new one (``base``, ``ease-out``) as on macOS and iOS, the words crossing
 * over to the inverted tone at the same pace. Pressing the chosen segment
 * shrinks the fill a little (``scale`` .92 at ``fast``); with the pointer held
 * the fill can be dragged across the segments and the one under the pointer
 * is picked on release. A plain click and the keys work as before.
 *
 * ``segmentedTrackClass`` / ``segmentedItemClass`` expose the same look for
 * controls that need other semantics (e.g. a toggle-button group).
 */
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { selectionHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type SegmentedSize = 'sm' | 'default'

const TRACK_SIZE: Record<SegmentedSize, string> = {
  // 24px dense toolbar variant; 28px on touch so it still fits the 32px
  // toolbar (like ``TabsList size="sm"``).
  sm: 'h-6 pointer-coarse:h-7',
  // 32px; on touch each segment is a 44px target.
  default: 'h-8 pointer-coarse:h-auto',
}

const ITEM_SIZE: Record<SegmentedSize, string> = {
  sm: 'px-2 text-xs pointer-coarse:min-w-9 [&_svg:not([class*=size-])]:size-3',
  default: 'px-2.5 text-xs pointer-coarse:min-h-9 pointer-coarse:min-w-9 [&_svg:not([class*=size-])]:size-3.5',
}

/** Track (container) classes. */
export function segmentedTrackClass({ size = 'default', fill = false }: { size?: SegmentedSize; fill?: boolean } = {}): string {
  return cn(
    'relative inline-flex max-w-full shrink-0 items-stretch overflow-hidden overflow-x-auto rounded-sm bg-(--bg-key) scrollbar-none',
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
    'inline-flex h-full items-center justify-center gap-1.5 font-medium whitespace-nowrap select-none',
    'transition-colors duration-(--motion-instant)',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring)',
    dimDisabled ? 'disabled:cursor-not-allowed disabled:opacity-50' : 'disabled:cursor-default',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
    ITEM_SIZE[size],
    iconOnly && 'aspect-square px-0',
    fill && 'flex-1',
    active
      ? 'bg-(--color-fill-selected) text-(--color-text-on-selected)'
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

interface IndicatorBox { x: number; y: number; w: number; h: number }

/** Pointer handlers a track takes to let its fill be dragged (see ``useSegmentIndicator``). */
export interface SegmentDragHandlers {
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void
  onLostPointerCapture: () => void
  onClick: () => void
}

/** A segment's rectangle in the track's scrolled coordinates. */
function boxOf(segment: HTMLElement): IndicatorBox {
  return { x: segment.offsetLeft, y: segment.offsetTop, w: segment.offsetWidth, h: segment.offsetHeight }
}

/**
 * The sliding fill for a segmented track: put ``trackRef`` on the track,
 * ``indicator`` first inside it, and ``slideItemClass`` on every segment.
 * ``chosen`` selects the chosen segment (radio or pressed toggle). The box
 * is the chosen segment's own rectangle (left, top, width, height), so in a
 * track that wraps onto several rows the fill covers that segment's row only,
 * not the whole track. It follows value changes and resizes (a Text size
 * change, a fill-width track, a reflow) and is null until the segments have
 * widths, so the first frame never slides in from 0 and the chosen segment
 * keeps its own fill until then.
 *
 * Pass ``onPick`` to make the fill draggable: spread ``trackProps`` on the
 * track and mark each segment ``data-segment-value``. A press on the chosen
 * segment shrinks the fill; moving with the pointer held carries it to the
 * enabled segment under the pointer, and releasing there calls ``onPick``
 * with that segment's value (not when it is the chosen one). A press on any
 * other segment is left to its own click.
 */
export function useSegmentIndicator(
  value: string,
  chosen = '[role="radio"][aria-checked="true"]',
  onPick?: (value: string) => void,
): {
  trackRef: RefObject<HTMLDivElement | null>
  indicator: ReactNode
  slideItemClass: string
  trackProps: Partial<SegmentDragHandlers>
} {
  const trackRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<IndicatorBox | null>(null)
  // While dragging: the box under the pointer, and whether the fill is pressed.
  const [dragBox, setDragBox] = useState<IndicatorBox | null>(null)
  const [pressed, setPressed] = useState(false)
  const drag = useRef<{ over: string | null } | null>(null)
  const onPickRef = useRef(onPick)
  useLayoutEffect(() => {
    onPickRef.current = onPick
  })
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const measure = () => {
      const segment = track.querySelector<HTMLElement>(chosen)
      const next = segment && segment.offsetWidth > 0 ? boxOf(segment) : null
      setBox((current) => (
        current?.x === next?.x && current?.y === next?.y && current?.w === next?.w && current?.h === next?.h ? current : next
      ))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(track)
    return () => observer.disconnect()
  }, [value, chosen])

  /** The enabled segment under the pointer, or the nearest one across. */
  const segmentAt = useCallback((event: PointerEvent<HTMLDivElement>): HTMLElement | null => {
    const track = trackRef.current
    if (!track) return null
    const rect = track.getBoundingClientRect()
    const x = event.clientX - rect.left + track.scrollLeft
    const y = event.clientY - rect.top + track.scrollTop
    const segments = Array.from(track.querySelectorAll<HTMLElement>('[data-segment-value]'))
      .filter((segment) => !(segment as HTMLButtonElement).disabled && segment.offsetWidth > 0)
    const inside = segments.find((segment) => (
      x >= segment.offsetLeft && x < segment.offsetLeft + segment.offsetWidth
      && y >= segment.offsetTop && y < segment.offsetTop + segment.offsetHeight
    ))
    if (inside) return inside
    // Between segments or past the ends: the nearest one by horizontal distance.
    let nearest: HTMLElement | null = null
    let best = Infinity
    for (const segment of segments) {
      const gap = Math.max(segment.offsetLeft - x, x - (segment.offsetLeft + segment.offsetWidth), 0)
      if (gap < best) {
        best = gap
        nearest = segment
      }
    }
    return nearest
  }, [])

  const endDrag = useCallback(() => {
    drag.current = null
    setPressed(false)
    setDragBox(null)
  }, [])

  const trackProps: Partial<SegmentDragHandlers> = onPick
    ? {
        onPointerDown: (event) => {
          if (event.button !== 0) return
          const track = trackRef.current
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-segment-value]') : null
          const current = track?.querySelector<HTMLElement>(chosen)
          // Only the chosen segment's fill is picked up; others click as usual.
          if (!track || !target || target !== current || (target as HTMLButtonElement).disabled) return
          drag.current = { over: target.dataset.segmentValue ?? null }
          try {
            track.setPointerCapture?.(event.pointerId)
          } catch {
            // A synthetic or already-gone pointer: the press still works without capture.
          }
          setPressed(true)
        },
        onPointerMove: (event) => {
          if (!drag.current) return
          const segment = segmentAt(event)
          const over = segment?.dataset.segmentValue ?? null
          if (!segment || over === drag.current.over) return
          drag.current.over = over
          setDragBox(boxOf(segment))
        },
        onPointerUp: (event) => {
          if (!drag.current) return
          const segment = segmentAt(event)
          const over = segment?.dataset.segmentValue ?? drag.current.over
          endDrag()
          if (over != null && over !== value) onPickRef.current?.(over)
        },
        onPointerCancel: endDrag,
        // A press ends with its click or by losing the pointer, so the fill
        // lets go even when a pointerup never reached the track.
        onLostPointerCapture: endDrag,
        onClick: endDrag,
      }
    : {}

  const shown = dragBox ?? box
  const indicator = shown ? (
    // A 1px box scaled to the segment's width and height: it moves by
    // transform alone, and has no corners for the scale to distort (the
    // track clips the ends). The inner fill takes the press dip, so it
    // shrinks in both axes about its own centre.
    <span
      aria-hidden="true"
      data-segment-indicator=""
      data-pressed={pressed || undefined}
      className="pointer-events-none absolute top-0 left-0 h-px w-px origin-top-left transition-[translate,scale] duration-(--motion-base) ease-(--ease-out)"
      style={{ translate: `${shown.x}px ${shown.y}px`, scale: `${shown.w} ${shown.h}` }}
    >
      <span
        className="block size-full bg-(--color-fill-selected) transition-[scale] duration-(--motion-fast) ease-(--ease-out)"
        style={{ scale: pressed ? 0.92 : 1 }}
      />
    </span>
  ) : null
  // Above the fill, the words cross to the inverted tone at its pace rather
  // than ahead of it.
  const slideItemClass = cn('relative duration-(--motion-fast)', box && 'bg-transparent')
  return { trackRef, indicator, slideItemClass, trackProps }
}

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
  const pick = (next: string) => {
    const option = options.find((candidate) => candidate.value === next)
    if (!option || option.disabled || disabled || next === value) return
    selectionHapticFeedback()
    onChange(option.value)
  }
  const { trackRef, indicator, slideItemClass, trackProps } = useSegmentIndicator(value, undefined, pick)

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
    if (target.value !== value) {
      selectionHapticFeedback()
      onChange(target.value)
    }
  }

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-slot="segmented-control"
      // ``touch-pan-y``: a horizontal swipe drags the fill instead of scrolling the track.
      className={cn(segmentedTrackClass({ size, fill }), 'touch-pan-y', className)}
      {...trackProps}
    >
      {indicator}
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
              if (active) return
              selectionHapticFeedback()
              onChange(option.value)
            }}
            onKeyDown={(event) => handleKeyDown(event, option.value)}
            className={cn(
              segmentedItemClass({ active, size, fill, iconOnly: option.label == null }),
              slideItemClass,
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
