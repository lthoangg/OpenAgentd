/**
 * App windows tell the desktop shell which session they show, so the notch
 * island can clear a finished session once it has been read.
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

  it('says nothing where there is no island', async () => {
    platform = { isTauri: false, os: 'macos', isMacOverlay: false }
    renderHook(() => useReportShownSession('a'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual([])
  })
})
