/**
 * TelemetryOverlay — usage, spend, and turn traces as a Settings-style
 * overlay mounted at the app root, so the status bar, the mobile drawer, the
 * command palette, and ``/telemetry`` deep links all open the same surface
 * without leaving the current route.
 *
 * Escape steps back one level: the open span, then the trace, then the overlay.
 */
import { useCallback, type RefObject } from 'react'
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
import { modelName, workspaceName } from './model'

/**
 * Opening Usage lands on the selected time range (the first thing you would
 * change), not on Close. Read at focus time; a trace view has no range, so
 * focus falls back to the first control.
 */
const RANGE_FOCUS: RefObject<HTMLElement | null> = {
  get current() {
    return document.querySelector<HTMLElement>('[role="dialog"][aria-label="Usage"] [role="radiogroup"][aria-label="Time range"] [aria-checked="true"]')
  },
}

/** Mirrors SettingsModal's panel motion; reduced motion keeps only the fade. */
const PANEL_VARIANTS = {
  hidden: { opacity: 0, scale: 0.98, y: 4 },
  visible: { opacity: 1, scale: 1, y: 0 },
} as const
const PANEL_VARIANTS_REDUCED = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
} as const

const RANGE_WORDS: Record<number, string> = { 1: 'Last 24 hours', 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days' }

/** "Last 7 days · all workspaces · all models": what the numbers cover. */
function UsageScope() {
  const days = useTelemetryStore((s) => s.days)
  const workspace = useTelemetryStore((s) => s.workspace)
  const model = useTelemetryStore((s) => s.model)
  return (
    <span className="max-sm:hidden">
      {RANGE_WORDS[days] ?? `Last ${days} days`} · {workspace ? workspaceName(workspace) : 'all workspaces'} ·{' '}
      {model ? modelName(model) : 'all models'}
    </span>
  )
}

export function TelemetryOverlay() {
  const open = useUIStore((s) => s.telemetryOpen)
  const close = useUIStore((s) => s.closeTelemetry)
  const traceId = useTelemetryStore((s) => s.traceId)
  const spanId = useTelemetryStore((s) => s.spanId)
  const stepBack = useTelemetryStore((s) => s.stepBack)
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
    if (!useTelemetryStore.getState().stepBack()) close()
  }, RANGE_FOCUS, { kind: 'overlay' })

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
            aria-label="Usage"
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
              title={traceId ? 'Turn' : 'Usage'}
              subtitle={traceId ? undefined : <UsageScope />}
              onClose={close}
              closeLabel="Close usage"
              closeTooltip={traceId ? 'Close' : 'Close (Esc)'}
              leading={
                traceId && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="md:size-7"
                          onClick={() => void stepBack()}
                          aria-label={spanId ? 'Back to the trace' : 'Back to usage'}
                        >
                          <ArrowLeft size={14} aria-hidden="true" />
                        </Button>
                      }
                    />
                    <TooltipContent>{spanId ? 'Back to the trace (Esc)' : 'Back to usage (Esc)'}</TooltipContent>
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
