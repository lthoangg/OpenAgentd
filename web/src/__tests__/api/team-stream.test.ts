import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  Object.defineProperty(window, '__OAD_API_BASE_URL__', {
    value: 'http://127.0.0.1:4082',
    writable: true,
    configurable: true,
  })
  Object.defineProperty(window, '__OAD_TOKEN__', {
    value: 'secondary-window-token',
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  delete window.__OAD_API_BASE_URL__
  delete window.__OAD_TOKEN__
})

describe('teamStream', () => {
  it('includes desktop authentication in its raw SSE URL', async () => {
    const fetchSpy = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = fetchSpy as typeof fetch
    const { teamStream } = await import('@/api/client/team')

    teamStream('session-1', { onEvent: () => {} })
    await Promise.resolve()

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4082/api/team/session-1/stream?_token=secondary-window-token',
      expect.any(Object),
    )
  })
})
