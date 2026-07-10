import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '@/queries'
import { useFileRefsQuery } from '@/queries/useFileRefsQuery'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
}

describe('useFileRefsQuery', () => {
  it('uses the coding workspace files key for coding references', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ files: [] }))) as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    renderHook(
      () => useFileRefsQuery({ mode: 'coding', workspace: '/work/project' }),
      { wrapper: wrapper(client) },
    )

    await waitFor(() => expect(client.getQueryData(queryKeys.coding.files('/work/project'))).toEqual({ files: [] }))
    expect(client.getQueryCache().getAll()).toHaveLength(1)
  })
})
