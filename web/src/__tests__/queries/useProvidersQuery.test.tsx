import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, type Query } from '@tanstack/react-query'

import type { ProvidersListBody, StoredCredential } from '@/api/client'
import { queryKeys } from '@/queries/keys'
import { msUntilCooldownEnds, useProvidersQuery } from '@/queries/useProvidersQuery'

const NOW = 1_700_000_000_000
const NOW_S = NOW / 1000

function credential(id: string, extra: Partial<StoredCredential> = {}): StoredCredential {
  return { id, label: id, disabled: false, kind: 'oauth', hint: null, settings: {}, status: 'ready', in_use: false, cooldown_until: null, cooldown_reason: null, ...extra }
}

function list(...credentials: StoredCredential[][]): ProvidersListBody {
  return { providers: credentials.map((stored, i) => ({ id: `p${i}`, stored_credentials: stored })) } as unknown as ProvidersListBody
}

const cooling = (id: string, untilS: number) => credential(id, { status: 'cooling_down', cooldown_until: untilS, cooldown_reason: 'quota' })

describe('msUntilCooldownEnds', () => {
  it('waits for nothing when no account is cooling', () => {
    expect(msUntilCooldownEnds(undefined, NOW)).toBe(false)
    expect(msUntilCooldownEnds(list([credential('a')], [credential('b', { status: 'disabled' })]), NOW)).toBe(false)
    // A cooling account with no end the list can wait for.
    expect(msUntilCooldownEnds(list([credential('a', { status: 'cooling_down' })]), NOW)).toBe(false)
  })

  it('reads the list again just after the first cooldown ends, across providers', () => {
    const data = list([cooling('a', NOW_S + 600)], [cooling('b', NOW_S + 60), credential('c')])
    expect(msUntilCooldownEnds(data, NOW)).toBe(61_000)
  })

  it('does not ask in a loop when the server still says cooling past the end', () => {
    expect(msUntilCooldownEnds(list([cooling('a', NOW_S - 30)]), NOW)).toBe(5_000)
  })

  it('caps a week-long wait at what a timer can hold', () => {
    expect(msUntilCooldownEnds(list([cooling('a', NOW_S + 30 * 24 * 3600)]), NOW)).toBe(2 ** 31 - 1)
  })
})

describe('useProvidersQuery', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('schedules its next read for when a cooling account turns ready', async () => {
    const untilS = Math.floor(Date.now() / 1000) + 120
    globalThis.fetch = mock(async () => new Response(JSON.stringify(list([cooling('a', untilS)])), { status: 200 })) as unknown as typeof fetch
    const client = new QueryClient()
    const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useProvidersQuery(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    const query = client.getQueryCache().find({ queryKey: queryKeys.settings.providers() }) as Query<ProvidersListBody>
    const interval = query.observers[0]?.options.refetchInterval
    if (typeof interval !== 'function') throw new Error('refetchInterval is not computed from the list')
    const wait = interval(query)
    expect(typeof wait).toBe('number')
    expect(wait as number).toBeGreaterThan(115_000)
    expect(wait as number).toBeLessThanOrEqual(121_000)
  })
})
