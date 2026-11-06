/**
 * RunBar — a phone's one line above the composer while the agent works:
 * the running mark Sessions uses, the step it is on and the time the turn has taken
 * (mockup J4 4.1). Stop is the Send slot's ■ under it. Steps count the
 * turn's tool calls. Hidden off a phone and while the agent is not working
 * (a question waiting on the user is not "running").
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

export function RunBar() {
  const isPhone = useIsPhone()
  const working = useAgentStore((s) => s.isAgentWorking && s.leadName != null && s.agentStreams[s.leadName]?.status === 'working')
  const startedAt = useAgentStore((s) => (s.leadName ? s.agentStreams[s.leadName]?._turnStartedAt ?? null : null))
  const steps = useAgentStore((s) => (s.leadName ? s.agentStreams[s.leadName]?.currentBlocks.filter((b) => b.type === 'tool').length ?? 0 : 0))
  const [now, setNow] = useState(() => Date.now())
  const visible = isPhone && working

  useEffect(() => {
    if (!visible) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [visible])

  if (!visible) return null
  return (
    <div data-run-bar="" className="oa-fade-in flex min-h-8 items-center gap-2 px-3 pb-1.5 text-meta text-(--color-text-muted) tabular-nums">
      <SessionStatusMark status="running" label="Running" />
      <span className="min-w-0 truncate">{runBarLabel(steps, startedAt ? now - startedAt : 0)}</span>
    </div>
  )
}
