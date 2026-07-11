/**
 * ToastStack — renders all toasts from ``useToastStore`` in the top-right
 * corner.  Handles its own mount/unmount animations and auto-dismiss is
 * driven by the store.
 *
 * Swipe right or up to dismiss.
 */
import { AnimatePresence, motion, useMotionValue, useTransform } from 'framer-motion'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { useToastStore, type Toast } from '@/stores/useToastStore'
import { useReducedMotion } from '@/hooks/useReducedMotion'

const TONE_STYLES: Record<
  Toast['tone'],
  { icon: React.ComponentType<{ size?: number; className?: string }>; iconClass: string }
> = {
  success: {
    icon: CheckCircle2,
    iconClass: 'text-(--color-success) opacity-60',
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
}

function ToastItem({ t, dismiss }: ToastItemProps) {
  const { icon: Icon, iconClass } = TONE_STYLES[t.tone]
  const prefersReducedMotion = useReducedMotion()

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

  return (
    <motion.div
      key={t.id}
      layout
      style={{ x, y, opacity }}
      variants={{
        enter: prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.96, transition: { type: 'spring', damping: 26, stiffness: 320 } },
        visible: prefersReducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', damping: 26, stiffness: 320 } },
        exit: prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.96, transition: { type: 'tween', duration: 0.15, ease: 'easeIn' } },
      }}
      initial="enter"
      animate="visible"
      exit="exit"
      drag
      dragConstraints={{ left: 0, right: 200, top: -200, bottom: 0 }}
      dragElastic={{ left: 0.05, right: 0.4, top: 0.4, bottom: 0.05 }}
      dragMomentum={false}
      onDragEnd={handleDragEnd}
      whileDrag={{ cursor: 'grabbing' }}
      data-swipe-ignore
      className="pointer-events-auto flex cursor-grab items-start gap-3 rounded-sm border border-(--color-border) bg-(--bg-card) p-3 shadow-md select-none"
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
      <button
        onClick={() => dismiss(t.id)}
        aria-label="Dismiss"
        className="flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-xs p-1 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
      >
        <X size={12} />
      </button>
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
    <div className="mobile-safe-toast pointer-events-none fixed z-[60] flex w-auto flex-col gap-2 sm:left-auto sm:w-full sm:max-w-sm">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastItem key={t.id} t={t} dismiss={dismiss} />
        ))}
      </AnimatePresence>
    </div>
  )
}
