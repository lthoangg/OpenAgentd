import type { SessionGoal } from '@/api/types'
import type { GoalSessionState } from '@/lib/goal'
import { useSessionSubagentsQuery } from '@/queries/useSessionsQuery'
import { useAgentStore } from '@/stores/useAgentStore'

/** The session state a goal reads, from the live stream (and subagents while it waits). */
export function useGoalSessionState(sessionId: string | null, goal: SessionGoal | null): GoalSessionState {
  const running = useAgentStore((s) => s.isAgentWorking)
  const waitingForUser = useAgentStore((s) => Boolean(s.pendingQuestion) && s.pendingQuestion?.kind !== 'plan_review')
  const planReview = useAgentStore((s) => s.pendingQuestion?.kind === 'plan_review')
  const planMode = useAgentStore((s) => (s.sessionPendingInteractionMode ?? s.sessionInteractionMode) === 'plan')
  const queuedMessages = useAgentStore((s) => s._pendingMessages?.length ?? 0)
  // Only an active goal between turns waits on subagents.
  const { data: subagents } = useSessionSubagentsQuery(sessionId, goal?.status === 'active' && !running)
  const subagentsRunning = (subagents?.live_members ?? subagents?.subagents ?? []).filter((sub) => sub.status === 'working').length
  return { running, waitingForUser, planReview, planMode, queuedMessages, subagentsRunning }
}
