import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScheduledTaskResponse } from '@/api/types'
import { CreateTaskForm } from '@/components/SchedulerPanel/CreateTaskForm'
import { EditTaskForm } from '@/components/SchedulerPanel/EditTaskForm'
import { useAgentStore } from '@/stores/useAgentStore'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const createMutate = mock((..._args: unknown[]) => {})
const updateMutate = mock((..._args: unknown[]) => {})

mock.module('@/queries', () => ({
  useScheduledTasksQuery: () => ({ data: { tasks: [] } }),
  useCreateScheduledTaskMutation: () => ({ mutate: createMutate, isPending: false }),
  useUpdateScheduledTaskMutation: () => ({ mutate: updateMutate, isPending: false }),
}))

function renderWithQuery(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

const TASK: ScheduledTaskResponse = {
  id: 'task-id', slug: 'existing-task', name: 'Existing task', workspace: '/repo/app',
  schedule_type: 'every', at_datetime: null, every_seconds: 3600, cron_expression: null,
  timezone: 'UTC', prompt: 'Existing prompt', session_id: null, max_runs: null, enabled: true,
  status: 'pending', run_count: 0, last_run_at: null, last_error: null, next_fire_at: null,
  created_at: '2026-08-13T00:00:00Z', updated_at: '2026-08-13T00:00:00Z',
}

/** The next enabled field after `el` inside its form, in DOM order. */
function nextField(el: HTMLElement): Element | undefined {
  const form = el.closest('form') as HTMLFormElement
  const all = Array.from(form.querySelectorAll('input, textarea, select, button')).filter(
    (node) => !(node as HTMLInputElement).disabled && (node as HTMLElement).tabIndex !== -1,
  )
  return all[all.indexOf(el) + 1]
}

const realMatchMedia = window.matchMedia
/** A touch screen: ``(pointer: fine)`` does not match. */
function useTouch() {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

describe('scheduler forms on a touch keyboard: Enter moves to the next field', () => {
  beforeEach(() => {
    useTouch()
    createMutate.mockClear()
    updateMutate.mockClear()
    useAgentStore.setState({ sessionId: null, sessionTitle: null, _workspace: null })
  })
  afterEach(() => {
    cleanup()
    window.matchMedia = realMatchMedia
  })

  it('CreateTaskForm: Enter in the time advances focus and does not submit', async () => {
    const user = userEvent.setup()
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    fireEvent.change(screen.getByLabelText('What should it do?'), { target: { value: 'Valid prompt' } })
    const time = screen.getByLabelText('Time') as HTMLInputElement

    await user.click(time)
    await user.keyboard('{Enter}')

    expect(createMutate).not.toHaveBeenCalled()
    expect(document.activeElement === time).toBe(false)
    expect(document.activeElement === (nextField(time) ?? null)).toBe(true)
  })

  it('CreateTaskForm: Enter in the last input passes "Back" and lands on the submit button without submitting', async () => {
    const user = userEvent.setup()
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    fireEvent.change(screen.getByLabelText('What should it do?'), { target: { value: 'Valid prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    const sessionId = screen.getByLabelText('Session ID') as HTMLInputElement

    await user.click(sessionId)
    await user.keyboard('{Enter}')

    expect(createMutate).not.toHaveBeenCalled()
    expect(document.activeElement === screen.getByRole('button', { name: 'Create task' })).toBe(true)
  })

  it('CreateTaskForm: only the submit button submits', async () => {
    const user = userEvent.setup()
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    fireEvent.change(screen.getByLabelText('What should it do?'), { target: { value: 'Valid prompt' } })

    await user.click(screen.getByRole('button', { name: 'Create task' }))
    expect(createMutate).toHaveBeenCalledTimes(1)
  })

  it('CreateTaskForm: Enter inside the prompt textarea still inserts a newline (not intercepted)', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    const prompt = screen.getByLabelText('What should it do?')
    // fireEvent returns false when preventDefault was called.
    expect(fireEvent.keyDown(prompt, { key: 'Enter' })).toBe(true)
  })

  it('CreateTaskForm: single-line inputs show a Next key; the name keeps prose keyboard settings', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    expect(screen.getByLabelText('Time').getAttribute('enterkeyhint')).toBe('next')
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    const name = screen.getByLabelText('Name')
    expect(name.getAttribute('enterkeyhint')).toBe('next')
    expect(name.getAttribute('autocapitalize')).toBe('sentences')
    expect(name.getAttribute('autocorrect')).toBe('on')
  })

  it('EditTaskForm: Enter in the interval advances focus and does not submit', async () => {
    const user = userEvent.setup()
    renderWithQuery(<EditTaskForm task={TASK} onSuccess={() => {}} onCancel={() => {}} />)
    const interval = screen.getByLabelText('Interval') as HTMLInputElement

    await user.click(interval)
    await user.keyboard('{Enter}')

    expect(updateMutate).not.toHaveBeenCalled()
    expect(document.activeElement === interval).toBe(false)
    expect(document.activeElement === (nextField(interval) ?? null)).toBe(true)
  })
})

describe('scheduler forms with a mouse or trackpad', () => {
  beforeEach(() => {
    createMutate.mockClear()
    useAgentStore.setState({ sessionId: null, sessionTitle: null, _workspace: null })
  })
  afterEach(() => cleanup())

  it('CreateTaskForm: Enter in the time still submits, as before', async () => {
    const user = userEvent.setup()
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    fireEvent.change(screen.getByLabelText('What should it do?'), { target: { value: 'Valid prompt' } })

    await user.click(screen.getByLabelText('Time'))
    await user.keyboard('{Enter}')

    expect(createMutate).toHaveBeenCalledTimes(1)
  })
})
