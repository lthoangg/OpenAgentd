/**
 * TelemetryOverlay — usage, spend, and turn traces as a Settings-style
 * overlay mounted at the app root, so the status bar, the mobile drawer, the
 * command palette, and ``/telemetry`` deep links all open the same surface
 * without leaving the current route.
 *
 * Escape steps back from a trace before it closes the overlay.
 */
import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft } from 'lucide-react'

import { OverlayHeader } from '@/components/ui/app-overlay'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useModalFocus } from '@/hooks/useModalFocus'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { useTelemetryStore } from '@/stores/useTelemetryStore'
import { useUIStore } from '@/stores/useUIStore'
import { TelemetryView } from './TelemetryView'

/** Mirrors SettingsModal's panel motion; reduced motion keeps only the fade. */
const PANEL_VARIANTS = {
  hidden: { opacity: 0, scale: 0.98, y: 4 },
  visible: { opacity: 1, scale: 1, y: 0 },
} as const
const PANEL_VARIANTS_REDUCED = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
} as const

export function TelemetryOverlay() {
  const open = useUIStore((s) => s.telemetryOpen)
  const close = useUIStore((s) => s.closeTelemetry)
  const traceId = useTelemetryStore((s) => s.traceId)
  const closeTrace = useTelemetryStore((s) => s.closeTrace)
  const prefersReducedMotion = useReducedMotion()
  const panel = prefersReducedMotion ? PANEL_VARIANTS_REDUCED : PANEL_VARIANTS
  const navigate = useNavigate()
  const openSession = useCallback(
    (sessionId: string) => {
      close()
      void navigate({ to: '/$sessionId', params: { sessionId } })
    },
    [close, navigate],
  )

  useModalFocus(open, () => {
    if (useTelemetryStore.getState().traceId) closeTrace()
    else close()
  }, undefined, { kind: 'overlay' })

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="telemetry-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATIONS_S.fast }}
            className="fixed inset-0 z-50 bg-(--color-overlay)"
            onClick={close}
            aria-hidden="true"
            data-swipe-ignore
          />
          <motion.div
            key="telemetry-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Telemetry"
            data-modal-focus="true"
            data-swipe-ignore
            initial={panel.hidden}
            animate={panel.visible}
            exit={panel.hidden}
            transition={{ duration: prefersReducedMotion ? 0 : DURATIONS_S.fast, ease: EASINGS.out }}
            className={cn(
              'settings-modal-shell z-50 flex flex-col overflow-hidden rounded-lg',
              'border border-(--color-border) bg-(--bg-page) shadow-(--shadow-depth)',
            )}
          >
            <OverlayHeader
              title={traceId ? 'Turn trace' : 'Telemetry'}
              onClose={close}
              closeLabel="Close telemetry"
              closeTooltip={traceId ? 'Close' : 'Close (Esc)'}
              leading={
                traceId && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button type="button" variant="ghost" size="icon-sm" className="md:size-7" onClick={closeTrace} aria-label="Back to overview">
                          <ArrowLeft size={14} aria-hidden="true" />
                        </Button>
                      }
                    />
                    <TooltipContent>Back to overview (Esc)</TooltipContent>
                  </Tooltip>
                )
              }
            />
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <TelemetryView onOpenSession={openSession} />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
