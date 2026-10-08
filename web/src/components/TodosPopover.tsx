/**
 * TodosPopover — the agent task list as a panel under the app header.
 *
 * Mobile (and desktop without a workspace, where there is no review dock)
 * opens this from the header Tasks button. On desktop with a workspace the
 * same checklist lives in the review dock's Tasks tab instead.
 */
import { ListTodo } from 'lucide-react'
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'
import { useKeyLayer } from '@/lib/keyboard/hooks'
import { cn } from '@/lib/utils'
import type { SessionPlan, TodoItem } from '@/api/types'
import { ActivePlanSection } from './ActivePlanSection'
import { TaskChecklist, TaskProgressBar, summarizeTodos } from './TaskChecklist'

interface TodosPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  todos: TodoItem[]
  /** The session's saved plan; its row sits under the header. */
  plan?: SessionPlan | null
  onClearPlan?: () => void
  /** Open the plan in the dock's Plan tab (sessions with a workspace). */
  onOpenPlan?: () => void
}

export function TodosPopover({ open, onOpenChange, todos, plan = null, onClearPlan, onOpenPlan }: TodosPopoverProps) {
  const summary = summarizeTodos(todos)
  const { mounted, closing } = useDeferredUnmount(open, 100)
  useKeyLayer(open, { kind: 'transient', onClose: () => onOpenChange(false) })
  if (!mounted) return null

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none"
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
          'absolute inset-x-0 bottom-0 top-[calc(var(--spacing-app-header)+env(safe-area-inset-top,0px))] cursor-default bg-transparent transition-opacity duration-(--motion-instant) ease-out pointer-events-auto',
          closing ? 'opacity-0' : 'opacity-100',
        )}
        aria-label="Close tasks"
        onClick={() => onOpenChange(false)}
      />
      <section
        role="dialog"
        aria-label="Tasks"
        className={cn(
          'absolute right-2 top-[calc(var(--spacing-app-header)+env(safe-area-inset-top,0px)+0.5rem)] w-[min(calc(100vw-1rem),20rem)] overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card) p-0 shadow-(--shadow-depth) pointer-events-auto',
          closing
            ? 'animate-out fade-out-0 zoom-out-95 duration-(--motion-instant) ease-out'
            : 'animate-in fade-in-0 duration-(--motion-instant) ease-out',
        )}
      >
        <div className="flex items-center justify-between border-b border-(--color-border-subtle) px-2.5 py-2">
          <span className="text-[11px] font-medium text-(--color-text)">Tasks</span>
          {summary.total > 0 && (
            <span
              className={cn(
                'font-mono text-xs tabular-nums text-(--color-text-subtle) md:text-[11px]',
                summary.allDone && 'text-(--color-success)',
              )}
            >
              {summary.finished}/{summary.total} done
            </span>
          )}
        </div>
        {plan && onClearPlan && (
          <ActivePlanSection
            plan={plan}
            onClear={onClearPlan}
            onOpen={onOpenPlan ? () => { onOpenChange(false); onOpenPlan() } : undefined}
          />
        )}
        {summary.total > 0 && <TaskProgressBar summary={summary} />}
        {summary.total === 0 ? (
          <div role="status" className="flex flex-col items-center gap-1 px-3 py-5 text-center">
            <ListTodo size={14} aria-hidden="true" className="text-(--color-text-subtle) opacity-40" />
            <p className="text-xs text-(--color-text-subtle)">No tasks yet</p>
          </div>
        ) : (
          <TaskChecklist
            todos={todos}
            className="scrollbar-none max-h-[min(46vh,17rem)] overflow-y-auto overscroll-contain px-1.5 py-1"
          />
        )}
      </section>
    </div>
  )
}
