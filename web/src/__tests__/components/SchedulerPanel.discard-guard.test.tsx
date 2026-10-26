/**
 * Leaving a scheduler form that holds unsaved input asks first; leaving an
 * untouched form, or one just submitted, does not.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SchedulerPanel } from '@/components/SchedulerPanel'
import { SchedulerDockView } from '@/components/SchedulerPanel/SchedulerDockView'
import type { ScheduledTaskResponse } from '@/api/types'
import { useFakeTimers } from '../fake-timers'
import '@testing-library/jest-dom'

function task(name: string): ScheduledTaskResponse {
  return { id: 'task-1', slug: 'nightly', name, workspace: '/repo/app', schedule_type: 'every', at_datetime: null, every_seconds: 3600, cron_expression: null, timezone: 'UTC', prompt: 'Do the thing', session_id: null, enabled: true, status: 'pending', run_count: 0, max_runs: null, last_run_at: null, last_error: null, next_fire_at: null, created_at: '2026-05-25T00:00:00Z', updated_at: '2026-05-25T00:00:00Z' }
}

const originalFetch = globalThis.fetch
function stubApi(tasks: ScheduledTaskResponse[]) {
  globalThis.fetch = mock(async (...args: unknown[]) => {
    const init = args[1] as RequestInit | undefined
    const body = init?.method === 'POST' ? task('Created') : { tasks }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
}

function wrap(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('scheduler overlay — unsaved task', () => {
  it('closes at once when the form is untouched', async () => {
    stubApi([])
    const onClose = mock(() => {})
    wrap(<SchedulerPanel open onClose={onClose} contextWorkspace="/repo/app" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Close scheduler panel' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Discard this task?')).toBeNull()
  })

  it('asks before closing over a typed title, and Keep editing keeps it', async () => {
    stubApi([])
    const onClose = mock(() => {})
    wrap(<SchedulerPanel open onClose={onClose} contextWorkspace="/repo/app" />)
    fireEvent.change(await screen.findByLabelText('Task title'), { target: { value: 'Nightly report' } })

    fireEvent.click(screen.getByRole('button', { name: 'Close scheduler panel' }))
    expect(await screen.findByText('Discard this task?')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    // Step the dialog's exit motion instead of waiting on real timers.
    const timers = useFakeTimers()
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
      act(() => timers.tick(500))
    } finally {
      timers.restore()
    }
    expect(screen.queryByText('Discard this task?')).toBeNull()
    expect(screen.getByLabelText('Task title')).toHaveValue('Nightly report')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes after Discard', async () => {
    stubApi([])
    const onClose = mock(() => {})
    wrap(<SchedulerPanel open onClose={onClose} contextWorkspace="/repo/app" />)
    fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'Summarise the day' } })

    fireEvent.click(screen.getByRole('button', { name: 'Close scheduler panel' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('asks before opening another task over unsaved input', async () => {
    stubApi([task('Existing reminder')])
    wrap(<SchedulerPanel open onClose={() => {}} contextWorkspace="/repo/app" />)
    fireEvent.change(await screen.findByLabelText('Task title'), { target: { value: 'Nightly report' } })

    fireEvent.click(await screen.findByText('Existing reminder'))

    expect(await screen.findByText('Discard this task?')).toBeInTheDocument()
    expect(screen.getByLabelText('Task title')).toHaveValue('Nightly report')
  })

  it('does not ask once the task has been created', async () => {
    stubApi([])
    const onClose = mock(() => {})
    wrap(<SchedulerPanel open onClose={onClose} contextWorkspace="/repo/app" />)
    fireEvent.change(await screen.findByLabelText('Task title'), { target: { value: 'Nightly report' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Summarise the day' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(screen.getByLabelText('Task title')).toHaveValue(''))

    fireEvent.click(screen.getByRole('button', { name: 'Close scheduler panel' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Discard this task?')).toBeNull()
  })
})

describe('scheduler dock tab — unsaved task', () => {
  it('asks before going back to the list over unsaved input', async () => {
    stubApi([])
    wrap(<SchedulerDockView contextWorkspace="/repo/app" />)
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
    fireEvent.change(await screen.findByLabelText('Task title'), { target: { value: 'Nightly report' } })

    fireEvent.click(screen.getByRole('button', { name: 'Back to task list' }))

    expect(await screen.findByText('Discard this task?')).toBeInTheDocument()
    expect(screen.getByLabelText('Task title')).toHaveValue('Nightly report')
  })

  it('goes back at once from an untouched form', async () => {
    stubApi([])
    wrap(<SchedulerDockView contextWorkspace="/repo/app" />)
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
    await screen.findByLabelText('Task title')

    fireEvent.click(screen.getByRole('button', { name: 'Back to task list' }))

    await waitFor(() => expect(screen.queryByLabelText('Task title')).toBeNull())
    expect(screen.queryByText('Discard this task?')).toBeNull()
  })
})
