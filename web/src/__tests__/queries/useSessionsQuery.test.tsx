import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiBaseUrl } from '@/api/base-url'
import {
  useActiveSessionsQuery,
  useAllSessionsQuery,
  usePinnedSessionsQuery,
  useSessionSearchQuery,
  useSetSessionPinnedMutation,
  useUpdateSessionTitleMutation,
  useWorkspaceSessionsQuery,
} from '@/queries/useSessionsQuery'
import { queryKeys } from '@/queries/keys'
import { useAgentStore } from '@/stores/useAgentStore'

const originalFetch = globalThis.fetch
const realDateNow = Date.now

afterEach(() => {
  globalThis.fetch = originalFetch
  Date.now = realDateNow
  focusManager.setFocused(undefined)
})

describe('useWorkspaceSessionsQuery', () => {
  // The global event stream patches these lists and resyncs after a gap, so
  // a focus refetch only re-read every loaded page of every workspace in
  // the sidebar, one request per page, on each alt-tab.
  it('does not refetch when the window regains focus', async () => {
    setApiBaseUrl('')
    const fetchMock = mock(async (_input: unknown) => new Response(JSON.stringify({
      data: [{ id: 's1', title: 'T', agent_name: 'lead', created_at: null, updated_at: null }],
      next_cursor: null,
      has_more: false,
    })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    const { result } = renderHook(() => useWorkspaceSessionsQuery('/repo'), { wrapper })
    await waitFor(() => expect(result.current.data?.pages[0].data[0].id).toBe('s1'))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Well past the list's stale time.
    const later = realDateNow() + 60_000
    Date.now = () => later
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('asks for unpinned sessions in activity order and hides pinned rows an older server sends', async () => {
    setApiBaseUrl('')
    const fetchMock = mock(async (_input: unknown) => new Response(JSON.stringify({
      data: [
        { id: 'pinned', title: 'P', agent_name: 'lead', created_at: null, updated_at: null, pinned_at: '2026-10-01T00:00:00Z' },
        { id: 's1', title: 'T', agent_name: 'lead', created_at: null, updated_at: null },
      ],
      next_cursor: null,
      has_more: false,
    })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    const { result } = renderHook(() => useWorkspaceSessionsQuery('/repo'), { wrapper })
    await waitFor(() => expect(result.current.data?.pages[0].data.map((s) => s.id)).toEqual(['s1']))
    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://x')
    expect(url.searchParams.get('sort')).toBe('activity')
    expect(url.searchParams.get('pinned')).toBe('false')
    expect(client.getQueryData(queryKeys.session.sessions.workspace('/repo', 'activity'))).toBeDefined()
  })
})

describe('useAllSessionsQuery', () => {
  it('lists unpinned sessions across workspaces and stays idle when disabled', async () => {
    setApiBaseUrl('')
    const fetchMock = mock(async (_input: unknown) => new Response(JSON.stringify({
      data: [{ id: 's1', title: 'T', agent_name: 'lead', created_at: null, updated_at: null, workspace: '/a' }],
      next_cursor: null,
      has_more: false,
    })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    const idle = renderHook(() => useAllSessionsQuery(false), { wrapper })
    expect(idle.result.current.fetchStatus).toBe('idle')

    const { result } = renderHook(() => useAllSessionsQuery(), { wrapper })
    await waitFor(() => expect(result.current.data?.pages[0].data[0].id).toBe('s1'))
    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://x')
    expect(url.searchParams.get('sort')).toBe('activity')
    expect(url.searchParams.get('workspace')).toBeNull()
    expect(url.searchParams.getAll('workspaces')).toEqual([])
    expect(url.searchParams.get('pinned')).toBe('false')
  })
})

describe('usePinnedSessionsQuery', () => {
  it('asks for pinned sessions and keeps only pinned rows', async () => {
    setApiBaseUrl('')
    const fetchMock = mock(async (_input: unknown) => new Response(JSON.stringify({
      data: [
        { id: 'p1', title: 'P', agent_name: 'lead', created_at: null, updated_at: null, pinned_at: '2026-10-01T00:00:00Z' },
        { id: 'plain', title: 'T', agent_name: 'lead', created_at: null, updated_at: null },
      ],
      next_cursor: null,
      has_more: false,
    })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    const { result } = renderHook(() => usePinnedSessionsQuery(), { wrapper })
    await waitFor(() => expect(result.current.data?.pages[0].data.map((s) => s.id)).toEqual(['p1']))
    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://x')
    expect(url.searchParams.get('pinned')).toBe('true')
  })
})

describe('useSetSessionPinnedMutation', () => {
  const page = (rows: Array<Record<string, unknown>>) => ({
    pages: [{ data: rows, next_cursor: null, has_more: false }],
    pageParams: [null],
  })

  it('moves the row into Pinned before the server answers, then refetches the lists', async () => {
    setApiBaseUrl('')
    let release: (value: Response) => void = () => {}
    const fetchMock = mock((..._args: unknown[]) => new Promise<Response>((resolve) => { release = resolve }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const row = { id: 's1', title: 'T', agent_name: 'lead', created_at: null, updated_at: null, workspace: '/repo' }
    client.setQueryData(queryKeys.session.sessions.workspace('/repo'), page([row]))
    client.setQueryData(queryKeys.session.sessions.pinned(), page([]))
    const realInvalidate = client.invalidateQueries.bind(client)
    const invalidate = mock((...args: unknown[]) => realInvalidate(...(args as Parameters<typeof realInvalidate>)))
    client.invalidateQueries = invalidate as unknown as typeof client.invalidateQueries
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    const { result } = renderHook(() => useSetSessionPinnedMutation(), { wrapper })
    act(() => { result.current.mutate({ id: 's1', pinned: true }) })

    await waitFor(() => {
      const pinned = client.getQueryData<ReturnType<typeof page>>(queryKeys.session.sessions.pinned())
      expect(pinned?.pages[0].data.map((s) => s.id)).toEqual(['s1'])
    })
    const ws = client.getQueryData<ReturnType<typeof page>>(queryKeys.session.sessions.workspace('/repo'))
    expect(ws?.pages[0].data[0].pinned_at).toBeTruthy()
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({ pinned: true })

    release(new Response(JSON.stringify({ ...row, pinned_at: '2026-10-19T00:00:00Z' })))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.session.sessions.all() })
  })

  it('restores the previous pin when the server refuses', async () => {
    setApiBaseUrl('')
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ detail: 'nope' }), { status: 422 })) as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const pinnedAt = '2026-10-01T00:00:00Z'
    client.setQueryData(queryKeys.session.sessions.pinned(), page([{ id: 's1', title: 'T', agent_name: 'lead', created_at: null, updated_at: null, pinned_at: pinnedAt }]))
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    const { result } = renderHook(() => useSetSessionPinnedMutation(), { wrapper })
    await act(async () => {
      await result.current.mutateAsync({ id: 's1', pinned: false }).catch(() => {})
    })
    const pinned = client.getQueryData<ReturnType<typeof page>>(queryKeys.session.sessions.pinned())
    expect(pinned?.pages[0].data[0].pinned_at).toBe(pinnedAt)
  })
})

describe('useActiveSessionsQuery', () => {
  it('asks the server for running and waiting sessions in one page', async () => {
    setApiBaseUrl('')
    const fetchMock = mock(async (_input: unknown) => new Response(JSON.stringify({
      data: [{ id: 's1', title: 'T', agent_name: 'lead', created_at: null, updated_at: null, needs_input: true }],
      next_cursor: null,
      has_more: false,
    })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    const { result } = renderHook(() => useActiveSessionsQuery(), { wrapper })

    await waitFor(() => expect(result.current.data?.pages[0].data[0].id).toBe('s1'))
    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://x')
    expect(url.pathname).toBe('/api/agent/sessions')
    expect(url.searchParams.get('active')).toBe('true')
  })
})

describe('useSessionSearchQuery', () => {
  it('searches titles on the server and stays idle without a query', async () => {
    setApiBaseUrl('')
    const fetchMock = mock(async (_input: unknown) => new Response(JSON.stringify({
      data: [{ id: 'm1', title: 'Migration plan', agent_name: 'lead', created_at: null, updated_at: null }],
      next_cursor: null,
      has_more: false,
    })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    const idle = renderHook(() => useSessionSearchQuery(''), { wrapper })
    expect(idle.result.current.fetchStatus).toBe('idle')
    expect(fetchMock).not.toHaveBeenCalled()

    const { result } = renderHook(() => useSessionSearchQuery('migr'), { wrapper })
    await waitFor(() => expect(result.current.data?.pages[0].data[0].id).toBe('m1'))
    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://x')
    expect(url.searchParams.get('q')).toBe('migr')
  })
})

describe('useUpdateSessionTitleMutation', () => {
  // The server does not broadcast a rename, and the header reads the title
  // from the agent store rather than the session lists.
  it('updates the title of the session on screen', async () => {
    setApiBaseUrl('')
    globalThis.fetch = mock(async (_input: unknown) => new Response(JSON.stringify({
      id: 'current', title: 'Renamed', agent_name: 'lead', created_at: null, updated_at: null,
    }))) as unknown as typeof fetch
    useAgentStore.setState({ sessionId: 'current', sessionTitle: 'Old' })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    const { result } = renderHook(() => useUpdateSessionTitleMutation(), { wrapper })
    await result.current.mutateAsync({ id: 'current', title: 'Renamed' })

    expect(useAgentStore.getState().sessionTitle).toBe('Renamed')
  })
})
