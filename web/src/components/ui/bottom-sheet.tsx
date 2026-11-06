/**
 * BottomSheet — the phone form of a popover: slides up from the bottom edge,
 * drags down (or Escape, or a tap on the backdrop) to close.
 *
 * Used where a desktop popover would sit too small under a finger: the run
 * picker and the composer's "+" menu. Like the native sheets on iOS and
 * Android it has a grab handle, clears the home indicator, and stops short
 * of the status bar so the page behind it stays in view.
 *
 * Detents (``detents``, as on iOS): the heights the sheet rests at. ``medium``
 * is half the screen, ``large`` (the default, and the tallest) 92% of it. A
 * sheet never rests taller than its content, so one whose content is shorter
 * than medium simply fits it, with nothing to drag between. A drag on the
 * handle or the content (once nothing in it is scrolled) moves between the
 * detents, and a flick moves one step. Scrolling up in a sheet resting below
 * its tallest detent first expands it, then scrolls. Pulled below the lowest
 * detent past ``SHEET_CLOSE_DISTANCE`` (the same distance as the full-screen
 * sheet of ``AppOverlay``), or flicked down from it, the sheet closes.
 *
 * As on iOS, it drags from anywhere, not only the handle: a pull down on the
 * content closes it once there is nothing above to scroll back to (the
 * content, and any list the finger is on, sit at their top).
 *
 * Two ``SpringValue``s (``lib/drawer-motion``) drive every drag, the handle's
 * and the content's. ``h`` is the sheet's height, between its lowest and
 * tallest detent (it is only written for a sheet with more than one detent;
 * any other sizes itself). ``y`` is how far the sheet is pulled below its
 * lowest detent, written to its ``translate`` and, as the sheet leaves, to its
 * scrim: the scrim is as clear as the sheet is far down (full at rest, gone
 * 300px lower). A release that closes hands the finger's speed to the exit
 * spring; one that stays springs to its detent with it, never above the
 * tallest.
 *
 * Reduced motion: no drag. The sheet opens at its tallest detent, where all of
 * its content is reachable by scrolling.
 *
 * It renders into document.body: the composer is a size container, and
 * older WebKit and Chromium (Android 15's Chrome 124 among them) place a
 * fixed child inside such a container, so the sheet and its backdrop sat
 * in the composer instead of over the page.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, type TargetAndTransition } from 'framer-motion'

import { resolveRelease, sheetStops, type SheetDetent, type SheetStop } from '@/components/ui/_sheet'
import { useModalFocus } from '@/hooks/useModalFocus'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { softHapticFeedback } from '@/lib/haptics'
import { DRAWER_SPRING, SpringValue } from '@/lib/drawer-motion'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { cn } from '@/lib/utils'

/** The sheet follows a pull past its lowest detent at this share of the finger. */
const PULL_ELASTIC = 0.6
/** Movement under this is still a tap, not a pull. */
const PULL_SLOP_PX = 6
/** The scrim clears over this much downward travel (px). */
const SCRIM_FADE_PX = 300
/** A finger that rested this long before lifting has no release speed to carry. */
const VELOCITY_STALE_MS = 80
/** The plain slide: enter, and any exit that is not a release. */
const SLIDE = { duration: DURATIONS_S.base, ease: EASINGS.sheet } as const
const DEFAULT_DETENTS: SheetDetent[] = ['large']

export interface BottomSheetProps {
  open: boolean
  onClose: () => void
  /** Accessible name of the sheet. */
  label: string
  children: ReactNode
  /**
   * Element focused as the sheet opens. Defaults to the sheet itself: like a
   * native sheet it opens without raising the on-screen keyboard, which a
   * focused search field would do, covering the list.
   */
  initialFocus?: RefObject<HTMLElement | null>
  className?: string
  /**
   * Heights the sheet rests at, ``medium`` (half the screen) and ``large``
   * (92%). Default: ``['large']``, one height, up to the largest and no
   * further than the content.
   */
  detents?: SheetDetent[]
  /** The detent it opens at. Default: the lowest. */
  initialDetent?: SheetDetent
}

/** The sheet's resting places, measured from its content. */
interface SheetLayout {
  stops: SheetStop[]
  /** The stop it rests at. */
  index: number
  /** More than one stop: ``h`` is the sheet's height. Otherwise the content sizes it. */
  sized: boolean
  /** Measured since it opened: a content change then keeps its stop. */
  ready: boolean
}

