import { describe, expect, it } from 'bun:test'
import { renderHook, waitFor } from '@testing-library/react'

import { ProviderUsageError } from '@/lib/provider-usage'
import { useRetryCountdown } from '@/components/settings/pages/settings.providers/ProfileUsage'

describe('useRetryCountdown', () => {
  it('counts down on its own, from the state it keeps (not from the error alone)', async () => {
    const error = new ProviderUsageError('rate_limited', { status: 429, retryAtMs: Date.now() + 5_000 })
    const { result } = renderHook(() => useRetryCountdown(error))
    const first = result.current
    expect(first).toBeGreaterThan(3_500)
    await waitFor(() => expect(result.current).toBeLessThan(first - 900), { timeout: 3000 })
    await waitFor(() => expect(result.current).toBeLessThan(first - 1900), { timeout: 3000 })
  })

  it('is zero for no error and for any error that is not a rate limit', () => {
    expect(renderHook(() => useRetryCountdown(null)).result.current).toBe(0)
    expect(renderHook(() => useRetryCountdown(new ProviderUsageError('unavailable'))).result.current).toBe(0)
  })

  it('stops at zero', async () => {
    const error = new ProviderUsageError('rate_limited', { retryAtMs: Date.now() + 300 })
    const { result } = renderHook(() => useRetryCountdown(error))
    await waitFor(() => expect(result.current).toBe(0), { timeout: 3000 })
  })
})
