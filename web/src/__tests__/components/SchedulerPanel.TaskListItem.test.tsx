import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScheduledTaskResponse } from '@/api/types'
import { TaskListItem } from '@/components/SchedulerPanel/TaskListItem'
import '@testing-library/jest-dom'

const scheduledTask: ScheduledTaskResponse = {
  id: 'task-id',
  slug: 'daily-standup',
  name: 'Daily standup',
  workspace: '/repo/app',
  schedule_type: 'every',
  at_datetime: null,
  every_seconds: 3600,
  cron_expression: null,
  timezone: 'UTC',
  prompt: 'Run standup',
  session_id: null,
  enabled: true,
  status: 'pending',
  run_count: 0,
  max_runs: null,
  last_run_at: null,
  last_error: null,
  next_fire_at: null,
  created_at: '2026-07-13T00:00:00Z',
  updated_at: '2026-07-13T00:00:00Z',
}

let originalFetch: typeof fetch | undefined

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch
})

function renderItem(task: ScheduledTaskResponse = scheduledTask, props: { isSelected?: boolean; onSelect?: () => void; onDeleted?: () => void } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskListItem
        task={task}
        isSelected={props.isSelected ?? false}
        onSelect={props.onSelect ?? (() => {})}
        onDeleted={props.onDeleted ?? (() => {})}
      />
    </QueryClientProvider>,
  )
}

function recordRequests() {
  const requests: Array<{ url: string; method: string }> = []
  globalThis.fetch = mock(async (...args: unknown[]) => {
    const input = args[0] as RequestInfo | URL
    const init = args[1] as RequestInit | undefined
    requests.push({ url: typeof input === 'string' ? input : input.toString(), method: init?.method ?? 'GET' })
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  return requests
}

describe('TaskListItem', () => {
  it('uses an in-app confirmation dialog before deleting a task, opened from the right-click menu', async () => {
    const requests = recordRequests()
    renderItem()

    // The row has no Delete icon button: delete is in its context menu
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    fireEvent.contextMenu(screen.getByRole('button', { name: /Daily standup/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete task…' }))

    expect(screen.getByRole('dialog', { name: 'Delete scheduled task' })).toBeInTheDocument()
    expect(requests).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Delete task permanently' }))

    await waitFor(() => {
      expect(requests).toEqual([
        { url: '/api/scheduler/tasks/daily-standup', method: 'DELETE' },
      ])
    })
  })

  it('offers Run now, Pause and Delete task… in its context menu', () => {
    renderItem()
    fireEvent.contextMenu(screen.getByRole('button', { name: /Daily standup/ }))
    const menu = screen.getByRole('menu', { name: 'Actions for Daily standup' })
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent)).toEqual([
      'Run now',
      'Pause',
      'Delete task…',
    ])
  })

  it('has Run now and Pause buttons (not Trigger now) that act without opening the task', async () => {
    const requests = recordRequests()
    const onSelect = mock(() => {})
    renderItem(scheduledTask, { onSelect })

    expect(screen.queryByRole('button', { name: 'Trigger now' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests.map((r) => r.method)).toEqual(['POST', 'POST'])
    expect(requests[0].url).toBe('/api/scheduler/tasks/daily-standup/trigger')
    expect(requests[1].url).toBe('/api/scheduler/tasks/daily-standup/pause')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('offers Resume for a paused task', () => {
    renderItem({ ...scheduledTask, status: 'paused' })
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
  })

  it('selects the task from a click and from Enter', () => {
    const onSelect = mock(() => {})
    renderItem(scheduledTask, { onSelect })
    const row = screen.getByRole('button', { name: /Daily standup/ })
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it('shows the name once, with no slug chip while the slug equals the name', () => {
    renderItem({ ...scheduledTask, name: 'daily-standup' })
    expect(screen.getAllByText('daily-standup')).toHaveLength(1)
  })

  it('shows the slug as a mono outline chip only when it differs from the name', () => {
    renderItem()
    expect(screen.getAllByText('Daily standup')).toHaveLength(1)
    const slug = screen.getByText('daily-standup').closest('[data-slot="chip"]')
    expect(slug).toBeTruthy()
    expect(slug?.className).toContain('font-mono')
  })

  it('shows the schedule as a mono line, and the state as a chip', () => {
    renderItem()
    expect(screen.getByText('every 1 h').className).toContain('font-mono')
    const state = screen.getByText('scheduled').closest('[data-slot="chip"]')
    expect(state?.getAttribute('data-tone')).toBe('neutral')
  })

  it('names a failed repeating task by its last run, and shows the error', () => {
    renderItem({
      ...scheduledTask,
      status: 'failed',
      last_error: 'Model unavailable',
      last_run_at: new Date(Date.now() - 2 * 60_000).toISOString(),
      next_fire_at: new Date(Date.now() + 3_600_000).toISOString(),
    })
    expect(screen.getByText('last run failed').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('error')
    expect(screen.getByText('Model unavailable').className).toContain('text-(--color-error)')
    expect(screen.getByText(/^Last run 2m ago · failed · next in /)).toBeInTheDocument()
  })

  it('says "Not run yet" for a task that has not run', () => {
    renderItem()
    expect(screen.getByText('Not run yet')).toBeInTheDocument()
  })

  it('names the schedule of a cron task', () => {
    renderItem({ ...scheduledTask, schedule_type: 'cron', every_seconds: null, cron_expression: '0 9 * * 1-5' })
    expect(screen.getByText('cron 0 9 * * 1-5')).toBeInTheDocument()
  })
})