export function BottomSheet({ open, onClose, label, children, initialFocus, className, detents = DEFAULT_DETENTS, initialDetent }: BottomSheetProps) {
  const reduced = useReducedMotion()
  const sheetRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  /** Where it rests, for ``data-detent``: a detent's name, or ``fit`` when the content sizes it. */
  const [detent, setDetent] = useState<SheetDetent | 'fit'>('fit')
  useModalFocus(open, onClose, initialFocus ?? sheetRef, { kind: 'overlay' })
  const layout = useRef<SheetLayout>({ stops: [], index: 0, sized: false, ready: false })
  const dragging = useRef(false)
  const latest = useRef({ detents, initialDetent, reduced, onClose })
  useLayoutEffect(() => {
    latest.current = { detents, initialDetent, reduced, onClose }
  })
  // How far the sheet is pulled below its lowest detent: by the finger, sprung on release.
  const y = useMemo(() => new SpringValue((value) => {
    const sheet = sheetRef.current
    if (sheet) sheet.style.translate = value > 0 ? `0 ${value}px` : ''
    const scrim = scrimRef.current
    if (scrim) scrim.style.opacity = value > 0 ? String(Math.max(0, 1 - value / SCRIM_FADE_PX)) : ''
  }, { min: 0, restDistance: 0.5, restSpeed: 5 }), [])
  // The sheet's height (px) between its detents; the content's own when there is one.
  const h = useMemo(() => new SpringValue((value) => {
    const sheet = sheetRef.current
    if (sheet && layout.current.sized) sheet.style.height = `${value}px`
  }, { restDistance: 0.5, restSpeed: 5 }), [])
  useEffect(() => () => {
    y.cancel()
    h.cancel()
  }, [y, h])
  // The exit that follows a release that closes: from where the finger left
  // the sheet, carrying its speed. Any other close (Escape, the backdrop) runs
  // the plain slide; both are the same object so a release can set the spring
  // in the render the sheet is leaving in.
  const exitMotion = useRef<TargetAndTransition>({ y: '100%', transition: SLIDE })
  useEffect(() => {
    if (!open) return
    y.set(0)
    exitMotion.current.y = '100%'
    exitMotion.current.transition = SLIDE
  }, [open, y])

  /**
   * Reads the content's height and settles where the sheet rests: the stops
   * it can reach, and the one it is at (the opening detent, or the one it was
   * at when the content changed under it).
   */
  const measure = useCallback(() => {
    const sheet = sheetRef.current
    const content = contentRef.current
    if (!sheet || !content) return
    const { detents: asked, initialDetent: opening, reduced: noMotion } = latest.current
    const style = getComputedStyle(sheet)
    // The sheet's own height around its content: handle, home-indicator padding, hairline.
    const chrome = (handleRef.current?.offsetHeight ?? 0) + (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderTopWidth) || 0)
    const natural = content.offsetHeight > 0 ? chrome + content.offsetHeight : 0
    const stops = sheetStops(window.innerHeight, natural, asked.length > 0 ? asked : DEFAULT_DETENTS)
    const before = layout.current
    let index: number
    if (before.ready) {
      const found = stops.findIndex((stop) => stop.name === before.stops[before.index]?.name)
      index = found >= 0 ? found : Math.min(before.index, stops.length - 1)
    } else if (noMotion) {
      // Nothing to drag it taller with: open where the content is all reachable.
      index = stops.length - 1
    } else {
      const wanted = stops.findIndex((stop) => stop.name === (opening ?? stops[0]?.name))
      index = wanted >= 0 ? wanted : opening === 'large' ? stops.length - 1 : 0
    }
    const sized = stops.length > 1
    layout.current = { stops, index, sized, ready: true }
    setDetent(sized ? stops[index].name : 'fit')
    if (!sized) {
      sheet.style.height = ''
      h.set(stops[0]?.px ?? 0)
    } else if (!dragging.current && !h.isSettlingTo(stops[index].px)) {
      h.set(stops[index].px)
    }
  }, [h])
  // After every render while open (the content may have changed), and when it
  // resizes by itself (a list filtering) or the window does.
  useLayoutEffect(() => {
    if (!open) {
      layout.current.ready = false
      return
    }
    measure()
  })
  useEffect(() => {
    if (!open) return
    const content = contentRef.current
    const observer = content && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null
    if (content) observer?.observe(content)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open, measure])

  const drag = useMemo(() => {
    /** The sheet's height when the finger went down. */
    let base = 0
    const goTo = (index: number, velocity = 0) => {
      const state = layout.current
      const stop = state.stops[index]
      if (!stop) return
      state.index = index
      setDetent(state.sized ? stop.name : 'fit')
      h.settle(stop.px, -velocity)
    }
    const bounds = () => {
      const { stops } = layout.current
      return { low: stops[0]?.px ?? 0, high: stops[stops.length - 1]?.px ?? 0 }
    }
    return {
      /** A taller detent is there to reach. */
      canExpand: () => layout.current.sized && layout.current.index < layout.current.stops.length - 1,
      begin() {
        dragging.current = true
        y.cancel()
        h.cancel()
        base = h.value
      },
      /** The finger is ``dy`` px from where it went down (positive down). */
      move(dy: number) {
        const { low, high } = bounds()
        const wanted = base - dy
        if (wanted >= low) {
          h.set(Math.min(wanted, high))
          y.set(0)
        } else {
          h.set(low)
          y.set((low - wanted) * PULL_ELASTIC)
        }
      },
      /** A drag ends: close, or spring to a detent. */
      end(dy: number, velocity: number) {
        dragging.current = false
        const { low, high } = bounds()
        const wanted = base - dy
        const release = resolveRelease(layout.current.stops.map((stop) => stop.px), {
          height: Math.min(high, Math.max(low, wanted)),
          overshoot: Math.max(0, low - wanted),
          velocity,
        })
        if (release.kind === 'close') {
          const sheet = sheetRef.current
          // Mutated, not replaced: the exiting sheet keeps the props of its last render.
          exitMotion.current.y = sheet ? sheet.offsetHeight : '100%'
          exitMotion.current.transition = { type: 'spring', ...DRAWER_SPRING, velocity: Math.max(0, velocity) }
          softHapticFeedback()
          latest.current.onClose()
          return
        }
        goTo(release.index, velocity)
        y.settle(0, velocity)
      },
      /** A cancelled touch is not a decision: the sheet springs back to where it rests. */
      cancel() {
        dragging.current = false
        y.settle(0)
        goTo(layout.current.index)
      },
      /** Up one detent (scrolling a sheet that rests below its tallest). */
      expand() {
        goTo(layout.current.index + 1)
      },
    }
  }, [y, h])
  usePullToClose(bodyRef, drag, open && !reduced)
  const handleProps = useHandlePull(drag, open && !reduced)

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="sheet-backdrop"
            data-swipe-ignore
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATIONS_S.fast }}
            className="fixed inset-0 z-40"
            onClick={onClose}
            aria-hidden="true"
          >
            {/* The pull dims this layer; the outer one fades with the sheet's arrival and exit. */}
            <div ref={scrimRef} data-sheet-scrim="" className="h-full w-full bg-(--color-overlay)" />
          </motion.div>
          <motion.div
            key="sheet"
            ref={sheetRef}
            tabIndex={-1}
            data-swipe-ignore
            data-bottom-sheet=""
            data-detent={detent}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            data-modal-focus="true"
            initial={reduced ? { opacity: 0 } : { y: '100%' }}
            animate={reduced ? { opacity: 1 } : { y: 0 }}
            exit={reduced ? { opacity: 0 } : exitMotion.current}
            transition={{ duration: reduced ? 0.01 : DURATIONS_S.base, ease: EASINGS.sheet }}
            className={cn(
              'fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col overflow-hidden rounded-t-lg border-t border-(--color-border-subtle) bg-(--bg-page) pb-safe shadow-(--shadow-depth) outline-none',
              className,
            )}
          >
            <SheetHandle ref={handleRef} {...handleProps} />
            <div ref={bodyRef} data-sheet-body="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">
              <div ref={contentRef} data-sheet-content="">{children}</div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/** Tracks a finger's last two samples, for the release speed (px/s, positive down). */
