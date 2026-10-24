/**
 * GoalChip — the session's `/goal` beside the Code/Plan switch: how far it
 * has got, and its status to pause, resume, or clear it: a popover on
 * desktop, a bottom sheet on phones. Hidden without a goal, and once an
 * achieved goal is dismissed.
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Target } from 'lucide-react'
import type { SessionGoal } from '@/api/types'
import { InlineCodeText } from '@/components/InlineCodeText'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'
import { useIsMobile } from '@/hooks/use-mobile'
import { useModalFocus } from '@/hooks/useModalFocus'
import {
  formatGoalDuration,
  formatGoalTokens,
  goalChipState,
  goalTurnNumber,
  pauseReasonLabel,
  pauseReasonText,
  type GoalAction,
  type GoalTone,
} from '@/lib/goal'
import { DURATIONS_S } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { useGoalActionMutation, useSessionGoalQuery } from '@/queries/useSessionGoalQuery'
import { useGoalUiStore } from '@/stores/useGoalUiStore'
import { useToastStore } from '@/stores/useToastStore'

const TONE_CLASS: Record<GoalTone, string> = {
  active: 'border-(--accent-blue)/40 bg-(--accent-blue-soft) text-(--accent-blue-text)',
  wait: 'border-(--accent-orange)/40 bg-(--accent-orange-soft) text-(--accent-orange-text)',
  paused: 'border-(--color-border) bg-(--bg-card) text-(--color-text-muted)',
  blocked: 'border-(--color-error)/30 bg-(--color-error-subtle) text-(--color-error)',
  achieved: 'border-(--color-success)/30 bg-(--accent-green-soft) text-(--accent-green-text)',
}

/** The popover's status pill: the chip's tone, on a borderless pill. */
const BADGE_CLASS: Record<GoalTone, string> = {
  active: 'bg-(--accent-blue-soft) text-(--accent-blue-text)',
  wait: 'bg-(--accent-orange-soft) text-(--accent-orange-text)',
  paused: 'bg-(--bg-key) text-(--color-text-muted)',
  blocked: 'bg-(--color-error-subtle) text-(--color-error)',
  achieved: 'bg-(--accent-green-soft) text-(--accent-green-text)',
}

function badgeTone(goal: SessionGoal): GoalTone {
  if (goal.status === 'achieved') return 'achieved'
  if (goal.status === 'paused') return goal.pause_reason === 'blocked' ? 'blocked' : 'paused'
  return 'active'
}

/** The ring: filled while the goal runs, hollow while it waits. */
function GoalRing({ tone }: { tone: GoalTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative size-3 shrink-0 rounded-full border-2 border-current',
        tone === 'active' && 'animate-pulse motion-reduce:animate-none',
      )}
    >
      {tone !== 'paused' && <span className="absolute inset-[2px] rounded-full bg-current" />}
    </span>
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

function statusBadge(goal: SessionGoal, running: boolean): string {
  if (goal.status === 'achieved') return 'Achieved'
  if (goal.status === 'paused') return goal.pause_reason === 'blocked' ? 'Blocked' : `Paused · ${pauseReasonLabel(goal.pause_reason)}`
  return `Active · turn ${Math.max(1, goalTurnNumber(goal, running))}`
}

