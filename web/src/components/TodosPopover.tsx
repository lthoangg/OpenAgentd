/**
 * TodosPopover — task-list popover surfaced from the team-chat topbar.
 *
 * Renders the agent's task list as a flat, scrollable checklist (no
 * kanban columns, no priority badges). Each row is a status-aware
 * checkbox + content line:
 *
 *   - pending    → empty square
 *   - in_progress → empty square with a breathing pulse (animate-pulse)
 *   - completed  → checked square, content struck through + dimmed
 *   - cancelled  → empty square, content struck through + dimmed
 *
 * Sort order keeps the user's eye on what matters right now:
 *   in_progress → pending → completed → cancelled
 */

import { ListTodo, Square, SquareCheck, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TopbarAction } from '@/components/ui/topbar-action'
import type { TodoItem } from '@/api/types'

// ── Status → row style ──────────────────────────────────────────────────────

const STATUS_ICON: Record<TodoItem['status'], LucideIcon> = {
  completed: SquareCheck,
  cancelled: Square,
  in_progress: Square,
  pending: Square,
}

// ``--color-accent`` resolves to ``--color-text`` in the dark palette, so
// it can't be used for status hue — we'd lose the contrast against
// regular text. ``--color-info`` (resolves to ``--accent-blue``) is
// defined distinctly in both themes and reads as "in progress".
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
  // (whether shipped or dropped) it no longer needs attention. This is
  // also what the topbar progress badge reports so the two stay in sync.
  const finishedCount = todos.filter(
    (t) => t.status === 'completed' || t.status === 'cancelled',
  ).length
  const hasInProgress = todos.some((t) => t.status === 'in_progress')
  const progressLabel =
    todos.length > 0 ? `${finishedCount}/${todos.length}` : undefined
  const sortedTodos = [...todos].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  )

  const content = (
    <>
      {/* Header: mono-uppercase title + completion counter. */}
      <div className="flex items-center justify-between border-b border-(--color-border) px-3 py-2">
        <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-(--color-text-muted)">
          Tasks
        </span>
        {todos.length > 0 && (
          <span className="font-mono text-[10px] text-(--color-text-subtle)">
            {finishedCount}/{todos.length} done
          </span>
        )}
      </div>

      {todos.length === 0 ? (
        <p
          role="status"
          className="px-3 py-6 text-center font-(family-name:--font-hand) text-sm text-(--color-text-subtle)"
        >
          No tasks yet
        </p>
      ) : (
        <ul
          aria-label="Task list"
          className="scrollbar-none max-h-[min(60vh,24rem)] overflow-y-auto overscroll-contain py-1"
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
                className="flex items-start gap-2.5 px-3 py-1.5"
              >
                <Icon
                  size={14}
                  aria-hidden="true"
                  className={`mt-0.5 shrink-0 ${STATUS_ICON_COLOR[todo.status]} ${
                    isInProgress ? 'animate-pulse' : ''
                  }`}
                />
                <span
                  className={`min-w-0 flex-1 text-xs leading-snug ${
                    isStruck
                      ? 'text-(--color-text-subtle) line-through'
                      : 'text-(--color-text)'
                  }`}
                >
                  {todo.content}
                </span>
                {agent && (
                  <span
                    className="mt-0.5 shrink-0 font-mono text-[9px] uppercase tracking-wide text-(--color-text-subtle)"
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
    if (!open) return null
    return (
      <div className="fixed inset-0 z-50" role="presentation">
        <button
          type="button"
          className="absolute inset-0 cursor-default bg-transparent"
          aria-label="Close tasks"
          onClick={() => onOpenChange(false)}
        />
        <section
          role="dialog"
          aria-label="Tasks"
          className="absolute right-2 top-[calc(var(--spacing-app-header)+env(safe-area-inset-top,0px)+0.5rem)] w-[min(calc(100vw-1rem),24rem)] overflow-hidden rounded-md bg-(--color-surface) p-0 shadow-md ring-1 ring-(--color-border)"
        >
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)"
            aria-label="Close tasks"
          >
            <X size={14} aria-hidden="true" />
          </button>
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
        className="w-[min(calc(100vw-1rem),24rem)] overflow-hidden rounded-md bg-(--color-surface) p-0 shadow-md ring-1 ring-(--color-border)"
      >
        {content}
      </PopoverContent>
    </Popover>
  )
}
