/**
 * The dock's task list toolbar: "New task" is a real Button (24px, 36px on
 * touch through the Button rule), and the bar grows with it instead of
 * clipping it.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SchedulerDockView } from '@/components/SchedulerPanel/SchedulerDockView'
import '@testing-library/jest-dom'

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('SchedulerDockView toolbar', () => {
  it('has a borderless Button for New task in a bar that can grow on touch', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ tasks: [{ id: 't', slug: 't', name: 'T', workspace: '/w', schedule_type: 'every', at_datetime: null, every_seconds: 60, cron_expression: null, timezone: 'UTC', prompt: 'p', session_id: null, enabled: true, status: 'pending', run_count: 0, max_runs: null, last_run_at: null, last_error: null, next_fire_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }] }), { status: 200 })) as unknown as typeof fetch
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <SchedulerDockView contextWorkspace={null} />
      </QueryClientProvider>,
    )

    const button = await screen.findByRole('button', { name: 'New task' })
    // ``Button`` carries the 36px touch minimum (index.css: [data-slot="button"]).
    expect(button.getAttribute('data-slot')).toBe('button')
    expect(button.className).not.toMatch(/(^|\s)border(-\w+)?(\s|$)/)
    const bar = button.parentElement as HTMLElement
    expect(bar.className).toContain('min-h-(--spacing-toolbar)')
    expect(bar.className).not.toMatch(/(^|\s)h-\(--spacing-toolbar\)/)
  })
})
