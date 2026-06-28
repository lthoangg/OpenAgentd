/**
 * TodosPopover — task-list popover surfaced from the team-chat topbar.
 *
 * Renders the agent's task list as a flat, scrollable checklist (no
 * kanban columns, no priority badges). Each row is a status-aware
 * icon + content line:
 *
 *   - pending     → empty circle (thin, muted)
 *   - in_progress → spinning loader (blue)
 *   - completed   → checkmark (green, content struck through + dimmed)
 *   - cancelled   → minus/dash (subtle, content struck through + dimmed)
 *
 * Sort order keeps the user's eye on what matters right now:
 *   in_progress → pending → completed → cancelled
 */

import { useMemo } from 'react'
import { Check, Circle, ListTodo, Loader2, Minus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TopbarAction } from '@/components/ui/topbar-action'
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'
import { cn } from '@/lib/utils'
import type { TodoItem } from '@/api/types'

// ── Status → row style ──────────────────────────────────────────────────────

const STATUS_ICON: Record<TodoItem['status'], LucideIcon> = {
  completed: Check,
  cancelled: Minus,
  in_progress: Loader2,
  pending: Circle,
}

const STATUS_ICON_COLOR: Record<TodoItem['status'], string> = {
  completed: 'text-(--color-success)',
  cancelled: 'text-(--color-text-subtle)',
  in_progress: 'text-(--color-info)',
  pending: 'text-(--color-text-muted)',
}

// Sort priority for the flat list — most actionable first.
const STATUS_ORDER: Record<TodoItem['status'], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
}

function getAgentLabel(todo: TodoItem): string | null {
  return todo.claimed_by ?? todo.assigned_to ?? null
}

// ── Component ────────────────────────────────────────────────────────────────

interface TodosPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  todos: TodoItem[]
  /** When null/undefined the trigger is disabled (no active session). */
  sessionId: string | null
  /** Render the topbar trigger. Set false when another control opens this popover. */
  trigger?: boolean
}

