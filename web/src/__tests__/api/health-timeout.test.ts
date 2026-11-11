/**
 * `health()` gives up on a server that never answers (an account bridge whose
 * relay link is down answers 503 `link_down`; a hung one answers nothing), so
 * the health query fails and the "Can't reach … · Retrying…" banner shows.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { ApiValidationError } from '@/api/client/_shared'
import { HEALTH_TIMEOUT_MS, health, healthWithin } from '@/api/client/misc'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** A fetch that never answers, and rejects like the platform when its signal aborts. */
function hangingFetch() {
  return mock((...args: unknown[]) => new Promise<Response>((_resolve, reject) => {
    ;(args[1] as RequestInit | undefined)?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
  })) as unknown as typeof fetch
}

describe('health', () => {
  it('waits about five seconds', () => {
    expect(HEALTH_TIMEOUT_MS).toBe(5_000)
  })

  it('fails once its timeout passes without an answer', async () => {
    globalThis.fetch = hangingFetch()
    const started = Date.now()
    await expect(healthWithin(30)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('passes an abort signal to the request', async () => {
    const fetchMock = mock(async (..._args: unknown[]) => Response.json({ status: 'ok', version: '3.0.0' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(health()).resolves.toEqual({ status: 'ok', version: '3.0.0' })
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal?.aborted).toBe(false)
  })

  it('fails on the bridge answering 503 link_down, with its detail', async () => {
    globalThis.fetch = mock(async () => Response.json({ detail: 'The link to this computer is down.', error: 'link_down' }, { status: 503 })) as unknown as typeof fetch
    const error = await health().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiValidationError)
    expect((error as ApiValidationError).status).toBe(503)
    expect((error as ApiValidationError).message).toBe('The link to this computer is down.')
  })
})
