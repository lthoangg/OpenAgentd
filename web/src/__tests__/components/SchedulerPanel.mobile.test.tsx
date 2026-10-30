/**
 * Phone layout of the scheduler overlay: one header (the overlay's), Run now /
 * Pause in a bottom bar, and no repeated pane title or close button.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom'
import { SchedulerPanel } from '@/components/SchedulerPanel'
import { SchedulerDockView } from '@/components/SchedulerPanel/SchedulerDockView'
import { useUIStore } from '@/stores/useUIStore'
import type { ScheduledTaskResponse } from '@/api/types'

function task(id: string, name: string): ScheduledTaskResponse {
  return { id, slug: id, name, workspace: '/repo/app', schedule_type: 'every', at_datetime: null, every_seconds: 3600, cron_expression: null, timezone: 'UTC', prompt: 'Do the thing', session_id: null, enabled: true, status: 'pending', run_count: 0, max_runs: null, last_run_at: null, last_error: null, next_fire_at: null, created_at: '2026-05-25T00:00:00Z', updated_at: '2026-05-25T00:00:00Z' }
}

function renderPanel(ui: React.ReactElement = <SchedulerPanel open onClose={() => {}} />) {
  const tasks = [task('t1', 'Nightly build')]
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ tasks }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

const originalMatchMedia = window.matchMedia

beforeEach(() => {
  // A fresh function, so useIsMobile builds a new (matching) query list.
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  cleanup()
  window.matchMedia = originalMatchMedia
  useUIStore.setState({ scheduledTaskFocus: null })
})

describe('scheduler overlay on phones', () => {
  it('shows the task once and moves Run now / Pause to a bottom bar', async () => {
    useUIStore.getState().focusScheduledTask('t1')
    renderPanel()

    const runNow = await screen.findByRole('button', { name: 'Run now' })
    expect(runNow).toHaveTextContent('Run now')
    expect(screen.queryByRole('button', { name: 'Trigger now' })).toBeNull()
    expect(runNow).not.toHaveAttribute('aria-label')
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveTextContent('Pause')
    expect(screen.getByRole('button', { name: 'Edit task' })).toBeInTheDocument()
    // The overlay header holds the title and Back; the pane repeats neither.
    expect(screen.getAllByText('Nightly build')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Back to task list' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close detail' })).not.toBeInTheDocument()
  })

  it('keeps the edit form to one title and one way to cancel', async () => {
    useUIStore.getState().focusScheduledTask('t1')
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit task' }))

    expect(await screen.findByRole('heading', { name: 'Edit task' })).toBeInTheDocument()
    expect(screen.getAllByText('Nightly build')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Cancel edit' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('opens the create form without a second header', async () => {
    renderPanel()

    // The list's "+" is named for what it opens
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
    expect(screen.queryByRole('button', { name: 'Create new task' })).toBeNull()

    await waitFor(() => expect(screen.getByRole('button', { name: /Create task/ })).toBeInTheDocument())
    // Only the overlay header's title; the pane no longer repeats it.
    expect(screen.getAllByRole('heading', { name: 'New task' })).toHaveLength(1)
    expect(screen.getByLabelText('Max runs (optional)')).toHaveAttribute('inputmode', 'numeric')
    // The overlay already pads the safe area; only the dock sheet adds it.
    expect(screen.getByRole('button', { name: /Create task/ }).parentElement).not.toHaveClass('pb-safe')
  })

  it('clears the home indicator in the dock sheet, which reaches the screen edge', async () => {
    useUIStore.getState().focusScheduledTask('t1')
    renderPanel(<SchedulerDockView contextWorkspace={null} />)

    const runNow = await screen.findByRole('button', { name: 'Run now' })
    expect(runNow.parentElement).toHaveClass('pb-safe')
  })
})
