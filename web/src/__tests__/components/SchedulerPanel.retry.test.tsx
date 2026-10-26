import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SchedulerPanel } from '@/components/SchedulerPanel'
import '@testing-library/jest-dom'

const originalFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('SchedulerPanel — task list load failure', () => {
  it('offers Retry next to the error and reloads the list', async () => {
    let fail = true
    globalThis.fetch = mock(async (...args: unknown[]) => {
      const input = args[0] as RequestInfo | URL
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/scheduler/tasks')) {
        return fail
          ? new Response('{"detail":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } })
          : new Response(JSON.stringify({ tasks: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={client}><SchedulerPanel open onClose={() => {}} /></QueryClientProvider>)

    expect(await screen.findByText(/Failed to load tasks/i)).toBeInTheDocument()
    fail = false
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.getByText(/No scheduled tasks yet/i)).toBeInTheDocument())
    expect(screen.queryByText(/Failed to load tasks/i)).toBeNull()
  })
})
