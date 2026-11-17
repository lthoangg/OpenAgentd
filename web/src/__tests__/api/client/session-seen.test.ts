/**
 * reportSessionSeen: tells the server a session is on screen so its
 * notification stays off the phone; at most once per session every 10 s.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { reportSessionSeen, resetSessionSeenReports, SEEN_REPORT_GAP_MS } from '@/api/client/session-seen'

const originalFetch = globalThis.fetch

describe('reportSessionSeen', () => {
  let calls: Array<[string, string | undefined]>
  let fail = false
  let clock = 1_000_000
  let now: { mockRestore: () => void }
  beforeEach(() => {
    resetSessionSeenReports()
    calls = []
    fail = false
    clock = 1_000_000
    now = spyOn(Date, 'now').mockImplementation(() => clock)
    globalThis.fetch = mock(async (url: unknown, init: unknown) => {
      calls.push([String(url).replace(/^.*\/agent\//, ''), (init as RequestInit | undefined)?.method])
      if (fail) throw new TypeError('offline')
      return new Response('{"status":"ok"}')
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    now.mockRestore()
  })

  it('posts once per session in the gap, then again after it', () => {
    reportSessionSeen('s1')
    reportSessionSeen('s1')
    reportSessionSeen('s2')
    expect(calls).toEqual([['s1/seen', 'POST'], ['s2/seen', 'POST']])
    clock += SEEN_REPORT_GAP_MS
    reportSessionSeen('s1')
    expect(calls).toHaveLength(3)
  })

  it('reports a notification about the session at once, even inside the gap', () => {
    reportSessionSeen('s1')
    clock += 3000
    reportSessionSeen('s1', { now: true })
    expect(calls).toEqual([['s1/seen', 'POST'], ['s1/seen', 'POST']])
  })

  it('never throws when the server is old or unreachable', async () => {
    fail = true
    expect(() => reportSessionSeen('s3')).not.toThrow()
    await Promise.resolve()
    expect(calls).toEqual([['s3/seen', 'POST']])
  })
})
