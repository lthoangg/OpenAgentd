/**
 * PullToRefresh — iOS's pull-down-to-refresh for a scroll container.
 *
 * The pull is one number, ``p`` px (0 = at rest). The finger writes it on
 * every touchmove straight to the DOM through a ``SpringValue`` (``translate``
 * on the content, ``translate``/``opacity``/``rotate`` on the indicator), so a
 * long list never re-renders per frame. Only ``refreshing`` is React state,
 * because it mounts the status that assistive tech reads.
 *
 * Why native touch listeners, not React's: React registers ``touchmove`` as
 * passive, and a passive listener cannot stop the browser's own overscroll
 * bounce, which would fight our translate. The ``touchmove`` listener is
 * non-passive and calls ``preventDefault`` only while a pull is under way, so
 * an ordinary scroll (and a scroll that has begun to move) is never blocked.
 *
 * A pull starts only when the list is at the very top (``scrollTop <= 0``) and
 * the finger moves clearly *down*: the decision is made once, at the first
 * move past the slop, like ``useEdgeSwipe`` locks an axis. Anything else (up,
 * sideways, a list already scrolled) is the list's. The row at the top of a
 * scrolled list never turns into a pull half way through a scroll.
 *
 * Release past the threshold holds the content at 44px while the spinner
 * turns, until ``onRefresh`` settles *and* 400ms have passed: a refresh that
 * returns at once would otherwise flash the spinner for a frame, which reads
 * as nothing happening. Then the spring carries it back to 0. A rejected
 * refresh still stops the spinner (reporting the error is the caller's job).
 */
import { Loader2 } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from 'react'

