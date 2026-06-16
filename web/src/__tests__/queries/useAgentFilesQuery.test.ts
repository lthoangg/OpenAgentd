import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys, useRegistryQuery } from '@/queries'

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('useRegistryQuery', () => {
  it('keeps the agent registry as app-lifetime metadata', () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ tools: [], skills: [], providers: [], models: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof fetch
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })

    renderHook(() => useRegistryQuery(), { wrapper: createWrapper(queryClient) })

    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.agentFiles.registry() })
    const options = query?.options as {
      staleTime?: unknown
      gcTime?: unknown
      refetchOnWindowFocus?: unknown
      refetchOnReconnect?: unknown
    }
    expect(options.staleTime).toBe(Infinity)
    expect(options.gcTime).toBe(Infinity)
    expect(options.refetchOnWindowFocus).toBe(false)
    expect(options.refetchOnReconnect).toBe(false)
  })
})
