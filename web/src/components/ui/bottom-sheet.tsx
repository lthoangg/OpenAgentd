/**
 * BottomSheet — the phone form of a popover: slides up from the bottom edge,
 * drags down (or Escape, or a tap on the backdrop) to close.
 *
 * Used where a desktop popover would sit too small under a finger: the run
 * picker and the composer's "+" menu. Like the native sheets on iOS and
 * Android it has a grab handle, clears the home indicator, and stops at
 * 85% of the visible height so the page behind it stays in view.
 */
import { type ReactNode, type RefObject } from 'react'
import { AnimatePresence, motion, useDragControls, type PanInfo } from 'framer-motion'

import { useModalFocus } from '@/hooks/useModalFocus'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { softHapticFeedback } from '@/lib/haptics'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { cn } from '@/lib/utils'

/** A drag past this distance, or flicked faster than this, closes the sheet. */
const CLOSE_DISTANCE_PX = 80
const CLOSE_VELOCITY = 500

export interface BottomSheetProps {
  open: boolean
  onClose: () => void
  /** Accessible name of the sheet. */
  label: string
  children: ReactNode
  /** Element focused as the sheet opens (defaults to the first control). */
  initialFocus?: RefObject<HTMLElement | null>
  className?: string
}

export function BottomSheet({ open, onClose, label, children, initialFocus, className }: BottomSheetProps) {
  const reduced = useReducedMotion()
  const dragControls = useDragControls()
  useModalFocus(open, onClose, initialFocus, { kind: 'overlay' })

  const handleDragEnd = (_event: unknown, info: PanInfo) => {
    if (info.offset.y > CLOSE_DISTANCE_PX || info.velocity.y > CLOSE_VELOCITY) {
      softHapticFeedback()
      onClose()
    }
  }

  return (
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
              'fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col overflow-hidden rounded-t-lg border-t border-(--color-border-subtle) bg-(--bg-page) pb-safe shadow-(--shadow-depth)',
              className,
            )}
          >
            <SheetHandle onPointerDown={(event) => dragControls.start(event)} />
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
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
      <span className="h-1 w-9 rounded-full bg-(--color-border-strong)" />
    </div>
  )
}
