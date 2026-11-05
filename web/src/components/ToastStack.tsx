/**
 * ToastStack — renders all toasts from ``useToastStore`` at the head of the
 * ``FloatingNotices`` column: top right under the app header, full width on
 * phones, so they never cover the header's controls. The newest toast sits
 * nearest the top edge. Handles its own mount/unmount animations; each item
 * owns its auto-dismiss timer (see ToastItem) so it can pause on hover/focus.
 *
 * Swipe right or up to dismiss.
 */
import { AnimatePresence, motion, useMotionValue, useTransform } from 'framer-motion'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { CheckCircle2, AlertCircle, Info } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CloseButton } from '@/components/ui/close-button'
import { useToastStore, type Toast } from '@/stores/useToastStore'
import { useReducedMotion } from '@/hooks/useReducedMotion'

const TONE_STYLES: Record<
  Toast['tone'],
  { icon: React.ComponentType<{ size?: number; className?: string }>; iconClass: string }
> = {
  success: {
    icon: CheckCircle2,
    iconClass: 'text-(--accent-green-text)',
  },
  error: {
    icon: AlertCircle,
    iconClass: 'text-(--color-error)',
  },
  info: {
    icon: Info,
    iconClass: 'text-(--color-text-muted)',
  },
}

// Threshold (px) past which a drag is treated as a dismiss gesture
const SWIPE_THRESHOLD = 60

interface ToastItemProps {
  t: Toast
  dismiss: (id: string) => void
  /** AnimatePresence's ``popLayout`` measures the leaving toast through it. */
  ref?: React.Ref<HTMLDivElement>
}

function ToastItem({ t, dismiss, ref }: ToastItemProps) {
  const { icon: Icon, iconClass } = TONE_STYLES[t.tone]
  const prefersReducedMotion = useReducedMotion()

  // Auto-dismiss timer lives here (not the store) so it can pause while the
  // pointer or keyboard focus is on the toast — otherwise a toast the user is
  // reading vanishes mid-sentence. Remaining time is preserved across pauses.
  // A null duration (every error) never runs out: it stays until closed.
  const [paused, setPaused] = useState(false)
  const remainingRef = useRef(t.durationMs === undefined ? 4500 : t.durationMs)
  useEffect(() => {
    const remaining = remainingRef.current
    if (paused || remaining === null || remaining <= 0) return
    const startedAt = Date.now()
    const timer = setTimeout(() => dismiss(t.id), remaining)
    return () => {
      clearTimeout(timer)
      remainingRef.current = Math.max(0, remaining - (Date.now() - startedAt))
    }
  }, [paused, dismiss, t.id])

  const x = useMotionValue(0)
  const y = useMotionValue(0)
  // Fade out as the user drags away
  const opacity = useTransform([x, y], ([latestX, latestY]: number[]) => {
    const dist = Math.max(Math.abs(latestX), Math.abs(latestY))
    return Math.max(0, 1 - dist / (SWIPE_THRESHOLD * 1.5))
  })

  function handleDragEnd() {
    const dx = x.get()
    const dy = y.get()
    // Dismiss on swipe right or swipe up
    if (dx > SWIPE_THRESHOLD || dy < -SWIPE_THRESHOLD) {
      dismiss(t.id)
    }
  }

  // Two layers: the outer one enters, leaves and reflows (its opacity is
  // the variants'); the inner one follows the finger and fades with the
  // drag. On one element the drag's derived opacity overrode the variants,
  // so a toast popped in and out without its fade.
  return (
    <motion.div
      ref={ref}
      layout
      variants={{
        enter: prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.96, transition: { type: 'spring', damping: 26, stiffness: 320 } },
        visible: prefersReducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', damping: 26, stiffness: 320 } },
        exit: prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.96, transition: { type: 'tween', duration: DURATIONS_S.fast, ease: EASINGS.inOut } },
      }}
      initial="enter"
      animate="visible"
      exit="exit"
      className="pointer-events-auto"
    >
    <motion.div
      style={{ x, y, opacity }}
      drag
      dragConstraints={{ left: 0, right: 200, top: -200, bottom: 0 }}
      dragElastic={{ left: 0.05, right: 0.4, top: 0.4, bottom: 0.05 }}
      dragMomentum={false}
      onDragEnd={handleDragEnd}
      whileDrag={{ cursor: 'grabbing' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      data-swipe-ignore
      className="pointer-events-auto flex cursor-grab items-start gap-3 rounded-sm border border-(--color-border) bg-(--bg-card) p-3 shadow-(--shadow-depth) select-none"
      // Errors must interrupt assistive tech (WCAG 4.1.3 Status Messages);
      // success/info stay polite so they don't preempt the user.
      role={t.tone === 'error' ? 'alert' : 'status'}
      aria-live={t.tone === 'error' ? 'assertive' : 'polite'}
    >
      <Icon size={16} className={`mt-0.5 shrink-0 ${iconClass}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-(--color-text)">{t.title}</p>
        {t.description && (
          <p className="mt-0.5 text-xs text-(--color-text-muted)">{t.description}</p>
        )}
      </div>
      {t.action && (
        <button
          type="button"
          onClick={() => {
            t.action?.onAction()
            dismiss(t.id)
          }}
          className="-my-1 inline-flex h-7 shrink-0 items-center rounded-xs bg-(--bg-key) px-2.5 text-sm font-medium text-(--color-text) transition-colors hover:bg-(--color-fill-key-hover) pointer-coarse:h-9"
        >
          {t.action.label}
        </button>
      )}
      {/* No Esc tooltip: Esc does not dismiss a toast, and swipe does. */}
      <CloseButton size="icon-xs" label="Dismiss" tooltip={null} className="-my-1" onClick={() => dismiss(t.id)} />
    </motion.div>
    </motion.div>
  )
}

// Stable selector — `dismiss` is a function defined once on the store so
// this always returns the same reference and never triggers a re-render.
const dismissSelector = (s: ReturnType<typeof useToastStore.getState>) => s.dismiss

export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore(dismissSelector)

  return (
    <div className="pointer-events-none relative flex w-full flex-col gap-2 sm:max-w-sm">
      {/* popLayout: the toasts that stay close the gap while one leaves,
          not after its exit has finished. */}
      <AnimatePresence initial={false} mode="popLayout">
        {/* The store appends; the column reads newest first. */}
        {[...toasts].reverse().map((t) => (
          <ToastItem key={t.id} t={t} dismiss={dismiss} />
        ))}
      </AnimatePresence>
    </div>
  )
}
