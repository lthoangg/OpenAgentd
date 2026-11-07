import { afterEach, describe, expect, it, mock } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'

const health = mock(() => new Promise<never>(() => {}))
mock.module('@/api/client', () => ({ health }))

import { useHealthQuery } from '@/queries/useHealthQuery'

afterEach(() => {
  cleanup()
  onlineManager.setOnline(true)
  health.mockClear()
})

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: new QueryClient() }, children)
}

describe('useHealthQuery', () => {
  // React Query pauses queries while the device is offline. A paused health
  // check never fails, so the dot stayed green and the offline banner never
  // came. The health check is the one query whose job is to fail then.
  it('still checks the server while the device is offline', async () => {
    onlineManager.setOnline(false)
    const { result } = renderHook(() => useHealthQuery(), { wrapper })
    await waitFor(() => expect(health).toHaveBeenCalledTimes(1))
    expect(result.current.fetchStatus).toBe('fetching')
  })
})
