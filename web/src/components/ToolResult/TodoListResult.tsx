/**
 * A todo result: the board's tasks with status, priority, owner and
 * dependencies, under the outcome of the action that changed it.
 */

import { Check, Circle, ListTodo, Loader2, Minus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { GenericResult } from './GenericResult'

interface TodoResultTask {
  taskId: string
  status: string
  priority: string
  deps: string | null
  assignedTo: string | null
  claimedBy: string | null
  content: string
  instructions: string | null
  result: string | null
}

const TODO_STATUS_ICON: Record<string, LucideIcon> = {
  completed: Check,
  cancelled: Minus,
  in_progress: Loader2,
  pending: Circle,
}

const TODO_STATUS_COLOR: Record<string, string> = {
  completed: 'text-(--accent-green-text)',
  cancelled: 'text-(--color-text-subtle)',
  in_progress: 'text-(--color-text)',
  pending: 'text-(--color-text-muted)',
}

/** The board's status ids in words. */
const TODO_STATUS_LABEL: Record<string, string> = {
  completed: 'Done',
  cancelled: 'Cancelled',
  in_progress: 'In progress',
  pending: 'To do',
}

// Matches the backend's `_format_items` line shape:
// `[task_1] [status] (priority) deps=[…] assigned=X claimed=Y content`
const TODO_LINE_RE =
  /^\[([^\]]+)\] \[([^\]]+)\] \(([^)]+)\)(?: deps=\[([^\]]*)\])?(?: assigned=(\S+))?(?: claimed=(\S+))? (.+)$/

interface ParsedTodoList {
  outcomes: string[]
  tasks: TodoResultTask[]
}

/** Parse the todo board-state text into tasks and action outcomes; null when nothing matches. */
function parseTodoList(result: string): ParsedTodoList | null {
  const tasks: TodoResultTask[] = []
  const outcomes: string[] = []
  // 'instructions' / 'result' sub-lines can span multiple lines; unmatched
  // lines append to whichever field is currently open.
  let openField: 'instructions' | 'result' | null = null

  for (const rawLine of result.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line) {
      if (openField && tasks.length > 0) {
        const last = tasks[tasks.length - 1]
        last[openField] = `${last[openField]}\n`
      }
      continue
    }

    const m = line.match(TODO_LINE_RE)
    if (m) {
      tasks.push({
        taskId: m[1],
        status: m[2],
        priority: m[3],
        deps: m[4] || null,
        assignedTo: m[5] || null,
        claimedBy: m[6] || null,
        content: m[7].trim(),
        instructions: null,
        result: null,
      })
      openField = null
      continue
    }

    const sub = line.match(/^ {4}(instructions|result): (.*)$/)
    if (sub && tasks.length > 0) {
      openField = sub[1] as 'instructions' | 'result'
      tasks[tasks.length - 1][openField] = sub[2]
      continue
    }
    if (openField && tasks.length > 0) {
      const last = tasks[tasks.length - 1]
      last[openField] = `${last[openField]}\n${line}`
      continue
    }

    // Outcome line (e.g. "created task_1", "claimed task_1", "cleared 1 completed", "blocked task_2: waiting for task_1")
    const isOutcome = /^(created|updated|claimed|deleted|cleared|blocked|not_found|not_claimed|claim_missing_actor|invalid_dependencies|invalid_status_transition)\b/i.test(line)
    if (isOutcome) {
      outcomes.push(line)
      openField = null
      continue
    }
    return null // unrecognised line — fall back to generic text
  }
  return tasks.length > 0 || outcomes.length > 0 ? { outcomes, tasks } : null
}

/** ``created task_1`` → ``created "Add tests" · task_1``: the task's words first. */
function describeTodoOutcome(outcome: string, tasks: TodoResultTask[]): string {
  const m = outcome.match(/^(\w+) (task_\w+)(.*)$/)
  if (!m) return outcome
  const task = tasks.find((t) => t.taskId === m[2])
  return task ? `${m[1]} "${task.content}"${m[3]} · ${m[2]}` : outcome
}

export function TodoListResult({ result }: { result: string }) {
  if (result.trim() === 'No todos.') {
    return <EmptyState fill={false} icon={ListTodo} title="No tasks" className="py-3" />
  }
  const parsed = parseTodoList(result)
  if (!parsed) return <GenericResult result={result} />

  const { outcomes, tasks } = parsed

  return (
    <div className="space-y-2">
      {outcomes.length > 0 && (
        <div className="space-y-1">
          {outcomes.map((outcome, idx) => {
            const isError = /^(blocked|not_found|not_claimed|claim_missing_actor|invalid_)/i.test(outcome)
            return (
              <div
                key={idx}
                className={`font-mono text-xs leading-relaxed ${
                  isError ? 'text-(--accent-orange-text)' : 'text-(--color-text-muted)'
                }`}
              >
                {describeTodoOutcome(outcome, tasks)}
              </div>
            )
          })}
        </div>
      )}
      {tasks.length > 0 && (
        <ul className="space-y-2">
          {tasks.map((task) => {
            const Icon = TODO_STATUS_ICON[task.status] ?? Circle
            const iconColor = TODO_STATUS_COLOR[task.status] ?? 'text-(--color-text-muted)'
            const isFinished = task.status === 'completed' || task.status === 'cancelled'
            const agent = task.claimedBy ?? task.assignedTo
            return (
              <li key={task.taskId} className="flex items-start gap-2">
                <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
                  <Icon
                    size={12}
                    className={`shrink-0 ${iconColor} ${task.status === 'in_progress' ? 'animate-spin' : ''}`}
                    aria-hidden
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-xs leading-5 break-words ${
                      isFinished ? 'text-(--color-text-muted)' : 'text-(--color-text)'
                    }`}
                  >
                    {task.content}
                  </div>
                  {/* What the task is reads first; its ID trails, muted. */}
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-xs md:text-meta text-(--color-text-muted)">
                    <span>{TODO_STATUS_LABEL[task.status] ?? task.status}</span>
                    {task.priority && <span>{task.priority}</span>}
                    {agent && <span>{agent}</span>}
                    {task.deps && <span>after {task.deps}</span>}
                    <span className="text-(--color-text-subtle)">{task.taskId}</span>
                  </div>
                  {task.instructions && (
                    <div className="mt-1 text-xs leading-relaxed whitespace-pre-wrap break-words text-(--color-text-muted)">
                      <span className="font-semibold">instructions:</span> {task.instructions}
                    </div>
                  )}
                  {task.result && (
                    <div className="mt-1 text-xs leading-relaxed whitespace-pre-wrap break-words text-(--color-text-2)">
                      <span className="font-semibold">result:</span> {task.result}
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
