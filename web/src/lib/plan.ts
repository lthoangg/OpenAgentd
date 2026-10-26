/**
 * Where the session plan stands, read with its task board and goal: a draft,
 * awaiting review, approved, changed since approval, or done. Pure, so the
 * Plan tab, the plan row and the work summary agree.
 */
import type { SessionGoal, SessionPlan, TodoItem } from '@/api/types'

export type PlanStatus = 'review' | 'approved' | 'changed' | 'draft' | 'done'

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  review: 'Awaiting review',
  approved: 'Approved',
  changed: 'Changed since approval',
  draft: 'Draft',
  done: 'Done',
}

/** The task board and goal a plan is read with. */
export interface PlanProgress {
  todos?: readonly TodoItem[]
  goal?: SessionGoal | null
}

/** Whether ``goal`` runs ``plan``: approving it with Keep going made the plan's Done when its objective. */
export function isPlanGoal(goal: SessionGoal | null | undefined, plan: SessionPlan): goal is SessionGoal {
  const doneWhen = plan.done_when?.trim()
  return Boolean(goal && goal.status !== 'cleared' && doneWhen && goal.objective.trim() === doneWhen)
}

/**
 * The plan's status. An approved plan is done once its goal is achieved, or,
 * with no goal still running it, once every task on the board is finished.
 */
export function planStatus(plan: SessionPlan, reviewing: boolean, progress: PlanProgress = {}): PlanStatus {
  if (reviewing) return 'review'
  const approved = plan.approved_revision
  if (approved === null || approved === undefined) return 'draft'
  if (plan.revision !== undefined && plan.revision > approved) return 'changed'
  const goal = isPlanGoal(progress.goal, plan) ? progress.goal : null
  if (goal?.status === 'achieved') return 'done'
  if (goal) return 'approved'
  const todos = progress.todos ?? []
  const finished = todos.length > 0 && todos.every((t) => t.status === 'completed' || t.status === 'cancelled')
  return finished ? 'done' : 'approved'
}

/** The task a goal works on next: the one in progress, else the first pending one. */
export function nextTask(todos: readonly TodoItem[]): TodoItem | null {
  return todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending') ?? null
}