function velocityTracker() {
  let last = { y: 0, t: 0 }
  let previous = { y: 0, t: 0 }
  return {
    reset(y: number) {
      last = previous = { y, t: performance.now() }
    },
    push(y: number) {
      previous = last
      last = { y, t: performance.now() }
    },
    /** Zero when the finger rested before it lifted: nothing to carry. */
    velocity(): number {
      const dt = last.t - previous.t
      if (dt <= 0 || performance.now() - last.t > VELOCITY_STALE_MS) return 0
      return ((last.y - previous.y) / dt) * 1000
    },
  }
}

/** What a drag does to the sheet; ``BottomSheet`` owns the springs behind it. */
interface SheetDrag {
  canExpand(): boolean
  begin(): void
  move(dy: number): void
  end(dy: number, velocity: number): void
  cancel(): void
  expand(): void
}

/**
 * A pull on the sheet's content moves the sheet: down to a lower detent, and
 * past the close distance (or on a flick) closes it; up, while a taller
 * detent is there, to that. Only when nothing between the finger and the sheet
 * is scrolled down: then the pull scrolls back up instead. Up in a sheet at
 * its tallest detent is the content's scroll.
 *
 * Touch events, not pointer events: once the browser takes a pan for
 * scrolling it cancels the pointer, so the rest of the pull would never be
 * heard. The listener is not passive, so the pull can keep the page from
 * scrolling. The wheel does the same step up for a pointer that scrolls.
 */
