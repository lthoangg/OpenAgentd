import { describe, it, expect } from 'bun:test'
import type { TodoItem } from '@/api/types'

// ── Sorting Logic ──────────────────────────────────────────────────────────

/**
 * The sort order used in the Todos popover.
 * Extracted as a pure function for testability.
 */
const TODO_STATUS_ORDER: Record<TodoItem['status'], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
}

function sortTodos(todos: TodoItem[]): TodoItem[] {
  return [...todos].sort((a, b) => TODO_STATUS_ORDER[a.status] - TODO_STATUS_ORDER[b.status])
}

describe('Todos Popover - Sorting Logic', () => {
  it('sorts in_progress items first', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'pending', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'in_progress', priority: 'high' },
      { task_id: '3', content: 'Task 3', status: 'completed', priority: 'medium' },
    ]
    const sorted = sortTodos(todos)
    expect(sorted[0].status).toBe('in_progress')
  })

  it('sorts pending items second', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'completed', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'pending', priority: 'high' },
      { task_id: '3', content: 'Task 3', status: 'cancelled', priority: 'medium' },
    ]
    const sorted = sortTodos(todos)
    expect(sorted[0].status).toBe('pending')
  })

  it('sorts completed items third', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'cancelled', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'completed', priority: 'high' },
      { task_id: '3', content: 'Task 3', status: 'pending', priority: 'medium' },
    ]
    const sorted = sortTodos(todos)
    expect(sorted[0].status).toBe('pending')
    expect(sorted[1].status).toBe('completed')
  })

  it('sorts cancelled items last', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'in_progress', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'cancelled', priority: 'high' },
      { task_id: '3', content: 'Task 3', status: 'pending', priority: 'medium' },
    ]
    const sorted = sortTodos(todos)
    expect(sorted[2].status).toBe('cancelled')
  })

  it('maintains relative order for items with same status (stable sort)', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'First pending', status: 'pending', priority: 'low' },
      { task_id: '2', content: 'Second pending', status: 'pending', priority: 'high' },
      { task_id: '3', content: 'Third pending', status: 'pending', priority: 'medium' },
    ]
    const sorted = sortTodos(todos)
    expect(sorted[0].task_id).toBe('1')
    expect(sorted[1].task_id).toBe('2')
    expect(sorted[2].task_id).toBe('3')
  })

  it('sorts mixed statuses correctly', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Completed 1', status: 'completed', priority: 'low' },
      { task_id: '2', content: 'In Progress 1', status: 'in_progress', priority: 'high' },
      { task_id: '3', content: 'Pending 1', status: 'pending', priority: 'medium' },
      { task_id: '4', content: 'Cancelled 1', status: 'cancelled', priority: 'low' },
      { task_id: '5', content: 'In Progress 2', status: 'in_progress', priority: 'low' },
      { task_id: '6', content: 'Pending 2', status: 'pending', priority: 'high' },
    ]
    const sorted = sortTodos(todos)
    expect(sorted[0].status).toBe('in_progress')
    expect(sorted[1].status).toBe('in_progress')
    expect(sorted[2].status).toBe('pending')
    expect(sorted[3].status).toBe('pending')
    expect(sorted[4].status).toBe('completed')
    expect(sorted[5].status).toBe('cancelled')
  })

  it('does not mutate original array', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'completed', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'pending', priority: 'high' },
    ]
    const original = [...todos]
    sortTodos(todos)
    expect(todos).toEqual(original)
  })

  it('handles empty array', () => {
    const todos: TodoItem[] = []
    const sorted = sortTodos(todos)
    expect(sorted).toHaveLength(0)
  })

  it('handles single item', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'pending', priority: 'low' },
    ]
    const sorted = sortTodos(todos)
    expect(sorted).toHaveLength(1)
    expect(sorted[0].task_id).toBe('1')
  })
})

