/**
 * TaskDetailView — the task's own pane: header actions, state tiles, and the
 * Schedule / Delivery / History sections.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScheduledTaskResponse } from '@/api/types'
import { TaskDetailView } from '@/components/SchedulerPanel/TaskDetailView'
import '@testing-library/jest-dom'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const TASK: ScheduledTaskResponse = {
  id: 'task-id', slug: 'daily-standup', name: 'Daily standup', workspace: '/repo/app',
  schedule_type: 'every', at_datetime: null, every_seconds: 180, cron_expression: null,
  timezone: 'UTC', prompt: 'Run the standup', session_id: null, enabled: true, status: 'pending',
  run_count: 0, max_runs: null, last_run_at: null, last_error: null, next_fire_at: null,
  created_at: '2026-07-13T00:00:00Z', updated_at: '2026-07-13T00:00:00Z',
}

let originalFetch: typeof fetch | undefined
let requests: Array<{ url: string; method: string }> = []

beforeEach(() => {
  originalFetch = globalThis.fetch
  requests = []
  globalThis.fetch = mock(async (...args: unknown[]) => {
    const input = args[0] as RequestInfo | URL
    const init = args[1] as RequestInit | undefined
    requests.push({ url: typeof input === 'string' ? input : input.toString(), method: init?.method ?? 'GET' })
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  if (originalFetch) globalThis.fetch = originalFetch
})

function renderDetail(overrides: Partial<ScheduledTaskResponse> = {}, onClose: () => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TaskDetailView task={{ ...TASK, ...overrides }} onClose={onClose} />
    </QueryClientProvider>,
  )
}

/** The value beside a label in a tile or a row. */
function tile(label: string): HTMLElement {
  return screen.getByText(label, { selector: 'p' }).parentElement as HTMLElement
}
function row(label: string): HTMLElement {
  return screen.getByText(label, { selector: 'span' }).parentElement as HTMLElement
}

describe('TaskDetailView header', () => {
  it('names the task and its schedule, with no slug chip while the slug equals the name', () => {
    renderDetail({ name: 'daily-standup' })
    expect(screen.getByRole('heading', { name: 'daily-standup' })).toBeInTheDocument()
    expect(document.querySelectorAll('[data-slot="chip"][title^="Slug"]')).toHaveLength(0)
    expect(screen.getByText('every 3 min').className).toContain('font-mono')
  })

  it('shows the slug as a chip only when it differs from the name', () => {
    renderDetail()
    const slug = screen.getByText('daily-standup').closest('[data-slot="chip"]')
    expect(slug).toBeTruthy()
    expect(slug?.className).toContain('font-mono')
  })

  it('has Run now (not Trigger now), Pause, Edit task and Delete task… actions', async () => {
    renderDetail()
    expect(screen.queryByRole('button', { name: 'Trigger now' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    await waitFor(() => expect(requests).toContainEqual({ url: '/api/scheduler/tasks/daily-standup/trigger', method: 'POST' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(requests).toContainEqual({ url: '/api/scheduler/tasks/daily-standup/pause', method: 'POST' }))
    expect(screen.getByRole('button', { name: 'Edit task' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete task…' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('asks before deleting, from the Delete task… action', async () => {
    const onClose = mock(() => {})
    renderDetail({}, onClose)

    fireEvent.click(screen.getByRole('button', { name: 'Delete task…' }))
    expect(screen.getByRole('dialog', { name: 'Delete scheduled task' })).toBeInTheDocument()
    expect(requests).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Delete task permanently' }))
    await waitFor(() => expect(requests).toEqual([{ url: '/api/scheduler/tasks/daily-standup', method: 'DELETE' }]))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('offers Resume for a paused task', () => {
    renderDetail({ status: 'paused' })
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
  })
})

describe('TaskDetailView tiles', () => {
  it('shows Status as a chip, Last run, Next run and Runs, with no Enabled tile', () => {
    renderDetail()
    const labels = Array.from(screen.getByRole('region', { name: 'Status' }).querySelectorAll('p')).map((p) => p.textContent)
    expect(labels).toEqual(['Status', 'Last run', 'Next run', 'Runs'])
    expect(screen.queryByText('Enabled')).toBeNull()

    const chip = within(tile('Status')).getByText('scheduled').closest('[data-slot="chip"]')
    expect(chip?.getAttribute('data-tone')).toBe('neutral')
    expect(within(tile('Last run')).getByText('Not yet')).toBeInTheDocument()
    expect(within(tile('Next run')).getByText('None scheduled')).toBeInTheDocument()
    expect(within(tile('Runs')).getByText('0')).toBeInTheDocument()
  })

  it('shows runs against the limit, last and next run as short spans', () => {
    renderDetail({
      run_count: 30,
      max_runs: 30,
      last_run_at: new Date(Date.now() - 2 * 60_000).toISOString(),
      next_fire_at: new Date(Date.now() + 3_600_000).toISOString(),
      status: 'completed',
    })
    expect(within(tile('Runs')).getByText('30 of 30')).toBeInTheDocument()
    expect(within(tile('Last run')).getByText('2m ago · ok')).toBeInTheDocument()
    expect(within(tile('Next run')).getByText('in 1h')).toBeInTheDocument()
    expect(within(tile('Status')).getByText('done').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('success')
  })

  it('names a failed repeating task by its last run', () => {
    renderDetail({ status: 'failed', last_error: 'Model unavailable', next_fire_at: new Date(Date.now() + 3_600_000).toISOString() })
    expect(within(tile('Status')).getByText('last run failed').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('error')
    expect(screen.getByText('Last run failed', { selector: 'p, div, span' })).toBeInTheDocument()
    expect(screen.getByText('Model unavailable')).toBeInTheDocument()
  })
})

describe('TaskDetailView schedule', () => {
  it('describes a repeating task as "Repeats" with its interval and the seconds', () => {
    renderDetail()
    expect(within(row('Type')).getByText('Repeats')).toBeInTheDocument()
    expect(row('Every').textContent).toBe('Every3 min (180 s)')
    expect(screen.queryByText('Means')).toBeNull()
  })

  it('describes a cron task with its expression and what it means', () => {
    renderDetail({ schedule_type: 'cron', every_seconds: null, cron_expression: '0 9 * * 1-5' })
    expect(within(row('Type')).getByText('Cron')).toBeInTheDocument()
    expect(within(row('Expression')).getByText('0 9 * * 1-5')).toBeInTheDocument()
    expect(row('Means').textContent).toContain('Weekdays at 09:00')
    expect(row('Means').textContent).toContain(' · next ')
    expect(screen.queryByText('Every', { selector: 'span' })).toBeNull()
  })

  it('describes a one-off task as "Once" with its date', () => {
    renderDetail({ schedule_type: 'at', every_seconds: null, at_datetime: '2026-10-24T09:00:00Z' })
    expect(within(row('Type')).getByText('Once')).toBeInTheDocument()
    expect(within(row('Date and time')).getByText('24/10/2026 09:00')).toBeInTheDocument()
  })
})

describe('TaskDetailView history', () => {
  it('calls the dates section "History", with only Created and Updated', () => {
    renderDetail()
    expect(screen.getByText('History')).toBeInTheDocument()
    expect(screen.queryByText('Runs', { selector: 'h3, h2, h4' })).toBeNull()
    expect(screen.getByText('Created', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('Updated', { selector: 'span' })).toBeInTheDocument()
  })
})
