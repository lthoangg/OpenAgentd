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

describe('DiffTabView — load failure', () => {
  it('keeps the error text and retries the diff on Retry', async () => {
    let fail = true
    globalThis.fetch = mock(async () => (fail
      ? new Response('{"detail":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ workspace: '/w', is_git_repo: true, diff: '' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    )) as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DiffTabView workspace="/w" path="a.ts" /></QueryClientProvider>)

    expect(await screen.findByText('Failed to load the diff.')).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.queryByText('Failed to load the diff.')).toBeNull())
    expect(screen.getByText('No uncommitted changes in this file.')).toBeTruthy()
  })
})
