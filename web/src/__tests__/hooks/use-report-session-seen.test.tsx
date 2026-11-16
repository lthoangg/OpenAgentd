/**
 * useReportSessionSeen: the session on screen is reported seen when it
 * opens and when its window comes back into focus, never while unfocused.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'

import { resetSessionSeenReports } from '@/api/client/session-seen'
import { useReportSessionSeen } from '@/hooks/use-report-session-seen'

const originalFetch = globalThis.fetch

afterEach(cleanup)

describe('useReportSessionSeen', () => {
  let reported: string[]
  let focused = true
  let focus: { mockRestore: () => void }
  beforeEach(() => {
    resetSessionSeenReports()
    reported = []
    focused = true
    focus = spyOn(document, 'hasFocus').mockImplementation(() => focused)
    globalThis.fetch = mock(async (url: unknown) => {
      reported.push(String(url).replace(/^.*\/agent\//, ''))
      return new Response('{}')
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    focus.mockRestore()
  })

  it('reports the session when it opens in a focused window', () => {
    renderHook(() => useReportSessionSeen('s1'))
    expect(reported).toEqual(['s1/seen'])
  })

  it('waits for focus when the window is in the background', () => {
    focused = false
    renderHook(() => useReportSessionSeen('s2'))
    expect(reported).toEqual([])
    focused = true
    window.dispatchEvent(new Event('focus'))
    expect(reported).toEqual(['s2/seen'])
  })

  it('reports nothing without a session, and stops listening on unmount', () => {
    const { unmount } = renderHook(() => useReportSessionSeen(null))
    window.dispatchEvent(new Event('focus'))
    expect(reported).toEqual([])
    renderHook(() => useReportSessionSeen('s3')).unmount()
    unmount()
    resetSessionSeenReports()
    window.dispatchEvent(new Event('focus'))
    expect(reported).toEqual(['s3/seen'])
  })
})
