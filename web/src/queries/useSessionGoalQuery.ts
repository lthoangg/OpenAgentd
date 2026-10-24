import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { clearSessionGoal, getSessionGoal, pauseSessionGoal, resumeSessionGoal } from '@/api/client'
import type { SessionGoal, SessionGoalResponse } from '@/api/types'
import { patchSessionGoalStatus } from '@/stores/cache-invalidation-bridge'
import { queryKeys } from './keys'

/**
 * The session's newest goal. ``session_goal`` events on the global feed
 * write it in place (``handleGlobalEvent``), so this rarely refetches.
 */
export function useSessionGoalQuery(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.goal(sessionId ?? ''),
    queryFn: () => getSessionGoal(sessionId as string),
    enabled: !!sessionId,
    staleTime: 30_000,
  })
}

export type GoalAction = 'pause' | 'resume' | 'clear'

/** Pause, resume, or clear a session's goal; the answer updates the cache at once. */
export function useGoalActionMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async ({ sessionId, action }: { sessionId: string; action: GoalAction }): Promise<SessionGoal | null> => {
      if (action === 'pause') return pauseSessionGoal(sessionId)
      if (action === 'resume') return resumeSessionGoal(sessionId)
      await clearSessionGoal(sessionId)
      return null
    },
    onSuccess: (goal, { sessionId, action }) => {
      if (action === 'clear') {
        client.setQueryData<SessionGoalResponse>(queryKeys.goal(sessionId), (old) => (
          old?.goal ? { goal: { ...old.goal, status: 'cleared' } } : old
        ))
        patchSessionGoalStatus(client, sessionId, null)
        return
      }
      if (goal) {
        client.setQueryData<SessionGoalResponse>(queryKeys.goal(sessionId), { goal })
        patchSessionGoalStatus(client, sessionId, goal.status === 'active' || goal.status === 'paused' ? goal.status : null)
      }
    },
    onError: (_err, { sessionId }) => {
      client.invalidateQueries({ queryKey: queryKeys.goal(sessionId) })
    },
  })
}