// ── Status Icon Mapping ────────────────────────────────────────────────────
//
// The popover now renders lucide icons (Check / Minus / Loader2 / Circle)
// instead of unicode glyphs so the visuals scale and theme cleanly
// alongside the rest of the design system. We assert by component
// identity — referentially comparing the lucide components imported
// from the same module the production code uses.

import { Check, Circle, Loader2, Minus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

function getStatusIcon(status: TodoItem['status']): LucideIcon {
  const icons: Record<TodoItem['status'], LucideIcon> = {
    completed: Check,
    cancelled: Minus,
    in_progress: Loader2,
    pending: Circle,
  }
  return icons[status]
}

describe('Todos Popover - Status Icon Mapping', () => {
  it('maps completed status to a tick icon', () => {
    expect(getStatusIcon('completed')).toBe(Check)
  })

  it('maps cancelled status to a minus icon', () => {
    expect(getStatusIcon('cancelled')).toBe(Minus)
  })

  it('maps in_progress status to a loader icon', () => {
    expect(getStatusIcon('in_progress')).toBe(Loader2)
  })

  it('maps pending status to a circle icon', () => {
    expect(getStatusIcon('pending')).toBe(Circle)
  })

  it('returns correct icon for all statuses', () => {
    const statuses: TodoItem['status'][] = ['completed', 'cancelled', 'in_progress', 'pending']
    const icons = statuses.map(getStatusIcon)
    expect(icons).toEqual([Check, Minus, Loader2, Circle])
  })
})

// ── Priority Badge Mapping ─────────────────────────────────────────────────

/**
 * Maps todo priority to its display label.
 * Extracted as a pure function for testability.
 */
function getPriorityLabel(priority: TodoItem['priority']): string {
  return priority
}

describe('Todos Popover - Priority Badge Mapping', () => {
  it('maps high priority to "high"', () => {
    expect(getPriorityLabel('high')).toBe('high')
  })

  it('maps medium priority to "medium"', () => {
    expect(getPriorityLabel('medium')).toBe('medium')
  })

  it('maps low priority to "low"', () => {
    expect(getPriorityLabel('low')).toBe('low')
  })

  it('returns correct label for all priorities', () => {
    const priorities: TodoItem['priority'][] = ['high', 'medium', 'low']
    const labels = priorities.map(getPriorityLabel)
    expect(labels).toEqual(['high', 'medium', 'low'])
  })
})

// ── Counter Logic ──────────────────────────────────────────────────────────

/**
 * Calculates the number of completed todos.
 * Extracted as a pure function for testability.
 */
function getCompletedCount(todos: TodoItem[]): number {
  return todos.filter((t) => t.status === 'completed').length
}

describe('Todos Popover - Counter Logic', () => {
  it('counts completed items correctly', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'completed', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'completed', priority: 'high' },
      { task_id: '3', content: 'Task 3', status: 'pending', priority: 'medium' },
    ]
    expect(getCompletedCount(todos)).toBe(2)
  })

  it('returns 0 when no items are completed', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'pending', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'in_progress', priority: 'high' },
    ]
    expect(getCompletedCount(todos)).toBe(0)
  })

  it('returns 0 for empty list', () => {
    expect(getCompletedCount([])).toBe(0)
  })

  it('counts all completed items in mixed list', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'completed', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'pending', priority: 'high' },
      { task_id: '3', content: 'Task 3', status: 'completed', priority: 'medium' },
      { task_id: '4', content: 'Task 4', status: 'cancelled', priority: 'low' },
      { task_id: '5', content: 'Task 5', status: 'completed', priority: 'high' },
    ]
    expect(getCompletedCount(todos)).toBe(3)
  })

  it('ignores cancelled items when counting completed', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'completed', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'cancelled', priority: 'high' },
    ]
    expect(getCompletedCount(todos)).toBe(1)
  })
})

// ── In-Progress Indicator Logic ────────────────────────────────────────────

/**
 * Determines if any todo has in_progress status.
 * Extracted as a pure function for testability.
 */
function hasInProgressTodo(todos: TodoItem[]): boolean {
  return todos.some((t) => t.status === 'in_progress')
}

