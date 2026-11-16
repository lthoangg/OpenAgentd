import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, waitFor } from '@testing-library/react'
import { cleanupSidebarHarness, renderSidebarForSessions, resetSidebarHarness } from './harness'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  it('refreshes the repository tree only when another window changes the saved workspaces', async () => {
    await renderSidebarForSessions(undefined)
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof mock>
    const treeFetches = () => fetchSpy.mock.calls.filter(([input]) => String(input).includes('/api/agent/workspace/tree')).length
    const before = treeFetches()

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'oa.unread-sessions.v1' }))
      await Promise.resolve()
    })
    expect(treeFetches()).toBe(before)

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'oa-coding-workspaces' }))
      await Promise.resolve()
    })
    await waitFor(() => expect(treeFetches()).toBe(before + 1))
  })
})
