/**
 * GoalTabView — the session's goal as a review-dock tab (the dock drawer on
 * phones): what the session is doing for the goal right now, the objective
 * (the approved plan's Done when), the plan it runs and how far its tasks
 * have got, how far the goal has got against its limits, what the last
 * check found or why it paused, and Pause, Resume and Clear.
 *
 * "Now" reads the session as well as the goal: a running turn, an open
 * question, Plan mode, queued messages and working subagents all decide
 * what the goal does next, so the tab names whichever applies.
 *
 * Colour carries the status only: blue while it works and once achieved,
 * orange while it waits on the user, red when blocked, neutral when paused.
 */
import { CircleCheck, Target } from 'lucide-react'
import type { SessionGoal, SessionPlan, TodoItem } from '@/api/types'
import { InlineCodeText } from '@/components/InlineCodeText'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import {
  formatGoalDuration,
  formatGoalTokens,
  goalNow,
  goalTurnNumber,
  isLiveGoal,
  pauseReasonText,
  type GoalAction,
  type GoalNow,
  type GoalSessionState,
  type GoalTone,
} from '@/lib/goal'
import { PLAN_STATUS_LABEL, nextTask, planStatus, type PlanStatus } from '@/lib/plan'
import { cn } from '@/lib/utils'
import { useGoalActionMutation, useSessionGoalQuery } from '@/queries/useSessionGoalQuery'
import { useSessionSubagentsQuery } from '@/queries/useSessionsQuery'
import { useAgentStore } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'
import { planTitle } from '../ActivePlanSection'
import { summarizeTodos } from '../TaskChecklist'
import { DockLoadError } from './DockLoadError'

const NOW_CLASS: Record<GoalTone, string> = {
  active: 'border-(--accent-blue)/35 bg-(--accent-blue-soft) text-(--accent-blue-text)',
  achieved: 'border-(--accent-blue)/35 bg-(--accent-blue-soft) text-(--accent-blue-text)',
  wait: 'border-(--accent-orange)/40 bg-(--accent-orange-soft) text-(--accent-orange-text)',
  paused: 'border-(--color-border) bg-(--bg-card) text-(--color-text-2)',
  blocked: 'border-(--color-error)/30 bg-(--color-error-subtle) text-(--color-error)',
}

const NO_GOAL_BODY = 'Approve a plan with Keep going until done and the agent works through it turn after turn until a check confirms its Done when.'

const PLAN_PILL_CLASS: Partial<Record<PlanStatus, string>> = {
  approved: 'bg-(--accent-green-soft) text-(--accent-green-text)',
  done: 'bg-(--accent-green-soft) text-(--accent-green-text)',
  review: 'bg-(--accent-orange-soft) text-(--accent-orange-text)',
}

/** The ring: filled and pulsing while the goal works, hollow while it waits or stopped. */
function GoalRing({ tone }: { tone: GoalTone }) {
  if (tone === 'achieved') return <CircleCheck size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative mt-[3px] size-3 shrink-0 rounded-full border-2 border-current',
        tone === 'active' && 'animate-pulse motion-reduce:animate-none',
      )}
    >
      {(tone === 'active' || tone === 'blocked') && <span className="absolute inset-[2px] rounded-full bg-current" />}
    </span>
  )
}

function NowLine({ now }: { now: GoalNow }) {
  return (
    <div role="status" data-goal-now={now.tone} className={cn('flex items-start gap-2.5 rounded-sm border px-3 py-2.5', NOW_CLASS[now.tone])}>
      <GoalRing tone={now.tone} />
      <div className="min-w-0">
        <p className="text-sm font-medium leading-snug">{now.text}</p>
        {now.note && <p className="mt-0.5 text-xs leading-relaxed text-(--color-text-2)">{now.note}</p>}
      </div>
    </div>
  )
}

function StatRow({ label, value, fraction }: { label: string; value: string; fraction?: number }) {
  return (
    <div className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-2">
      <span className="text-(--color-text-muted)">{label}</span>
      {fraction === undefined ? <span /> : (
        <span className="h-1.5 overflow-hidden rounded-full bg-(--bg-key)" aria-hidden="true">
          <span className="block h-full rounded-full bg-(--accent-blue)" style={{ width: `${Math.min(100, Math.max(2, fraction * 100))}%` }} />
        </span>
      )}
      <span className="font-mono text-[11px] tabular-nums text-(--color-text-2)">{value}</span>
    </div>
  )
}

