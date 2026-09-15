import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { isChatWorkspacePath, useChatWorkspace } from '@/queries/useChatWorkspace'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
}

describe('useChatWorkspace', () => {
  it('reads the pinned chat entry from the workspace tree', async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          repositories: [{ path: '/repo/project', name: 'project', worktrees: [] }],
          chat: { path: '/home/user', name: 'Chat' },
        }),
      ),
    ) as typeof fetch

    const { result } = renderHook(() => useChatWorkspace(), {
      wrapper: wrapper(makeClient()),
    })

    await waitFor(() => expect(result.current).toEqual({ path: '/home/user', name: 'Chat' }))
  })

  it('returns null when the response carries no chat entry', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ repositories: [] })),
    ) as typeof fetch

    const { result } = renderHook(() => useChatWorkspace(), {
      wrapper: wrapper(makeClient()),
    })

    await waitFor(() => expect(result.current).toBeNull())
  })
})

describe('isChatWorkspacePath', () => {
  const chat = { path: '/home/user', name: 'Chat' }

  it('matches the chat root, tolerating a trailing separator', () => {
    expect(isChatWorkspacePath('/home/user', chat)).toBe(true)
    expect(isChatWorkspacePath('/home/user/', chat)).toBe(true)
  })

  it('rejects other paths and missing inputs', () => {
    expect(isChatWorkspacePath('/home/user/projects', chat)).toBe(false)
    expect(isChatWorkspacePath('/repo/project', chat)).toBe(false)
    expect(isChatWorkspacePath(null, chat)).toBe(false)
    expect(isChatWorkspacePath('/home/user', null)).toBe(false)
  })
})
