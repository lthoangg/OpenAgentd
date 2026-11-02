/**
 * App windows tell the desktop shell which session they show, so the notch
 * island can clear a finished session once it has been read, and so the
 * session → window router can bring forward the window that already shows a
 * session instead of opening it twice.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, renderHook, waitFor } from '@testing-library/react'

let platform = { isTauri: true, os: 'macos', isMacOverlay: false }
let calls: [string, unknown][] = []

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => platform,
  getPlatform: () => platform,
}))
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.push([cmd, args])
  },
}))

const { useReportShownSession } = await import('@/lib/island-setting')

beforeEach(() => {
  platform = { isTauri: true, os: 'macos', isMacOverlay: false }
  calls = []
})
afterEach(cleanup)

describe('useReportShownSession', () => {
  it('reports the session on screen whenever it changes', async () => {
    const { rerender } = renderHook(({ id }: { id: string | null }) => useReportShownSession(id), {
      initialProps: { id: 'a' as string | null },
    })
    rerender({ id: 'b' })
    rerender({ id: null })
    await waitFor(() => expect(calls).toEqual([
      ['island_viewing', { sessionId: 'a' }],
      ['island_viewing', { sessionId: 'b' }],
      ['island_viewing', { sessionId: null }],
    ]))
  })

  // The router needs every window's session, on every desktop OS; only the
  // notch is macOS-only. It used to report only where the island exists.
  it('reports on Windows and Linux too, where there is no island', async () => {
    for (const os of ['windows', 'linux']) {
      platform = { isTauri: true, os, isMacOverlay: false }
      calls = []
      const { unmount } = renderHook(() => useReportShownSession('a'))
      await waitFor(() => expect(calls).toEqual([['island_viewing', { sessionId: 'a' }]]))
      unmount()
    }
  })

  it('says nothing outside the desktop app', async () => {
    platform = { isTauri: false, os: 'macos', isMacOverlay: false }
    renderHook(() => useReportShownSession('a'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual([])

    platform = { isTauri: true, os: 'ios', isMacOverlay: false }
    renderHook(() => useReportShownSession('a'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual([])
  })
})
