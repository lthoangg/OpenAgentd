import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { forgetProviderUsage, queryKeys, useProviderUsageQuery, useResetProviderUsageMutation } from '@/queries'
import { activeBlock, clearProviderUsage } from '@/queries/providerUsageCache'
import { getProviderUsage } from '@/api/client'
import { toProviderUsageError } from '@/lib/provider-usage'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
}

// Default options on purpose: the hook itself must not retry.
const makeClient = () => new QueryClient()

const ok = (limits: unknown[] = [{ limit_id: 'a', primary: { used_percent: 12 } }], extra: object = {}) =>
  new Response(JSON.stringify({ provider: 'codex', limits, ...extra }), { status: 200 })

function limited(retryAfterS: number, lastGood: object | null = null) {
  const nowS = Date.now() / 1000
  return new Response(
    JSON.stringify({
      detail: {
        code: 'usage_rate_limited',
        message: 'Usage is rate-limited.',
        retry_at: nowS + retryAfterS,
        retry_after: retryAfterS,
        last_good: lastGood,
      },
    }),
    { status: 429 },
  )
}

const lastGood = (updatedAtS: number) => ({
  provider: 'codex',
  stale: true,
  updated_at: updatedAtS,
  limits: [{ limit_id: 'a', primary: { used_percent: 40 } }],
})

