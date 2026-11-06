/**
 * SwipeRow — an iOS list row that reveals trailing actions (Pin, Hide…)
 * when the finger drags it left.
 *
 * The row is one number, ``x`` (0 = shut, ``-actionsWidth`` = open). The
 * finger writes it on every pointermove straight to the DOM through a
 * ``SpringValue`` (``translate`` on the content, a ``clip-path`` on the
 * actions), so a list of rows never re-renders per frame. Only ``open`` is
 * React state, because it changes what assistive tech may reach.
 *
 * Why pointer events and ``touch-action: pan-y``: the row tells the browser
 * it may only pan vertically. A vertical drag is then the browser's (the list
 * scrolls and we get ``pointercancel``); a horizontal one is ours and keeps
 * delivering ``pointermove``. That needs no non-passive listener and no
 * ``preventDefault`` race with a scroll that already began.
 *
 * The gesture locks like ``useEdgeSwipe``: nothing happens until 8px of
 * travel, and then only a clearly horizontal drag (|dx| > 1.5·|dy|) takes
 * over; a thumb scrolling the list arcs sideways, and a laxer rule made rows
 * jitter open mid-scroll. The row follows the finger from where it was
 * grabbed (so a drag started on an open row closes it), less the slop, so it
 * never jumps at the moment of locking.
 *
 * The actions sit *behind* the content and are revealed by clipping, not by
 * painting the content opaque: a row's own background (selected, pressed)
 * keeps working on any surface, and the actions never show through it. They
 * read left to right in array order, so the last one is at the edge and is
 * the first to appear (put the weightier action last, as iOS does).
 *
 * The revealed buttons are for sighted touch users. While shut they are
 * ``aria-hidden`` and out of the tab order; keyboard and screen-reader users
 * reach the same actions through the row's own menu.
 */
