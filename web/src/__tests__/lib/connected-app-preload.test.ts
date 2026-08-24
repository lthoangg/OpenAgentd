import { describe, expect, it, mock } from 'bun:test'
import type { QueryClient } from '@tanstack/react-query'
import { preloadConnectedApp } from '@/lib/connected-app-preload'
import { queryKeys } from '@/queries/keys'

function createClient() {
  const prefetchQuery = mock(() => Promise.resolve())
  const prefetchInfiniteQuery = mock(() => Promise.resolve())
  return {
    client: { prefetchQuery, prefetchInfiniteQuery } as unknown as QueryClient,
    prefetchQuery,
    prefetchInfiniteQuery,
  }
}

describe('preloadConnectedApp', () => {
  it('warms coding entry data after a connection', () => {
    const { client, prefetchQuery, prefetchInfiniteQuery } = createClient()

    preloadConnectedApp(client)

    expect(prefetchQuery).toHaveBeenCalledTimes(3)
    expect(prefetchQuery.mock.calls.map(([options]) => (options as { queryKey: readonly unknown[] }).queryKey)).toEqual([
      // Shared /team/agents entry — same key the home-page probe and chat
      // header read, so the preload warms both.
      queryKeys.teamAgents(),
      queryKeys.settings.providers(),
      queryKeys.coding.tree(),
    ])
    expect(prefetchInfiniteQuery).toHaveBeenCalledTimes(1)
    expect(prefetchInfiniteQuery.mock.calls.map(([options]) => (options as { queryKey: readonly unknown[] }).queryKey)).toEqual([
      queryKeys.team.sessions.workspace('__all_coding__'),
    ])
  })
})