describe('Todos Popover - In-Progress Indicator Logic', () => {
  it('returns true when at least one item is in_progress', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'pending', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'in_progress', priority: 'high' },
    ]
    expect(hasInProgressTodo(todos)).toBe(true)
  })

  it('returns false when no items are in_progress', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'pending', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'completed', priority: 'high' },
    ]
    expect(hasInProgressTodo(todos)).toBe(false)
  })

  it('returns false for empty list', () => {
    expect(hasInProgressTodo([])).toBe(false)
  })

  it('returns true when multiple items are in_progress', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'in_progress', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'in_progress', priority: 'high' },
    ]
    expect(hasInProgressTodo(todos)).toBe(true)
  })

  it('returns false when only cancelled items exist', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'cancelled', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'cancelled', priority: 'high' },
    ]
    expect(hasInProgressTodo(todos)).toBe(false)
  })
})

// ── Display Logic (Completed/Cancelled Styling) ────────────────────────────

/**
 * Determines if a todo should be displayed with strikethrough and dimmed text.
 * Extracted as a pure function for testability.
 */
function shouldDimTodo(status: TodoItem['status']): boolean {
  return status === 'completed' || status === 'cancelled'
}

describe('Todos Popover - Display Logic (Dimming)', () => {
  it('dims completed items', () => {
    expect(shouldDimTodo('completed')).toBe(true)
  })

  it('dims cancelled items', () => {
    expect(shouldDimTodo('cancelled')).toBe(true)
  })

  it('does not dim pending items', () => {
    expect(shouldDimTodo('pending')).toBe(false)
  })

  it('does not dim in_progress items', () => {
    expect(shouldDimTodo('in_progress')).toBe(false)
  })

  it('correctly identifies all dimmed statuses', () => {
    const statuses: TodoItem['status'][] = ['completed', 'cancelled', 'in_progress', 'pending']
    const dimmed = statuses.filter(shouldDimTodo)
    expect(dimmed).toEqual(['completed', 'cancelled'])
  })
})

// ── Priority Badge Styling ─────────────────────────────────────────────────

/**
 * Determines the CSS class for priority badge styling.
 * Extracted as a pure function for testability.
 */
function getPriorityBadgeClass(priority: TodoItem['priority']): string {
  if (priority === 'high') {
    return 'bg-red-500/10 text-red-500'
  }
  if (priority === 'low') {
    return 'bg-(--bg-key) text-(--color-text-subtle)'
  }
  // medium
  return 'bg-amber-500/10 text-amber-500'
}

describe('Todos Popover - Priority Badge Styling', () => {
  it('applies red styling for high priority', () => {
    const classes = getPriorityBadgeClass('high')
    expect(classes).toContain('bg-red-500/10')
    expect(classes).toContain('text-red-500')
  })

  it('applies amber styling for medium priority', () => {
    const classes = getPriorityBadgeClass('medium')
    expect(classes).toContain('bg-amber-500/10')
    expect(classes).toContain('text-amber-500')
  })

  it('applies accent styling for low priority', () => {
    const classes = getPriorityBadgeClass('low')
    expect(classes).toContain('bg-(--bg-key)')
    expect(classes).toContain('text-(--color-text-subtle)')
  })

  it('returns correct classes for all priorities', () => {
    const priorities: TodoItem['priority'][] = ['high', 'medium', 'low']
    const classes = priorities.map(getPriorityBadgeClass)
    expect(classes).toHaveLength(3)
    expect(classes[0]).toContain('red')
    expect(classes[1]).toContain('amber')
    // Low priority uses paper neutrals (--bg-key + --color-text-subtle)
    // rather than a marker accent.
    expect(classes[2]).toContain('bg-(--bg-key)')
  })
})

// ── Integration: Full Rendering Logic ──────────────────────────────────────

/**
 * Simulates the full rendering logic of the Todos popover.
 * This tests how all the pieces work together.
 */
