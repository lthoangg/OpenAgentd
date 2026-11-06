/**
 * TodosPopover — the agent task list: a panel under the app header, and on a
 * phone a bottom sheet with two detents.
 *
 * Mobile (and desktop without a workspace, where there is no review dock)
 * opens this from the header Tasks button. On desktop with a workspace the
 * same checklist lives in the review dock's Tasks tab instead.
 *
 * A phone (touch and narrow, ``useIsPhone``) gets the list in a ``BottomSheet``
 * that opens at medium, with the chat still in view, and pulls up to large for
 * a long list or the plan and goal rows. The sheet closes by its own gestures
 * (a pull down, the backdrop, Escape) and by Done, for a hand that does not
 * drag. A narrow mouse window and a tablet keep the panel.
 */
import { ListTodo } from 'lucide-react'
import { useRef } from 'react'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import type { SheetDetent } from '@/components/ui/_sheet'
import { Button } from '@/components/ui/button'
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'
import { usePresenceMotion } from '@/components/ui/_use-presence-motion'
import { EmptyState } from '@/components/ui/empty-state'
import { useIsPhone } from '@/hooks/use-is-phone'
import { KeyLayerScope, useKeyLayer } from '@/lib/keyboard/hooks'
import { DURATIONS_S } from '@/lib/motion'
import { cn } from '@/lib/utils'
import type { SessionGoal, SessionPlan, TodoItem } from '@/api/types'
import type { GoalAction } from '@/lib/goal'
import { TaskChecklist, TaskProgressBar, summarizeTodos } from './TaskChecklist'
import { DoneWhenRow } from './DoneWhenRow'
import { doneWhen as readDoneWhen } from '@/lib/work'
import { WorkSummary } from './WorkSummary'

interface TodosPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  todos: TodoItem[]
  /** The session's goal; its row sits above the plan row. */
  goal?: SessionGoal | null
  /** The session's saved plan; its row sits under the header. */
  plan?: SessionPlan | null
  onClearPlan?: () => void
  /** Open the plan in the dock's Plan tab (sessions with a workspace). */
  onOpenPlan?: () => void
  /** Open the goal in the dock's Goal tab (sessions with a workspace). */
  onOpenGoal?: () => void
  /** Pause and Resume from the goal row. */
  onGoalAction?: (action: Extract<GoalAction, 'pause' | 'resume'>) => void
}

/** The phone sheet opens at medium and pulls up to large. */
const SHEET_DETENTS: SheetDetent[] = ['medium', 'large']

export function TodosPopover(props: TodosPopoverProps) {
  return useIsPhone() ? <TodosSheet {...props} /> : <TodosPanel {...props} />
}

/** A phone's Tasks: the list in a bottom sheet, resting at medium. */
function TodosSheet({ open, onOpenChange, todos, goal = null, plan = null, onClearPlan, onOpenPlan, onOpenGoal, onGoalAction }: TodosPopoverProps) {
  const summary = summarizeTodos(todos)
  const doneWhen = readDoneWhen(plan, { todos, goal })
  return (
    <BottomSheet open={open} onClose={() => onOpenChange(false)} label="Tasks" detents={SHEET_DETENTS} initialDetent="medium">
      <div className="pb-2">
        <div className="flex items-center gap-2 px-4 pb-1">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-(--color-text)">Tasks</h2>
            {summary.total > 0 && (
              <p className={cn('text-meta text-(--color-text-muted)', summary.allDone && 'text-(--accent-green-text)')}>
                {summary.finished} of {summary.total} done
              </p>
            )}
          </div>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} className="-mr-2 text-(--color-accent)!">
            Done
          </Button>
        </div>
        <WorkSummary
          goal={goal}
          plan={plan}
          todos={todos}
          // Rows are 44px to a finger; the plan and goal rows grow with them.
          className="min-h-11 [&_button]:min-h-11"
          onClearPlan={onClearPlan}
          onOpenPlan={onOpenPlan ? () => { onOpenChange(false); onOpenPlan() } : undefined}
          onOpenGoal={onOpenGoal ? () => { onOpenChange(false); onOpenGoal() } : undefined}
          onGoalAction={onGoalAction}
        />
        {summary.total > 0 && <TaskProgressBar summary={summary} />}
        {summary.total === 0 ? (
          <EmptyState fill={false} icon={ListTodo} title="No tasks yet" className="px-3 py-8" />
        ) : (
          <>
            {/* The sheet's body scrolls, so the list has no height of its own.
                A task wraps rather than truncating: there is no tooltip to read it in. */}
            <TaskChecklist todos={todos} overflow="wrap" className="px-2 py-1 [&_li]:py-3 [&_p]:leading-snug" />
            {doneWhen && <DoneWhenRow doneWhen={doneWhen} />}
          </>
        )}
      </div>
    </BottomSheet>
  )
}

