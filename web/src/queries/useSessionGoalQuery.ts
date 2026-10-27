import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { clearSessionGoal, getSessionGoal, pauseSessionGoal, resumeSessionGoal, startSessionGoal } from '@/api/client'
import type { SessionGoal, SessionGoalResponse } from '@/api/types'
import type { GoalAction } from '@/lib/goal'
import { patchSessionGoalStatus } from '@/stores/cache-invalidation-bridge'
import { useToastStore } from '@/stores/useToastStore'
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

/**
 * Pause and Resume for the status line that heads the Tasks view, with the
 * error toast the Goal tab gives. ``undefined`` without a session.
 */
export function useGoalControls(sessionId: string | null | undefined): ((action: 'pause' | 'resume') => void) | undefined {
  const { mutate } = useGoalActionMutation()
  const pushToast = useToastStore((s) => s.push)
  const run = useCallback((action: 'pause' | 'resume') => {
    if (!sessionId) return
    mutate({ sessionId, action }, {
      onError: (err) => pushToast({ tone: 'error', title: `Could not ${action} the goal`, description: err instanceof Error ? err.message : String(err) }),
    })
  }, [sessionId, mutate, pushToast])
  return sessionId ? run : undefined
}

/** Run the session's approved plan as a goal; the answer lands in the goal cache at once. */
export function useStartGoalMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ sessionId, maxTurns }: { sessionId: string; maxTurns?: number }) => startSessionGoal(sessionId, maxTurns),
    onSuccess: (goal, { sessionId }) => {
      client.setQueryData<SessionGoalResponse>(queryKeys.goal(sessionId), { goal })
      patchSessionGoalStatus(client, sessionId, goal.status === 'active' || goal.status === 'paused' ? goal.status : null)
    },
    onError: (_err, { sessionId }) => {
      client.invalidateQueries({ queryKey: queryKeys.goal(sessionId) })
    },
  })
}

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
