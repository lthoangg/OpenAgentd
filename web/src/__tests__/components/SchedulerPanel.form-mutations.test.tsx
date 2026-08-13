import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScheduledTaskResponse } from '@/api/types'
import { CreateTaskForm } from '@/components/SchedulerPanel/CreateTaskForm'
import { EditTaskForm } from '@/components/SchedulerPanel/EditTaskForm'
import { useTeamStore } from '@/stores/useTeamStore'
import '@testing-library/jest-dom'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

type MutationOptions = { onSuccess?: () => void; onError?: (error: Error) => void }
const createMutate = mock((..._args: unknown[]) => {})
const updateMutate = mock((..._args: unknown[]) => {})
let createPending = false
let updatePending = false

mock.module('@/queries', () => ({
  useCreateScheduledTaskMutation: () => ({ mutate: createMutate, isPending: createPending }),
  useUpdateScheduledTaskMutation: () => ({ mutate: updateMutate, isPending: updatePending }),
}))

function renderWithQuery(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

function task(overrides: Partial<ScheduledTaskResponse> = {}): ScheduledTaskResponse {
  return {
    id: 'task-id', slug: 'existing-task', name: 'Existing task', mode: 'normal', workspace: null,
    schedule_type: 'every', at_datetime: null, every_seconds: 3600, cron_expression: null,
    timezone: 'UTC', prompt: 'Existing prompt', session_id: null, max_runs: null, enabled: true,
    status: 'pending', run_count: 0, last_run_at: null, last_error: null, next_fire_at: null,
    created_at: '2026-08-13T00:00:00Z', updated_at: '2026-08-13T00:00:00Z',
    ...overrides,
  }
}

async function chooseDropdown(triggerName: RegExp, optionLabel: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: triggerName }))
  fireEvent.click(await screen.findByRole('menuitem', { name: optionLabel }))
}

describe('scheduler TanStack Form mutations', () => {
  beforeEach(() => {
    createMutate.mockClear()
    updateMutate.mockClear()
    createPending = false
    updatePending = false
    useTeamStore.setState({ sessionId: null, sessionTitle: null, _workspace: null })
  })

  afterEach(() => cleanup())

  it('links a missing coding workspace error to its selector', () => {
    renderWithQuery(<CreateTaskForm contextMode="coding" contextWorkspace={null} onSuccess={() => {}} />)

    fireEvent.change(screen.getByLabelText('Task Title'), { target: { value: 'Coding task' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Run in a workspace' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))

    const workspace = screen.getByRole('button', { name: 'Select workspace' })
    expect(workspace.getAttribute('aria-invalid')).toBe('true')
    expect(workspace.getAttribute('aria-describedby')).toBe('task-workspace-error')
    expect(screen.getByText('Workspace is required for coding mode').getAttribute('id')).toBe('task-workspace-error')
    expect(createMutate).not.toHaveBeenCalled()
  })

  it('creates an every task with an exact exclusive payload', () => {
    renderWithQuery(<CreateTaskForm contextMode="normal" contextWorkspace={null} onSuccess={() => {}} />)

    fireEvent.change(screen.getByLabelText('Task Title'), { target: { value: 'Repeating task' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Run repeatedly' } })
    fireEvent.change(screen.getByLabelText('Interval (seconds)'), { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))

    expect(createMutate).toHaveBeenCalledTimes(1)
    const payload = createMutate.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toEqual({
      name: 'Repeating task', mode: 'normal', workspace: null, schedule_type: 'every', timezone: 'UTC',
      prompt: 'Run repeatedly', session_id: null, max_runs: null, enabled: true, every_seconds: 120,
    })
    expect('at_datetime' in payload).toBe(false)
    expect('cron_expression' in payload).toBe(false)
  })

  it('hydrates Edit, updates every values, and sends an exact PUT body', async () => {
    renderWithQuery(<EditTaskForm task={task()} onSuccess={() => {}} onCancel={() => {}} />)

    expect(screen.getByLabelText('Prompt')).toHaveValue('Existing prompt')
    fireEvent.change(screen.getByLabelText('Interval (seconds)'), { target: { value: '120' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Updated prompt' } })
    await chooseDropdown(/Session Target/i, /Persistent Task Session/i)
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    expect(updateMutate).toHaveBeenCalledTimes(1)
    expect(updateMutate.mock.calls[0][0]).toEqual({
      slug: 'existing-task',
      body: {
        mode: 'normal', workspace: null, schedule_type: 'every', timezone: 'UTC',
        prompt: 'Updated prompt', session_id: 'auto', max_runs: null, enabled: true,
        every_seconds: 120,
      },
    })
  })

  it('announces Edit validation errors at their fields and does not mutate', () => {
    renderWithQuery(<EditTaskForm task={task()} onSuccess={() => {}} onCancel={() => {}} />)

    const prompt = screen.getByLabelText('Prompt')
    fireEvent.change(prompt, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    expect(updateMutate).not.toHaveBeenCalled()
    expect(prompt).toHaveAttribute('aria-invalid', 'true')
    expect(prompt).toHaveAttribute('aria-describedby', 'edit-task-prompt-error')
    expect(screen.getByRole('alert')).toHaveTextContent('Please correct the highlighted fields.')
    expect(screen.getByText('Prompt is required')).toBeInTheDocument()
  })

  it('preserves an Edit draft and exposes API failures as an alert', async () => {
    updateMutate.mockImplementation((...args: unknown[]) => {
      const options = args[1] as MutationOptions
      options.onError?.(new Error('Update failed'))
    })
    renderWithQuery(<EditTaskForm task={task()} onSuccess={() => {}} onCancel={() => {}} />)

    const prompt = screen.getByLabelText('Prompt')
    fireEvent.change(prompt, { target: { value: 'Retry this draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Update failed'))
    expect(prompt).toHaveValue('Retry this draft')
  })
})
