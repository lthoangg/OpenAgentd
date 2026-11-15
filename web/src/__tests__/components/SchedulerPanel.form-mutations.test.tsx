import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
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

let existingSlugs: string[] = []

mock.module('@/queries', () => ({
  useScheduledTasksQuery: () => ({ data: { tasks: existingSlugs.map((slug) => ({ slug })) } }),
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

const PROMPT = 'What should it do?'

describe('scheduler TanStack Form mutations', () => {
  beforeEach(() => {
    createMutate.mockClear()
    updateMutate.mockClear()
    createPending = false
    updatePending = false
    existingSlugs = []
    useAgentStore.setState({ sessionId: null, sessionTitle: null, _workspace: null })
  })

  afterEach(() => cleanup())

  it('asks three questions and where the reply goes, and nothing else, on the first page', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

    expect(screen.getByLabelText(PROMPT)).toHaveAttribute('placeholder', 'Summarize what changed in this folder since yesterday.')
    expect(screen.getByLabelText('When?').textContent).toContain('Every day')
    expect(screen.getByLabelText('Time')).toHaveValue('09:00')
    expect(screen.getByLabelText('Where?').textContent).toContain('app')
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-label'))).toEqual(['A new session each time', 'The same session'])
    for (const label of ['Name', 'Stop after', 'Time zone', 'Session ID', 'Cron expression', 'Interval']) {
      expect(screen.queryByLabelText(label)).toBeNull()
    }
  })

  it('offers "This session" when the open session is in the task\'s workspace, and sends its ID', () => {
    useAgentStore.setState({ sessionId: 'session-1', sessionTitle: 'Fix the build', _workspace: '/repo/app' })
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

    fireEvent.change(screen.getByLabelText(PROMPT), { target: { value: 'Check the build' } })
    fireEvent.click(screen.getByRole('radio', { name: 'This session' }))
    expect(screen.getByText('Every run adds to “Fix the build”.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

    expect((createMutate.mock.calls[0][0] as { session_id: string }).session_id).toBe('session-1')
  })

  it('links a missing workspace error to its selector', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace={null} onSuccess={() => {}} />)

    fireEvent.change(screen.getByLabelText(PROMPT), { target: { value: 'Run in a workspace' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

    const workspace = screen.getByLabelText('Where?')
    expect(workspace.getAttribute('aria-invalid')).toBe('true')
    expect(workspace.getAttribute('aria-describedby')).toBe('task-workspace-error')
    expect(screen.getByText('Choose a workspace.').getAttribute('id')).toBe('task-workspace-error')
    expect(createMutate).not.toHaveBeenCalled()
  })

  it('creates "every weekday at 9" without a number of seconds, named after the prompt', async () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

    fireEvent.change(screen.getByLabelText(PROMPT), { target: { value: 'Summarize what changed since yesterday.' } })
    await chooseDropdown(/When/, /^Every weekday$/)
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

    expect(createMutate).toHaveBeenCalledTimes(1)
    const payload = createMutate.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toEqual({
      name: 'Summarize what changed since yesterday', workspace: '/repo/app', schedule_type: 'cron', timezone: 'UTC',
      prompt: 'Summarize what changed since yesterday.', session_id: null, max_runs: null, enabled: true,
      cron_expression: '0 9 * * 1-5',
    })
    expect('at_datetime' in payload).toBe(false)
    expect('every_seconds' in payload).toBe(false)
  })

  it('numbers the name it writes when another task already has it', () => {
    existingSlugs = ['check-the-build']
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

    fireEvent.change(screen.getByLabelText(PROMPT), { target: { value: 'Check the build' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

    expect((createMutate.mock.calls[0][0] as { name: string }).name).toBe('Check the build 2')
  })

  it('picks a day for "Every week on" and writes it with the time', async () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

    fireEvent.change(screen.getByLabelText(PROMPT), { target: { value: 'Weekly review' } })
    await chooseDropdown(/When/, /^Every week on…$/)
    expect(screen.getByLabelText('When?').textContent).toContain('Every week on')
    await chooseDropdown(/Day of the week/, /^Friday$/)
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '17:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

    expect(createMutate.mock.calls[0][0]).toMatchObject({ schedule_type: 'cron', cron_expression: '30 17 * * 5' })
  })

  it('creates an interval task with an exact exclusive payload', async () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

    fireEvent.change(screen.getByLabelText(PROMPT), { target: { value: 'Run repeatedly' } })
    await chooseDropdown(/When/, /minutes, hours or days/)
    // The amount is in the chosen unit (hours by default): 2 hours is 7200 s
    fireEvent.change(screen.getByLabelText('Interval'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

    expect(createMutate).toHaveBeenCalledTimes(1)
    const payload = createMutate.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toEqual({
      name: 'Run repeatedly', workspace: '/repo/app', schedule_type: 'every', timezone: 'UTC',
      prompt: 'Run repeatedly', session_id: null, max_runs: null, enabled: true, every_seconds: 7200,
    })
    expect('at_datetime' in payload).toBe(false)
    expect('cron_expression' in payload).toBe(false)
  })

  it('shows an interval as an amount and a unit, never as seconds', async () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    await chooseDropdown(/When/, /minutes, hours or days/)

    expect(screen.getByLabelText('When?').textContent).toBe('Every')
    expect(screen.getByLabelText('Interval')).toHaveValue(1)
    expect(screen.getByRole('button', { name: 'Interval unit' }).textContent).toContain('hours')
    expect(screen.queryByText(/= [\d,]+ s/)).toBeNull()
  })

  describe('when the task runs next', () => {
    let now: ReturnType<typeof spyOn> | null = null
    const clock = (iso: string) => { now = spyOn(Date, 'now').mockReturnValue(new Date(iso).getTime()) }
    afterEach(() => { now?.mockRestore(); now = null })

    it('says when a repeating task first runs if saved now, in the local clock', async () => {
      clock('2026-11-07T10:00:00Z')
      renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
      await chooseDropdown(/When/, /minutes, hours or days/)
      const hint = document.getElementById('task-when-hint') as HTMLElement
      const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone
      const at = new Date('2026-11-07T11:00:00Z').toLocaleString('en-US', { timeZone: localTz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      expect(hint.textContent).toBe(`First run: ${at.replace(' at ', ', ')}, one interval after you save.`)
      // The field reads it too.
      expect(screen.getByLabelText('Interval').getAttribute('aria-describedby')).toBe(hint.id)
    })

    it('says how soon a one-time task runs, in its timezone', () => {
      clock('2026-11-07T10:00:00Z')
      renderWithQuery(
        <EditTaskForm task={task({ schedule_type: 'at', every_seconds: null, at_datetime: '2026-11-07T13:00:00Z', timezone: 'Asia/Ho_Chi_Minh' })} onSuccess={() => {}} onCancel={() => {}} />,
      )
      expect(screen.getByLabelText('When?').textContent).toBe('Once, on')
      expect(screen.getByText('Runs in 3h (Asia/Ho_Chi_Minh)')).toBeInTheDocument()
    })

    it('warns that a one-time task set in the past runs as soon as it is saved', () => {
      clock('2026-11-07T10:00:00Z')
      renderWithQuery(
        <EditTaskForm task={task({ schedule_type: 'at', every_seconds: null, at_datetime: '2026-11-07T08:00:00Z' })} onSuccess={() => {}} onCancel={() => {}} />,
      )
      expect(screen.getByText('That time has passed: it runs as soon as you save.')).toBeInTheDocument()
    })
  })

  it('offers days, hours and minutes, and changes what the typed number counts', async () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    await chooseDropdown(/When/, /minutes, hours or days/)

    fireEvent.click(screen.getByRole('button', { name: 'Interval unit' }))
    // The "When?" menu leaves on its exit motion first.
    await waitFor(() => expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['days', 'hours', 'minutes']))
    fireEvent.click(screen.getByRole('option', { name: 'minutes' }))

    // 1 hour re-expressed as the same amount of the new unit: 1 minute
    await waitFor(() => expect(screen.getByRole('button', { name: 'Interval unit' }).textContent).toContain('minutes'))
    expect(screen.getByLabelText('Interval')).toHaveValue(1)

    fireEvent.change(screen.getByLabelText('Interval'), { target: { value: '90' } })
    fireEvent.change(screen.getByLabelText(PROMPT), { target: { value: 'Run often' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    expect((createMutate.mock.calls[0][0] as { every_seconds: number }).every_seconds).toBe(5400)
  })

  it('keeps seconds for a task that already counts in them', async () => {
    renderWithQuery(<EditTaskForm task={task({ every_seconds: 90 })} onSuccess={() => {}} onCancel={() => {}} />)

    expect(screen.getByLabelText('Interval')).toHaveValue(90)
    fireEvent.click(screen.getByRole('button', { name: 'Interval unit' }))
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual(['days', 'hours', 'minutes', 'seconds'])
  })

  it('titles the form "New task" and writes the prompt in sans text', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

    expect(screen.getByRole('heading', { name: 'New task' })).toBeInTheDocument()
    const prompt = screen.getByLabelText(PROMPT)
    expect(prompt.className).toContain('text-sm')
    expect(prompt.className).not.toContain('font-mono')
  })

  it('names the workspace picker "Choose a workspace…" until one is picked', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace={null} onSuccess={() => {}} />)
    expect(screen.getByLabelText('Where?').textContent).toContain('Choose a workspace…')
  })

  it('previews a cron expression and rejects an invalid one', async () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

    await chooseDropdown(/When/, /^Custom \(cron\)$/)
    const cron = screen.getByLabelText('Cron expression')
    expect(cron).toHaveAttribute('placeholder', '0 9 * * 1-5')

    fireEvent.change(cron, { target: { value: '0 9 * * 1-5' } })
    expect(screen.getByText('Weekdays at 09:00')).toBeInTheDocument()
    fireEvent.change(cron, { target: { value: '0 9 1 6 *' } })
    expect(screen.getByText('Custom schedule')).toBeInTheDocument()
    fireEvent.change(cron, { target: { value: '61 * * * *' } })
    expect(screen.getByText(/Not a valid cron expression yet/)).toBeInTheDocument()
    expect(cron).toHaveAttribute('aria-invalid', 'true')

    fireEvent.change(screen.getByLabelText(PROMPT), { target: { value: 'Run on a schedule' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    expect(createMutate).not.toHaveBeenCalled()
    expect(screen.getByText(/This isn't a valid cron expression/)).toBeInTheDocument()

    fireEvent.change(cron, { target: { value: '0 9 1 6 *' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    expect(createMutate.mock.calls[0][0]).toMatchObject({ schedule_type: 'cron', cron_expression: '0 9 1 6 *' })
  })

  describe('More options', () => {
    it('is a second page with the name, a run limit, the time zone and a session ID', () => {
      renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

      fireEvent.click(screen.getByRole('button', { name: 'More options' }))
      expect(screen.getByRole('heading', { name: 'More options' })).toBeInTheDocument()
      for (const label of ['Name', 'Stop after', 'Time zone', 'Session ID']) expect(screen.getByLabelText(label)).toBeInTheDocument()
      expect(screen.queryByLabelText(PROMPT)).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      expect(screen.getByLabelText(PROMPT)).toBeInTheDocument()
    })

    it('keeps what was typed on one page while the other is open, and sends both', () => {
      renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

      fireEvent.change(screen.getByLabelText(PROMPT), { target: { value: 'Send the report' } })
      fireEvent.click(screen.getByRole('button', { name: 'More options' }))
      // The name it would get is the placeholder.
      expect(screen.getByLabelText('Name')).toHaveAttribute('placeholder', 'Send the report')
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Daily report' } })
      fireEvent.change(screen.getByLabelText('Stop after'), { target: { value: '3' } })
      fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Asia/Tokyo' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

      expect(createMutate.mock.calls[0][0]).toEqual({
        name: 'Daily report', workspace: '/repo/app', schedule_type: 'cron', timezone: 'Asia/Tokyo',
        prompt: 'Send the report', session_id: null, max_runs: 3, enabled: true, cron_expression: '0 9 * * *',
      })
    })

    it('opens the page that holds the problem when a submit fails on the other one', () => {
      renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)

      // Nothing typed: the problem (no prompt) is on the first page.
      fireEvent.click(screen.getByRole('button', { name: 'More options' }))
      fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
      expect(createMutate).not.toHaveBeenCalled()
      expect(screen.getByLabelText(PROMPT)).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByText('Say what the task should do.')).toBeInTheDocument()

      // Fixed there, with a problem left on More options: that page opens.
      fireEvent.change(screen.getByLabelText(PROMPT), { target: { value: 'Go' } })
      fireEvent.click(screen.getByRole('button', { name: 'More options' }))
      fireEvent.change(screen.getByLabelText('Stop after'), { target: { value: '-2' } })
      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
      expect(createMutate).not.toHaveBeenCalled()
      expect(screen.getByLabelText('Stop after')).toHaveAttribute('aria-invalid', 'true')
    })

    it('has no Name on Edit: a saved task keeps its name', () => {
      renderWithQuery(<EditTaskForm task={task()} onSuccess={() => {}} onCancel={() => {}} />)
      fireEvent.click(screen.getByRole('button', { name: 'More options' }))
      expect(screen.queryByLabelText('Name')).toBeNull()
      expect(screen.getByLabelText('Stop after')).toBeInTheDocument()
    })
  })

  it('hydrates Edit, updates interval values, and sends an exact PUT body', async () => {
    renderWithQuery(<EditTaskForm task={task()} onSuccess={() => {}} onCancel={() => {}} />)

    expect(screen.getByLabelText(PROMPT)).toHaveValue('Existing prompt')
    // 3600 s hydrates as 1 hours
    expect(screen.getByLabelText('Interval')).toHaveValue(1)
    expect(screen.getByRole('button', { name: 'Interval unit' }).textContent).toContain('hours')
    await chooseDropdown(/Interval unit/, /^minutes$/)
    fireEvent.change(screen.getByLabelText('Interval'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(PROMPT), { target: { value: 'Updated prompt' } })
    fireEvent.click(screen.getByRole('radio', { name: 'The same session' }))
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

  it('opens a saved weekday schedule as "Every weekday" and says when it runs next', () => {
    renderWithQuery(
      <EditTaskForm task={task({ schedule_type: 'cron', every_seconds: null, cron_expression: '30 8 * * 1-5' })} onSuccess={() => {}} onCancel={() => {}} />,
    )
    expect(screen.getByLabelText('When?').textContent).toBe('Every weekday')
    expect(screen.getByLabelText('Time')).toHaveValue('08:30')
    expect(document.getElementById('edit-task-when-hint')?.textContent).toMatch(/^Next run: \w{3} \w{3} \d+, 08:30 \(UTC\)\.$/)
    expect(screen.queryByLabelText('Cron expression')).toBeNull()
  })

  it('announces Edit validation errors at their fields and does not mutate', () => {
    renderWithQuery(<EditTaskForm task={task()} onSuccess={() => {}} onCancel={() => {}} />)

    const prompt = screen.getByLabelText(PROMPT)
    fireEvent.change(prompt, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(updateMutate).not.toHaveBeenCalled()
    expect(prompt).toHaveAttribute('aria-invalid', 'true')
    expect(prompt).toHaveAttribute('aria-describedby', 'edit-task-prompt-error')
    expect(screen.getByRole('alert')).toHaveTextContent('Please correct the highlighted fields.')
    expect(screen.getByText('Say what the task should do.')).toBeInTheDocument()
  })

  it('preserves an Edit draft and exposes API failures as an alert', async () => {
    updateMutate.mockImplementation((...args: unknown[]) => {
      const options = args[1] as MutationOptions
      options.onError?.(new Error('Update failed'))
    })
    renderWithQuery(<EditTaskForm task={task()} onSuccess={() => {}} onCancel={() => {}} />)

    const prompt = screen.getByLabelText(PROMPT)
    fireEvent.change(prompt, { target: { value: 'Retry this draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Update failed'))
    expect(prompt).toHaveValue('Retry this draft')
  })
})