function usePullToClose(
  bodyRef: RefObject<HTMLDivElement | null>,
  drag: SheetDrag,
  enabled: boolean,
) {
  useEffect(() => {
    const body = bodyRef.current
    if (!enabled || !body) return
    // 'pending': not yet a pull or a scroll; 'pull' moves the sheet; 'pass' leaves the gesture to the page.
    let mode: 'pending' | 'pull' | 'pass' = 'pass'
    let startX = 0
    let startY = 0
    let lastY = 0
    const speed = velocityTracker()

    const scrolledAbove = (target: EventTarget | null) => {
      for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
        if (el.scrollTop > 0) return true
        if (el === body) break
      }
      return false
    }

    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (event.touches.length !== 1 || !touch) {
        mode = 'pass'
        return
      }
      mode = scrolledAbove(event.target) ? 'pass' : 'pending'
      startX = touch.clientX
      startY = lastY = touch.clientY
      speed.reset(touch.clientY)
    }

    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (mode === 'pass' || !touch) return
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (mode === 'pending') {
        // More sideways than vertical (a strip that scrolls across), or up with
        // no taller detent to reach: the page's.
        if (Math.abs(dx) > Math.abs(dy) || (dy < 0 && !drag.canExpand())) {
          mode = 'pass'
          return
        }
        // A pull at the top has nothing to scroll, so holding the page still
        // from the first move costs nothing and keeps the browser from taking it.
        event.preventDefault()
        if (Math.abs(dy) < PULL_SLOP_PX) return
        mode = 'pull'
        drag.begin()
      }
      event.preventDefault()
      lastY = touch.clientY
      speed.push(touch.clientY)
      drag.move(dy)
    }

    const onEnd = () => {
      if (mode !== 'pull') {
        mode = 'pass'
        return
      }
      mode = 'pass'
      drag.end(lastY - startY, speed.velocity())
    }

    // A cancelled touch is not a decision to close: the sheet springs home.
    const onCancel = () => {
      if (mode === 'pull') drag.cancel()
      mode = 'pass'
    }

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY <= 0 || !drag.canExpand()) return
      event.preventDefault()
      drag.expand()
    }

    body.addEventListener('touchstart', onStart, { passive: true })
    body.addEventListener('touchmove', onMove, { passive: false })
    body.addEventListener('touchend', onEnd)
    body.addEventListener('touchcancel', onCancel)
    body.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      body.removeEventListener('touchstart', onStart)
      body.removeEventListener('touchmove', onMove)
      body.removeEventListener('touchend', onEnd)
      body.removeEventListener('touchcancel', onCancel)
      body.removeEventListener('wheel', onWheel)
    }
  }, [bodyRef, drag, enabled])
}

/**
 * The grab handle's drag, on the same springs as the content's pull (pointer
 * events: the handle is ``touch-action: none``, so the browser never takes
 * the gesture for a scroll). Down follows the finger through the detents and
 * then at ``PULL_ELASTIC``; up goes as far as the tallest detent.
 */
function useHandlePull(drag: SheetDrag, enabled: boolean) {
  const current = useRef<{ id: number; startY: number; lastY: number; speed: ReturnType<typeof velocityTracker> } | null>(null)
  return {
    onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
      if (!enabled || !event.isPrimary) return
      event.currentTarget.setPointerCapture?.(event.pointerId)
      const speed = velocityTracker()
      speed.reset(event.clientY)
      drag.begin()
      current.current = { id: event.pointerId, startY: event.clientY, lastY: event.clientY, speed }
    },
    onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
      const now = current.current
      if (!now || now.id !== event.pointerId) return
      now.lastY = event.clientY
      now.speed.push(event.clientY)
      drag.move(event.clientY - now.startY)
    },
    onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
      const now = current.current
      if (!now || now.id !== event.pointerId) return
      current.current = null
      drag.end(now.lastY - now.startY, now.speed.velocity())
    },
    onPointerCancel(event: React.PointerEvent<HTMLDivElement>) {
      const now = current.current
      if (!now || now.id !== event.pointerId) return
      current.current = null
      drag.cancel()
    },
  }
}

/** The grab handle; dragging starts here so the list below still scrolls. */
function SheetHandle({ ref, ...props }: React.HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      {...props}
      ref={ref}
      className="flex h-6 shrink-0 cursor-grab items-center justify-center"
      data-sheet-handle=""
      aria-hidden="true"
      style={{ touchAction: 'none' }}
    >
      <span className="h-1 w-9 rounded-full bg-(--color-text-subtle)" />
    </div>
  )
}
