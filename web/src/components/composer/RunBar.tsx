/**
 * RunBar — the left of a phone's status line above the composer while the
 * agent works: the running mark Sessions uses, the step it is on and the time
 * the turn has taken (mockup J4 4.1). The line itself (``PhoneStatusLine``)
 * also holds the side questions' "btw" pill. Stop is the Send slot's ■ under it. Steps count the
 * turn's tool calls. Hidden off a phone and while the agent is not working
 * (a question waiting on the user is not "running").
 */
import { useEffect, useState } from 'react'
import type { ContentBlock } from '@/api/types'
import { useIsPhone } from '@/hooks/use-is-phone'
import { useAgentStore } from '@/stores/useAgentStore'
import { useSimpleDetail } from '@/stores/useDisplayPrefsStore'
import { SessionStatusMark } from '@/components/Sidebar/SessionStatusMark'

/**
 * "Running · step 7 · 3:12"; no step before the first tool call. With the
 * Detail setting on Simple: "Working · 3:12", the word the transcript's fold uses.
 */
export function runBarLabel(steps: number, elapsedMs: number, simple = false): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const time = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  if (simple) return `Working · ${time}`
  return steps > 0 ? `Running · step ${steps} · ${time}` : `Running · ${time}`
}

/**
 * The tool calls of the stream's trailing turn: back from the end to its
 * prompt (any user block, the boundary the Full transcript draws). Both the
 * live blocks and the stored ones count: a resume, a reload, or a compaction
 * partway through the turn moves its earlier calls into ``blocks``.
 */
export function turnToolCount(stream: { blocks: readonly ContentBlock[]; currentBlocks: readonly ContentBlock[] }): number {
  let count = 0
  for (const list of [stream.currentBlocks, stream.blocks]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const block = list[i]
      if (block.type === 'user') return count
      if (block.type === 'tool') count += 1
    }
  }
  return count
}

export function RunBar() {
  const isPhone = useIsPhone()
  const simple = useSimpleDetail()
  const working = useAgentStore((s) => s.isAgentWorking && s.leadName != null && s.agentStreams[s.leadName]?.status === 'working')
  const startedAt = useAgentStore((s) => (s.leadName ? s.agentStreams[s.leadName]?._turnStartedAt ?? null : null))
  const steps = useAgentStore((s) => {
    const stream = s.leadName ? s.agentStreams[s.leadName] : undefined
    return stream ? turnToolCount(stream) : 0
  })
  const [now, setNow] = useState(() => Date.now())
  const visible = isPhone && working

  useEffect(() => {
    if (!visible) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [visible])

  if (!visible) return null
  return (
    <div data-run-bar="" className="oa-fade-in flex min-w-0 flex-1 items-center gap-2 text-meta text-(--color-text-muted) tabular-nums">
      <SessionStatusMark status="running" label={simple ? 'Working' : 'Running'} />
      <span className="min-w-0 truncate">{runBarLabel(steps, startedAt ? now - startedAt : 0, simple)}</span>
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
