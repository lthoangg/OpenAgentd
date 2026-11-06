/**
 * TelemetryOverlay — **Usage**: spend and turn traces as an `AppOverlay`
 * (wide, app-level: the frame Settings uses) mounted at the app root, so the
 * status bar, the mobile drawer, the command palette, and ``/telemetry`` deep
 * links all open the same surface without leaving the current route. The name
 * in the UI is Usage (spend and traces); a provider's own limits are
 * "Provider limits", and the Settings page for how long this data is kept is
 * "Retention".
 *
 * Escape steps back one level: the open span, then the trace, then the overlay.
 */
import { useCallback, type RefObject } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { AppOverlay, OVERLAY_MAX_WIDTH, OverlayHeader } from '@/components/ui/app-overlay'
import { useTelemetryStore } from '@/stores/useTelemetryStore'
import { useUIStore } from '@/stores/useUIStore'
import { TelemetryView } from './TelemetryView'
import { workspaceName } from './model'

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

const RANGE_WORDS: Record<number, string> = { 1: 'Last 24 hours', 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days' }

/** "Last 7 days · all workspaces · all models": what the numbers cover. */
function UsageScope() {
  const days = useTelemetryStore((s) => s.days)
  const workspace = useTelemetryStore((s) => s.workspace)
  const model = useTelemetryStore((s) => s.model)
  return (
    <span className="max-sm:hidden">
      {RANGE_WORDS[days] ?? `Last ${days} days`} · {workspace ? workspaceName(workspace) : 'all workspaces'} ·{' '}
      {model ? <span className="font-mono">{model}</span> : 'all models'}
    </span>
  )
}

export function TelemetryOverlay() {
  const open = useUIStore((s) => s.telemetryOpen)
  const close = useUIStore((s) => s.closeTelemetry)
  const traceId = useTelemetryStore((s) => s.traceId)
  const spanId = useTelemetryStore((s) => s.spanId)
  const stepBack = useTelemetryStore((s) => s.stepBack)
  const navigate = useNavigate()
  const openSession = useCallback(
    (sessionId: string) => {
      close()
      void navigate({ to: '/$sessionId', params: { sessionId } })
    },
    [close, navigate],
  )

  return (
    <AppOverlay
      open={open}
      onClose={close}
      // Escape steps out of a span, then a trace, before it closes; a click on
      // the backdrop closes outright.
      onEscape={() => {
        if (!useTelemetryStore.getState().stepBack()) close()
      }}
      label="Usage"
      maxWidth={OVERLAY_MAX_WIDTH.wide}
      appLevel
      initialFocus={RANGE_FOCUS}
    >
      <OverlayHeader
        title={traceId ? 'Turn' : 'Usage'}
        subtitle={traceId ? undefined : <UsageScope />}
        onClose={close}
        closeLabel="Close usage"
        closeTooltip={traceId ? 'Close' : 'Close (Esc)'}
        // A phone reads "‹ Usage" (or "‹ Turn" from a span), as iOS names the
        // screen it returns to; elsewhere a ← whose tooltip names it.
        back={traceId ? {
          label: spanId ? 'Turn' : 'Usage',
          onBack: () => void stepBack(),
          ariaLabel: spanId ? 'Back to the trace' : 'Back to usage',
          tooltip: spanId ? 'Back to the trace (Esc)' : 'Back to usage (Esc)',
        } : undefined}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TelemetryView onOpenSession={openSession} />
      </div>
    </AppOverlay>
  )
}
