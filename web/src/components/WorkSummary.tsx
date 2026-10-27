/**
 * WorkSummary — the session's plan and goal as one header above the task
 * list (the Tasks tab, the header's task popover).
 *
 * A goal runs an approved plan until a check confirms its Done when, and the
 * tasks track the plan's milestones, so the three read together. While a goal
 * runs the plan, the plan row carries the one status ("Approved · Running")
 * and the goal row under it only adds the turn, with Pause or Resume. A goal
 * that runs something else keeps its own status row.
 */
import { CircleCheck } from 'lucide-react'
import type { SessionGoal, SessionPlan, TodoItem } from '@/api/types'
import { Button } from '@/components/ui/button'
import { goalStatusTone, goalTurnNumber, pauseReasonLabel, type GoalAction, type GoalTone } from '@/lib/goal'
import { isPlanGoal, planStatus } from '@/lib/plan'
import { workStatusLabel } from '@/lib/work'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@/stores/useAgentStore'
import { ActivePlanSection } from './ActivePlanSection'

const TONE_CLASS: Record<GoalTone, string> = {
  active: 'text-(--accent-blue-text)',
  achieved: 'text-(--accent-blue-text)',
  wait: 'text-(--accent-orange-text)',
  paused: 'text-(--color-text-2)',
  blocked: 'text-(--color-error)',
}

/** One line on what a goal is doing: "Working · turn 3/50", "Paused: turn limit", "Achieved". */
export function goalSummaryText(goal: SessionGoal, running: boolean): string {
  switch (goalStatusTone(goal)) {
    case 'achieved': return 'Achieved'
    case 'blocked': return 'Blocked'
    case 'paused': return `Paused: ${pauseReasonLabel(goal.pause_reason)}`
    default: return `Working · turn ${Math.max(1, goalTurnNumber(goal, running))}/${goal.max_turns}`
  }
}

function GoalMark({ tone }: { tone: GoalTone }) {
  if (tone === 'achieved') return <CircleCheck size={12} aria-hidden="true" className="shrink-0" />
  return (
    <span
      aria-hidden="true"
      className={cn('relative size-2.5 shrink-0 rounded-full border-2 border-current', tone === 'active' && 'animate-pulse motion-reduce:animate-none')}
    >
      {tone === 'active' && <span className="absolute inset-px rounded-full bg-current" />}
    </span>
  )
}

export function GoalSummaryRow({ goal, onOpen, onAction, bare = false, className }: {
  goal: SessionGoal
  onOpen?: () => void
  /** Pause and Resume; without it the row has no buttons. */
  onAction?: (action: Extract<GoalAction, 'pause' | 'resume'>) => void
  /** The plan row above already says how the goal stands: show only its turn. */
  bare?: boolean
  className?: string
}) {
  const running = useAgentStore((s) => s.isAgentWorking)
  const tone = goalStatusTone(goal)
  const turn = Math.max(1, goalTurnNumber(goal, running))
  const text = bare && goal.status !== 'achieved' ? `Turn ${turn}/${goal.max_turns}` : goalSummaryText(goal, running)
  return (
    <div className={cn('flex shrink-0 items-center gap-2 border-b border-(--color-border-subtle) px-2.5 py-1', className)} data-goal-summary={goal.status}>
      <span className={cn('flex shrink-0 items-center', TONE_CLASS[tone])}><GoalMark tone={tone} /></span>
      <span className="text-xs font-medium text-(--color-text)">Goal</span>
      <span className={cn('shrink-0 text-[11px] font-medium', TONE_CLASS[tone])}>{text}</span>
      {bare ? <span className="flex-1" aria-hidden="true" /> : (
        <span className="min-w-0 flex-1 truncate text-xs text-(--color-text-subtle)" title={goal.objective}>{goal.objective}</span>
      )}
      {onAction && goal.status === 'active' && (
        <Button type="button" variant="ghost" size="xs" onClick={() => onAction('pause')} title="Let the current turn finish, then start no new one">
          Pause
        </Button>
      )}
      {onAction && goal.status === 'paused' && (
        <Button type="button" variant="ghost" size="xs" onClick={() => onAction('resume')}>
          Resume
        </Button>
      )}
      {onOpen && (
        <Button type="button" variant="ghost" size="xs" onClick={onOpen} aria-label="Open goal">
          Open
        </Button>
      )}
    </div>
  )
}

export interface WorkSummaryProps {
  /** The session's goal, as its parent already queried it. */
  goal?: SessionGoal | null
  plan: SessionPlan | null
  todos: readonly TodoItem[]
  /** Stop using the plan in this session; without it the plan row is not shown. */
  onClearPlan?: () => void
  onOpenPlan?: () => void
  onOpenGoal?: () => void
  /** Pause and Resume from the goal row. */
  onGoalAction?: (action: Extract<GoalAction, 'pause' | 'resume'>) => void
  className?: string
}

/** The goal row (while the session has one) over the plan row (while it has a plan). */
export function WorkSummary({ goal: rawGoal = null, plan, todos, onClearPlan, onOpenPlan, onOpenGoal, onGoalAction, className }: WorkSummaryProps) {
  const reviewing = useAgentStore((s) => s.pendingQuestion?.kind === 'plan_review')
  const goal = rawGoal && rawGoal.status !== 'cleared' ? rawGoal : null
  const planRow = plan && onClearPlan
  if (!goal && !planRow) return null
  // The goal runs this plan: one status, on the plan row.
  const merged = Boolean(goal && planRow && isPlanGoal(goal, plan))
  const showGoalStatus = goal && goal.status !== 'achieved' ? goalStatusTone(goal) : null
  return (
    <div className="shrink-0" data-work-summary>
      {goal && !merged && <GoalSummaryRow goal={goal} onOpen={onOpenGoal} onAction={onGoalAction} className={className} />}
      {planRow && (
        <ActivePlanSection
          plan={plan}
          status={planStatus(plan, reviewing, { todos, goal })}
          statusLabel={merged ? workStatusLabel(plan, reviewing, { todos, goal }) : undefined}
          statusClassName={merged && showGoalStatus ? TONE_CLASS[showGoalStatus] : undefined}
          onClear={onClearPlan}
          onOpen={onOpenPlan}
          className={className}
        />
      )}
      {goal && merged && <GoalSummaryRow goal={goal} onOpen={onOpenGoal} onAction={onGoalAction} bare className={className} />}
    </div>
  )
}
