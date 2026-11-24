import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NEW_SCHEDULED_TASK, useUIStore } from '@/stores/useUIStore'
import { APP_EVENTS } from '@/lib/app-events'
import { cleanupSidebarHarness, renderSidebarForSessions, resetSidebarHarness } from './harness'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  it('lists upcoming scheduled tasks soonest first and opens the scheduler on one', async () => {
    const user = userEvent.setup()
    const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
    const task = (id: string, name: string, next: string | null, enabled = true) => ({
      id, slug: id, name, workspace: '/repo/project', schedule_type: 'every', at_datetime: null, every_seconds: 3600,
      cron_expression: null, timezone: 'UTC', prompt: 'p', session_id: null, max_runs: null, enabled,
      status: enabled ? 'pending' : 'paused', run_count: 0, last_run_at: null, last_error: null, next_fire_at: next,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    })
    const baseFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
      if (String(input).includes('/api/scheduler/tasks')) {
        return new Response(JSON.stringify({ tasks: [
          task('later', 'Weekly report', inMinutes(120)),
          task('soon', 'Nightly build', inMinutes(30)),
          task('paused', 'Paused digest', inMinutes(10), false),
          task('done', 'One-off reminder', null),
        ] }))
      }
      return baseFetch(input as RequestInfo, init as RequestInit | undefined)
    }) as typeof fetch
    const opened = mock(() => {})
    window.addEventListener(APP_EVENTS.openScheduler, opened)

    await renderSidebarForSessions(undefined)
    const section = await screen.findByRole('region', { name: 'Scheduled' })
    await waitFor(() => expect(section.textContent).toContain('Nightly build'))
    const names = Array.from(section.querySelectorAll('li')).map((row) => row.textContent ?? '')
    expect(names[0]).toContain('Nightly build')
    expect(names[1]).toContain('Weekly report')
    expect(section.textContent).not.toContain('Paused digest')
    expect(section.textContent).not.toContain('One-off reminder')

    await user.click(screen.getByRole('button', { name: /Nightly build/ }))
    window.removeEventListener(APP_EVENTS.openScheduler, opened)

    expect(useUIStore.getState().scheduledTaskFocus).toBe('soon')
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('has no Scheduled heading while no task exists at all', async () => {
    const baseFetch = globalThis.fetch
    let asked = false
    globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
      if (String(input).includes('/api/scheduler/tasks')) {
        asked = true
        return new Response(JSON.stringify({ tasks: [] }))
      }
      return baseFetch(input as RequestInfo, init as RequestInit | undefined)
    }) as typeof fetch

    await renderSidebarForSessions(undefined)
    await waitFor(() => expect(asked).toBe(true))
    await act(async () => { await Promise.resolve() })

    expect(screen.queryByRole('region', { name: 'Scheduled' })).toBeNull()
    expect(screen.queryByText('No scheduled tasks')).toBeNull()
  })

  it('keeps Scheduled when a task exists but none is due, with a + that opens a new task', async () => {
    const user = userEvent.setup()
    const baseFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
      if (String(input).includes('/api/scheduler/tasks')) {
        return new Response(JSON.stringify({ tasks: [{
          id: 'paused', slug: 'paused', name: 'Paused digest', workspace: '/repo/project', schedule_type: 'every', at_datetime: null, every_seconds: 3600,
          cron_expression: null, timezone: 'UTC', prompt: 'p', session_id: null, max_runs: null, enabled: false,
          status: 'paused', run_count: 0, last_run_at: null, last_error: null, next_fire_at: null,
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        }] }))
      }
      return baseFetch(input as RequestInfo, init as RequestInit | undefined)
    }) as typeof fetch
    const opened = mock(() => {})
    window.addEventListener(APP_EVENTS.openScheduler, opened)

    await renderSidebarForSessions(undefined)
    const section = await screen.findByRole('region', { name: 'Scheduled' })
    await waitFor(() => expect(section.textContent).toContain('Nothing due'))

    await user.click(within(section).getByRole('button', { name: 'New task' }))
    window.removeEventListener(APP_EVENTS.openScheduler, opened)
    expect(useUIStore.getState().scheduledTaskFocus).toBe(NEW_SCHEDULED_TASK)
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('says so with Retry when the tasks fail to load, instead of leaving no section', async () => {
    const user = userEvent.setup()
    let failing = true
    globalThis.fetch = mock(async () => (
      failing
        ? new Response('boom', { status: 500 })
        : new Response(JSON.stringify({ tasks: [{
          id: 'paused', slug: 'paused', name: 'Paused digest', workspace: '/repo/project', schedule_type: 'every', at_datetime: null, every_seconds: 3600,
          cron_expression: null, timezone: 'UTC', prompt: 'p', session_id: null, max_runs: null, enabled: false,
          status: 'paused', run_count: 0, last_run_at: null, last_error: null, next_fire_at: null,
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        }] }))
    )) as unknown as typeof fetch
    const { ScheduledSection } = await import('@/components/Sidebar/ScheduledSection')
    // The sidebar's own client retries for seconds before it reports a failure.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <ScheduledSection />
      </QueryClientProvider>,
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Couldn't load scheduled tasks.")
    expect(alert.closest('section')?.getAttribute('aria-label')).toBe('Scheduled')

    failing = false
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Scheduled' }).textContent).toContain('Nothing due'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
