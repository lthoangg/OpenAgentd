/**
 * BottomSheet — the phone form of a popover: slides up from the bottom edge,
 * drags down (or Escape, or a tap on the backdrop) to close.
 *
 * Used where a desktop popover would sit too small under a finger: the run
 * picker and the composer's "+" menu. Like the native sheets on iOS and
 * Android it has a grab handle, clears the home indicator, and stops at
 * 85% of the visible height so the page behind it stays in view.
 *
 * As on iOS, it drags down from anywhere, not only the handle: a pull down
 * on the content closes it once there is nothing above to scroll back to
 * (the content, and any list the finger is on, sit at their top).
 *
 * One ``y`` drives every pull — the handle's and the content's. It is a
 * ``SpringValue`` (``lib/drawer-motion``) written to the sheet's ``translate``
 * and, as the sheet leaves, to its scrim: the scrim is as clear as the sheet
 * is far down (full at rest, gone 300px lower). A release that closes hands
 * the finger's speed to the exit spring; one that stays springs back with it,
 * never above its resting place.
 *
 * It renders into document.body: the composer is a size container, and
 * older WebKit and Chromium (Android 15's Chrome 124 among them) place a
 * fixed child inside such a container, so the sheet and its backdrop sat
 * in the composer instead of over the page.
 */
import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, type TargetAndTransition } from 'framer-motion'

import { useModalFocus } from '@/hooks/useModalFocus'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { softHapticFeedback } from '@/lib/haptics'
import { DRAWER_SPRING, SpringValue } from '@/lib/drawer-motion'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { cn } from '@/lib/utils'

/** A drag past this distance, or flicked faster than this, closes the sheet. */
const CLOSE_DISTANCE_PX = 80
const CLOSE_VELOCITY = 500
/** The sheet follows a pull past its resting place at this share of the finger. */
const PULL_ELASTIC = 0.6
/** Movement under this is still a tap, not a pull. */
const PULL_SLOP_PX = 6
/** The scrim clears over this much downward travel (px). */
const SCRIM_FADE_PX = 300
/** A finger that rested this long before lifting has no release speed to carry. */
const VELOCITY_STALE_MS = 80
/** The plain slide: enter, and any exit that is not a release. */
const SLIDE = { duration: DURATIONS_S.base, ease: EASINGS.sheet } as const

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
}

