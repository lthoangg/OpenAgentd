/**
 * Sidebar row props that warm a session before it is opened: its first
 * history page (`session-prefetch.ts`) and its workspace's agents, so a
 * switch to another workspace does not wait on either.
 */
import { hoverIntent } from '@/hooks/use-hover-intent'
import { queryClient } from '@/lib/query-client'
import { prefetchSessionHistory } from '@/lib/session-prefetch'
import { agentRegistryQueryOptions } from '@/queries/agent-registry'

/** How long the pointer rests on a row before it counts as intent. */
export const PREFETCH_DWELL_MS = 90

let dwell: { sessionId: string; timer: ReturnType<typeof setTimeout> } | null = null

function cancelDwell() {
  if (dwell) clearTimeout(dwell.timer)
  dwell = null
}

export function prefetchSession(sessionId: string, workspace?: string | null): void {
  prefetchSessionHistory(sessionId)
  if (workspace) void queryClient.prefetchQuery(agentRegistryQueryOptions(workspace)).catch(() => {})
}

/**
 * Prefetch after the pointer rests on the row a beat (real mouse movement
 * only, see `hoverIntent`), or at once when it is pressed.
 */
export function sessionPrefetchProps(sessionId: string, workspace?: string | null) {
  return {
    ...hoverIntent(() => {
      if (dwell?.sessionId === sessionId) return
      cancelDwell()
      dwell = {
        sessionId,
        timer: setTimeout(() => {
          dwell = null
          prefetchSession(sessionId, workspace)
        }, PREFETCH_DWELL_MS),
      }
    }),
    onMouseLeave: () => {
      if (dwell?.sessionId === sessionId) cancelDwell()
    },
    onPointerDown: () => {
      cancelDwell()
      prefetchSession(sessionId, workspace)
    },
  }
}
