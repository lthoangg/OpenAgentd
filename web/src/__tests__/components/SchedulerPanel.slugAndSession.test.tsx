/**
 * SchedulerPanel — Task Title Slugification and Session Target Selector tests
 */

import { afterEach, beforeEach, describe, it, expect, mock } from 'bun:test'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { SchedulerPanel } from '@/components/SchedulerPanel'
import { useTeamStore } from '@/stores/useTeamStore'
import '@testing-library/jest-dom'

let originalFetch: typeof fetch | undefined

beforeEach(() => {
  originalFetch = globalThis.fetch
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
  // Reset store
  useTeamStore.setState({
    sessionId: null,
    sessionTitle: null,
    _workspace: null,
  })
})

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

describe('SchedulerPanel — Title Slugification and Session Target Selector', () => {
  it('displays the Task Title input and auto-slugifies user input in real-time', async () => {
    renderSchedulerPanel()
    const user = userEvent.setup()

    // Find task title input
    const titleInput = screen.getByLabelText('Task Title')
    expect(titleInput).toBeInTheDocument()

    // Type a friendly title
    await user.type(titleInput, 'My Daily Standup! 123')

    // Verify it auto-slugifies and displays the slug
    await waitFor(() => {
      expect(screen.getByText('my-daily-standup-123')).toBeInTheDocument()
    })
  })

  it('renders standard Session Target choices and displays adaptive descriptions', async () => {
    renderSchedulerPanel()
    const user = userEvent.setup()

    // Find session target select
    const targetSelect = screen.getByLabelText('Session Target')
    expect(targetSelect).toBeInTheDocument()

    // By default, should select New Session and show its helper description
    expect(targetSelect).toHaveValue('new')
    expect(screen.getByText('Creates a fresh, isolated chat session for every run.')).toBeInTheDocument()

    // Switch to Persistent Task Session (auto)
    await user.selectOptions(targetSelect, 'auto')
    expect(screen.getByText('Runs all executions in a single dedicated chat session created for this task.')).toBeInTheDocument()
  })

  it('displays Current Chat Session option when there is an active session in the store', async () => {
    // Set active session in store
    useTeamStore.setState({
      sessionId: 'active-session-uuid-123',
      sessionTitle: 'Sprint Planning Meeting',
    })

    renderSchedulerPanel()
    const user = userEvent.setup()

    const targetSelect = screen.getByLabelText('Session Target')

    // Switch to Current Chat Session
    await user.selectOptions(targetSelect, 'current')
    expect(screen.getByText('Delivers the prompt directly into your active chat thread.')).toBeInTheDocument()
  })

  it('displays custom Session ID input and validates UUID format on submission', async () => {
    renderSchedulerPanel()
    const user = userEvent.setup()

    // 1. Switch to custom session ID
    const targetSelect = screen.getByLabelText('Session Target')
    await user.selectOptions(targetSelect, 'custom')

    expect(screen.getByText('Delivers the prompt to a specific chat session by its UUID.')).toBeInTheDocument()

    // Find the custom UUID input
    const customInput = screen.getByPlaceholderText('Enter session UUID (e.g. 123e4567-e89b-12d3-a456-426614174000)')
    expect(customInput).toBeInTheDocument()

    // 2. Fill in other required fields to trigger validation on session ID specifically
    const titleInput = screen.getByLabelText('Task Title')
    await user.type(titleInput, 'Test Task')

    const promptInput = screen.getByPlaceholderText('Message to deliver to the team lead when the task fires.')
    await user.type(promptInput, 'Hello future self')

    // Type invalid UUID
    await user.type(customInput, 'invalid-uuid-abc')

    // Click submit
    const submitBtn = screen.getByRole('button', { name: 'Create Task' })
    await user.click(submitBtn)

    // Verify validation error
    await waitFor(() => {
      expect(screen.getByText('Please enter a valid UUID (e.g. 123e4567-e89b-12d3-a456-426614174000)')).toBeInTheDocument()
    })
  })

  it('hides Current Chat Session option when routing is incompatible with active session, and resets selection to new if current is active', async () => {
    // 1. Set active session in normal mode (workspace = null)
    useTeamStore.setState({
      sessionId: 'active-session-uuid-123',
      sessionTitle: 'Sprint Planning Meeting',
      _workspace: null,
    })

    renderSchedulerPanel()
    const user = userEvent.setup()

    const targetSelect = screen.getByLabelText('Session Target')

    // Since default mode is 'normal' (matching active session's workspace = null),
    // the "current" option should be present and selectable.
    await user.selectOptions(targetSelect, 'current')
    expect(targetSelect).toHaveValue('current')

    // 2. Change routing mode to 'coding' in the form
    const codingTab = screen.getByRole('tab', { name: 'Coding' })
    await user.click(codingTab)

    // Since the active session is in 'normal' mode, but the form's selected routing target
    // is now 'coding', they are incompatible.
    // The "current" option should be hidden, and the value should have auto-reset to 'new'.
    expect(targetSelect).not.toHaveValue('current')
    expect(targetSelect).toHaveValue('new')

    // Verify the "current" option is no longer rendered in the select options
    const currentOption = screen.queryByRole('option', { name: /Current Chat Session/ })
    expect(currentOption).toBeNull()
  })
})
