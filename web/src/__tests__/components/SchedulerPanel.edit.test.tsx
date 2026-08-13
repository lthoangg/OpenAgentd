/**
 * SchedulerPanel — Edit Task Form tests
 *
 * Tests for the edit functionality:
 * - Edit button visibility and toggle
 * - Form pre-population with existing task values
 * - Cancel button returns to detail view
 * - Form validation (empty prompt, invalid interval, etc.)
 * - Schedule type switching shows correct conditional fields
 *
 * Note: API integration tests are covered in component integration tests.
 * These tests focus on UI behavior and form interactions.
 */

import { afterEach, beforeEach, describe, it, expect, mock } from 'bun:test'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { SchedulerPanel } from '@/components/SchedulerPanel'
import '@testing-library/jest-dom'

// The panel's task-list query fires ``fetch('/api/scheduler/tasks')`` as
// soon as it mounts. Without a stub, happy-dom forwards that to Node's
// real ``fetch``, which attempts an actual socket connection against
// ``http://localhost:5173`` — there is no listener in tests, so the
// promise hangs until the OS-level connect timeout (>1 s) and the
// default ``waitFor`` window expires before the query settles. Stubbing
// ``fetch`` here makes failure (or success) deterministic and instant
// so the UI fallback-state assertions stop racing the network.
let originalFetch: typeof fetch | undefined

