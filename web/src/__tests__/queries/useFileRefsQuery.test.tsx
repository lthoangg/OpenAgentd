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

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('useFileRefsQuery', () => {
  it('uses the coding workspace files key for coding references', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ workspace: '/work/project', files: [], truncated: false })),
    ) as typeof fetch
    const client = makeClient()

    renderHook(
      () => useFileRefsQuery({ workspace: '/work/project' }),
      { wrapper: wrapper(client) },
    )

    await waitFor(() =>
      expect(client.getQueryData(queryKeys.coding.files('/work/project'))).toBeDefined(),
    )
    expect(client.getQueryCache().getAll()).toHaveLength(1)
  })

  // Both consumers of a shared key must cache the *same* shape. Previously the
  // picker narrowed the payload to ``{ files }`` while the panel stored the
  // full response, so whichever resolved last won and fields like
  // ``truncated`` could silently become undefined for the other reader.
  it('caches the full response shape, not a narrowed { files } object', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        workspace: '/work/project',
        files: [{ path: 'a.txt', name: 'a.txt', size: 1, modified_at: null }],
        truncated: true,
      })),
    ) as typeof fetch
    const client = makeClient()

    renderHook(
      () => useFileRefsQuery({ workspace: '/work/project' }),
      { wrapper: wrapper(client) },
    )

    await waitFor(() =>
      expect(client.getQueryData(queryKeys.coding.files('/work/project'))).toBeDefined(),
    )
    expect(client.getQueryData(queryKeys.coding.files('/work/project'))).toMatchObject({
      workspace: '/work/project',
      truncated: true,
    })
  })

  it('derives directory refs from file path prefixes', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        workspace: '/work/project',
        files: [{ path: 'src/lib/util.ts', name: 'util.ts', size: 1, modified_at: null }],
        truncated: false,
      })),
    ) as typeof fetch
    const client = makeClient()

    const { result } = renderHook(
      () => useFileRefsQuery({ workspace: '/work/project' }),
      { wrapper: wrapper(client) },
    )

    await waitFor(() => expect(result.current.refs.length).toBeGreaterThan(0))
    expect(result.current.refs).toEqual([
      { path: 'src/lib/util.ts', name: 'util.ts', type: 'file' },
      { path: 'src', name: 'src', type: 'directory' },
      { path: 'src/lib', name: 'lib', type: 'directory' },
    ])
  })
})
