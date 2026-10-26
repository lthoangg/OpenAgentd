/**
 * TasksTabView — the agent's task list as a review-dock tab (desktop ⌘T).
 *
 * Same checklist as the mobile popover, but rows wrap instead of truncating
 * since the dock's width varies and there is room for the full text.
 */
import { ListTodo } from 'lucide-react'
import type { SessionGoal, SessionPlan, TodoItem } from '@/api/types'
import type { GoalAction } from '@/lib/goal'
import { cn } from '@/lib/utils'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { TaskChecklist, TaskProgressBar, summarizeTodos } from '../TaskChecklist'
import { DoneWhenRow } from '../DoneWhenRow'
import { doneWhen as readDoneWhen } from '@/lib/work'
import { WorkSummary } from '../WorkSummary'

export interface TasksTabViewProps {
  todos: TodoItem[]
  sessionId: string | null
  /** The session's saved plan; its row sits above the task list. */
  plan?: SessionPlan | null
  onClearPlan?: () => void
  /** Open the plan in the Plan tab. */
  onOpenPlan?: () => void
  /** The session's goal; its row sits above the plan row. */
  goal?: SessionGoal | null
  /** Open the goal in the Goal tab. */
  onOpenGoal?: () => void
  /** Pause and Resume from the goal row. */
  onGoalAction?: (action: Extract<GoalAction, 'pause' | 'resume'>) => void
}

export function TasksTabView({ todos, sessionId, plan = null, onClearPlan, onOpenPlan, goal = null, onOpenGoal, onGoalAction }: TasksTabViewProps) {
  const scrollRef = useScrollMemory(sessionId ? `tasks:${sessionId}` : null)
  const summary = summarizeTodos(todos)
  const doneWhen = readDoneWhen(plan, { todos, goal })
  const planRow = (
    <WorkSummary
      goal={goal}
      plan={plan}
      todos={todos}
      onClearPlan={onClearPlan}
      onOpenPlan={onOpenPlan}
      onOpenGoal={onOpenGoal}
      onGoalAction={onGoalAction}
      className="px-3"
    />
  )

  if (summary.total === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {planRow}
        <div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <ListTodo size={16} aria-hidden="true" className="text-(--color-text-subtle)" />
          <p className="text-xs font-medium text-(--color-text-2)">
            {sessionId ? 'No tasks yet' : 'No active session'}
          </p>
          <p className="max-w-64 text-xs text-(--color-text-subtle)">
            {sessionId
              ? 'The agent lists its steps here when it plans multi-step work.'
              : 'Start a session to see the agent\u2019s task list.'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {planRow}
      <div className="flex h-(--spacing-toolbar) shrink-0 items-center px-3">
        <span
          className={cn(
            'font-mono text-[11px] tabular-nums',
            summary.allDone ? 'text-(--color-success)' : 'text-(--color-text-muted)',
          )}
        >
          {summary.finished}/{summary.total} done
        </span>
      </div>
      <TaskProgressBar summary={summary} />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">
        <TaskChecklist todos={todos} overflow="wrap" className="space-y-px p-1.5" />
        {doneWhen && <DoneWhenRow doneWhen={doneWhen} />}
      </div>
    </div>
  )
}