/** The popover body: objective, progress, why it stopped, and the actions. */
export function GoalStatusPanel({ goal, running, busy, onAction, onDismiss, onClose }: {
  goal: SessionGoal
  running: boolean
  busy: boolean
  onAction: (action: GoalAction) => void
  onDismiss?: () => void
  /** A Close action, for the phone sheet (the popover closes on an outside tap). */
  onClose?: () => void
}) {
  const turns = goalTurnNumber(goal, running)
  const tokens = goal.token_budget
    ? `${formatGoalTokens(goal.tokens_used)} / ${formatGoalTokens(goal.token_budget)}`
    : formatGoalTokens(goal.tokens_used)
  const note = goal.status === 'paused'
    ? { title: 'Why it paused', text: pauseReasonText(goal), detail: goal.detail }
    : goal.status === 'achieved'
      ? { title: 'Check', text: goal.detail ?? 'The check confirmed the goal is met.', detail: null }
      : goal.rejected_claims > 0 && goal.detail
        ? { title: 'Last check', text: `Not yet: ${goal.detail}`, detail: null }
        : null
  const tone = badgeTone(goal)
  return (
    <div className="flex flex-col gap-3" data-goal-panel>
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Target size={14} aria-hidden="true" />
        Goal
        <span data-goal-badge={tone} className={cn('ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium', BADGE_CLASS[tone])}>
          {statusBadge(goal, running)}
        </span>
      </div>
      <p className="max-h-32 overflow-y-auto rounded-xs border border-(--color-border-subtle) bg-(--bg-page) px-2.5 py-2 text-xs leading-relaxed whitespace-pre-wrap text-(--color-text-2) selectable-text">
        <InlineCodeText text={goal.objective} />
      </p>
      <div className="flex flex-col gap-1.5 text-xs">
        <StatRow label="Turns" value={`${turns} / ${goal.max_turns}`} fraction={turns / goal.max_turns} />
        <StatRow label="Tokens" value={tokens} fraction={goal.token_budget ? goal.tokens_used / goal.token_budget : undefined} />
        <StatRow label="Time" value={formatGoalDuration(goal.active_seconds)} />
      </div>
      {note && (
        <div className="border-t border-(--color-border-subtle) pt-2.5 text-xs leading-relaxed text-(--color-text-2)">
          <span className="mb-0.5 block text-[11px] font-medium text-(--color-text-muted)">{note.title}</span>
          <InlineCodeText text={note.text} />
          {note.detail && <span className="mt-1 block whitespace-pre-wrap text-(--color-text)"><InlineCodeText text={note.detail} /></span>}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {goal.status === 'active' && (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onAction('pause')} title="Let the current turn finish, then start no new one">
            Pause
          </Button>
        )}
        {goal.status === 'paused' && (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onAction('resume')}>
            Resume
          </Button>
        )}
        {(goal.status === 'active' || goal.status === 'paused') && (
          <Button size="sm" variant="danger-subtle" disabled={busy} onClick={() => onAction('clear')}>
            Clear goal
          </Button>
        )}
        {goal.status === 'achieved' && onDismiss && (
          <Button size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
        {onClose && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
            Close
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * The status as a bottom sheet (phones): modal, over the app's scrim, with
 * the panel's actions at touch size (``Button`` grows to 44px on touch).
 */
function GoalSheet({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }) {
  const { mounted, closing } = useDeferredUnmount(open, DURATIONS_S.fast * 1000)
  useModalFocus(open && mounted, () => onOpenChange(false))
  if (!mounted) return null
  return createPortal(
    <>
      <div
        aria-hidden="true"
        // An overlay over the edge-swipe zones must not open a drawer (see ui/dialog).
        data-swipe-ignore
        className={cn(
          'fixed inset-0 z-50 bg-(--color-overlay)',
          closing ? 'animate-out fade-out-0 animation-duration-(--motion-fast)' : 'animate-in fade-in-0 animation-duration-(--motion-fast)',
        )}
        onClick={() => onOpenChange(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Goal"
        data-modal-focus={open ? 'true' : undefined}
        data-swipe-ignore
        data-goal-sheet
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto overscroll-contain',
          'rounded-t-lg border-t border-(--color-border) bg-(--bg-card) px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]',
          'text-xs text-(--color-text) shadow-(--shadow-depth) outline-none ease-(--ease-sheet)',
          closing
            ? 'animate-out fade-out-0 motion-safe:slide-out-to-bottom animation-duration-(--motion-fast)'
            : 'animate-in fade-in-0 motion-safe:slide-in-from-bottom animation-duration-(--motion-base)',
        )}
      >
        {children}
      </div>
    </>,
    document.body,
  )
}

/** The chip: sized with the composer row (Code/Plan, attach, send), which does not grow on touch. */
const CHIP_CLASS = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm border px-2 text-xs whitespace-nowrap transition-colors duration-(--motion-fast) hover:brightness-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 md:h-7'

export function GoalChip({ sessionId, running, waitingForUser, planMode, open, onOpenChange }: {
  sessionId: string | null
  /** A turn is running. */
  running: boolean
  /** The agent asked the user something and waits for the answer. */
  waitingForUser: boolean
  planMode: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isMobile = useIsMobile()
  const { data } = useSessionGoalQuery(sessionId)
  const goal = data?.goal ?? null
  const dismissed = useGoalUiStore((s) => (goal ? s.dismissed.includes(goal.id) : false))
  const dismiss = useGoalUiStore((s) => s.dismiss)
  const mutation = useGoalActionMutation()
  const pushToast = useToastStore((s) => s.push)
  const state = goalChipState(goal, { running, waitingForUser, planMode })
  const hidden = !sessionId || !goal || !state || (goal.status === 'achieved' && dismissed)
  // A status left open must not pop up again with the next goal.
  useEffect(() => {
    if (hidden && open) onOpenChange(false)
  }, [hidden, open, onOpenChange])
  if (hidden) return null

  const runAction = (action: GoalAction) => {
    mutation.mutate({ sessionId, action }, {
      onSuccess: () => { if (action === 'clear') onOpenChange(false) },
      onError: (err) => pushToast({ tone: 'error', title: `Could not ${action} the goal`, description: (err as Error).message }),
    })
  }
  const label = `${state.label}. Show goal status`
  const chipBody = (
    <>
      <GoalRing tone={state.tone} />
      <span className={cn(state.tone === 'active' && 'font-mono text-[11px] tabular-nums')}>
        {isMobile ? state.short : state.label}
      </span>
    </>
  )
  const panel = (
    <GoalStatusPanel
      goal={goal}
      running={running}
      busy={mutation.isPending}
      onAction={runAction}
      onDismiss={() => { dismiss(goal.id); onOpenChange(false) }}
      onClose={isMobile ? () => onOpenChange(false) : undefined}
    />
  )

  if (isMobile) {
    return (
      <>
        <button
          type="button"
          className={cn(CHIP_CLASS, TONE_CLASS[state.tone])}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-goal-chip={state.tone}
          onClick={() => onOpenChange(!open)}
        >
          {chipBody}
        </button>
        <GoalSheet open={open} onOpenChange={onOpenChange}>{panel}</GoalSheet>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        className={cn(CHIP_CLASS, TONE_CLASS[state.tone])}
        aria-label={label}
        title={goal.objective}
        data-goal-chip={state.tone}
      >
        {chipBody}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-[min(22rem,calc(100vw-1rem))]">
        {panel}
      </PopoverContent>
    </Popover>
  )
}
