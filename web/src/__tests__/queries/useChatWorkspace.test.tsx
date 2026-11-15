import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { isChatWorkspacePath, useChatWorkspace, useWorkspaceHasGit, workspaceHasGit } from '@/queries/useChatWorkspace'

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

describe('workspaceHasGit', () => {
  const repositories = [
    { path: '/repo/app', name: 'app', git: true, worktrees: [{ path: '/wt/fix', name: 'fix', managed: true }] },
    { path: '/docs/notes', name: 'notes', git: false, worktrees: [{ path: '/docs/notes/drafts', name: 'drafts', managed: false, kind: 'folder' as const }] },
    { path: '/old/server', name: 'server', worktrees: [] },
  ]

  it('is false for a folder the tree says is not in a Git working tree, and for its subfolders', () => {
    expect(workspaceHasGit('/docs/notes', repositories)).toBe(false)
    expect(workspaceHasGit('/docs/notes/', repositories)).toBe(false)
    expect(workspaceHasGit('/docs/notes/drafts', repositories)).toBe(false)
  })

  it('is true for a repository and its worktrees', () => {
    expect(workspaceHasGit('/repo/app', repositories)).toBe(true)
    expect(workspaceHasGit('/wt/fix', repositories)).toBe(true)
  })

  it('is true while nothing says otherwise: an older server, a path not in the tree, no tree yet', () => {
    expect(workspaceHasGit('/old/server', repositories)).toBe(true)
    expect(workspaceHasGit('/somewhere/else', repositories)).toBe(true)
    expect(workspaceHasGit('/repo/app', undefined)).toBe(true)
    expect(workspaceHasGit(null, repositories)).toBe(true)
  })
})

describe('useWorkspaceHasGit', () => {
  it('reads it from the workspace tree', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ repositories: [{ path: '/docs/notes', name: 'notes', git: false, worktrees: [] }], chat: null })),
    ) as typeof fetch

    const { result } = renderHook(() => useWorkspaceHasGit('/docs/notes'), { wrapper: wrapper(makeClient()) })

    // Not known yet: nothing probes git on a guess.
    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('reads as Git when the tree cannot be loaded', async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 500 })) as typeof fetch

    const { result } = renderHook(() => useWorkspaceHasGit('/docs/notes'), { wrapper: wrapper(makeClient()) })

    await waitFor(() => expect(result.current).toBe(true))
  })
})