import type { LucideIcon } from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import { useReducedMotion } from '@/hooks/useReducedMotion'
import { SpringValue } from '@/lib/drawer-motion'
import { selectionHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'

export type SwipeActionTone = 'neutral' | 'accent' | 'destructive'

export interface SwipeAction {
  id: string
  /** Shown under the icon, and the button's accessible name when revealed. */
  label: string
  icon: LucideIcon
  tone: SwipeActionTone
  onAction: () => void
}

export interface SwipeRowProps {
  /** Trailing actions, left to right; the last sits at the edge. */
  actions: SwipeAction[]
  /** No swipe at all, and a revealed row shuts (a sheet is open over the list). */
  disabled?: boolean
  /** The row itself. Its own clicks still work while the row is shut. */
  children: ReactNode
  className?: string
}

/** Each revealed action: 72px wide, the row's full height. */
const ACTION_WIDTH = 72
/** px of travel before the gesture decides what it is. */
const SLOP = 8
/** Horizontal travel must exceed vertical by this factor (see ``useEdgeSwipe``). */
const HORIZONTAL_DOMINANCE = 1.5
/** px/ms: a flick at this speed decides the release whatever the distance. */
const FLING_VELOCITY = 0.5
/** Past the actions' full width the row only follows the finger this far. */
const RUBBER_BAND = 0.3
/** A finger that rested this long before lifting has no release speed to carry. */
const VELOCITY_STALE_MS = 80

/**
 * Fills, not borders. Accent and destructive are written as separate class
 * strings (as ``ui/button.tsx`` does): this is a primary action's fill, not
 * a chosen segment, so the design lint's selection-fill rule is not about it.
 */
const TONE: Record<SwipeActionTone, string> = {
  neutral: 'bg-(--bg-key) text-(--color-text) active:bg-(--color-fill-key-hover)',
  accent: ['bg-(--color-accent)', 'text-(--color-text-on-accent)', 'active:bg-(--color-accent)/80'].join(' '),
  destructive: ['bg-(--color-error)', 'text-(--color-text-on-accent)', 'active:bg-(--color-error)/80'].join(' '),
}

/** Whichever row is open right now. Opening another one shuts it. */
interface OpenRow {
  close: () => void
}
let openRow: OpenRow | null = null

/** Tests: forget the open row so one test's state never leaks into the next. */
export function _resetSwipeRowsForTests(): void {
  openRow = null
}

interface Track {
  pointerId: number
  startX: number
  startY: number
  /** True once the gesture has taken over from the list's scroll. */
  locked: boolean
  /** Finger x that maps to ``base``: where the row was grabbed, less the slop. */
  originX: number
  /** Where the row was when the gesture locked (0, or minus the actions' width). */
  base: number
  lastX: number
  lastT: number
  /** px/ms, EMA-smoothed; negative is leftward. */
  velocity: number
  /** Whether the row is currently past the point where release would open it. */
  pastHalf: boolean
}

/** The row's position for a finger travel of ``p``: no right overshoot, a band on the left. */
function resist(p: number, width: number): number {
  if (p > 0) return 0
  return p < -width ? -width + (p + width) * RUBBER_BAND : p
}

/** Release decision: a flick decides on speed alone, otherwise on distance. */
function shouldOpen(position: number, velocity: number, width: number): boolean {
  if (velocity <= -FLING_VELOCITY) return true
  if (velocity >= FLING_VELOCITY) return false
  return position <= -width / 2
}

/**
 * Write the row's position: translate the content, and uncover that much of
 * the actions. Past the actions' full width (the rubber band) they stretch to
 * fill the gap, as iOS's do, instead of leaving a hole.
 */
function paint(content: HTMLElement | null, actions: HTMLElement | null, width: number, x: number): void {
  if (content) content.style.translate = x === 0 ? '' : `${x}px 0`
  if (!actions) return
  const reveal = Math.max(0, -x)
  const span = Math.max(width, reveal)
  actions.style.width = `${span}px`
  actions.style.clipPath = `inset(0 0 0 ${reveal === 0 ? '100%' : `${span - reveal}px`})`
}

export function SwipeRow({ actions, disabled = false, children, className }: SwipeRowProps) {
  const reduced = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<Track | null>(null)
  const openRef = useRef(false)
  const [open, setOpen] = useState(false)

  const width = actions.length * ACTION_WIDTH
  // Read by the spring's write callback and the handlers, which outlive a render.
  const widthRef = useRef(width)
  const disabledRef = useRef(disabled)
  widthRef.current = width
  disabledRef.current = disabled

  const [spring] = useState(
    () => new SpringValue((x) => paint(contentRef.current, actionsRef.current, widthRef.current, x), { max: 0 }),
  )
  useEffect(() => {
    spring.reduced = reduced === true
  }, [spring, reduced])

  // The registry holds a stable handle whose ``close`` reaches this render's ``rest``.
  const restRef = useRef<(next: boolean, velocity?: number) => void>(() => {})
  const [self] = useState<OpenRow>(() => ({ close: () => restRef.current(false) }))

  /** Send the row to rest, open or shut, carrying ``velocity`` (px/ms, leftward negative). */
  function rest(next: boolean, velocity = 0): void {
    if (next) {
      if (openRow && openRow !== self) openRow.close()
      openRow = self
    } else if (openRow === self) {
      openRow = null
    }
    openRef.current = next
    setOpen(next)
    spring.settle(next ? -widthRef.current : 0, velocity * 1000)
  }
  restRef.current = rest

  // A new number of actions changes the open position; paint the rest state afresh.
  useLayoutEffect(() => {
    if (!trackRef.current?.locked) spring.set(openRef.current ? -width : 0)
  }, [spring, width])

  // A sheet opened over the list: no swipe, and nothing left revealed.
  useEffect(() => {
    if (!disabled) return
    trackRef.current = null
    self.close()
  }, [disabled, self])

  useEffect(() => () => {
    spring.cancel()
    if (openRow === self) openRow = null
  }, [spring, self])

  // The list moved under a revealed row: shut it, as iOS does. ``scroll`` does not
  // bubble, so listen in the capture phase and keep only scrollers that hold the row.
  useEffect(() => {
    if (!open) return
    const onScroll = (event: Event) => {
      const root = rootRef.current
      if (root && event.target instanceof Node && event.target.contains(root)) self.close()
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', onScroll, true)
  }, [open, self])

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'touch') return
    // A second finger turns a swipe into something else: let go of the first.
    if (trackRef.current && trackRef.current.pointerId !== event.pointerId) {
      endTrack(false)
      return
    }
    if (disabledRef.current || widthRef.current === 0) return
    trackRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      locked: false,
      originX: event.clientX,
      base: 0,
      lastX: event.clientX,
      lastT: event.timeStamp || performance.now(),
      velocity: 0,
      pastHalf: false,
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const track = trackRef.current
    if (!track || event.pointerId !== track.pointerId) return
    const width = widthRef.current
    const dx = event.clientX - track.startX
    const dy = event.clientY - track.startY

    // Decide the axis once, on the first move past the slop. Anything that is
    // not clearly horizontal belongs to the list's scroll.
    if (!track.locked) {
      const absX = Math.abs(dx)
      const absY = Math.abs(dy)
      if (Math.max(absX, absY) < SLOP) return
      // A shut row has nothing to reveal to the right: leave that to the app's other gestures.
      if (absX <= absY * HORIZONTAL_DOMINANCE || (dx > 0 && spring.value >= 0)) {
        trackRef.current = null
        return
      }
      track.locked = true
      // Catch a row that is still springing exactly where it is.
      track.base = spring.value
      track.originX = track.startX + Math.sign(dx) * SLOP
      track.pastHalf = track.base <= -width / 2
      // One row at a time: grabbing this one puts any other away.
      if (openRow && openRow !== self) openRow.close()
    }

    const position = resist(track.base + (event.clientX - track.originX), width)
    const now = event.timeStamp || performance.now()
    const dt = now - track.lastT
    if (dt >= 4) {
      track.velocity = track.velocity * 0.7 + ((event.clientX - track.lastX) / dt) * 0.3
      track.lastX = event.clientX
      track.lastT = now
    }
    spring.set(position)

    const past = position <= -width / 2
    if (past !== track.pastHalf) {
      track.pastHalf = past
      selectionHapticFeedback()
    }
  }

  /** The gesture is over: ``commit`` carries the finger's release to a rest place, otherwise the row returns to where it began. */
  function endTrack(commit: boolean, now = performance.now()) {
    const track = trackRef.current
    trackRef.current = null
    if (!track?.locked) return
    if (!commit) {
      rest(openRef.current)
      return
    }
    const velocity = now - track.lastT <= VELOCITY_STALE_MS ? track.velocity : 0
    rest(shouldOpen(spring.value, velocity, widthRef.current), velocity)
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerId !== trackRef.current?.pointerId) return
    endTrack(true, event.timeStamp || performance.now())
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerId !== trackRef.current?.pointerId) return
    endTrack(false)
  }

  // A tap on an open row's content shuts it and goes no further: the row's own
  // click (open the session) must not fire. The revealed actions are not content.
  function onClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    if (!openRef.current) return
    if (event.target instanceof Node && actionsRef.current?.contains(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    rest(false)
  }

  return (
    <div
      ref={rootRef}
      data-swipe-row=""
      // The app's left-edge swipe skips this row: its own drag owns the gesture.
      data-swipe-ignore=""
      className={cn('relative touch-pan-y overflow-hidden', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={onClickCapture}
    >
      <div
        ref={actionsRef}
        // Behind the content, clipped to what the content has uncovered. Inert
        // while shut so a tap on the row's right edge can never land on one.
        className={cn('absolute inset-y-0 right-0 flex overflow-hidden rounded-r-sm', !open && 'pointer-events-none')}
      >
        {actions.map(({ id, label, tone, onAction }) => (
          <button
            key={id}
            type="button"
            aria-hidden={open ? undefined : true}
            tabIndex={open ? undefined : -1}
            onClick={() => {
              onAction()
              rest(false)
            }}
            className={cn(
              'flex h-full min-w-0 flex-1 items-center justify-center px-1 text-xs font-medium select-none transition-opacity duration-(--motion-instant) active:opacity-70',
              'focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:outline-none focus-visible:ring-inset',
              TONE[tone],
            )}
          >
            {/* Flush, full-height segments with a word, as Mail's swipe:
                a glyph alone read as floating dots on a 36-40px row. */}
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>
      <div ref={contentRef} data-swipe-row-content="" className="relative">
        {children}
      </div>
    </div>
  )
}
