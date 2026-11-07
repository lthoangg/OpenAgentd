/**
 * RunBar — the left of a phone's status line above the composer while the
 * agent works: the running mark Sessions uses, the step it is on and the time
 * the turn has taken (mockup J4 4.1). The line itself (``PhoneStatusLine``)
 * also holds the side questions' "btw" pill. Stop is the Send slot's ■ under it. Steps count the
 * turn's tool calls. Hidden off a phone and while the agent is not working
 * (a question waiting on the user is not "running").
 *
 * ``DeckRunStatus`` is desktop's: the same words in the run deck's empty
 * middle, beside Stop, with the Esc that stops the run (desktop mockup 5.1).
 * In the deck rather than a line above it, so the composer never moves when
 * a turn starts or ends.
 */
import { useEffect, useState } from 'react'
import { useIsPhone } from '@/hooks/use-is-phone'
import { useAgentStore } from '@/stores/useAgentStore'
import { SessionStatusMark } from '@/components/Sidebar/SessionStatusMark'

/** "Running · step 7 · 3:12"; no step before the first tool call. */
export function runBarLabel(steps: number, elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const time = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  return steps > 0 ? `Running · step ${steps} · ${time}` : `Running · ${time}`
}

/** The lead's run, ticking each second while ``enabled``; ``null`` when it is not working. */
function useRunLabel(enabled: boolean): string | null {
  const working = useAgentStore((s) => s.isAgentWorking && s.leadName != null && s.agentStreams[s.leadName]?.status === 'working')
  const startedAt = useAgentStore((s) => (s.leadName ? s.agentStreams[s.leadName]?._turnStartedAt ?? null : null))
  const steps = useAgentStore((s) => (s.leadName ? s.agentStreams[s.leadName]?.currentBlocks.filter((b) => b.type === 'tool').length ?? 0 : 0))
  const [now, setNow] = useState(() => Date.now())
  const visible = enabled && working

  useEffect(() => {
    if (!visible) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [visible])

  return visible ? runBarLabel(steps, startedAt ? now - startedAt : 0) : null
}

export function RunBar() {
  const label = useRunLabel(useIsPhone())
  if (label === null) return null
  return (
    <div data-run-bar="" className="oa-fade-in flex min-w-0 flex-1 items-center gap-2 text-meta text-(--color-text-muted) tabular-nums">
      <SessionStatusMark status="running" label="Running" />
      <span className="min-w-0 truncate">{label}</span>
    </div>
  )
}

/**
 * Desktop's run status, for the run deck after its spacer (before the context
 * meter and Stop). It gives way first in a narrow composer: the label under
 * 420px of deck, all of it under 300px.
 */
export function DeckRunStatus() {
  const label = useRunLabel(!useIsPhone())
  if (label === null) return null
  return (
    <div data-deck-run-status="" className="oa-fade-in hidden min-w-0 shrink items-center gap-1.5 pr-1 text-meta text-(--color-text-muted) tabular-nums @[300px]:flex">
      <SessionStatusMark status="running" label="Running" />
      <span className="hidden min-w-0 truncate @[420px]:inline">{label}</span>
      <kbd aria-hidden="true" className="shrink-0 rounded-xs bg-(--bg-key) px-1 py-px font-sans text-meta text-(--color-text-muted)">Esc</kbd>
    </div>
  )
}

/**
 * A phone's one status line above the composer: the run on the left, the
 * side questions' pill on the right. It takes no room when both are absent
 * (``empty:hidden``; a portalled sheet adds nothing here).
 */
export function PhoneStatusLine({ children }: { children: React.ReactNode }) {
  return (
    <div data-phone-status-line="" className="flex min-h-7 items-center gap-2 px-3 pb-1 empty:hidden">
      {children}
    </div>
  )
}
