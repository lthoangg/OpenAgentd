/**
 * TaskDetailView — the task's own pane: header actions (Run now and Edit task
 * in words, the rest in a ⋯ menu with Delete last), state tiles, and the
 * Runs in / Schedule / Dates sections.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScheduledTaskResponse } from '@/api/types'
import { TaskDetailView } from '@/components/SchedulerPanel/TaskDetailView'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
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
  useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
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

describe('TaskDetailView entrance', () => {
  it('fades in at fast with the token easing, so a newly chosen task does not just swap', () => {
    const { container } = renderDetail()
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain('oa-fade-in-fast')
  })
})

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

  it('leaves the slug out with the Detail setting on Simple', () => {
    useDisplayPrefsStore.setState({ transcriptStyle: 'reader' })
    try {
      renderDetail()
      expect(screen.getByRole('heading', { name: 'Daily standup' })).toBeInTheDocument()
      expect(screen.queryByText('daily-standup')).toBeNull()
    } finally {
      useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
    }
  })

  it('has Run now (not Trigger now) and Edit task as labelled buttons, then a ⋯ menu last', () => {
    renderDetail()
    expect(screen.queryByRole('button', { name: 'Trigger now' })).toBeNull()

    const run = screen.getByRole('button', { name: 'Run now' })
    const edit = screen.getByRole('button', { name: 'Edit task' })
    const more = screen.getByRole('button', { name: 'More actions' })
    expect(run).toHaveTextContent('Run now')
    expect(edit).toHaveTextContent('Edit task')
    expect(more.getAttribute('aria-haspopup')).toBe('menu')
    // 32px toolbar buttons from the Button primitive, in the order Run now,
    // Edit task, ⋯ (the menu ends the row).
    for (const button of [run, edit, more]) expect(button.getAttribute('data-slot')).toBe('button')
    expect(run.className).toContain('h-8')
    expect(more.className).toContain('size-8')
    const follows = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(run, edit)).toBe(true)
    expect(follows(edit, more)).toBe(true)
  })

  it('has no icon-only Pause or Delete, and no second × beside the overlay\'s', () => {
    renderDetail()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close detail' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Close/ })).toBeNull()
  })

  it('runs the task from Run now', async () => {
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    await waitFor(() => expect(requests).toContainEqual({ url: '/api/scheduler/tasks/daily-standup/trigger', method: 'POST' }))
  })

  it('holds Pause and Delete task… (last, destructive) in the ⋯ menu', async () => {
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))

    const menu = screen.getByRole('menu', { name: 'Actions for Daily standup' })
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'))
    // Run now is a button of its own in the header, so the menu does not repeat it.
    expect(items.map((item) => item.textContent)).toEqual(['Pause', 'Delete task…'])
    expect(items.at(-1)?.className).toContain('text-(--color-error)')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Pause' }))
    await waitFor(() => expect(requests).toContainEqual({ url: '/api/scheduler/tasks/daily-standup/pause', method: 'POST' }))
  })

  it('asks before deleting, from the ⋯ menu\'s Delete task…', async () => {
    const onClose = mock(() => {})
    renderDetail({}, onClose)

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete task…' }))
    expect(screen.getByRole('dialog', { name: 'Delete this task?' })).toBeInTheDocument()
    expect(requests).toHaveLength(0)
    // A confirm: no ×; Cancel dismisses; the action is "Delete task".
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
    await waitFor(() => expect(requests).toEqual([{ url: '/api/scheduler/tasks/daily-standup', method: 'DELETE' }]))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('offers Resume for a paused task, in the ⋯ menu', () => {
    renderDetail({ status: 'paused' })
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('menuitem', { name: 'Resume' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Pause' })).toBeNull()
  })
})

describe('TaskDetailView tiles', () => {
  it('shows Status as a chip, Last run, Next run and Runs, with no Enabled tile', () => {
    renderDetail()
    const labels = Array.from(screen.getByRole('region', { name: 'Status' }).querySelectorAll('p')).map((p) => p.textContent)
    expect(labels).toEqual(['Status', 'Last run', 'Next run', 'Runs'])
    expect(screen.queryByText('Enabled')).toBeNull()

    const chip = within(tile('Status')).getByText('Scheduled').closest('[data-slot="chip"]')
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
    expect(within(tile('Status')).getByText('Done').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('neutral')
  })

  it('names a failed repeating task by its last run', () => {
    renderDetail({ status: 'failed', last_error: 'Model unavailable', next_fire_at: new Date(Date.now() + 3_600_000).toISOString() })
    expect(within(tile('Status')).getByText('Last run failed').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('error')
    // The chip and the callout both name it.
    expect(screen.getAllByText('Last run failed')).toHaveLength(2)
    expect(screen.getByText('Model unavailable')).toBeInTheDocument()
  })

  it('says a task stopped because its last allowed run failed, with the error and Run again', async () => {
    renderDetail({ status: 'failed', run_count: 3, max_runs: 3, last_error: 'Model unavailable', next_fire_at: null })
    const callout = screen.getByText('Stopped: its last run failed').closest('[role="status"]') as HTMLElement
    expect(within(callout).getByText('Model unavailable')).toBeInTheDocument()
    fireEvent.click(within(callout).getByRole('button', { name: 'Run again' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/scheduler/tasks/daily-standup/trigger'))).toBe(true))
  })
})

describe('TaskDetailView schedule', () => {
  it('says a repeating task in one line, without a type or a number of seconds', () => {
    renderDetail()
    expect(row('When').textContent).toBe('WhenEvery 3 min')
    expect(screen.queryByText('Type')).toBeNull()
    expect(screen.queryByText(/180 s/)).toBeNull()
    // An interval has no time zone to show.
    expect(screen.queryByText('Time zone')).toBeNull()
  })

  it('says a weekday schedule in words with its next run, and keeps the expression for Full detail', () => {
    renderDetail({ schedule_type: 'cron', every_seconds: null, cron_expression: '0 9 * * 1-5' })
    expect(row('When').textContent).toMatch(/^WhenWeekdays at 09:00 · next: \w{3} \w{3} \d+, 09:00$/)
    expect(within(row('Expression')).getByText('0 9 * * 1-5')).toBeInTheDocument()
    expect(within(row('Time zone')).getByText('UTC')).toBeInTheDocument()

    cleanup()
    useDisplayPrefsStore.setState({ transcriptStyle: 'reader' })
    renderDetail({ schedule_type: 'cron', every_seconds: null, cron_expression: '0 9 * * 1-5' })
    expect(row('When').textContent).toContain('Weekdays at 09:00')
    expect(screen.queryByText('Expression')).toBeNull()
  })

  it('shows the expression in Simple detail too when it has no short description', () => {
    useDisplayPrefsStore.setState({ transcriptStyle: 'reader' })
    renderDetail({ schedule_type: 'cron', every_seconds: null, cron_expression: '0 9 1 6 *' })
    expect(row('When').textContent).toContain('Custom schedule')
    expect(within(row('Expression')).getByText('0 9 1 6 *')).toBeInTheDocument()
  })

  it('says a one-off task as "Once at" its date', () => {
    renderDetail({ schedule_type: 'at', every_seconds: null, at_datetime: '2024-10-24T09:00:00Z' })
    expect(row('When').textContent).toBe('WhenOnce at Oct 24, 2024, 09:00')
  })
})

describe('TaskDetailView "Runs in"', () => {
  it('names the workspace by its folder and says where replies go', () => {
    renderDetail({ workspace: '/Users/me/code/linkly', session_id: 'auto' })
    expect(screen.getByText('Runs in')).toBeInTheDocument()
    expect(screen.queryByText('Delivery')).toBeNull()
    expect(screen.queryByText('Coding agent')).toBeNull()
    expect(row('Workspace').textContent).toContain('linkly')
    expect(within(row('Replies go to')).getByText('The same session every time')).toBeInTheDocument()
  })

  it('says a new session each time for a task with no session, and shows a specific ID as it is', () => {
    renderDetail({ session_id: null })
    expect(within(row('Replies go to')).getByText('A new session each time')).toBeInTheDocument()

    cleanup()
    renderDetail({ session_id: '123e4567-e89b-12d3-a456-426614174000' })
    expect(within(row('Replies go to')).getByText('123e4567-e89b-12d3-a456-426614174000')).toBeInTheDocument()
  })
})

describe('TaskDetailView dates', () => {
  it('calls the dates section "Dates", with only Created and Updated', () => {
    renderDetail()
    expect(screen.getByText('Dates')).toBeInTheDocument()
    expect(screen.queryByText('History')).toBeNull()
    expect(screen.getByText('Created', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('Updated', { selector: 'span' })).toBeInTheDocument()
  })
})
