import { describe, it, expect } from 'bun:test'
import { Check, Circle, Loader2, Minus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { TodoItem } from '@/api/types'

// ── Sorting Logic ──────────────────────────────────────────────────────────

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
      { task_id: '1', content: 'Task 1', status: 'pending' },
      { task_id: '2', content: 'Task 2', status: 'in_progress' },
      { task_id: '3', content: 'Task 3', status: 'completed' },
    ]
    const sorted = sortTodos(todos)
    expect(sorted[0].status).toBe('in_progress')
  })

  it('sorts pending items second', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'completed' },
      { task_id: '2', content: 'Task 2', status: 'pending' },
      { task_id: '3', content: 'Task 3', status: 'cancelled' },
    ]
    const sorted = sortTodos(todos)
    expect(sorted[0].status).toBe('pending')
  })

  it('sorts completed items third', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'cancelled' },
      { task_id: '2', content: 'Task 2', status: 'completed' },
      { task_id: '3', content: 'Task 3', status: 'pending' },
    ]
    const sorted = sortTodos(todos)
    expect(sorted[0].status).toBe('pending')
    expect(sorted[1].status).toBe('completed')
  })

  it('sorts cancelled items last', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'in_progress' },
      { task_id: '2', content: 'Task 2', status: 'cancelled' },
      { task_id: '3', content: 'Task 3', status: 'pending' },
    ]
    const sorted = sortTodos(todos)
    expect(sorted[2].status).toBe('cancelled')
  })

  it('maintains relative order for items with same status (stable sort)', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'First pending', status: 'pending' },
      { task_id: '2', content: 'Second pending', status: 'pending' },
      { task_id: '3', content: 'Third pending', status: 'pending' },
    ]
    const sorted = sortTodos(todos)
    expect(sorted[0].task_id).toBe('1')
    expect(sorted[1].task_id).toBe('2')
    expect(sorted[2].task_id).toBe('3')
  })

  it('sorts mixed statuses correctly', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Completed 1', status: 'completed' },
      { task_id: '2', content: 'In Progress 1', status: 'in_progress' },
      { task_id: '3', content: 'Pending 1', status: 'pending' },
      { task_id: '4', content: 'Cancelled 1', status: 'cancelled' },
      { task_id: '5', content: 'In Progress 2', status: 'in_progress' },
      { task_id: '6', content: 'Pending 2', status: 'pending' },
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
      { task_id: '1', content: 'Task 1', status: 'completed' },
      { task_id: '2', content: 'Task 2', status: 'pending' },
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
      { task_id: '1', content: 'Task 1', status: 'pending' },
    ]
    const sorted = sortTodos(todos)
    expect(sorted).toHaveLength(1)
    expect(sorted[0].task_id).toBe('1')
  })
})

// ── Status Icon Mapping ────────────────────────────────────────────────────

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

// ── Counter Logic ──────────────────────────────────────────────────────────

function getCompletedCount(todos: TodoItem[]): number {
  return todos.filter((t) => t.status === 'completed').length
}

describe('Todos Popover - Counter Logic', () => {
  it('counts completed items correctly', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'completed' },
      { task_id: '2', content: 'Task 2', status: 'completed' },
      { task_id: '3', content: 'Task 3', status: 'pending' },
    ]
    expect(getCompletedCount(todos)).toBe(2)
  })

  it('returns 0 when no items are completed', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'pending' },
      { task_id: '2', content: 'Task 2', status: 'in_progress' },
    ]
    expect(getCompletedCount(todos)).toBe(0)
  })

  it('returns 0 for empty list', () => {
    expect(getCompletedCount([])).toBe(0)
  })

  it('counts all completed items in mixed list', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'completed' },
      { task_id: '2', content: 'Task 2', status: 'pending' },
      { task_id: '3', content: 'Task 3', status: 'completed' },
      { task_id: '4', content: 'Task 4', status: 'cancelled' },
      { task_id: '5', content: 'Task 5', status: 'completed' },
    ]
    expect(getCompletedCount(todos)).toBe(3)
  })

  it('ignores cancelled items when counting completed', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'completed' },
      { task_id: '2', content: 'Task 2', status: 'cancelled' },
    ]
    expect(getCompletedCount(todos)).toBe(1)
  })
})

// ── In-Progress Indicator Logic ────────────────────────────────────────────

function hasInProgressTodo(todos: TodoItem[]): boolean {
  return todos.some((t) => t.status === 'in_progress')
}

describe('Todos Popover - In-Progress Indicator Logic', () => {
  it('returns true when at least one item is in_progress', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'pending' },
      { task_id: '2', content: 'Task 2', status: 'in_progress' },
    ]
    expect(hasInProgressTodo(todos)).toBe(true)
  })

  it('returns false when no items are in_progress', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'pending' },
      { task_id: '2', content: 'Task 2', status: 'completed' },
    ]
    expect(hasInProgressTodo(todos)).toBe(false)
  })

  it('returns false for empty list', () => {
    expect(hasInProgressTodo([])).toBe(false)
  })

  it('returns true when multiple items are in_progress', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'in_progress' },
      { task_id: '2', content: 'Task 2', status: 'in_progress' },
    ]
    expect(hasInProgressTodo(todos)).toBe(true)
  })

  it('returns false when only cancelled items exist', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'cancelled' },
      { task_id: '2', content: 'Task 2', status: 'cancelled' },
    ]
    expect(hasInProgressTodo(todos)).toBe(false)
  })
})

// ── Display Logic (Completed/Cancelled Styling) ────────────────────────────

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

// ── Integration: Full Rendering Logic ──────────────────────────────────────

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
      { task_id: '1', content: 'Do something', status: 'pending' },
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
      { task_id: '1', content: 'Task 1', status: 'completed' },
      { task_id: '2', content: 'Task 2', status: 'pending' },
      { task_id: '3', content: 'Task 3', status: 'in_progress' },
      { task_id: '4', content: 'Task 4', status: 'completed' },
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
      { task_id: '1', content: 'Completed', status: 'completed' },
      { task_id: '2', content: 'In Progress', status: 'in_progress' },
      { task_id: '3', content: 'Pending', status: 'pending' },
    ]
    const state = computeTodosRenderState(todos)
    expect(state.sortedTodos[0].status).toBe('in_progress')
    expect(state.sortedTodos[1].status).toBe('pending')
    expect(state.sortedTodos[2].status).toBe('completed')
  })

  it('shows in_progress indicator when applicable', () => {
    const todosWithProgress: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'in_progress' },
    ]
    const stateWithProgress = computeTodosRenderState(todosWithProgress)
    expect(stateWithProgress.hasInProgress).toBe(true)

    const todosWithoutProgress: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'pending' },
    ]
    const stateWithoutProgress = computeTodosRenderState(todosWithoutProgress)
    expect(stateWithoutProgress.hasInProgress).toBe(false)
  })

  it('handles all completed todos', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'completed' },
      { task_id: '2', content: 'Task 2', status: 'completed' },
    ]
    const state = computeTodosRenderState(todos)
    expect(state.completedCount).toBe(2)
    expect(state.totalCount).toBe(2)
    expect(state.counterText).toBe('2/2 done')
    expect(state.hasInProgress).toBe(false)
  })

  it('handles all cancelled todos', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Task 1', status: 'cancelled' },
      { task_id: '2', content: 'Task 2', status: 'cancelled' },
    ]
    const state = computeTodosRenderState(todos)
    expect(state.completedCount).toBe(0)
    expect(state.totalCount).toBe(2)
    expect(state.counterText).toBe('0/2 done')
    expect(state.hasInProgress).toBe(false)
  })
})