describe('useProviderUsageQuery', () => {
  it('does not retry a failed request in a loop', async () => {
    const fetchMock = mock(async () => new Response('{}', { status: 500 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { result } = renderHook(() => useProviderUsageQuery('codex', true), { wrapper: wrapper(makeClient()) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    await new Promise((r) => setTimeout(r, 80))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('makes no request while disabled', async () => {
    const fetchMock = mock(async () => ok())
    globalThis.fetch = fetchMock as unknown as typeof fetch
    renderHook(() => useProviderUsageQuery('codex', false, 'cred_a'), { wrapper: wrapper(makeClient()) })
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requests the credential it was given', async () => {
    const fetchMock = mock(async (..._args: unknown[]) => ok())
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { result } = renderHook(() => useProviderUsageQuery('codex', true, 'cred a'), { wrapper: wrapper(makeClient()) })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(String(fetchMock.mock.calls[0][0])).toContain('/settings/providers/codex/usage?credential_id=cred%20a')
  })

  it('keeps showing the last numbers when a refresh fails', async () => {
    let n = 0
    globalThis.fetch = mock(async () => (++n === 1 ? ok() : new Response('{}', { status: 502 }))) as unknown as typeof fetch
    const { result } = renderHook(() => useProviderUsageQuery('codex', true), { wrapper: wrapper(makeClient()) })
    await waitFor(() => expect(result.current.data?.limits).toHaveLength(1))
    await act(async () => {
      await result.current.refetch()
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data?.limits[0].primary?.used_percent).toBe(12)
  })

  it('holds the server snapshot from a 429 with its original timestamp and makes no early upstream call', async () => {
    const updatedS = Math.floor(Date.now() / 1000) - 240
    const fetchMock = mock(async () => limited(120, lastGood(updatedS)))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const client = makeClient()
    const { result } = renderHook(() => useProviderUsageQuery('codex', true), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(toProviderUsageError(result.current.error).kind).toBe('rate_limited')
    expect(result.current.data?.limits[0].primary?.used_percent).toBe(40)
    expect(result.current.dataUpdatedAt).toBe(updatedS * 1000)

    // Manual refresh, focus and a second mount all stay inside the cooldown.
    await act(async () => {
      await result.current.refetch()
    })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    renderHook(() => useProviderUsageQuery('codex', true), { wrapper: wrapper(client) })
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.dataUpdatedAt).toBe(updatedS * 1000)
    expect(result.current.data?.limits[0].primary?.used_percent).toBe(40)
  })

  it('keeps the original timestamp of a last_good that arrives with a 502', async () => {
    const updatedS = Math.floor(Date.now() / 1000) - 600
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ detail: { code: 'usage_unavailable', message: 'Usage is unavailable.', last_good: lastGood(updatedS) } }),
        { status: 502 },
      ),
    ) as unknown as typeof fetch
    const { result } = renderHook(() => useProviderUsageQuery('codex', true), { wrapper: wrapper(makeClient()) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(toProviderUsageError(result.current.error).kind).toBe('unavailable')
    expect(result.current.data?.limits[0].primary?.used_percent).toBe(40)
    expect(result.current.dataUpdatedAt).toBe(updatedS * 1000)
  })

  it('restores the held snapshot from the block even after the cached query was dropped', async () => {
    const updatedS = Math.floor(Date.now() / 1000) - 240
    const fetchMock = mock(async () => limited(120, lastGood(updatedS)))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const client = makeClient()
    const key = queryKeys.settings.providerUsage('codex')
    const { result } = renderHook(() => useProviderUsageQuery('codex', true), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.dataUpdatedAt).toBe(updatedS * 1000))
    // The query is garbage-collected while the block is still in force.
    act(() => {
      client.removeQueries({ queryKey: key, exact: true })
    })
    await act(async () => {
      await result.current.refresh()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(client.getQueryState(key)?.dataUpdatedAt).toBe(updatedS * 1000))
    expect(client.getQueryData<{ limits: unknown[] }>(key)?.limits).toHaveLength(1)
  })

  it('keeps a 429 with an unfamiliar code in the rate-limit path, with no further calls', async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ detail: { code: 'brand_new', message: 'x', retry_after: 120 } }), { status: 429 }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { result } = renderHook(() => useProviderUsageQuery('codex', true), { wrapper: wrapper(makeClient()) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.kind).toBe('rate_limited')
    await act(async () => {
      await result.current.refresh()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not call a missing account unsupported', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ detail: 'Credential not found' }), { status: 404 })) as unknown as typeof fetch
    const { result } = renderHook(() => useProviderUsageQuery('codex', true, 'gone'), { wrapper: wrapper(makeClient()) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.kind).toBe('unavailable')
    const wide = renderHook(() => useProviderUsageQuery('plain', true), { wrapper: wrapper(makeClient()) })
    await waitFor(() => expect(wide.result.current.isError).toBe(true))
    expect(wide.result.current.error?.kind).toBe('unsupported')
  })

  it('drops every block when asked for a new server, but an ordinary cache drop keeps them', async () => {
    globalThis.fetch = mock(async () => limited(300)) as unknown as typeof fetch
    const client = makeClient()
    const key = queryKeys.settings.providerUsage('codex', 'cred_a')
    const { result } = renderHook(() => useProviderUsageQuery('codex', true, 'cred_a'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(activeBlock(client, key)).not.toBeNull()

    // Ordinary garbage collection / removal of the cached reading: the block stays.
    act(() => {
      client.removeQueries({ queryKey: key, exact: true })
    })
    expect(activeBlock(client, key)).not.toBeNull()

    // A different server: nothing from the old one may carry over.
    act(() => {
      client.clear()
      clearProviderUsage(client)
    })
    expect(activeBlock(client, key)).toBeNull()
  })

  it('keeps usage out of the provider list’s query key prefix', () => {
    const list = queryKeys.settings.providers()
    for (const key of [queryKeys.settings.providerUsage('codex'), queryKeys.settings.providerUsage('codex', 'cred_a')]) {
      expect(key.slice(0, list.length)).not.toEqual([...list])
    }
  })

  it('probes once when the cooldown ends, without polling before', async () => {
    let n = 0
    const fetchMock = mock(async () => (++n === 1 ? limited(0.3) : ok([{ limit_id: 'a', primary: { used_percent: 5 } }])))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { result } = renderHook(() => useProviderUsageQuery('codex', true), { wrapper: wrapper(makeClient()) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current.data?.limits[0].primary?.used_percent).toBe(5), { timeout: 3000 })
    expect(result.current.isError).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not probe after it is disabled (provider collapsed)', async () => {
    const fetchMock = mock(async () => limited(0.3))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { result, rerender } = renderHook(({ on }) => useProviderUsageQuery('codex', on), {
      wrapper: wrapper(makeClient()),
      initialProps: { on: true },
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    rerender({ on: false })
    await new Promise((r) => setTimeout(r, 700))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

const credentialsError = () =>
  new Response(JSON.stringify({ detail: { code: 'usage_credentials', message: 'Sign-in needs attention.' } }), { status: 401 })

/** What the hook asks TanStack to do in the background, read from the live observer. */
function backgroundPolicy(client: QueryClient, key: readonly unknown[]) {
  const query = client.getQueryCache().find({ queryKey: key, exact: true })
  if (!query) throw new Error('no query')
  const options = query.observers[0].options as {
    refetchInterval?: unknown
    refetchOnWindowFocus?: unknown
    refetchOnReconnect?: unknown
  }
  const read = (v: unknown) => (typeof v === 'function' ? (v as (q: unknown) => unknown)(query) : v)
  return { interval: read(options.refetchInterval), focus: read(options.refetchOnWindowFocus), reconnect: read(options.refetchOnReconnect) }
}

describe('manual refresh', () => {
  it('getProviderUsage sends force_refresh only when asked', async () => {
    const fetchMock = mock(async (..._args: unknown[]) => ok())
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await getProviderUsage('codex')
    await getProviderUsage('codex', 'cred_a')
    await getProviderUsage('codex', undefined, true)
    await getProviderUsage('codex', 'cred_a', true)
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls[0]).toMatch(/\/usage$/)
    expect(urls[1]).toMatch(/\/usage\?credential_id=cred_a$/)
    expect(urls[2]).toMatch(/\/usage\?force_refresh=true$/)
    expect(urls[3]).toMatch(/\/usage\?credential_id=cred_a&force_refresh=true$/)
  })

  it('forces only the user-triggered refresh, never the first load, a refetch or the poll path', async () => {
    const fetchMock = mock(async (..._args: unknown[]) => ok())
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { result } = renderHook(() => useProviderUsageQuery('codex', true, 'cred_a'), { wrapper: wrapper(makeClient()) })
    await waitFor(() => expect(result.current.data).toBeDefined())
    await act(async () => {
      await result.current.refetch()
    })
    await act(async () => {
      await result.current.refresh()
    })
    await act(async () => {
      await result.current.refetch()
    })
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls).toHaveLength(4)
    expect(urls.map((u) => u.includes('force_refresh=true'))).toEqual([false, false, true, false])
    expect(urls[2]).toContain('credential_id=cred_a')
  })

  it('still sends nothing while the provider says to wait, even for the button', async () => {
    const fetchMock = mock(async () => limited(120))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { result } = renderHook(() => useProviderUsageQuery('codex', true), { wrapper: wrapper(makeClient()) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    await act(async () => {
      await result.current.refresh()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not leave force switched on after a blocked press', async () => {
    let n = 0
    const fetchMock = mock(async (..._args: unknown[]) => (++n === 1 ? limited(0.2) : ok()))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { result } = renderHook(() => useProviderUsageQuery('codex', true), { wrapper: wrapper(makeClient()) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    await act(async () => {
      await result.current.refresh()
    })
    // The probe at the end of the wait is a normal request.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('force_refresh')
  })
})

describe('a sign-in that needs attention', () => {
  it('stops polling, focus and reconnect refetches, and does not call out again', async () => {
    const fetchMock = mock(async () => credentialsError())
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const client = makeClient()
    const key = queryKeys.settings.providerUsage('codex', 'cred_a')
    const { result } = renderHook(() => useProviderUsageQuery('codex', true, 'cred_a'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(toProviderUsageError(result.current.error).kind).toBe('credentials')
    expect(backgroundPolicy(client, key)).toEqual({ interval: false, focus: false, reconnect: false })

    await act(async () => {
      await result.current.refresh()
      await result.current.refetch()
    })
    renderHook(() => useProviderUsageQuery('codex', true, 'cred_a'), { wrapper: wrapper(client) })
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('asks again once that account is reconnected, and leaves another account alone', async () => {
    let credentialsOk = false
    const fetchMock = mock(async (...args: unknown[]) => {
      const url = String(args[0])
      if (url.includes('cred_b')) return limited(300)
      return credentialsOk ? ok() : credentialsError()
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const client = makeClient()
    const a = renderHook(() => useProviderUsageQuery('codex', true, 'cred_a'), { wrapper: wrapper(client) })
    const b = renderHook(() => useProviderUsageQuery('codex', true, 'cred_b'), { wrapper: wrapper(client) })
    await waitFor(() => expect(a.result.current.isError && b.result.current.isError).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(2)

    credentialsOk = true
    act(() => {
      forgetProviderUsage(client, 'codex', 'cred_a')
    })
    a.unmount()
    const again = renderHook(() => useProviderUsageQuery('codex', true, 'cred_a'), { wrapper: wrapper(client) })
    await waitFor(() => expect(again.result.current.data).toBeDefined())
    expect(again.result.current.isError).toBe(false)

    // cred_b is still cooling down: nothing new goes out for it.
    await act(async () => {
      await b.result.current.refresh()
    })
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('cred_b'))).toHaveLength(1)
  })
})

describe('useResetProviderUsageMutation', () => {
  it('redeems on the given credential and refreshes only that usage key', async () => {
    const fetchMock = mock(async (..._args: unknown[]) => ok([{ limit_id: 'a', primary: { used_percent: 0 } }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const client = makeClient()
    client.setQueryData(queryKeys.settings.providerUsage('codex', 'cred_a'), { provider: 'codex', limits: [] })
    client.setQueryData(queryKeys.settings.providerUsage('codex', 'cred_b'), { provider: 'codex', limits: [] })
    const invalidate = mock((..._args: unknown[]) => Promise.resolve())
    client.invalidateQueries = invalidate as unknown as typeof client.invalidateQueries

    const { result } = renderHook(() => useResetProviderUsageMutation(), { wrapper: wrapper(client) })
    await act(async () => {
      await result.current.mutateAsync({ providerId: 'codex', credentialId: 'cred_a' })
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/settings/providers/codex/reset?credential_id=cred_a')
    expect(init.method).toBe('POST')
    const usageKeys = invalidate.mock.calls
      .map((c) => (c[0] as { queryKey: readonly unknown[]; exact?: boolean }))
      .filter((c) => c.queryKey.includes('provider-usage'))
    expect(usageKeys).toHaveLength(1)
    expect(usageKeys[0].queryKey).toEqual(queryKeys.settings.providerUsage('codex', 'cred_a'))
    expect(usageKeys[0].exact).toBe(true)
    expect(client.getQueryData(queryKeys.settings.providerUsage('codex', 'cred_b'))).toEqual({ provider: 'codex', limits: [] })
  })
})