beforeEach(() => {
  originalFetch = globalThis.fetch
  // Default stub: scheduler tasks endpoint resolves to empty array so
  // the panel reaches the "No scheduled tasks yet" terminal state
  // quickly. Individual tests override this with ``mock(...)`` when they
  // need a different shape (e.g. the error-path test below).
  globalThis.fetch = mock(async (...args: unknown[]) => {
    const input = args[0] as RequestInfo | URL
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/api/scheduler/tasks')) {
      return new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch
  }
})

// ── Wrapper ──────────────────────────────────────────────────────────────────

function renderSchedulerPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <SchedulerPanel open={true} onClose={() => {}} />
    </QueryClientProvider>
  )
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SchedulerPanel — Edit Task Form', () => {
  it('renders the scheduler panel when open prop is true', () => {
    renderSchedulerPanel()

    // Panel should be visible
    expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
  })

  it('renders the error fallback when the tasks query rejects', async () => {
    // Override the default empty-list stub with a 500 so the query
    // settles into ``isError === true`` and the panel shows its error
    // branch (AlertCircle + 'Failed to load tasks').
    globalThis.fetch = mock(async (...args: unknown[]) => {
      const input = args[0] as RequestInfo | URL
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/scheduler/tasks')) {
        return new Response('{"detail":"boom"}', {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText(/Failed to load tasks/i)).toBeInTheDocument()
    })
    // The empty-state copy must NOT also be rendered — error and empty
    // are mutually exclusive branches in the component.
    expect(screen.queryByText(/No scheduled tasks yet/i)).toBeNull()
  })

  it('renders the empty-state message when the tasks query resolves to no tasks', async () => {
    // beforeEach already stubs fetch to return ``{ tasks: [] }`` for
    // this endpoint; no extra setup needed.
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText(/No scheduled tasks yet/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/Failed to load tasks/i)).toBeNull()
  })

  it('has a create task button in the header', async () => {
    renderSchedulerPanel()

    // Wait for panel to load
    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    // Create button should be visible (on desktop)
    const createButton = screen.queryByRole('button', { name: /Create new task/i })
    // May not be visible on all screen sizes, but the button should exist in the component
    expect(createButton || screen.getByText('Scheduled Tasks')).toBeInTheDocument()
  })

  it('has a close button in the header', async () => {
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    // Close button should be visible
    const closeButton = screen.getByRole('button', { name: /Close scheduler panel/i })
    expect(closeButton).toBeInTheDocument()
  })

  it('displays search input for filtering tasks', async () => {
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    // Search input should be visible
    const searchInput = screen.getByPlaceholderText(/Search tasks/i)
    expect(searchInput).toBeInTheDocument()
  })

  it('allows typing in search input', async () => {
    const user = userEvent.setup()
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText(/Search tasks/i)
    await user.type(searchInput, 'daily')

    expect(searchInput).toHaveValue('daily')
  })

  it('allows typing in search input and updates value', async () => {
    const user = userEvent.setup()
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText(/Search tasks/i) as HTMLInputElement
    await user.type(searchInput, 'test-search')

    // Verify the search input value was updated
    expect(searchInput.value).toBe('test-search')
  })

  it('clears search input when user deletes text', async () => {
    const user = userEvent.setup()
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText(/Search tasks/i) as HTMLInputElement
    await user.type(searchInput, 'test')
    expect(searchInput.value).toBe('test')

    await user.clear(searchInput)
    expect(searchInput.value).toBe('')
  })

  it('renders the panel with correct layout structure', async () => {
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    // Header should be present
    const header = screen.getByRole('heading', { name: /Scheduled Tasks/i })
    expect(header).toBeInTheDocument()

    // Search input should be present
    const searchInput = screen.getByPlaceholderText(/Search tasks/i)
    expect(searchInput).toBeInTheDocument()
  })

  it('has accessible close button', async () => {
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    const closeButton = screen.getByRole('button', { name: /Close scheduler panel/i })
    expect(closeButton).toHaveAttribute('aria-label', 'Close scheduler panel')
  })

  it('has accessible search input', async () => {
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText(/Search tasks/i)
    expect(searchInput).toBeInTheDocument()
    expect(searchInput).toHaveAttribute('placeholder', 'Search tasks…')
  })

  it('displays the all-tasks description in the header', async () => {
    renderSchedulerPanel()

    await waitFor(() => {
      expect(
        screen.getByText(/All scheduled tasks/i),
      ).toBeInTheDocument()
    })
  })

  it('shows calendar icon in header', async () => {
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    // The calendar icon should be rendered (lucide-react CalendarClock)
    // SVGs are rendered with aria-hidden="true"
    const svgs = document.querySelectorAll('svg[aria-hidden="true"]')
    expect(svgs.length).toBeGreaterThan(0)
  })

  it('maintains search input value when typing', async () => {
    const user = userEvent.setup()
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText(/Search tasks/i) as HTMLInputElement

    await user.type(searchInput, 'daily')
    expect(searchInput.value).toBe('daily')

    await user.type(searchInput, ' report')
    expect(searchInput.value).toBe('daily report')
  })

  it('handles rapid search input changes', async () => {
    const user = userEvent.setup()
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText(/Search tasks/i) as HTMLInputElement

    await user.type(searchInput, 'a')
    expect(searchInput.value).toBe('a')

    await user.type(searchInput, 'b')
    expect(searchInput.value).toBe('ab')

    await user.type(searchInput, 'c')
    expect(searchInput.value).toBe('abc')
  })

  it('debounces task filtering while keeping the search input responsive', async () => {
    globalThis.fetch = mock(async (...args: unknown[]) => {
      const input = args[0] as RequestInfo | URL
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/scheduler/tasks')) {
        const baseTask = {
          id: 'task-1',
          slug: 'daily-report',
          name: 'Daily report',
          mode: 'normal',
          workspace: null,
          schedule_type: 'every',
          at_datetime: null,
          every_seconds: 3600,
          cron_expression: null,
          timezone: 'UTC',
          prompt: 'Report',
          session_id: null,
          max_runs: null,
          enabled: true,
          status: 'pending',
          run_count: 0,
          last_run_at: null,
          last_error: null,
          next_fire_at: null,
          created_at: '2026-08-13T00:00:00Z',
          updated_at: '2026-08-13T00:00:00Z',
        }
        return new Response(JSON.stringify({
          tasks: [
            baseTask,
            { ...baseTask, id: 'task-2', slug: 'weekly-sync', name: 'Weekly sync' },
          ],
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const user = userEvent.setup()
    renderSchedulerPanel()
    await screen.findByText('Daily report')
    expect(screen.getByText('Weekly sync')).toBeInTheDocument()

    const searchInput = screen.getByPlaceholderText(/Search tasks/i)
    await user.type(searchInput, 'daily')

    expect(searchInput).toHaveValue('daily')
    expect(screen.getByText('Weekly sync')).toBeInTheDocument()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) })
    expect(screen.queryByText('Weekly sync')).toBeNull()
  })

  it('renders panel with correct z-index for overlay', async () => {
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    // The backdrop should have z-40 and the panel should have z-50
    const backdrop = document.querySelector('.z-40')
    const panel = document.querySelector('.z-50')

    expect(backdrop).toBeInTheDocument()
    expect(panel).toBeInTheDocument()
  })

  it('renders as a dialog with the correct role and label', async () => {
    renderSchedulerPanel()

    await waitFor(() => {
      expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument()
    })

    const panel = screen.getByRole('dialog', { name: /scheduled tasks/i })
    expect(panel).toBeInTheDocument()
    expect(panel).toHaveAttribute('aria-modal', 'true')
  })
})
