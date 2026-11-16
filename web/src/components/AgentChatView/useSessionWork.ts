/**
 * The session's work: its task list, its plan (and whether it waits for
 * review), and its goal, with what the header, the palette and the task
 * panel show of them.
 */
import { useCallback, useMemo } from 'react'
import { useGoalSessionState } from '@/hooks/useGoalSessionState'
import { failureToast } from '@/lib/failure-toast'
import { goalHeaderState } from '@/lib/work'
import { useGoalControls, useSessionGoalQuery } from '@/queries/useSessionGoalQuery'
import { useClearSessionPlanMutation, useSessionPlanQuery } from '@/queries/useSessionPlanQuery'
import { useTodosQuery } from '@/queries/useTodosQuery'
import { useAgentStore } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'

export function useSessionWork({ sessionId, workspace, handleOpenGoal }: {
  sessionId: string | null
  workspace: string | null
  /** Shows the dock's Goal tab. */
  handleOpenGoal: () => void
}) {
  const pushToast = useToastStore((s) => s.push)
  const { data: todosData } = useTodosQuery(sessionId)
  const todos = todosData?.todos ?? []
  const { data: planData } = useSessionPlanQuery(sessionId)
  const plan = planData?.plan ?? null
  const planAwaitingReview = useAgentStore((s) => s.pendingQuestion?.kind === 'plan_review')
  const { mutate: clearPlan } = useClearSessionPlanMutation()
  const handleClearPlan = useCallback(() => {
    if (!sessionId) return
    clearPlan(sessionId, {
      onError: (err) => pushToast(failureToast("Couldn't clear the plan", err)),
    })
  }, [sessionId, clearPlan, pushToast])

  // ── Session goal ───────────────────────────────────────────────────────────
  const { data: goalData } = useSessionGoalQuery(sessionId)
  const goal = goalData?.goal ?? null
  // The goal lives in the dock's Goal tab (its actions too): the palette
  // lists one entry that opens it, even before there is a goal, so it can be
  // found; the tab's empty state says how a goal starts.
  const paletteGoal = useMemo(
    () => (workspace ? { onShow: handleOpenGoal, active: Boolean(goal && goal.status !== 'cleared') } : undefined),
    [workspace, goal, handleOpenGoal],
  )
  // The header's Task list button shows the live goal as a ring and tooltip.
  const goalSession = useGoalSessionState(sessionId, goal)
  const headerGoalState = useMemo(() => goalHeaderState(goal, goalSession, todosData?.todos ?? []), [goal, goalSession, todosData])
  const goalControls = useGoalControls(sessionId)

  return { todos, plan, planAwaitingReview, handleClearPlan, goal, paletteGoal, headerGoalState, goalControls }
}
