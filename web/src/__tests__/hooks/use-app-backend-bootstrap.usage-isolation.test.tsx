import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

mock.module('@/lib/connected-app-preload', () => ({ preloadConnectedApp: () => undefined }))
mock.module('@/lib/app-backend', () => ({
  getAppBackendStatus: async () => null,
  switchToBundledAppBackend: async () => undefined,
}))

const { setApiBaseUrl } = await import('@/api/base-url')
const { useAppBackendBootstrap } = await import('@/hooks/use-app-backend-bootstrap')
const { queryClient } = await import('@/lib/query-client')
const { queryKeys } = await import('@/queries/keys')
const { activeBlock, holdBlock } = await import('@/queries/providerUsageCache')
const { ProviderUsageError } = await import('@/lib/provider-usage')

afterEach(() => {
  cleanup()
  setApiBaseUrl('/api')
})

describe('switching backend', () => {
  it('forgets usage blocks, so the same credential id on another server starts clean', () => {
    const key = queryKeys.settings.providerUsage('codex', 'cred_a')
    holdBlock(queryClient, key, new ProviderUsageError('credentials'))
    holdBlock(queryClient, queryKeys.settings.providerUsage('codex'), new ProviderUsageError('rate_limited', { retryAtMs: Date.now() + 600_000 }))
    expect(activeBlock(queryClient, key)).not.toBeNull()

    renderHook(() => useAppBackendBootstrap())
    act(() => {
      setApiBaseUrl('http://other-server.test/api')
    })

    expect(activeBlock(queryClient, key)).toBeNull()
    expect(activeBlock(queryClient, queryKeys.settings.providerUsage('codex'))).toBeNull()
  })
})
