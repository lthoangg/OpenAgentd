/**
 * TaskListPane — the three states every list has: loading is skeleton rows,
 * an error reads "Couldn't load X." with Retry, and empty is an EmptyState
 * whose title carries no full stop and which offers to create when it can.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom'
import { TaskListPane, type TaskListPaneProps } from '@/components/SchedulerPanel/TaskListPane'

afterEach(cleanup)

function renderPane(props: Partial<TaskListPaneProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TaskListPane
        tasks={[]}
        isLoading={false}
        isError={false}
        selectedTaskId={null}
        onSelect={() => {}}
        onDeleted={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  )
}

describe('TaskListPane', () => {
  it('loads as skeleton rows, not a spinner with a sentence', () => {
    renderPane({ isLoading: true })
    const status = screen.getByRole('status', { name: 'Loading scheduled tasks' })
    expect(status.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(3)
    expect(status.querySelector('.animate-spin')).toBeNull()
  })

  it("says \"Couldn't load scheduled tasks.\" with a Retry", () => {
    const onRetry = mock(() => {})
    renderPane({ isError: true, onRetry })
    expect(screen.getByText("Couldn't load scheduled tasks.")).toBeInTheDocument()
    expect(screen.queryByText(/Failed to load/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('offers "New task" from the empty state, which opens the create form', () => {
    const onCreate = mock(() => {})
    renderPane({ onCreate })
    expect(screen.getByRole('heading', { name: 'No scheduled tasks yet' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('has no create action when the host cannot create', () => {
    renderPane()
    expect(screen.queryByRole('button', { name: 'New task' })).toBeNull()
  })

  it('has none for a search with no matches, which is not an empty list', () => {
    renderPane({ onCreate: () => {} })
    fireEvent.change(screen.getByPlaceholderText('Search tasks…'), { target: { value: 'nothing like this' } })
    expect(screen.getByRole('heading', { name: 'No tasks match your search' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New task' })).toBeNull()
  })
})
