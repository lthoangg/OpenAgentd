import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScheduledTaskResponse } from '@/api/types'
import { CreateTaskForm } from '@/components/SchedulerPanel/CreateTaskForm'
import { EditTaskForm } from '@/components/SchedulerPanel/EditTaskForm'
import { useAgentStore } from '@/stores/useAgentStore'
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
    id: 'task-id', slug: 'existing-task', name: 'Existing task', workspace: '/repo/app',
    schedule_type: 'every', at_datetime: null, every_seconds: 3600, cron_expression: null,
    timezone: 'UTC', prompt: 'Existing prompt', session_id: null, max_runs: null, enabled: true,
    status: 'pending', run_count: 0, last_run_at: null, last_error: null, next_fire_at: null,
    created_at: '2026-08-13T00:00:00Z', updated_at: '2026-08-13T00:00:00Z',
    ...overrides,
  }
}

async function chooseDropdown(triggerName: RegExp, optionLabel: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: triggerName }))
  fireEvent.click(await screen.findByRole('option', { name: optionLabel }))
}

describe('scheduler TanStack Form mutations', () => {
  beforeEach(() => {
    createMutate.mockClear()
    updateMutate.mockClear()
    createPending = false
    updatePending = false
    useAgentStore.setState({ sessionId: null, sessionTitle: null, _workspace: null })
  })

  afterEach(() => cleanup())

  it('links a missing coding workspace error to its selector', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace={null} onSuccess={() => {}} />)

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Coding task' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Run in a workspace' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

    const workspace = screen.getByRole('button', { name: 'Select workspace' })
    expect(workspace.getAttribute('aria-invalid')).toBe('true')
    expect(workspace.getAttribute('aria-describedby')).toBe('task-workspace-error')
    expect(screen.getByText('Workspace is required').getAttribute('id')).toBe('task-workspace-error')
    expect(createMutate).not.toHaveBeenCalled()
  })

  it('creates an every task with an exact exclusive payload', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Repeating task' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Run repeatedly' } })
    // The amount is in the chosen unit (hours by default): 2 hours is 7200 s
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

    expect(createMutate).toHaveBeenCalledTimes(1)
    const payload = createMutate.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toEqual({
      name: 'Repeating task', workspace: '/repo/app', schedule_type: 'every', timezone: 'UTC',
      prompt: 'Run repeatedly', session_id: null, max_runs: null, enabled: true, every_seconds: 7200,
    })
    expect('at_datetime' in payload).toBe(false)
    expect('cron_expression' in payload).toBe(false)
  })

  it('shows the default interval as 1 hours, with the seconds it means', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

    expect(screen.getByLabelText('Every')).toHaveValue(1)
    expect(screen.getByRole('button', { name: 'Interval unit' }).textContent).toContain('hours')
    expect(screen.getByText('= 3,600 s')).toBeInTheDocument()
    expect(screen.getByText('The first run is one interval after you save.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Interval (seconds)')).toBeNull()
  })

  it('offers days, hours, minutes and seconds, and changes what the typed number counts', async () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Interval unit' }))
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual(['days', 'hours', 'minutes', 'seconds'])
    fireEvent.click(screen.getByRole('option', { name: 'minutes' }))

    // 1 hour re-expressed as the same amount of the new unit: 1 minute
    await waitFor(() => expect(screen.getByLabelText('Every')).toHaveValue(1))
    expect(screen.getByText('= 60 s')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '90' } })
    expect(screen.getByText('= 5,400 s')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Minutes task' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Run often' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    expect((createMutate.mock.calls[0][0] as { every_seconds: number }).every_seconds).toBe(5400)
  })

  it('titles the form "New task" and writes the prompt in sans text', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

    expect(screen.getByRole('heading', { name: 'New task' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Daily standup report')).toBeInTheDocument()
    const prompt = screen.getByLabelText('Prompt')
    expect(prompt.className).toContain('text-sm')
    expect(prompt.className).not.toContain('font-mono')
  })

  it('names the workspace picker "Choose a workspace…" until one is picked', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace={null} onSuccess={() => {}} />)
    expect(screen.getByRole('button', { name: 'Select workspace' }).textContent).toContain('Choose a workspace…')
  })

  it('previews a cron expression and rejects an invalid one', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

    fireEvent.click(screen.getByRole('radio', { name: /cron/i }))
    const cron = screen.getByLabelText('Cron expression')
    expect(cron).toHaveAttribute('placeholder', '0 9 * * 1-5')

    fireEvent.change(cron, { target: { value: '0 9 * * 1-5' } })
    expect(screen.getByText('Weekdays at 09:00')).toBeInTheDocument()
    fireEvent.change(cron, { target: { value: '0 9 1 6 *' } })
    expect(screen.getByText('Custom schedule')).toBeInTheDocument()
    fireEvent.change(cron, { target: { value: '61 * * * *' } })
    expect(screen.getByText(/Not a valid cron expression yet/)).toBeInTheDocument()
    expect(cron).toHaveAttribute('aria-invalid', 'true')

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Cron task' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Run on a schedule' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    expect(createMutate).not.toHaveBeenCalled()
    expect(screen.getByText(/This isn't a valid cron expression/)).toBeInTheDocument()

    fireEvent.change(cron, { target: { value: '0 9 * * 1-5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    expect((createMutate.mock.calls[0][0] as { cron_expression: string }).cron_expression).toBe('0 9 * * 1-5')
  })

  it('hydrates Edit, updates every values, and sends an exact PUT body', async () => {
    renderWithQuery(<EditTaskForm task={task()} onSuccess={() => {}} onCancel={() => {}} />)

    expect(screen.getByLabelText('Prompt')).toHaveValue('Existing prompt')
    // 3600 s hydrates as 1 hours
    expect(screen.getByLabelText('Every')).toHaveValue(1)
    expect(screen.getByRole('button', { name: 'Interval unit' }).textContent).toContain('hours')
    await chooseDropdown(/Interval unit/, /^minutes$/)
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Updated prompt' } })
    await chooseDropdown(/Session Target/i, /Persistent Task Session/i)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(updateMutate).toHaveBeenCalledTimes(1)
    expect(updateMutate.mock.calls[0][0]).toEqual({
      slug: 'existing-task',
      body: {
        workspace: '/repo/app', schedule_type: 'every', timezone: 'UTC',
        prompt: 'Updated prompt', session_id: 'auto', max_runs: null, enabled: true,
        every_seconds: 120,
      },
    })
  })

  it('announces Edit validation errors at their fields and does not mutate', () => {
    renderWithQuery(<EditTaskForm task={task()} onSuccess={() => {}} onCancel={() => {}} />)

    const prompt = screen.getByLabelText('Prompt')
    fireEvent.change(prompt, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Update failed'))
    expect(prompt).toHaveValue('Retry this draft')
  })
})