interface TodosRenderState {
  isEmpty: boolean
  sortedTodos: TodoItem[]
  completedCount: number
  totalCount: number
  hasInProgress: boolean
  counterText: string
}

function computeTodosRenderState(todos: TodoItem[]): TodosRenderState {
  const isEmpty = todos.length === 0
  const sortedTodos = sortTodos(todos)
  const completedCount = getCompletedCount(todos)
  const totalCount = todos.length
  const hasInProgress = hasInProgressTodo(todos)
  const counterText = isEmpty ? '' : `${completedCount}/${totalCount} done`

  return {
    isEmpty,
    sortedTodos,
    completedCount,
    totalCount,
    hasInProgress,
    counterText,
  }
}

describe('Todos Popover - Integration: Full Rendering Logic', () => {
  it('renders empty state correctly', () => {
    const state = computeTodosRenderState([])
    expect(state.isEmpty).toBe(true)
    expect(state.sortedTodos).toHaveLength(0)
    expect(state.completedCount).toBe(0)
    expect(state.totalCount).toBe(0)
    expect(state.hasInProgress).toBe(false)
    expect(state.counterText).toBe('')
  })

  it('renders single pending todo correctly', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'pending', priority: 'low' },
    ]
    const state = computeTodosRenderState(todos)
    expect(state.isEmpty).toBe(false)
    expect(state.sortedTodos).toHaveLength(1)
    expect(state.completedCount).toBe(0)
    expect(state.totalCount).toBe(1)
    expect(state.hasInProgress).toBe(false)
    expect(state.counterText).toBe('0/1 done')
  })

  it('renders mixed todos with correct counter', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'completed', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'pending', priority: 'high' },
      { task_id: '3', content: 'Task 3', status: 'in_progress', priority: 'medium' },
      { task_id: '4', content: 'Task 4', status: 'completed', priority: 'low' },
    ]
    const state = computeTodosRenderState(todos)
    expect(state.isEmpty).toBe(false)
    expect(state.sortedTodos).toHaveLength(4)
    expect(state.completedCount).toBe(2)
    expect(state.totalCount).toBe(4)
    expect(state.hasInProgress).toBe(true)
    expect(state.counterText).toBe('2/4 done')
  })

  it('sorts todos before rendering', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Completed', status: 'completed', priority: 'low' },
      { task_id: '2', content: 'In Progress', status: 'in_progress', priority: 'high' },
      { task_id: '3', content: 'Pending', status: 'pending', priority: 'medium' },
    ]
    const state = computeTodosRenderState(todos)
    expect(state.sortedTodos[0].status).toBe('in_progress')
    expect(state.sortedTodos[1].status).toBe('pending')
    expect(state.sortedTodos[2].status).toBe('completed')
  })

  it('shows in_progress indicator when applicable', () => {
    const todosWithProgress: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'in_progress', priority: 'low' },
    ]
    const stateWithProgress = computeTodosRenderState(todosWithProgress)
    expect(stateWithProgress.hasInProgress).toBe(true)

    const todosWithoutProgress: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'pending', priority: 'low' },
    ]
    const stateWithoutProgress = computeTodosRenderState(todosWithoutProgress)
    expect(stateWithoutProgress.hasInProgress).toBe(false)
  })

  it('handles all completed todos', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'completed', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'completed', priority: 'high' },
    ]
    const state = computeTodosRenderState(todos)
    expect(state.completedCount).toBe(2)
    expect(state.totalCount).toBe(2)
    expect(state.counterText).toBe('2/2 done')
    expect(state.hasInProgress).toBe(false)
  })

  it('handles all cancelled todos', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'cancelled', priority: 'low' },
      { task_id: '2', content: 'Task 2', status: 'cancelled', priority: 'high' },
    ]
    const state = computeTodosRenderState(todos)
    expect(state.completedCount).toBe(0)
    expect(state.totalCount).toBe(2)
    expect(state.counterText).toBe('0/2 done')
    expect(state.hasInProgress).toBe(false)
  })
})