function TodosPanel({ open, onOpenChange, todos, goal = null, plan = null, onClearPlan, onOpenPlan, onOpenGoal, onGoalAction }: TodosPopoverProps) {
  const summary = summarizeTodos(todos)
  const doneWhen = readDoneWhen(plan, { todos, goal })
  const { mounted, closing } = useDeferredUnmount(open, DURATIONS_S.fast * 1000)
  // Grows from the Tasks button's corner at ``fast`` and leaves the same way;
  // a reopen mid-exit turns back from where it is.
  const panelRef = useRef<HTMLElement>(null)
  usePresenceMotion(panelRef, mounted, closing, { enter: DURATIONS_S.fast })
  const layer = useKeyLayer(open, { kind: 'transient', onClose: () => onOpenChange(false) })
  if (!mounted) return null

  return (
    <KeyLayerScope layer={layer}>
    <div
      className="fixed inset-0 z-70 pointer-events-none"
      role="presentation"
      // Not tracked by useEdgeSwipe's drawer set — without this an
      // edge-zone touch on the backdrop/panel is read as a fresh "open"
      // gesture for the sidebar/actions drawer underneath.
      data-swipe-ignore
    >
      {/*
        The dismiss backdrop must NOT cover the app header — otherwise a
        tap on the Tasks / Files / panel buttons lands on the backdrop
        (closing this popover) instead of toggling the target surface.
        Start it below the header so those header actions stay live.
      */}
      <button
        type="button"
        className={cn(
          'absolute inset-x-0 bottom-0 top-[calc(var(--spacing-app-header)+env(safe-area-inset-top,0px))] cursor-default bg-transparent transition-opacity duration-(--motion-fast) ease-(--ease-out) pointer-events-auto',
          closing ? 'opacity-0' : 'opacity-100',
        )}
        aria-label="Close tasks"
        onClick={() => onOpenChange(false)}
      />
      <section
        ref={panelRef}
        role="dialog"
        aria-label="Tasks"
        className="absolute right-2 top-[calc(var(--spacing-app-header)+env(safe-area-inset-top,0px)+0.5rem)] w-[min(calc(100vw-1rem),20rem)] origin-top-right overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card) p-0 shadow-(--shadow-depth) pointer-events-auto"
      >
        <div className="flex items-center justify-between border-b border-(--color-border-subtle) px-2.5 py-2">
          <span className="text-meta font-medium text-(--color-text)">Tasks</span>
          {summary.total > 0 && (
            <span
              className={cn(
                'font-mono text-xs tabular-nums text-(--color-text-subtle) md:text-meta',
                summary.allDone && 'text-(--accent-green-text)',
              )}
            >
              {summary.finished}/{summary.total} done
            </span>
          )}
        </div>
        <WorkSummary
          goal={goal}
          plan={plan}
          todos={todos}
          onClearPlan={onClearPlan}
          onOpenPlan={onOpenPlan ? () => { onOpenChange(false); onOpenPlan() } : undefined}
          onOpenGoal={onOpenGoal ? () => { onOpenChange(false); onOpenGoal() } : undefined}
          onGoalAction={onGoalAction}
        />
        {summary.total > 0 && <TaskProgressBar summary={summary} />}
        {summary.total === 0 ? (
          <EmptyState fill={false} icon={ListTodo} title="No tasks yet" className="px-3 py-5" />
        ) : (
          <div className="scrollbar-none max-h-[min(46vh,17rem)] overflow-y-auto overscroll-contain">
            <TaskChecklist todos={todos} className="px-1.5 py-1" />
            {doneWhen && <DoneWhenRow doneWhen={doneWhen} />}
          </div>
        )}
      </section>
    </div>
    </KeyLayerScope>
  )
}
