import type { SessionGoal } from '@/api/types'
import type { GoalSessionState } from '@/lib/goal'
import { useSessionWaitingQuery } from '@/queries/useSessionsQuery'
import { useAgentStore } from '@/stores/useAgentStore'

/** The session state a goal reads, from the live stream (and the sessions it waits for between turns). */
export function useGoalSessionState(sessionId: string | null, goal: SessionGoal | null): GoalSessionState {
  const running = useAgentStore((s) => s.isAgentWorking)
  const waitingForUser = useAgentStore((s) => Boolean(s.pendingQuestion) && s.pendingQuestion?.kind !== 'plan_review')
  const planReview = useAgentStore((s) => s.pendingQuestion?.kind === 'plan_review')
  const planMode = useAgentStore((s) => (s.sessionPendingInteractionMode ?? s.sessionInteractionMode) === 'plan')
  const queuedMessages = useAgentStore((s) => s._pendingMessages?.length ?? 0)
  // Only an active goal between turns waits: on its subagents, and on
  // sessions in other workspaces that owe it a reply (the same list as the
  // "Waiting for" line under the answer).
  const { data: waiting } = useSessionWaitingQuery(sessionId, goal?.status === 'active' && !running)
  const sessionsAwaited = waiting?.items?.length ?? 0
  return { running, waitingForUser, planReview, planMode, queuedMessages, sessionsAwaited }
}
