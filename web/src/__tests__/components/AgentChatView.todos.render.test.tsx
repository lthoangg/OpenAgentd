import { describe, it, expect, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { TodoItem } from '@/api/types'

const todosTitle = 'Task list (Ctrl+T)'

function TodosPopoverMock({
  todos,
  sessionId,
  onOpenChange,
  open,
}: {
  todos: TodoItem[]
  sessionId: string | null
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const TODO_STATUS_ORDER: Record<TodoItem['status'], number> = {
    in_progress: 0,
    pending: 1,
    completed: 2,
    cancelled: 3,
  }

  const sortedTodos = [...todos].sort((a, b) => TODO_STATUS_ORDER[a.status] - TODO_STATUS_ORDER[b.status])
  const completedCount = todos.filter((t) => t.status === 'completed').length
  const hasInProgress = todos.some((t) => t.status === 'in_progress')

  const getStatusIcon = (status: TodoItem['status']): string => {
    const icons: Record<TodoItem['status'], string> = {
      completed: '✓',
      cancelled: '✗',
      in_progress: '▶',
      pending: '○',
    }
    return icons[status]
  }

  return (
    <div>
      <button
        onClick={() => onOpenChange(!open)}
        disabled={!sessionId}
        data-testid="todos-trigger"
        title={sessionId ? todosTitle : 'No active session'}
      >
        Todos
        {hasInProgress && <span data-testid="in-progress-dot" className="size-1.5 rounded-full" />}
      </button>

      {open && (
        <div data-testid="todos-popover" className="w-80">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-xs font-semibold">Tasks</span>
            {todos.length > 0 && (
              <span data-testid="todos-counter" className="text-[10px]">
                {completedCount}/{todos.length} done
              </span>
            )}
          </div>
          {todos.length === 0 ? (
            <p data-testid="todos-empty" className="px-3 py-4 text-center text-xs">
              No tasks yet
            </p>
          ) : (
            <ul data-testid="todos-list" className="max-h-80 overflow-y-auto py-1">
              {sortedTodos.map((todo) => (
                <li key={todo.task_id} data-testid={`todo-item-${todo.task_id}`} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="shrink-0 text-[10px]" data-testid={`todo-icon-${todo.task_id}`}>
                    {getStatusIcon(todo.status)}
                  </span>
                  <span
                    className={`flex-1 text-xs leading-snug ${
                      todo.status === 'completed' || todo.status === 'cancelled'
                        ? 'text-text-subtle line-through'
                        : 'text-text'
                    }`}
                    data-testid={`todo-content-${todo.task_id}`}
                  >
                    {todo.content}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

const createWrapper = () => {
  const queryClient = createTestQueryClient()
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('Todos Popover - Rendering', () => {
  afterEach(() => {
    cleanup()
  })

  describe('Button state', () => {
    it('renders button enabled when sessionId is provided', () => {
      render(
        <TodosPopoverMock todos={[]} sessionId="session-123" onOpenChange={() => {}} open={false} />,
        { wrapper: createWrapper() }
      )
      const button = screen.getByTestId('todos-trigger')
      expect(button.hasAttribute('disabled')).toBe(false)
    })

    it('renders button disabled when sessionId is null', () => {
      render(
        <TodosPopoverMock todos={[]} sessionId={null} onOpenChange={() => {}} open={false} />,
        { wrapper: createWrapper() }
      )
      const button = screen.getByTestId('todos-trigger')
      expect(button.hasAttribute('disabled')).toBe(true)
    })

    it('shows correct title when sessionId is provided', () => {
      render(
        <TodosPopoverMock todos={[]} sessionId="session-123" onOpenChange={() => {}} open={false} />,
        { wrapper: createWrapper() }
      )
      const button = screen.getByTestId('todos-trigger')
      expect(button.getAttribute('title')).toBe(todosTitle)
    })

    it('shows correct title when sessionId is null', () => {
      render(
        <TodosPopoverMock todos={[]} sessionId={null} onOpenChange={() => {}} open={false} />,
        { wrapper: createWrapper() }
      )
      const button = screen.getByTestId('todos-trigger')
      expect(button.getAttribute('title')).toBe('No active session')
    })
  })

  describe('In-progress indicator', () => {
    it('shows dot indicator when any todo is in_progress', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Task 1', status: 'in_progress' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={false} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByTestId('in-progress-dot')).toBeTruthy()
    })

    it('hides dot indicator when no todos are in_progress', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Task 1', status: 'pending' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={false} />,
        { wrapper: createWrapper() }
      )
      expect(screen.queryByTestId('in-progress-dot')).toBeNull()
    })

    it('shows dot indicator when multiple todos exist and one is in_progress', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Task 1', status: 'pending' },
        { task_id: '2', content: 'Task 2', status: 'in_progress' },
        { task_id: '3', content: 'Task 3', status: 'completed' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={false} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByTestId('in-progress-dot')).toBeTruthy()
    })
  })

  describe('Empty state', () => {
    it('shows "No tasks yet" when todos list is empty', () => {
      render(
        <TodosPopoverMock todos={[]} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByTestId('todos-empty').textContent).toBe('No tasks yet')
    })

    it('does not show counter when todos list is empty', () => {
      render(
        <TodosPopoverMock todos={[]} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.queryByTestId('todos-counter')).toBeNull()
    })

    it('does not show list when todos list is empty', () => {
      render(
        <TodosPopoverMock todos={[]} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.queryByTestId('todos-list')).toBeNull()
    })
  })

  describe('Counter display', () => {
    it('shows counter with correct format when todos exist', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Task 1', status: 'completed' },
        { task_id: '2', content: 'Task 2', status: 'pending' },
        { task_id: '3', content: 'Task 3', status: 'completed' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByTestId('todos-counter').textContent).toBe('2/3 done')
    })

    it('shows 0 completed when no todos are completed', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Task 1', status: 'pending' },
        { task_id: '2', content: 'Task 2', status: 'in_progress' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByTestId('todos-counter').textContent).toBe('0/2 done')
    })

    it('shows all completed when all todos are completed', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Task 1', status: 'completed' },
        { task_id: '2', content: 'Task 2', status: 'completed' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByTestId('todos-counter').textContent).toBe('2/2 done')
    })

    it('counts only completed items, not cancelled', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Task 1', status: 'completed' },
        { task_id: '2', content: 'Task 2', status: 'cancelled' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByTestId('todos-counter').textContent).toBe('1/2 done')
    })
  })

  describe('Todo items rendering', () => {
    it('renders all todos in the list', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Task 1', status: 'pending' },
        { task_id: '2', content: 'Task 2', status: 'in_progress' },
        { task_id: '3', content: 'Task 3', status: 'completed' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByTestId('todo-item-1')).toBeTruthy()
      expect(screen.getByTestId('todo-item-2')).toBeTruthy()
      expect(screen.getByTestId('todo-item-3')).toBeTruthy()
    })

    it('renders todo content correctly', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Unique task content here', status: 'pending' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByTestId('todo-content-1').textContent).toBe('Unique task content here')
    })

    it('uses task_id as React key for each item', () => {
      const todos: TodoItem[] = [
        { task_id: 'custom-id-1', content: 'Task 1', status: 'pending' },
        { task_id: 'custom-id-2', content: 'Task 2', status: 'pending' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByTestId('todo-item-custom-id-1')).toBeTruthy()
      expect(screen.getByTestId('todo-item-custom-id-2')).toBeTruthy()
    })
  })

  describe('Status icons', () => {
    it('shows checkmark for completed status', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Task 1', status: 'completed' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByText('✓')).toBeTruthy()
    })

    it('shows X for cancelled status', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Task 1', status: 'cancelled' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByText('✗')).toBeTruthy()
    })

    it('shows play symbol for in_progress status', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Task 1', status: 'in_progress' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByText('▶')).toBeTruthy()
    })

    it('shows circle for pending status', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Task 1', status: 'pending' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByText('○')).toBeTruthy()
    })

    it('renders correct icons for all statuses', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'In Progress', status: 'in_progress' },
        { task_id: '2', content: 'Pending', status: 'pending' },
        { task_id: '3', content: 'Completed', status: 'completed' },
        { task_id: '4', content: 'Cancelled', status: 'cancelled' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByText('▶')).toBeTruthy()
      expect(screen.getByText('○')).toBeTruthy()
      expect(screen.getByText('✓')).toBeTruthy()
      expect(screen.getByText('✗')).toBeTruthy()
    })
  })

  describe('Sorting', () => {
    it('renders todos in correct sort order', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Completed', status: 'completed' },
        { task_id: '2', content: 'In Progress', status: 'in_progress' },
        { task_id: '3', content: 'Pending', status: 'pending' },
        { task_id: '4', content: 'Cancelled', status: 'cancelled' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      const items = screen.getAllByTestId(/^todo-item-/)
      expect(items[0].getAttribute('data-testid')).toBe('todo-item-2') // in_progress first
      expect(items[1].getAttribute('data-testid')).toBe('todo-item-3') // pending second
      expect(items[2].getAttribute('data-testid')).toBe('todo-item-1') // completed third
      expect(items[3].getAttribute('data-testid')).toBe('todo-item-4') // cancelled last
    })
  })

  describe('Styling for completed/cancelled items', () => {
    it('applies strikethrough and dimmed text to completed items', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Completed task', status: 'completed' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      const content = screen.getByTestId('todo-content-1')
      expect(content.className).toContain('line-through')
      expect(content.className).toContain('text-text-subtle')
    })

    it('applies strikethrough and dimmed text to cancelled items', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Cancelled task', status: 'cancelled' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      const content = screen.getByTestId('todo-content-1')
      expect(content.className).toContain('line-through')
      expect(content.className).toContain('text-text-subtle')
    })

    it('does not apply strikethrough to pending items', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'Pending task', status: 'pending' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      const content = screen.getByTestId('todo-content-1')
      expect(content.className).not.toContain('line-through')
      expect(content.className).toContain('text-text')
    })

    it('does not apply strikethrough to in_progress items', () => {
      const todos: TodoItem[] = [
        { task_id: '1', content: 'In progress task', status: 'in_progress' },
      ]
      render(
        <TodosPopoverMock todos={todos} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      const content = screen.getByTestId('todo-content-1')
      expect(content.className).not.toContain('line-through')
      expect(content.className).toContain('text-text')
    })
  })

  describe('Popover open/close', () => {
    it('shows popover content when open is true', () => {
      render(
        <TodosPopoverMock todos={[]} sessionId="session-123" onOpenChange={() => {}} open={true} />,
        { wrapper: createWrapper() }
      )
      expect(screen.getByTestId('todos-popover')).toBeTruthy()
    })

    it('hides popover content when open is false', () => {
      render(
        <TodosPopoverMock todos={[]} sessionId="session-123" onOpenChange={() => {}} open={false} />,
        { wrapper: createWrapper() }
      )
      expect(screen.queryByTestId('todos-popover')).toBeNull()
    })

    it('calls onOpenChange when button is clicked', async () => {
      const user = userEvent.setup()
      let openState = false
      const onOpenChange = (newOpen: boolean) => {
        openState = newOpen
      }

      const { rerender } = render(
        <TodosPopoverMock todos={[]} sessionId="session-123" onOpenChange={onOpenChange} open={openState} />,
        { wrapper: createWrapper() }
      )

      const button = screen.getByTestId('todos-trigger')
      await user.click(button)
      expect(openState).toBe(true)

      rerender(
        <TodosPopoverMock todos={[]} sessionId="session-123" onOpenChange={onOpenChange} open={openState} />
      )
      expect(screen.getByTestId('todos-popover')).toBeTruthy()
    })
  })
})