import { useReducedMotion } from '@/hooks/useReducedMotion'
import { SpringValue } from '@/lib/drawer-motion'
import { selectionHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'

export interface PullToRefreshProps extends Omit<ComponentPropsWithRef<'div'>, 'children'> {
  /** Reload the list. The spinner turns until it settles, however it settles. */
  onRefresh: () => Promise<unknown>
  children: ReactNode
  /** No pull at all (a sheet is open over the list). A refresh under way finishes. */
  disabled?: boolean
}

/** The finger moves this much for each px the content follows. */
const RESISTANCE = 0.5
/** px of pull (not of finger travel) that commits a refresh on release. */
const THRESHOLD = 64
/** px the content rests at while refreshing: the indicator's own height. */
const HOLD = 44
/** A refresh shows its spinner at least this long, so a fast one is still seen. */
const MIN_REFRESH_MS = 400
/** px of travel before the gesture decides what it is (see ``useEdgeSwipe``). */
const SLOP = 8
/** The spinner makes three quarters of a turn by the time the pull commits. */
const TURN_DEG = 270

interface Gesture {
  startX: number
  startY: number
  /** True once the pull has taken over from the list's scroll. */
  engaged: boolean
  /** Finger y that maps to ``base``: where it was grabbed, less the slop. */
  originY: number
  /** Where the content was when the pull engaged (a spring-back still in flight). */
  base: number
  /** Whether the pull is currently past the point where release would refresh. */
  past: boolean
}

/**
 * Write the pull. The indicator is 44px tall and centres in the gap the
 * content has opened (``p / 2``), fading in as the gap grows; the spinner
 * turns with it, so the pull itself reads as winding it up.
 */
function paint(content: HTMLElement | null, indicator: HTMLElement | null, spinner: HTMLElement | null, p: number): void {
  if (content) content.style.translate = p === 0 ? '' : `0 ${p}px`
  if (indicator) {
    indicator.style.translate = `0 ${p / 2 - HOLD / 2}px`
    indicator.style.opacity = String(Math.min(1, p / HOLD))
  }
  if (spinner) spinner.style.rotate = `${(p / THRESHOLD) * TURN_DEG}deg`
}

export function PullToRefresh({ onRefresh, children, disabled = false, className, ref, ...props }: PullToRefreshProps) {
  const reduced = useReducedMotion()
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useRef<HTMLDivElement>(null)
  const spinnerRef = useRef<HTMLSpanElement>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Read by the touch listeners, which outlive a render.
  const refreshingRef = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  const disabledRef = useRef(disabled)
  const mountedRef = useRef(false)
  onRefreshRef.current = onRefresh
  disabledRef.current = disabled

  const [spring] = useState(
    () =>
      new SpringValue((p) => paint(contentRef.current, indicatorRef.current, spinnerRef.current, p), {
        min: 0,
        // Pixels, not progress units: settle a visible fraction of a px early.
        restDistance: 0.25,
        restSpeed: 5,
      }),
  )
  useEffect(() => {
    spring.reduced = reduced === true
  }, [spring, reduced])

  // The caller's ref and ours both point at the scroll container.
  const setScroller = useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef.current = node
      if (typeof ref === 'function') return ref(node)
      if (ref) ref.current = node
    },
    [ref],
  )

  // Paint the rest state before the first frame: the indicator starts hidden.
  useLayoutEffect(() => {
    spring.set(0)
  }, [spring])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    mountedRef.current = true
    let gesture: Gesture | null = null

    /** The gesture ended without a refresh (or was torn up): the content returns to rest. */
    const abandon = () => {
      const was = gesture
      gesture = null
      if (was?.engaged) spring.settle(0)
    }

    const startRefresh = () => {
      refreshingRef.current = true
      setRefreshing(true)
      spring.settle(HOLD)
      // An executor so a synchronous throw is a rejection like any other.
      const refresh = new Promise<unknown>((resolve) => resolve(onRefreshRef.current()))
      const minimum = new Promise<void>((resolve) => setTimeout(resolve, MIN_REFRESH_MS))
      void Promise.allSettled([refresh, minimum]).then(() => {
        refreshingRef.current = false
        if (!mountedRef.current) return
        setRefreshing(false)
        spring.settle(0)
      })
    }

    const onTouchStart = (event: TouchEvent) => {
      // A second finger landing mid-pull is a pinch or a two-finger pan: let go.
      abandon()
      if (disabledRef.current || refreshingRef.current) return
      const touch = event.touches[0]
      if (event.touches.length !== 1 || !touch) return
      if (scroller.scrollTop > 0) return
      gesture = { startX: touch.clientX, startY: touch.clientY, engaged: false, originY: 0, base: 0, past: false }
    }

    const onTouchMove = (event: TouchEvent) => {
      const g = gesture
      if (!g) return
      const touch = event.touches[0]
      if (event.touches.length !== 1 || !touch || disabledRef.current) {
        abandon()
        return
      }
      const dx = touch.clientX - g.startX
      const dy = touch.clientY - g.startY

      // Decide once, on the first move past the slop. Only a clearly downward
      // drag from the very top is a pull; the rest belongs to the list.
      if (!g.engaged) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP) return
        if (dy <= 0 || Math.abs(dx) > dy || scroller.scrollTop > 0) {
          gesture = null
          return
        }
        g.engaged = true
        // Catch a spring-back still in flight exactly where it is.
        g.base = spring.value
        g.originY = g.startY + SLOP
      }

      const pull = Math.max(0, g.base + (touch.clientY - g.originY) * RESISTANCE)
      // Only a pull that has moved the content holds the page still; the finger
      // heading back up past where it began is the list's scroll again.
      if (pull > 0 && event.cancelable) event.preventDefault()
      spring.set(pull)

      const past = pull >= THRESHOLD
      if (past !== g.past) {
        g.past = past
        selectionHapticFeedback()
      }
    }

    const onTouchEnd = () => {
      const g = gesture
      gesture = null
      if (!g?.engaged) return
      if (spring.value >= THRESHOLD) startRefresh()
      else spring.settle(0)
    }

    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: false })
    scroller.addEventListener('touchend', onTouchEnd, { passive: true })
    scroller.addEventListener('touchcancel', abandon, { passive: true })
    return () => {
      mountedRef.current = false
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('touchend', onTouchEnd)
      scroller.removeEventListener('touchcancel', abandon)
      spring.cancel()
    }
  }, [spring])

  return (
    <div
      {...props}
      ref={setScroller}
      data-pull-to-refresh=""
      className={cn('relative overflow-y-auto overscroll-contain', className)}
    >
      {/* Above the content: it moves down with the pull and uncovers the indicator. */}
      <div
        ref={indicatorRef}
        className="pointer-events-none absolute inset-x-0 top-0 flex h-11 items-center justify-center text-(--color-text-muted)"
      >
        <span
          ref={spinnerRef}
          // Named only while it is a status: during the pull it is decoration.
          role={refreshing ? 'status' : undefined}
          aria-label={refreshing ? 'Refreshing' : undefined}
          className="flex"
        >
          <Loader2
            size={16}
            aria-hidden="true"
            className={cn('shrink-0', refreshing && 'animate-spin motion-reduce:animate-none')}
          />
        </span>
      </div>
      <div ref={contentRef} data-pull-to-refresh-content="" className="relative min-h-full">
        {children}
      </div>
    </div>
  )
}
