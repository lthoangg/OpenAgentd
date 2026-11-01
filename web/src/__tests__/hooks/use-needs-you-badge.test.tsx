import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const invoke = mock(async (..._args: unknown[]) => {})
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => ({ isTauri: true, os: 'macos' }) }))
mock.module('@tauri-apps/api/core', () => ({ invoke }))
// The title count also reaches the native window title.
mock.module('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTitle: async () => {} }) }))

const { useNeedsYouBadge, useNeedsYouCount } = await import('@/hooks/use-needs-you-badge')
const { queryKeys } = await import('@/queries')

afterEach(() => {
  cleanup()
  invoke.mockClear()
})

function activePage(ids: string[]) {
  return {
    pages: [{
      data: ids.map((id) => ({ id, title: id, agent_name: 'lead', created_at: null, updated_at: null, workspace: '/w', running: true, needs_input: true })),
      next_cursor: null,
      has_more: false,
    }],
    pageParams: [null],
  }
}

describe('useNeedsYouBadge', () => {
  it('mirrors the sessions waiting on the user onto the app badge', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    client.setQueryData(queryKeys.session.sessions.active(), activePage(['a', 'b']))
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    const { result } = renderHook(() => useNeedsYouBadge(), { wrapper })
    await act(async () => { await Promise.resolve() })
    expect(result.current).toBe(2)
    expect(invoke.mock.calls.at(-1)).toEqual(['set_attention_badge', { count: 2 }])

    act(() => {
      client.setQueryData(queryKeys.session.sessions.active(), activePage([]))
    })
    await waitFor(() => expect(result.current).toBe(0))
    await waitFor(() => expect(invoke.mock.calls.at(-1)).toEqual(['set_attention_badge', { count: 0 }]))
  })

  it('does not wipe the badge before the first answer arrives', async () => {
    // No active-sessions data yet: the count is a guess of zero, not a fact.
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    // The request never answers.
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
    try {
      renderHook(() => useNeedsYouBadge(), { wrapper })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

      expect(invoke).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('lets a screen read the count without touching the badge', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    client.setQueryData(queryKeys.session.sessions.active(), activePage(['a']))
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    const { result } = renderHook(() => useNeedsYouCount(), { wrapper })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(result.current).toBe(1)
    expect(invoke).not.toHaveBeenCalled()
  })
})
