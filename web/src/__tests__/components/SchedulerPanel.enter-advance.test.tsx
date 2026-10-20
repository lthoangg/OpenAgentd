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

  it('CreateTaskForm: Enter in the title advances focus and does not submit', async () => {
    const user = userEvent.setup()
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    const title = screen.getByLabelText('Task title') as HTMLInputElement
    fireEvent.change(title, { target: { value: 'Valid title' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Valid prompt' } })

    await user.click(title)
    await user.keyboard('{Enter}')

    expect(createMutate).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(title)
    expect(document.activeElement).toBe(nextField(title) ?? null)
  })

  it('CreateTaskForm: Enter in the last input lands on the submit button without submitting', async () => {
    const user = userEvent.setup()
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Valid title' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Valid prompt' } })
    const maxRuns = screen.getByLabelText(/Max runs/) as HTMLInputElement

    await user.click(maxRuns)
    await user.keyboard('{Enter}')

    expect(createMutate).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create task' }))
  })

  it('CreateTaskForm: only the submit button submits', async () => {
    const user = userEvent.setup()
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Valid title' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Valid prompt' } })

    await user.click(screen.getByRole('button', { name: 'Create task' }))
    expect(createMutate).toHaveBeenCalledTimes(1)
  })

  it('CreateTaskForm: Enter inside the prompt textarea still inserts a newline (not intercepted)', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    const prompt = screen.getByLabelText('Prompt')
    // fireEvent returns false when preventDefault was called.
    expect(fireEvent.keyDown(prompt, { key: 'Enter' })).toBe(true)
  })

  it('CreateTaskForm: single-line inputs show a Next key; the title keeps prose keyboard settings', () => {
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    const title = screen.getByLabelText('Task title')
    expect(title.getAttribute('enterkeyhint')).toBe('next')
    expect(title.getAttribute('autocapitalize')).toBe('sentences')
    expect(title.getAttribute('autocorrect')).toBe('on')
    const interval = screen.getByLabelText('Interval (seconds)')
    expect(interval.getAttribute('enterkeyhint')).toBe('next')
  })

  it('EditTaskForm: Enter in the interval advances focus and does not submit', async () => {
    const user = userEvent.setup()
    renderWithQuery(<EditTaskForm task={TASK} onSuccess={() => {}} onCancel={() => {}} />)
    const interval = screen.getByLabelText('Interval (seconds)') as HTMLInputElement

    await user.click(interval)
    await user.keyboard('{Enter}')

    expect(updateMutate).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(interval)
    expect(document.activeElement).toBe(nextField(interval) ?? null)
  })
})

describe('scheduler forms with a mouse or trackpad', () => {
  beforeEach(() => {
    createMutate.mockClear()
    useAgentStore.setState({ sessionId: null, sessionTitle: null, _workspace: null })
  })
  afterEach(() => cleanup())

  it('CreateTaskForm: Enter in the title still submits, as before', async () => {
    const user = userEvent.setup()
    renderWithQuery(<CreateTaskForm contextWorkspace="/repo/app" onSuccess={() => {}} />)
    const title = screen.getByLabelText('Task title') as HTMLInputElement
    fireEvent.change(title, { target: { value: 'Valid title' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Valid prompt' } })

    await user.click(title)
    await user.keyboard('{Enter}')

    expect(createMutate).toHaveBeenCalledTimes(1)
  })
})
