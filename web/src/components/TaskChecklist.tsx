/**
 * TaskChecklist — the agent's task list as a flat, status-aware checklist.
 *
 * Shared by the mobile Tasks popover and the desktop review-dock Tasks tab.
 * Each row is a status icon + content line:
 *
 *   - pending     → empty circle (thin, muted)
 *   - in_progress → spinning loader (info)
 *   - completed   → checkmark (success, content struck through + dimmed)
 *   - cancelled   → minus/dash (subtle, content struck through + dimmed)
 *
 * Sort order keeps the eye on what matters right now:
 *   in_progress → pending → completed → cancelled
 */
import { useMemo } from 'react'
import { Check, Circle, Loader2, Minus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { TodoItem } from '@/api/types'

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

const STATUS_ORDER: Record<TodoItem['status'], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
}

export interface TodoSummary {
  total: number
  /** Completed + cancelled: once a task leaves the active set it needs no attention. */
  finished: number
  hasInProgress: boolean
  /** ``"finished/total"``, or undefined for an empty list. */
  progressLabel: string | undefined
  progressPct: number
  allDone: boolean
}

export function summarizeTodos(todos: TodoItem[]): TodoSummary {
  const finished = todos.filter((t) => t.status === 'completed' || t.status === 'cancelled').length
  const total = todos.length
  return {
    total,
    finished,
    hasInProgress: todos.some((t) => t.status === 'in_progress'),
    progressLabel: total > 0 ? `${finished}/${total}` : undefined,
    progressPct: total > 0 ? Math.round((finished / total) * 100) : 0,
    allDone: total > 0 && finished === total,
  }
}

/** 1px completion bar; doubles as the divider under a header or toolbar. */
export function TaskProgressBar({ summary }: { summary: TodoSummary }) {
  return (
    <div
      className="h-px w-full shrink-0 bg-(--color-border-subtle)"
      role="progressbar"
      aria-valuenow={summary.progressPct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Task completion"
    >
      <div
        className={cn(
          'h-full transition-[width] duration-(--motion-base) ease-out',
          summary.allDone ? 'bg-(--color-success)' : 'bg-(--color-info)',
        )}
        style={{ width: `${summary.progressPct}%` }}
      />
    </div>
  )
}

export interface TaskChecklistProps {
  todos: TodoItem[]
  /**
   * ``truncate`` keeps each row to one line with the full text in a tooltip
   * (popover); ``wrap`` lets long tasks wrap (dock tab, where width varies).
   */
  overflow?: 'truncate' | 'wrap'
  className?: string
}

export function TaskChecklist({ todos, overflow = 'truncate', className }: TaskChecklistProps) {
  const sortedTodos = useMemo(
    () => [...todos].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]),
    [todos],
  )
  return (
    <ul aria-label="Task list" className={className}>
      {sortedTodos.map((todo) => {
        const Icon = STATUS_ICON[todo.status]
        const isStruck = todo.status === 'completed' || todo.status === 'cancelled'
        const isInProgress = todo.status === 'in_progress'
        const textClass = cn(
          'text-xs leading-4',
          overflow === 'truncate' ? 'truncate' : 'break-words',
          isStruck
            ? 'text-(--color-text-subtle) line-through decoration-(--color-text-subtle)/40'
            : isInProgress
              ? 'font-medium text-(--color-text)'
              : 'text-(--color-text-2)',
        )
        return (
          <li
            key={todo.task_id}
            data-status={todo.status}
            className={cn(
              'flex gap-2 rounded-sm px-2 py-1.5 transition-colors',
              overflow === 'truncate' ? 'items-center' : 'items-start',
              isInProgress ? 'bg-(--color-info-subtle) text-(--color-text)' : 'hover:bg-(--bg-key)/50',
            )}
          >
            <Icon
              size={12}
              aria-hidden="true"
              className={cn(
                'shrink-0',
                overflow === 'wrap' && 'mt-0.5',
                STATUS_ICON_COLOR[todo.status],
                isInProgress && 'animate-spin',
              )}
            />
            <div className="min-w-0 flex-1">
              {overflow === 'truncate' ? (
                <Tooltip className="w-full">
                  <TooltipTrigger render={<div className={textClass}>{todo.content}</div>} />
                  <TooltipContent>{todo.content}</TooltipContent>
                </Tooltip>
              ) : (
                <p className={textClass}>{todo.content}</p>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
