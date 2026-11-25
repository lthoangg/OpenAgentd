import type { SessionGoal } from '@/api/types'
import type { GoalSessionState } from '@/lib/goal'
import { countWaiting } from '@/lib/waiting'
import { useSessionWaitingQuery } from '@/queries/useSessionsQuery'
import { useAgentStore } from '@/stores/useAgentStore'
import { isRunLive } from '@/stores/useAgentStore/run-state'
import { openQuestion } from '@/stores/useAgentStore/question-state'

/** The session state a goal reads, from the live stream (and the sessions it waits for between turns). */
export function useGoalSessionState(sessionId: string | null, goal: SessionGoal | null): GoalSessionState {
  const running = useAgentStore((s) => isRunLive(s.sessionRun))
  const waitingForUser = useAgentStore((s) => {
    const question = openQuestion(s)
    return question !== null && question.kind !== 'plan_review'
  })
  const planReview = useAgentStore((s) => openQuestion(s)?.kind === 'plan_review')
  const planMode = useAgentStore((s) => (s.sessionPendingInteractionMode ?? s.sessionInteractionMode) === 'plan')
  const queuedMessages = useAgentStore((s) => s._pendingMessages?.length ?? 0)
  // Only an active goal between turns waits: on its subagents, on sessions
  // in other workspaces that owe it a reply, and on background commands it
  // waits for (the same counts as the "Waiting for" line in the transcript:
  // idle sessions and servers left out).
  const { data: waiting } = useSessionWaitingQuery(sessionId, goal?.status === 'active' && !running)
  const { sessions: sessionsAwaited, commands: commandsAwaited } = countWaiting(waiting?.items)
  return { running, waitingForUser, planReview, planMode, queuedMessages, sessionsAwaited, commandsAwaited }
}
