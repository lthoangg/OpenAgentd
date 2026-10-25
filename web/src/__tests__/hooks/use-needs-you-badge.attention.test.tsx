/**
 * A session that newly needs you, while the window is in the background,
 * asks the OS for attention once (Dock bounce on macOS, taskbar flash on
 * Windows). Never at launch, never while the window has focus, never when
 * the count only drops.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const setBadgeCount = mock(async (..._args: unknown[]) => {})
const requestUserAttention = mock(async (..._args: unknown[]) => {})
let platform = { isTauri: true, os: 'windows' }
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => platform }))
mock.module('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setBadgeCount, requestUserAttention }),
  UserAttentionType: { Critical: 1, Informational: 2 },
}))

const { useNeedsYouBadge } = await import('@/hooks/use-needs-you-badge')
const { queryKeys } = await import('@/queries')

let focused = false
const originalHasFocus = document.hasFocus.bind(document)
beforeEach(() => {
  platform = { isTauri: true, os: 'windows' }
  focused = false
  document.hasFocus = () => focused
})
afterEach(() => {
  cleanup()
  document.hasFocus = originalHasFocus
  setBadgeCount.mockClear()
  requestUserAttention.mockClear()
})

function activePage(ids: string[]) {
  return {
    pages: [{
      data: ids.map((id) => ({ id, title: id, agent_name: 'lead', created_at: null, updated_at: null, workspace: '/w', running: true, needs_input: true })),
      next_cursor: null,
      has_more: false,
    }],
    pageParams: [null],
  }
}

async function mount(initial: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  client.setQueryData(queryKeys.session.sessions.active(), activePage(initial))
  const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(QueryClientProvider, { client }, children)
  renderHook(() => useNeedsYouBadge(), { wrapper })
  // The native calls go through a dynamic import; let it settle.
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  await settle()
  const set = async (ids: string[]) => {
    act(() => { client.setQueryData(queryKeys.session.sessions.active(), activePage(ids)) })
    await settle()
  }
  return set
}

describe('useNeedsYouBadge attention', () => {
  it('asks once, informationally, when a session newly needs you in the background', async () => {
    const set = await mount(['a'])
    await set(['a', 'b'])
    expect(requestUserAttention.mock.calls).toEqual([[2]])
  })

  it('does not ask for what was already waiting at launch', async () => {
    await mount(['a', 'b'])
    expect(requestUserAttention).not.toHaveBeenCalled()
  })

  it('does not ask while the window has focus', async () => {
    focused = true
    const set = await mount([])
    await set(['a'])
    expect(requestUserAttention).not.toHaveBeenCalled()
  })

  it('does not ask when the count only drops', async () => {
    const set = await mount(['a', 'b'])
    await set(['a'])
    expect(requestUserAttention).not.toHaveBeenCalled()
  })

  it('does not ask in the mobile app', async () => {
    platform = { isTauri: true, os: 'ios' }
    const set = await mount([])
    await set(['a'])
    expect(requestUserAttention).not.toHaveBeenCalled()
  })

  it('still badges the icon with the count', async () => {
    const set = await mount([])
    await set(['a'])
    expect(setBadgeCount.mock.calls.at(-1)).toEqual([1])
  })
})
