import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useFakeTimers } from '../fake-timers'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionResponse } from '@/api/types'
import { PinnedSection } from '@/components/Sidebar/PinnedSection'
import { queryKeys } from '@/queries/keys'
import { useSetSessionPinnedMutation } from '@/queries/useSessionsQuery'
import { useSidebarViewStore } from '@/stores/useSidebarViewStore'

const originalFetch = globalThis.fetch

const pinned = (id: string, title: string, workspace: string): SessionResponse => ({
  id,
  title,
  workspace,
  agent_name: 'code',
  created_at: '2026-10-18T09:00:00Z',
  updated_at: '2026-10-18T09:00:00Z',
  pinned_at: '2026-10-18T10:00:00Z',
})

function seed(queryClient: QueryClient, sessions: SessionResponse[]) {
  queryClient.setQueryData(queryKeys.session.sessions.pinned(), {
    pages: [{ data: sessions, has_more: false, next_cursor: null }],
    pageParams: [null],
  })
}

const handlers = {
  onSessionSelect: mock(() => {}),
  onSessionDelete: () => {},
  onSessionEdit: () => {},
  onSessionRename: () => {},
  onSessionRenameCancel: () => {},
  onSessionLongPress: () => {},
  onSessionContextActions: () => {},
}

function UnpinButton({ id }: { id: string }) {
  const mutation = useSetSessionPinnedMutation()
  return <button type="button" onClick={() => mutation.mutate({ id, pinned: false })}>unpin {id}</button>
}

function renderSection(queryClient: QueryClient, extra?: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <PinnedSection currentSessionId="pin-1" workspaceName={(path) => path.split('/').pop() ?? path} {...handlers} />
      {extra}
    </QueryClientProvider>,
  )
}

function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
}

beforeEach(() => {
  useSidebarViewStore.setState({ pinnedCollapsed: false })
  handlers.onSessionSelect.mockClear()
  // PATCH never settles here, so the optimistic state is what the test sees.
  globalThis.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('PinnedSection', () => {
  it('is not rendered when nothing is pinned', () => {
    const queryClient = newQueryClient()
    seed(queryClient, [])
    renderSection(queryClient)
    expect(screen.queryByRole('region', { name: 'Pinned' })).toBeNull()
  })

  it('lists pinned sessions with their workspace and selects one on click', () => {
    const queryClient = newQueryClient()
    seed(queryClient, [pinned('pin-1', 'Review PR', '/repo/web'), pinned('pin-2', 'Release checklist', '/repo/openagentd')])
    renderSection(queryClient)

    const section = screen.getByRole('region', { name: 'Pinned' })
    expect(section.textContent).toContain('Review PR')
    expect(section.textContent).toContain('web')
    expect(section.textContent).toContain('openagentd')
    expect(section.textContent).toContain('2')
    expect(screen.getByRole('button', { name: /^Review PR/, current: 'page' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Release checklist.*pinned$/ }))
    expect(handlers.onSessionSelect).toHaveBeenCalledTimes(1)
  })

  it('folds and remembers it', () => {
    const queryClient = newQueryClient()
    seed(queryClient, [pinned('pin-1', 'Review PR', '/repo/web')])
    renderSection(queryClient)

    const timers = useFakeTimers()
    try {
      const toggle = screen.getByRole('button', { name: /Pinned/, expanded: true })
      fireEvent.click(toggle)
      // Out of reach at once; gone once the fold has finished closing.
      expect(screen.getByText('Review PR').closest('[inert]')).not.toBeNull()
      act(() => timers.tick(300))
      expect(screen.queryByText('Review PR')).toBeNull()
    } finally {
      timers.restore()
    }
    expect(useSidebarViewStore.getState().pinnedCollapsed).toBe(true)
  })

  it('drops a row as soon as it is unpinned', async () => {
    const queryClient = newQueryClient()
    seed(queryClient, [pinned('pin-1', 'Review PR', '/repo/web'), pinned('pin-2', 'Release checklist', '/repo/openagentd')])
    renderSection(queryClient, <UnpinButton id="pin-2" />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'unpin pin-2' }))
      await Promise.resolve()
    })
    expect(await screen.findByText('Review PR')).toBeTruthy()
    expect(screen.queryByText('Release checklist')).toBeNull()
  })
})
