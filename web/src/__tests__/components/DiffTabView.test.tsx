import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { DiffTabView } from '@/components/WorkspacePanel/DiffTabView'

const originalFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('DiffTabView — loading', () => {
  // Rulebook 10: loading is a skeleton, not a line of text.
  it('shows skeleton rows named "Loading diff" while the diff is on its way', () => {
    globalThis.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(<QueryClientProvider client={client}><DiffTabView workspace="/w" path="a.ts" /></QueryClientProvider>)

    const loading = screen.getByRole('status', { name: 'Loading diff' })
    expect(loading.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(3)
    expect(container.textContent).not.toContain('Loading diff')
  })
})

describe('DiffTabView — load failure', () => {
  it('keeps the error text and retries the diff on Retry', async () => {
    let fail = true
    globalThis.fetch = mock(async () => (fail
      ? new Response('{"detail":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ workspace: '/w', is_git_repo: true, diff: '' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    )) as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DiffTabView workspace="/w" path="a.ts" /></QueryClientProvider>)

    expect(await screen.findByText("Couldn't load the diff.")).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    // A boolean: a failing toBeNull pretty-prints the element on every retry.
    await waitFor(() => expect(screen.queryByText("Couldn't load the diff.") === null).toBe(true))
    // An empty state, not a stray line of text.
    expect(screen.getByRole('heading', { name: 'No uncommitted changes in this file' })).toBeTruthy()
  })
})
