/**
 * WorkSummary — the session's goal and plan as one strip above the task
 * list (the Tasks tab, the header's task popover).
 *
 * A goal runs an approved plan until a check confirms its Done when, and the
 * tasks track the plan's milestones, so the three read together: the goal
 * row says what the goal is doing, and the plan row says where the plan
 * stands (Done once its goal is achieved or every task is finished).
 */
import { CircleCheck } from 'lucide-react'
import type { SessionGoal, SessionPlan, TodoItem } from '@/api/types'
import { Button } from '@/components/ui/button'
import { goalStatusTone, goalTurnNumber, pauseReasonLabel, type GoalTone } from '@/lib/goal'
import { planStatus } from '@/lib/plan'
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

export function GoalSummaryRow({ goal, onOpen, className }: { goal: SessionGoal; onOpen?: () => void; className?: string }) {
  const running = useAgentStore((s) => s.isAgentWorking)
  const tone = goalStatusTone(goal)
  const text = goalSummaryText(goal, running)
  return (
    <div className={cn('flex shrink-0 items-center gap-2 border-b border-(--color-border-subtle) px-2.5 py-1', className)} data-goal-summary={goal.status}>
      <span className={cn('flex shrink-0 items-center', TONE_CLASS[tone])}><GoalMark tone={tone} /></span>
      <span className="text-xs font-medium text-(--color-text)">Goal</span>
      <span className={cn('shrink-0 text-[11px] font-medium', TONE_CLASS[tone])}>{text}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-(--color-text-subtle)" title={goal.objective}>{goal.objective}</span>
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
  className?: string
}

/** The goal row (while the session has one) over the plan row (while it has a plan). */
export function WorkSummary({ goal: rawGoal = null, plan, todos, onClearPlan, onOpenPlan, onOpenGoal, className }: WorkSummaryProps) {
  const reviewing = useAgentStore((s) => s.pendingQuestion?.kind === 'plan_review')
  const goal = rawGoal && rawGoal.status !== 'cleared' ? rawGoal : null
  const planRow = plan && onClearPlan
  if (!goal && !planRow) return null
  return (
    <div className="shrink-0" data-work-summary>
      {goal && <GoalSummaryRow goal={goal} onOpen={onOpenGoal} className={className} />}
      {planRow && (
        <ActivePlanSection
          plan={plan}
          status={planStatus(plan, reviewing, { todos, goal })}
          onClear={onClearPlan}
          onOpen={onOpenPlan}
          className={className}
        />
      )}
    </div>
  )
}
