/**
 * When scheduler form errors appear and go: only after a submit, then
 * re-checked as the field changes, with focus taken to the first problem.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScheduledTaskResponse } from '@/api/types'
import { CreateTaskForm } from '@/components/SchedulerPanel/CreateTaskForm'
import { EditTaskForm } from '@/components/SchedulerPanel/EditTaskForm'
import { useAgentStore } from '@/stores/useAgentStore'
import '@testing-library/jest-dom'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const createMutate = mock((..._args: unknown[]) => {})
const updateMutate = mock((..._args: unknown[]) => {})
mock.module('@/queries', () => ({
  useScheduledTasksQuery: () => ({ data: { tasks: [] } }),
  useCreateScheduledTaskMutation: () => ({ mutate: createMutate, isPending: false }),
  useUpdateScheduledTaskMutation: () => ({ mutate: updateMutate, isPending: false }),
}))

function renderWithQuery(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

function task(overrides: Partial<ScheduledTaskResponse> = {}): ScheduledTaskResponse {
  return {
    id: 'task-id', slug: 'existing-task', name: 'Existing task', workspace: '/repo/app',
    schedule_type: 'every', at_datetime: null, every_seconds: 3600, cron_expression: null,
    timezone: 'UTC', prompt: 'Existing prompt', session_id: null, max_runs: null, enabled: true,
    status: 'pending', run_count: 0, last_run_at: null, last_error: null, next_fire_at: null,
    created_at: '2026-08-13T00:00:00Z', updated_at: '2026-08-13T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  createMutate.mockClear()
  updateMutate.mockClear()
  useAgentStore.setState({ sessionId: null, sessionTitle: null, _workspace: null })
})
afterEach(cleanup)

const PROMPT = 'What should it do?'

describe('Create task validation timing', () => {
  it('shows nothing while the form is first filled in', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    const prompt = screen.getByLabelText(PROMPT)
    fireEvent.change(prompt, { target: { value: 'Draft' } })
    fireEvent.change(prompt, { target: { value: '' } })

    expect(screen.queryByText('Say what the task should do.')).toBeNull()
    expect(prompt).toHaveAttribute('aria-invalid', 'false')
  })

  it('focuses the first invalid field when a submit fails', async () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

    expect(screen.getByText('Say what the task should do.')).toBeInTheDocument()
    expect(screen.getByText('Choose a time.')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement === screen.getByLabelText(PROMPT)).toBe(true))
    expect(createMutate).not.toHaveBeenCalled()
  })

  it('clears an error as soon as its field is fixed, leaving the others', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

    const prompt = screen.getByLabelText(PROMPT)
    fireEvent.change(prompt, { target: { value: 'Write the nightly report' } })

    expect(screen.queryByText('Say what the task should do.')).toBeNull()
    expect(prompt).toHaveAttribute('aria-invalid', 'false')
    expect(screen.getByText('Choose a time.')).toBeInTheDocument()
  })

  it('shows the error again if the fixed field is broken again', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    const prompt = screen.getByLabelText(PROMPT)
    fireEvent.change(prompt, { target: { value: 'Write the nightly report' } })
    fireEvent.change(prompt, { target: { value: '' } })

    expect(screen.getByText('Say what the task should do.')).toBeInTheDocument()
  })

  it('labels the last field\'s Enter key "done"', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    expect(screen.getByLabelText('Time')).toHaveAttribute('enterkeyhint', 'next')
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    expect(screen.getByLabelText('Session ID')).toHaveAttribute('enterkeyhint', 'done')
    expect(screen.getByLabelText('Name')).toHaveAttribute('enterkeyhint', 'next')
  })
})

describe('Edit task validation timing', () => {
  it('focuses the broken field on save and clears the error once it is fixed', async () => {
    renderWithQuery(<EditTaskForm task={task()} onSuccess={() => {}} onCancel={() => {}} />)
    const prompt = screen.getByLabelText(PROMPT)
    fireEvent.change(prompt, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(document.activeElement === prompt).toBe(true))
    fireEvent.change(prompt, { target: { value: 'Fixed prompt' } })

    expect(screen.queryByText('Say what the task should do.')).toBeNull()
    expect(prompt).toHaveAttribute('aria-invalid', 'false')
    expect(updateMutate).not.toHaveBeenCalled()
  })

  it('opens More options and focuses the field there when that is where the problem is', async () => {
    renderWithQuery(<EditTaskForm task={task({ max_runs: 3 })} onSuccess={() => {}} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.change(screen.getByLabelText('Stop after'), { target: { value: '0.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(document.activeElement === screen.queryByLabelText('Stop after')).toBe(true))
    expect(screen.getByText('Enter a whole number above zero, or leave it empty.')).toBeInTheDocument()
    expect(updateMutate).not.toHaveBeenCalled()
  })
})
