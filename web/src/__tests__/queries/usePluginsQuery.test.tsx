import { afterEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import type { PluginBundle, PluginsResponse } from '@/api/client'
import { queryKeys } from '@/queries/keys'
import {
  PLUGINS_PENDING_POLL_MS,
  pluginsPollInterval,
  usePluginsQuery,
  useReloadPluginsMutation,
  useSetPluginBundleEnabledMutation,
} from '@/queries/usePluginsQuery'

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

function bundle(name: string, over: Partial<PluginBundle> = {}): PluginBundle {
  return {
    name,
    version: '1.0.0',
    description: null,
    path: `/p/${name}`,
    enabled: true,
    state: 'running',
    errors: [],
    warnings: [],
    skills: [],
    mcp_servers: [],
    tools: [],
    permissions: null,
    has_code: false,
    ...over,
  }
}

const list = (...bundles: PluginBundle[]): PluginsResponse => ({ dirs: ['/p'], plugins: [], unported: [], bundles })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function setup(seed: PluginsResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.plugins(), seed)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const cached = () => client.getQueryData<PluginsResponse>(queryKeys.plugins())?.bundles
  const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated
  return { client, wrapper, cached, stale }
}

describe('pluginsPollInterval', () => {
  it('polls while an enabled bundle is still starting', () => {
    expect(pluginsPollInterval(list(bundle('a', { state: 'pending' })))).toBe(PLUGINS_PENDING_POLL_MS)
  })

  it('stops once every bundle has settled', () => {
    const settled = (['running', 'failed', 'blocked', 'stopped'] as const).map((state) => bundle(state, { state }))
    expect(pluginsPollInterval(list(...settled))).toBe(false)
  })

  it('does not poll for a bundle that is off, whatever its state says', () => {
    expect(pluginsPollInterval(list(bundle('a', { state: 'pending', enabled: false })))).toBe(false)
  })

  it('does not poll before any data arrives, or on a server without bundles', () => {
    expect(pluginsPollInterval(undefined)).toBe(false)
    expect(pluginsPollInterval({ dirs: [], plugins: [], unported: [] })).toBe(false)
  })
})

describe('usePluginsQuery', () => {
  const intervalOf = (client: QueryClient) =>
    client.getQueryCache().find({ queryKey: queryKeys.plugins() })?.observers[0]?.options.refetchInterval

  it('polls only when asked to, so the startup notice adds no traffic', () => {
    const quiet = setup(list(bundle('a', { state: 'pending' })))
    renderHook(() => usePluginsQuery(true), { wrapper: quiet.wrapper })
    expect(intervalOf(quiet.client)).toBeUndefined()
    cleanup()

    const live = setup(list(bundle('a', { state: 'pending' })))
    renderHook(() => usePluginsQuery(true, { pollWhilePending: true }), { wrapper: live.wrapper })
    const interval = intervalOf(live.client) as (query: { state: { data: PluginsResponse | undefined } }) => number | false
    expect(typeof interval).toBe('function')
    expect(interval({ state: { data: list(bundle('a', { state: 'pending' })) } })).toBe(PLUGINS_PENDING_POLL_MS)
    expect(interval({ state: { data: list(bundle('a')) } })).toBe(false)
  })
})

