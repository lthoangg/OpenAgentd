/**
 * Plan, tasks and goal read as one chain: the plan says what and why, the
 * tasks are the steps, Done when is the finish line, and the goal is the plan
 * running on its own. These pure helpers give every surface (the header's
 * Task list button, the Tasks tab and popover, the Plan and Goal tabs) the
 * same words for where that chain stands.
 */
import type { SessionGoal, SessionPlan, TodoItem } from '@/api/types'
import { goalNow, pauseReasonLabel, type GoalNow, type GoalSessionState, type GoalTone } from '@/lib/goal'
import { PLAN_STATUS_LABEL, isPlanGoal, nextTask, planStatus } from '@/lib/plan'

/** Every task finished (completed or cancelled), with at least one task on the board. */
export function tasksFinished(todos: readonly TodoItem[]): boolean {
  return todos.length > 0 && todos.every((t) => t.status === 'completed' || t.status === 'cancelled')
}

/**
 * The plan's status as one line, with its goal folded in while the goal runs
 * it: "Approved · Running", "Approved · Paused: turn limit", "All tasks done
 * · checking". Without a goal running the plan it is the plan's own status.
 */
export function workStatusLabel(
  plan: SessionPlan,
  reviewing: boolean,
  progress: { todos?: readonly TodoItem[]; goal?: SessionGoal | null } = {},
): string {
  const status = planStatus(plan, reviewing, progress)
  const goal = progress.goal
  if (status !== 'approved' || !isPlanGoal(goal, plan)) return PLAN_STATUS_LABEL[status]
  if (goal.status === 'paused') {
    return goal.pause_reason === 'blocked' ? 'Approved · Blocked' : `Approved · Paused: ${pauseReasonLabel(goal.pause_reason)}`
  }
  return tasksFinished(progress.todos ?? []) ? 'All tasks done · checking' : 'Approved · Running'
}

export type DoneWhenState = 'open' | 'waiting' | 'checking' | 'met'

export interface DoneWhen {
  state: DoneWhenState
  /** The plan's Done when. */
  text: string
  /** Where it stands, in a few words. */
  note: string
}

/**
 * The finish line of the task list: the plan's Done when and whether the
 * goal's check has confirmed it. ``null`` when the plan has none.
 */
export function doneWhen(
  plan: SessionPlan | null | undefined,
  progress: { todos?: readonly TodoItem[]; goal?: SessionGoal | null } = {},
): DoneWhen | null {
  const text = plan?.done_when?.trim()
  if (!plan || !text) return null
  const goal = isPlanGoal(progress.goal, plan) ? progress.goal : null
  if (goal?.status === 'achieved') return { state: 'met', text, note: 'Met · the completion check confirmed it' }
  if (!goal) return { state: 'open', text, note: 'No goal is running · you decide when it is met' }
  if (tasksFinished(progress.todos ?? [])) {
    return goal.status === 'paused'
      ? { state: 'checking', text, note: 'All tasks done · the goal is paused' }
      : { state: 'checking', text, note: 'All tasks done · waiting for the completion check' }
  }
  return { state: 'waiting', text, note: 'Not checked yet · the agent claims it when the tasks are done' }
}

export interface GoalHeaderState {
  tone: GoalTone
  /** Tooltip text: "Goal · Working on turn 7 of 50 · Next: Docs". */
  text: string
}

/**
 * What the header's Task list button shows for the session's goal: a ring in
 * the goal's colour and a tooltip. ``null`` without a goal, and once it is
 * achieved or cleared (the Goal tab still shows an achieved one).
 */
export function goalHeaderState(
  goal: SessionGoal | null | undefined,
  session: GoalSessionState,
  todos: readonly TodoItem[] = [],
): GoalHeaderState | null {
  if (!goal || (goal.status !== 'active' && goal.status !== 'paused')) return null
  const now: GoalNow | null = goalNow(goal, session)
  if (!now) return null
  const next = now.tone === 'active' ? nextTask(todos) : null
  return { tone: now.tone, text: `Goal · ${now.text}${next ? ` · Next: ${next.content}` : ''}` }
}