export function BottomSheet({ open, onClose, label, children, initialFocus, className }: BottomSheetProps) {
  const reduced = useReducedMotion()
  const sheetRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  useModalFocus(open, onClose, initialFocus ?? sheetRef, { kind: 'overlay' })
  // The one ``y``: pulled by the finger, sprung on release.
  const y = useMemo(() => new SpringValue((value) => {
    const sheet = sheetRef.current
    if (sheet) sheet.style.translate = value > 0 ? `0 ${value}px` : ''
    const scrim = scrimRef.current
    if (scrim) scrim.style.opacity = value > 0 ? String(Math.max(0, 1 - value / SCRIM_FADE_PX)) : ''
  }, { min: 0, restDistance: 0.5, restSpeed: 5 }), [])
  useEffect(() => () => y.cancel(), [y])
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

  /** A pull ends: close past the distance or on a flick, else spring back. */
  const finishPull = (offset: number, velocity: number) => {
    if (offset > CLOSE_DISTANCE_PX || velocity > CLOSE_VELOCITY) {
      const sheet = sheetRef.current
      // Mutated, not replaced: the exiting sheet keeps the props of its last render.
      exitMotion.current.y = sheet ? sheet.offsetHeight : '100%'
      exitMotion.current.transition = { type: 'spring', ...DRAWER_SPRING, velocity: Math.max(0, velocity) }
      softHapticFeedback()
      onClose()
    } else {
      y.settle(0, velocity)
    }
  }
  const finishPullRef = useRef(finishPull)
  useEffect(() => {
    finishPullRef.current = finishPull
  })
  const release = useRef((offset: number, velocity: number) => finishPullRef.current(offset, velocity)).current
  usePullToClose(sheetRef, bodyRef, y, open && !reduced, release)
  const handleProps = useHandlePull(y, open && !reduced, release)

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
            role="dialog"
            aria-modal="true"
            aria-label={label}
            data-modal-focus="true"
            initial={reduced ? { opacity: 0 } : { y: '100%' }}
            animate={reduced ? { opacity: 1 } : { y: 0 }}
            exit={reduced ? { opacity: 0 } : exitMotion.current}
            transition={{ duration: reduced ? 0.01 : DURATIONS_S.base, ease: EASINGS.sheet }}
            className={cn(
              'fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col overflow-hidden rounded-t-lg border-t border-(--color-border-subtle) bg-(--bg-page) pb-safe shadow-(--shadow-depth) outline-none',
              className,
            )}
          >
            <SheetHandle {...handleProps} />
            <div ref={bodyRef} data-sheet-body="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">{children}</div>
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

/**
 * A pull down on the sheet's content moves the sheet, and past the close
 * distance (or on a flick) closes it. Only when nothing between the finger
 * and the sheet is scrolled down: then the pull scrolls back up instead.
 *
 * Touch events, not pointer events: once the browser takes a pan for
 * scrolling it cancels the pointer, so the rest of the pull would never be
 * heard. The listener is not passive, so the pull can keep the page from
 * scrolling. The pull writes ``y`` (the sheet's CSS ``translate``, which adds
 * to the ``transform`` its enter and exit animate): a close slides on from
 * where the finger left it.
 */
function usePullToClose(
  sheetRef: RefObject<HTMLDivElement | null>,
  bodyRef: RefObject<HTMLDivElement | null>,
  y: SpringValue,
  enabled: boolean,
  onRelease: (offset: number, velocity: number) => void,
) {
  useEffect(() => {
    const sheet = sheetRef.current
    const body = bodyRef.current
    if (!enabled || !sheet || !body) return
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
        // Up, or more sideways than down (a strip that scrolls across): the page's.
        if (dy < 0 || Math.abs(dx) > Math.abs(dy)) {
          mode = 'pass'
          return
        }
        // A pull at the top has nothing to scroll, so holding the page still
        // from the first move costs nothing and keeps the browser from taking it.
        event.preventDefault()
        if (dy < PULL_SLOP_PX) return
        mode = 'pull'
      }
      event.preventDefault()
      lastY = touch.clientY
      speed.push(touch.clientY)
      y.set(Math.max(0, dy) * PULL_ELASTIC)
    }

    const onEnd = () => {
      if (mode !== 'pull') {
        mode = 'pass'
        return
      }
      mode = 'pass'
      onRelease(lastY - startY, speed.velocity())
    }

    // A cancelled touch is not a decision to close: the sheet springs home.
    const onCancel = () => {
      if (mode === 'pull') y.settle(0)
      mode = 'pass'
    }

    body.addEventListener('touchstart', onStart, { passive: true })
    body.addEventListener('touchmove', onMove, { passive: false })
    body.addEventListener('touchend', onEnd)
    body.addEventListener('touchcancel', onCancel)
    return () => {
      body.removeEventListener('touchstart', onStart)
      body.removeEventListener('touchmove', onMove)
      body.removeEventListener('touchend', onEnd)
      body.removeEventListener('touchcancel', onCancel)
    }
  }, [sheetRef, bodyRef, y, enabled, onRelease])
}

/**
 * The grab handle's drag, on the same ``y`` as the content's pull (pointer
 * events: the handle is ``touch-action: none``, so the browser never takes
 * the gesture for a scroll). Pulling up does nothing; down follows at
 * ``PULL_ELASTIC``.
 */
function useHandlePull(y: SpringValue, enabled: boolean, onRelease: (offset: number, velocity: number) => void) {
  const drag = useRef<{ id: number; startY: number; lastY: number; speed: ReturnType<typeof velocityTracker> } | null>(null)
  return {
    onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
      if (!enabled || !event.isPrimary) return
      event.currentTarget.setPointerCapture?.(event.pointerId)
      const speed = velocityTracker()
      speed.reset(event.clientY)
      drag.current = { id: event.pointerId, startY: event.clientY, lastY: event.clientY, speed }
    },
    onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
      const current = drag.current
      if (!current || current.id !== event.pointerId) return
      current.lastY = event.clientY
      current.speed.push(event.clientY)
      y.set(Math.max(0, event.clientY - current.startY) * PULL_ELASTIC)
    },
    onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
      const current = drag.current
      if (!current || current.id !== event.pointerId) return
      drag.current = null
      onRelease(current.lastY - current.startY, current.speed.velocity())
    },
    onPointerCancel(event: React.PointerEvent<HTMLDivElement>) {
      const current = drag.current
      if (!current || current.id !== event.pointerId) return
      drag.current = null
      y.settle(0)
    },
  }
}

/** The grab handle; dragging starts here so the list below still scrolls. */
function SheetHandle(props: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className="flex h-6 shrink-0 cursor-grab items-center justify-center"
      data-sheet-handle=""
      aria-hidden="true"
      style={{ touchAction: 'none' }}
    >
      <span className="h-1 w-9 rounded-full bg-(--color-text-subtle)" />
    </div>
  )
}