/** Why it paused, what the check said, or why the last claim was not accepted. */
function goalNote(goal: SessionGoal): { title: string; text: string; detail: string | null } | null {
  if (goal.status === 'paused') return { title: 'Why it paused', text: pauseReasonText(goal), detail: goal.detail }
  if (goal.status === 'achieved') return { title: 'Check', text: goal.detail ?? 'The check confirmed the goal is met.', detail: null }
  if (goal.rejected_claims > 0 && goal.detail) return { title: 'Last check', text: `Not yet: ${goal.detail}`, detail: null }
  return null
}

/** The plan the goal runs: title, revision, status, and how far its tasks have got. */
function GoalPlanSection({ plan, status, todos, onOpenPlan }: {
  plan: SessionPlan
  status: PlanStatus
  todos: TodoItem[]
  onOpenPlan?: () => void
}) {
  const summary = summarizeTodos(todos)
  const title = planTitle(plan.content) ?? 'Session plan'
  return (
    <section aria-label="Plan" className="flex flex-col gap-1.5" data-goal-plan={status}>
      <h3 className="label-caps text-(--color-text-muted)">Plan</h3>
      <div className="flex flex-col gap-2 rounded-sm border border-(--color-border-subtle) bg-(--bg-card) px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-(--color-text)" title={title}>
            {title}
            {plan.revision !== undefined && <span className="ml-1.5 font-mono text-[11px] tabular-nums text-(--color-text-subtle)">rev {plan.revision}</span>}
          </span>
          <span className={cn('shrink-0 rounded-full px-2 py-px text-[11px] font-medium', PLAN_PILL_CLASS[status] ?? 'bg-(--bg-key) text-(--color-text-2)')}>
            {PLAN_STATUS_LABEL[status]}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-(--color-text-muted)">
            {summary.total > 0 ? `Tasks ${summary.finished}/${summary.total}` : 'No tasks yet'}
          </span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-(--bg-key)" aria-hidden="true">
            <span className="block h-full rounded-full bg-(--accent-blue)" style={{ width: `${summary.progressPct}%` }} />
          </span>
          {onOpenPlan && (
            <Button type="button" size="xs" variant="ghost" onClick={onOpenPlan}>
              Open plan
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}

/** The plan section's inputs: the plan and its task board, and how to open it. */
export interface GoalPlanContext {
  plan: SessionPlan
  todos: TodoItem[]
  /** Whether the plan's review is open. */
  reviewing: boolean
  onOpenPlan?: () => void
}

/** The tab body for one goal, given what the session is doing. */
export function GoalStatusPanel({ goal, session, busy, onAction, plan }: {
  goal: SessionGoal
  session: GoalSessionState
  busy: boolean
  onAction: (action: GoalAction) => void
  /** The session plan, shown under the objective. */
  plan?: GoalPlanContext | null
}) {
  const baseNow = goalNow(goal, session)
  const next = plan ? nextTask(plan.todos) : null
  // While the goal works with nothing else to say, the Now line names the
  // task its turns point at, as the turn reminders do.
  const now = baseNow && baseNow.tone === 'active' && !baseNow.note && next
    ? { ...baseNow, note: `Next task: ${next.content}` }
    : baseNow
  const turns = goalTurnNumber(goal, session.running)
  const tokens = goal.token_budget
    ? `${formatGoalTokens(goal.tokens_used)} / ${formatGoalTokens(goal.token_budget)}`
    : formatGoalTokens(goal.tokens_used)
  const note = goalNote(goal)
  return (
    <div className="flex flex-col gap-4 text-xs" data-goal-panel={goal.status}>
      {now && <NowLine now={now} />}
      <section aria-label="Objective" className="flex flex-col gap-1.5">
        <h3 className="label-caps text-(--color-text-muted)">Objective</h3>
        <p className="max-h-48 overflow-y-auto rounded-sm border border-(--color-border-subtle) bg-(--bg-card) px-3 py-2 leading-relaxed whitespace-pre-wrap text-(--color-text) selectable-text">
          <InlineCodeText text={goal.objective} />
        </p>
      </section>
      {plan && (
        <GoalPlanSection
          plan={plan.plan}
          status={planStatus(plan.plan, plan.reviewing, { todos: plan.todos, goal })}
          todos={plan.todos}
          onOpenPlan={plan.onOpenPlan}
        />
      )}
      <div className="flex flex-col gap-1.5">
        <StatRow label="Turns" value={`${turns} / ${goal.max_turns}`} fraction={turns / goal.max_turns} />
        <StatRow label="Tokens" value={tokens} fraction={goal.token_budget ? goal.tokens_used / goal.token_budget : undefined} />
        <StatRow label="Time" value={formatGoalDuration(goal.active_seconds)} />
      </div>
      {note && (
        <section aria-label={note.title} className="border-t border-(--color-border-subtle) pt-3 leading-relaxed text-(--color-text-2)">
          <h3 className="mb-0.5 text-[11px] font-medium text-(--color-text-muted)">{note.title}</h3>
          <p className="break-words selectable-text"><InlineCodeText text={note.text} /></p>
          {note.detail && <p className="mt-1 whitespace-pre-wrap break-words text-(--color-text) selectable-text"><InlineCodeText text={note.detail} /></p>}
        </section>
      )}
      {isLiveGoal(goal) && (
        <div className="flex flex-wrap gap-2">
          {goal.status === 'active' ? (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onAction('pause')} title="Let the current turn finish, then start no new one">
              Pause
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onAction('resume')}>
              Resume
            </Button>
          )}
          <Button size="sm" variant="danger-subtle" disabled={busy} onClick={() => onAction('clear')}>
            Clear goal
          </Button>
        </div>
      )}
    </div>
  )
}

/** The session state a goal reads, from the live stream (and subagents while it waits). */
function useGoalSessionState(sessionId: string | null, goal: SessionGoal | null): GoalSessionState {
  const running = useAgentStore((s) => s.isAgentWorking)
  const waitingForUser = useAgentStore((s) => Boolean(s.pendingQuestion) && s.pendingQuestion?.kind !== 'plan_review')
  const planReview = useAgentStore((s) => s.pendingQuestion?.kind === 'plan_review')
  const planMode = useAgentStore((s) => (s.sessionPendingInteractionMode ?? s.sessionInteractionMode) === 'plan')
  const queuedMessages = useAgentStore((s) => s._pendingMessages.length)
  // Only an active goal between turns waits on subagents.
  const { data: subagents } = useSessionSubagentsQuery(sessionId, goal?.status === 'active' && !running)
  const subagentsRunning = (subagents?.live_members ?? subagents?.subagents ?? []).filter((sub) => sub.status === 'working').length
  return { running, waitingForUser, planReview, planMode, queuedMessages, subagentsRunning }
}

export interface GoalTabViewProps {
  sessionId: string | null
  /** The session plan; its section sits under the objective. */
  plan?: SessionPlan | null
  todos?: TodoItem[]
  /** Open the plan in the Plan tab. */
  onOpenPlan?: () => void
}

export function GoalTabView({ sessionId, plan = null, todos = [], onOpenPlan }: GoalTabViewProps) {
  const { data, isLoading, isError, isFetching, refetch } = useSessionGoalQuery(sessionId)
  const goal = data?.goal && data.goal.status !== 'cleared' ? data.goal : null
  const session = useGoalSessionState(sessionId, goal)
  const reviewing = useAgentStore((s) => s.pendingQuestion?.kind === 'plan_review')
  const mutation = useGoalActionMutation()
  const pushToast = useToastStore((s) => s.push)

  const runAction = (action: GoalAction) => {
    if (!sessionId) return
    mutation.mutate({ sessionId, action }, {
      onError: (err) => pushToast({ tone: 'error', title: `Could not ${action} the goal`, description: (err as Error).message }),
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-goal-tab>
      <div className="flex h-(--spacing-toolbar) shrink-0 items-center gap-2 border-b border-(--color-border-subtle) pl-3 pr-1.5">
        <span className="text-xs font-medium text-(--color-text)">Goal</span>
        <span className="truncate text-[11px] text-(--color-text-subtle)">Turns run on their own until a check confirms it</span>
      </div>
      {sessionId && !data && isError ? (
        <DockLoadError message="Failed to load the goal." onRetry={() => void refetch()} retrying={isFetching} />
      ) : !sessionId || (!goal && !isLoading) ? (
        <EmptyState icon={Target} title="No goal" body={NO_GOAL_BODY} />
      ) : !goal ? (
        <p className="px-4 py-3 text-xs text-(--color-text-subtle)">Loading the goal…</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">
          <div className="mx-auto max-w-xl px-4 py-4 pb-safe">
            <GoalStatusPanel
              goal={goal}
              session={session}
              busy={mutation.isPending}
              onAction={runAction}
              plan={plan ? { plan, todos, reviewing, onOpenPlan } : null}
            />
          </div>
        </div>
      )}
    </div>
  )
}
