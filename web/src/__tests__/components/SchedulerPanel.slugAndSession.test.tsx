/**
 * SchedulerPanel: the name's slug and where the reply goes
 */

import { afterEach, beforeEach, describe, it, expect, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { SchedulerPanel } from '@/components/SchedulerPanel'
import { useAgentStore } from '@/stores/useAgentStore'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
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
  cleanup()
  useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
  useAgentStore.setState({
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

describe('SchedulerPanel: the name, its slug, and where the reply goes', () => {
  it('shows the slug of a typed name in Full detail only', async () => {
    renderSchedulerPanel()
    const user = userEvent.setup()

    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    await user.type(screen.getByLabelText('Name'), 'My Daily Standup! 123')
    await waitFor(() => expect(screen.getByText('my-daily-standup-123')).toBeInTheDocument())

    cleanup()
    useDisplayPrefsStore.setState({ transcriptStyle: 'reader' })
    renderSchedulerPanel()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Daily Standup! 123' } })
    expect(screen.queryByText('my-daily-standup-123')).toBeNull()
  })

  it('offers a new session each time or the same one, and says what each means', () => {
    renderSchedulerPanel()

    expect(screen.getByRole('radiogroup', { name: 'Where does the reply go?' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'A new session each time' })).toBeChecked()
    expect(screen.getByText('Each run starts its own session.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'The same session' }))
    expect(screen.getByText('Every run adds to one session kept for this task.')).toBeInTheDocument()
    // No session is open here, and no ID is set: two choices.
    expect(screen.getAllByRole('radio')).toHaveLength(2)
  })

  it('takes a session ID in More options, offers it as a fourth choice, and checks its format on submit', async () => {
    renderSchedulerPanel()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('What should it do?'), 'Hello future self')
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    await user.type(screen.getByLabelText('Session ID'), 'invalid-uuid-abc')

    // Back on the first page the ID is the chosen target.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('radio', { name: 'A specific session' })).toBeChecked()
    expect(screen.getByText('Every run adds to the session whose ID is in More options.')).toBeInTheDocument()

    // No workspace is chosen either, so the first page keeps the focus; the
    // ID's problem is waiting on its own page.
    await user.click(screen.getByRole('button', { name: 'Create task' }))
    expect(screen.getByText('Choose a workspace.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    await waitFor(() => {
      expect(screen.getByText("This isn't a session ID. One looks like 123e4567-e89b-12d3-a456-426614174000.")).toBeInTheDocument()
    })
  })

  it('clearing the session ID goes back to a new session each time', () => {
    renderSchedulerPanel()

    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.change(screen.getByLabelText('Session ID'), { target: { value: '123e4567-e89b-12d3-a456-426614174000' } })
    fireEvent.change(screen.getByLabelText('Session ID'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(screen.getByRole('radio', { name: 'A new session each time' })).toBeChecked()
    expect(screen.queryByRole('radio', { name: 'A specific session' })).toBeNull()
  })
})