describe('useSetPluginBundleEnabledMutation', () => {
  it('shows the new state at once, before the server answers, and touches no other bundle', async () => {
    let answer!: (response: Response) => void
    globalThis.fetch = (() => new Promise<Response>((resolve) => { answer = resolve })) as typeof fetch
    const other = bundle('other')
    const { wrapper, cached } = setup(list(bundle('a'), other))
    const { result } = renderHook(() => useSetPluginBundleEnabledMutation(), { wrapper })

    act(() => { result.current.mutate({ name: 'a', enabled: false }) })

    await waitFor(() => expect(cached()?.[0]).toMatchObject({ name: 'a', enabled: false, state: 'disabled' }))
    expect(cached()?.[1]).toEqual(other)

    await act(async () => { answer(json(bundle('a', { enabled: false, state: 'disabled' }))) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('shows a bundle being turned on as pending until the server says how it started', async () => {
    let answer!: (response: Response) => void
    globalThis.fetch = (() => new Promise<Response>((resolve) => { answer = resolve })) as typeof fetch
    const { wrapper, cached } = setup(list(bundle('a', { enabled: false, state: 'disabled' })))
    const { result } = renderHook(() => useSetPluginBundleEnabledMutation(), { wrapper })

    act(() => { result.current.mutate({ name: 'a', enabled: true }) })
    await waitFor(() => expect(cached()?.[0]).toMatchObject({ enabled: true, state: 'pending' }))

    await act(async () => { answer(json(bundle('a', { enabled: true, state: 'failed', errors: ['no such file'] }))) })
    await waitFor(() => expect(cached()?.[0]).toMatchObject({ enabled: true, state: 'failed', errors: ['no such file'] }))
  })

  it('puts the previous list back when the server refuses', async () => {
    globalThis.fetch = (async () => json({ detail: 'read-only' }, 500)) as typeof fetch
    const before = list(bundle('a'), bundle('other'))
    const { wrapper, cached } = setup(before)
    const { result } = renderHook(() => useSetPluginBundleEnabledMutation(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ name: 'a', enabled: false }).catch(() => undefined)
    })

    expect(cached()).toEqual(before.bundles)
    await waitFor(() => expect(result.current.error?.message).toBe('read-only'))
  })

  it('marks the list, the MCP servers and the skills stale, since a bundle brings and takes them', async () => {
    globalThis.fetch = (async () => json(bundle('a', { enabled: false, state: 'disabled' }))) as typeof fetch
    const { client, wrapper, stale } = setup(list(bundle('a')))
    client.setQueryData(queryKeys.mcp.list(), { servers: [] })
    client.setQueryData(queryKeys.skillFiles.list(), { skills: [] })
    const { result } = renderHook(() => useSetPluginBundleEnabledMutation(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ name: 'a', enabled: false })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(stale(queryKeys.plugins())).toBe(true)
    expect(stale(queryKeys.mcp.list())).toBe(true)
    expect(stale(queryKeys.skillFiles.list())).toBe(true)
  })

  it('leaves a list from a server without bundles alone', async () => {
    globalThis.fetch = (async () => json(bundle('a'))) as typeof fetch
    const old: PluginsResponse = { dirs: ['/p'], plugins: [], unported: [] }
    const { client, wrapper } = setup(old)
    const { result } = renderHook(() => useSetPluginBundleEnabledMutation(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ name: 'a', enabled: true })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(client.getQueryData(queryKeys.plugins())).toEqual(old)
  })
})

describe('useReloadPluginsMutation', () => {
  it('writes the list the server answers with, and marks the MCP servers and skills stale', async () => {
    const after = list(bundle('a'), bundle('new'))
    globalThis.fetch = (async () => json(after)) as typeof fetch
    const { client, wrapper, cached, stale } = setup(list(bundle('a')))
    client.setQueryData(queryKeys.mcp.list(), { servers: [] })
    client.setQueryData(queryKeys.skillFiles.list(), { skills: [] })
    const { result } = renderHook(() => useReloadPluginsMutation(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync()
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(cached()).toEqual(after.bundles)
    expect(stale(queryKeys.mcp.list())).toBe(true)
    expect(stale(queryKeys.skillFiles.list())).toBe(true)
  })

  it('keeps the list it had when the reload fails', async () => {
    globalThis.fetch = (async () => json({ detail: 'boom' }, 500)) as typeof fetch
    const before = list(bundle('a'))
    const { wrapper, cached } = setup(before)
    const { result } = renderHook(() => useReloadPluginsMutation(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined)
    })

    expect(cached()).toEqual(before.bundles)
    await waitFor(() => expect(result.current.error?.message).toBe('boom'))
  })
})
