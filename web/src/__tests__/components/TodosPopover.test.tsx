import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { TodosPopover } from '@/components/TodosPopover'
import type { TodoItem } from '@/api/types'

afterEach(cleanup)

describe('TodosPopover', () => {
  it('shows an empty-state message when there are no todos', () => {
    render(
      <TodosPopover
        open
        onOpenChange={() => {}}
        todos={[]}
        sessionId="session-123"
      />,
    )

    expect(screen.getByText('No tasks yet')).toBeTruthy()
    // No checklist should be rendered when the list is empty.
    expect(screen.queryByRole('list', { name: 'Task list' })).toBeNull()
  })

  it('renders a flat checklist sorted in_progress → pending → completed → cancelled', () => {
    const todos: TodoItem[] = [
      {
        task_id: 'task_done',
        content: 'Completed task',
        status: 'completed',
        priority: 'low',
        dependencies: [],
        assigned_to: 'explorer#1',
        claimed_by: 'explorer#1',
      },
      {
        task_id: 'task_cancel',
        content: 'Cancelled task',
        status: 'cancelled',
        priority: 'low',
      },
      {
        task_id: 'task_pending',
        content: 'Pending task',
        status: 'pending',
        priority: 'high',
        dependencies: ['task_done'],
        assigned_to: 'executor#1',
        claimed_by: null,
      },
      {
        task_id: 'task_active',
        content: 'Active task',
        status: 'in_progress',
        priority: 'medium',
      },
    ]

    render(
      <TodosPopover
        open
        onOpenChange={() => {}}
        todos={todos}
        sessionId="session-123"
      />,
    )

    // All content lines render.
    expect(screen.getByText('Active task')).toBeTruthy()
    expect(screen.getByText('Pending task')).toBeTruthy()
    expect(screen.getByText('Completed task')).toBeTruthy()
    expect(screen.getByText('Cancelled task')).toBeTruthy()

    // Header counter reflects (completed + cancelled) / total — cancelled
    // tasks have also left the active set, so they count as "finished".
    expect(screen.getByText('2/4 done')).toBeTruthy()

    // Sort order: in_progress → pending → completed → cancelled.
    const items = screen.getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Active task'),
      expect.stringContaining('Pending task'),
      expect.stringContaining('Completed task'),
      expect.stringContaining('Cancelled task'),
    ])
  })

  it('strikes through completed and cancelled rows, not pending or in_progress', () => {
    const todos: TodoItem[] = [
      { task_id: '1', content: 'Active', status: 'in_progress', priority: 'low' },
      { task_id: '2', content: 'Pending', status: 'pending', priority: 'low' },
      { task_id: '3', content: 'Done', status: 'completed', priority: 'low' },
      { task_id: '4', content: 'Cancelled', status: 'cancelled', priority: 'low' },
    ]

    render(
      <TodosPopover
        open
        onOpenChange={() => {}}
        todos={todos}
        sessionId="session-123"
      />,
    )

    expect(screen.getByText('Active').className).not.toContain('line-through')
    expect(screen.getByText('Pending').className).not.toContain('line-through')
    expect(screen.getByText('Done').className).toContain('line-through')
    expect(screen.getByText('Cancelled').className).toContain('line-through')
  })

  it('does not apply the mobile first-open zoom-in animation', () => {
    render(
      <TodosPopover
        open
        onOpenChange={() => {}}
        todos={[]}
        sessionId="session-123"
        trigger={false}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: 'Tasks' })
    expect(dialog.className).not.toContain('zoom-in-95')
    expect(dialog.className).toContain('fade-in-0')
  })

})