export function TodosPopover({
  open,
  onOpenChange,
  todos,
  sessionId,
  trigger = true,
}: TodosPopoverProps) {
  // "Finished" includes cancelled — once a task leaves the active set
  // (whether shipped or dropped) it no longer needs attention.
  const finishedCount = todos.filter(
    (t) => t.status === 'completed' || t.status === 'cancelled',
  ).length
  const hasInProgress = todos.some((t) => t.status === 'in_progress')
  const progressLabel =
    todos.length > 0 ? `${finishedCount}/${todos.length}` : undefined
  const progressPct =
    todos.length > 0 ? Math.round((finishedCount / todos.length) * 100) : 0
  const allDone = todos.length > 0 && finishedCount === todos.length
  const sortedTodos = useMemo(
    () => [...todos].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]),
    [todos],
  )

  const { mounted, closing } = useDeferredUnmount(open, 100)

  const content = (
    <>
      {/* Header: title + completion counter + thin progress bar. */}
      <div className="border-b border-(--color-border) bg-(--color-surface)/30">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-(--color-text-2)">
            <ListTodo size={11} aria-hidden="true" className="text-(--color-text-muted)" />
            Tasks
          </span>
          {todos.length > 0 && (
            <span
              className={`font-mono text-[10px] tabular-nums tracking-wide ${
                allDone ? 'text-(--color-success)' : 'text-(--color-text-subtle)'
              }`}
            >
              {finishedCount}/{todos.length} done
            </span>
          )}
        </div>
        {/* Slim progress track — only meaningful when there are tasks. */}
        {todos.length > 0 && (
          <div
            className="h-0.5 w-full bg-(--color-border)"
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Task completion"
          >
            <div
              className={`h-full rounded-r-full transition-[width] duration-500 ease-out ${
                allDone ? 'bg-(--color-success)' : 'bg-(--color-info)'
              }`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </div>

      {todos.length === 0 ? (
        <div
          role="status"
          className="flex flex-col items-center gap-1 px-3 py-6 text-center"
        >
          <ListTodo
            size={16}
            aria-hidden="true"
            className="text-(--color-text-subtle) opacity-40"
          />
          <p className="text-xs text-(--color-text-subtle)">
            No tasks yet
          </p>
        </div>
      ) : (
        <ul
          aria-label="Task list"
          className="scrollbar-none max-h-[min(50vh,20rem)] overflow-y-auto overscroll-contain p-1"
        >
          {sortedTodos.map((todo) => {
            const Icon = STATUS_ICON[todo.status]
            const isStruck =
              todo.status === 'completed' || todo.status === 'cancelled'
            const isInProgress = todo.status === 'in_progress'
            const agent = getAgentLabel(todo)
            return (
              <li
                key={todo.task_id}
                className={cn(
                  'group relative flex items-start gap-2 rounded px-2 py-1 transition-colors',
                  isInProgress
                    ? 'bg-(--color-info-subtle)/20'
                    : 'hover:bg-(--color-surface)/60'
                )}
              >
                <span className="relative mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  <Icon
                    size={12}
                    aria-hidden="true"
                    className={cn(
                      STATUS_ICON_COLOR[todo.status],
                      isInProgress && 'animate-spin'
                    )}
                  />
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 text-xs leading-snug',
                    isStruck
                      ? 'text-(--color-text-subtle) line-through decoration-(--color-text-subtle)/40'
                      : isInProgress
                        ? 'font-medium text-(--color-text)'
                        : 'text-(--color-text-2)'
                  )}
                >
                  {todo.content}
                </span>
                {agent && (
                  <span
                    className="mt-0.5 shrink-0 rounded-xs border border-(--color-border) bg-(--bg-page) px-1 py-0.5 font-mono text-[8px] uppercase tracking-wider text-(--color-text-muted)"
                    title={`Assigned to ${agent}`}
                  >
                    {agent}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )

  if (!trigger) {
    if (!mounted) return null
    return (
      <div className="fixed inset-0 z-50 pointer-events-none" role="presentation">
        {/*
          The dismiss backdrop must NOT cover the app header — otherwise a
          tap on the Tasks / Files / panel buttons lands on the backdrop
          (closing this popover) instead of toggling the target surface.
          Start it below the header so those header actions stay live.
        */}
        <button
          type="button"
          className={cn(
            'absolute inset-x-0 bottom-0 top-[calc(var(--spacing-app-header)+env(safe-area-inset-top,0px))] cursor-default bg-black/15 backdrop-blur-[1px] transition-opacity duration-100 ease-out pointer-events-auto',
            closing ? 'opacity-0' : 'opacity-100'
          )}
          aria-label="Close tasks"
          onClick={() => onOpenChange(false)}
        />
        <section
          role="dialog"
          aria-label="Tasks"
          className={cn(
            'absolute right-2 top-[calc(var(--spacing-app-header)+env(safe-area-inset-top,0px)+0.5rem)] w-[min(calc(100vw-1rem),20rem)] overflow-hidden rounded-lg border border-(--color-border) bg-(--bg-card) p-0 shadow-lg ring-1 ring-black/5 duration-100 ease-out pointer-events-auto',
            closing
              ? 'animate-out fade-out-0 zoom-out-95'
              : 'animate-in fade-in-0 zoom-in-95'
          )}
        >
          {content}
        </section>
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {trigger && (
        <PopoverTrigger
          render={
            <TopbarAction
              Icon={ListTodo}
              indicator={hasInProgress}
              badge={progressLabel}
              title={sessionId ? 'Task list (Ctrl+T)' : 'No active session'}
              aria-label="Task list"
              // Selected/active highlight while the popover is open — matches
              // the Files / Agents active treatment in the topbar so the
              // whole cluster reads consistently (team + coding modes).
              data-state={open ? 'open' : 'closed'}
              className={
                open
                  ? 'border border-(--color-border-strong) bg-(--bg-key) text-(--color-text)'
                  : undefined
              }
            />
          }
          disabled={!sessionId}
        />
      )}
      <PopoverContent
        side="bottom"
        align="end"
        // ``ring-0`` cancels the shadcn default; outline comes from the
        // ``--color-border`` ring so the chrome matches Files / Agents.
        className="w-[min(calc(100vw-1rem),20rem)] overflow-hidden rounded-lg border border-(--color-border) bg-(--bg-card) p-0 shadow-lg ring-1 ring-black/5"
      >
        {content}
      </PopoverContent>
    </Popover>
  )
}
