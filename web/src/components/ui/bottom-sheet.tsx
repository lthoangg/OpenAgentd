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
 * It renders into document.body: the composer is a size container, and
 * older WebKit and Chromium (Android 15's Chrome 124 among them) place a
 * fixed child inside such a container, so the sheet and its backdrop sat
 * in the composer instead of over the page.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useDragControls, type PanInfo } from 'framer-motion'

import { useModalFocus } from '@/hooks/useModalFocus'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { softHapticFeedback } from '@/lib/haptics'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { cn } from '@/lib/utils'

/** A drag past this distance, or flicked faster than this, closes the sheet. */
const CLOSE_DISTANCE_PX = 80
const CLOSE_VELOCITY = 500
/** The sheet follows a pull past its resting place at this share of the finger, as the handle's drag does. */
const PULL_ELASTIC = 0.6
/** Movement under this is still a tap, not a pull. */
const PULL_SLOP_PX = 6

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
  const dragControls = useDragControls()
  const sheetRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  useModalFocus(open, onClose, initialFocus ?? sheetRef, { kind: 'overlay' })
  usePullToClose(sheetRef, bodyRef, open && !reduced, onClose)

  const handleDragEnd = (_event: unknown, info: PanInfo) => {
    if (info.offset.y > CLOSE_DISTANCE_PX || info.velocity.y > CLOSE_VELOCITY) {
      softHapticFeedback()
      onClose()
    }
  }

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
            className="fixed inset-0 z-40 bg-(--color-overlay)"
            onClick={onClose}
            aria-hidden="true"
          />
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
            exit={reduced ? { opacity: 0 } : { y: '100%' }}
            transition={{ duration: reduced ? 0.01 : DURATIONS_S.base, ease: EASINGS.sheet }}
            drag={reduced ? false : 'y'}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            dragControls={dragControls}
            dragListener={false}
            onDragEnd={handleDragEnd}
            className={cn(
              'fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col overflow-hidden rounded-t-lg border-t border-(--color-border-subtle) bg-(--bg-page) pb-safe shadow-(--shadow-depth) outline-none',
              className,
            )}
          >
            <SheetHandle onPointerDown={(event) => dragControls.start(event)} />
            <div ref={bodyRef} data-sheet-body="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/**
 * A pull down on the sheet's content moves the sheet, and past the close
 * distance (or on a flick) closes it. Only when nothing between the finger
 * and the sheet is scrolled down: then the pull scrolls back up instead.
 *
 * Touch events, not pointer events: once the browser takes a pan for
 * scrolling it cancels the pointer, so framer's drag never hears the rest.
 * The listener is not passive, so the pull can keep the page from scrolling.
 * The pull moves the sheet by the CSS ``translate`` property, which adds to
 * the ``transform`` framer animates: a close slides on from where the
 * finger left it.
 */
function usePullToClose(
  sheetRef: RefObject<HTMLDivElement | null>,
  bodyRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  onClose: () => void,
) {
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const sheet = sheetRef.current
    const body = bodyRef.current
    if (!enabled || !sheet || !body) return
    // 'pending': not yet a pull or a scroll; 'pull' moves the sheet; 'pass' leaves the gesture to the page.
    let mode: 'pending' | 'pull' | 'pass' = 'pass'
    let startX = 0
    let startY = 0
    let last = { y: 0, t: 0 }
    let previous = { y: 0, t: 0 }

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
      startY = touch.clientY
      last = previous = { y: touch.clientY, t: performance.now() }
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
        sheet.style.transition = 'none'
      }
      event.preventDefault()
      previous = last
      last = { y: touch.clientY, t: performance.now() }
      sheet.style.translate = `0 ${Math.max(0, dy) * PULL_ELASTIC}px`
    }

    const onEnd = () => {
      if (mode !== 'pull') {
        mode = 'pass'
        return
      }
      mode = 'pass'
      const offset = last.y - startY
      const dt = last.t - previous.t
      const velocity = dt > 0 ? ((last.y - previous.y) / dt) * 1000 : 0
      if (offset > CLOSE_DISTANCE_PX || velocity > CLOSE_VELOCITY) {
        softHapticFeedback()
        onCloseRef.current()
      } else {
        sheet.style.transition = `translate ${DURATIONS_S.fast}s cubic-bezier(${EASINGS.sheet.join(', ')})`
        sheet.style.translate = ''
      }
    }

    body.addEventListener('touchstart', onStart, { passive: true })
    body.addEventListener('touchmove', onMove, { passive: false })
    body.addEventListener('touchend', onEnd)
    body.addEventListener('touchcancel', onEnd)
    return () => {
      body.removeEventListener('touchstart', onStart)
      body.removeEventListener('touchmove', onMove)
      body.removeEventListener('touchend', onEnd)
      body.removeEventListener('touchcancel', onEnd)
    }
  }, [sheetRef, bodyRef, enabled])
}

/** The grab handle; dragging starts here so the list below still scrolls. */
function SheetHandle({ onPointerDown }: { onPointerDown: (event: React.PointerEvent) => void }) {
  return (
    <div
      className="flex h-6 shrink-0 cursor-grab items-center justify-center"
      data-sheet-handle=""
      aria-hidden="true"
      onPointerDown={onPointerDown}
      style={{ touchAction: 'none' }}
    >
      <span className="h-1 w-9 rounded-full bg-(--color-text-subtle)" />
    </div>
  )
}
