import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionResponse } from '@/api/types'
import { FlatSessionGroups } from '@/components/Sidebar/FlatSessionGroups'
import { queryKeys } from '@/queries/keys'
import { useSidebarViewStore, type SidebarGroupBy } from '@/stores/useSidebarViewStore'

const originalFetch = globalThis.fetch
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function session(id: string, title: string, workspace: string, agoMs: number, extra: Partial<SessionResponse> = {}): SessionResponse {
  const at = new Date(Date.now() - agoMs).toISOString()
  return { id, title, workspace, agent_name: 'code', created_at: at, updated_at: at, ...extra }
}

const handlers = {
  onSessionSelect: () => {},
  onSessionDelete: () => {},
  onSessionEdit: () => {},
  onSessionRename: () => {},
  onSessionRenameCancel: () => {},
  onSessionLongPress: () => {},
  onSessionContextActions: () => {},
}

function setup({
  groupBy,
  all,
  active = [],
  hasMore = false,
  draftWorkspace = null,
}: {
  groupBy: Exclude<SidebarGroupBy, 'project'>
  all: SessionResponse[]
  active?: SessionResponse[]
  hasMore?: boolean
  draftWorkspace?: string | null
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queryKeys.session.sessions.everywhere('activity'), {
    pages: [{ data: all, has_more: hasMore, next_cursor: hasMore ? 'cursor-2' : null }],
    pageParams: [null],
  })
  queryClient.setQueryData(queryKeys.session.sessions.active(), {
    pages: [{ data: active, has_more: false, next_cursor: null }],
    pageParams: [null],
  })
  render(
    <QueryClientProvider client={queryClient}>
      <FlatSessionGroups
        groupBy={groupBy}
        sortBy="activity"
        workspaceName={(path) => (path === '/home/user' ? 'Chat' : path.split('/').pop() ?? path)}
        draftWorkspace={draftWorkspace}
        {...handlers}
      />
    </QueryClientProvider>,
  )
  return queryClient
}

const groupLabels = () => screen.queryAllByRole('region').map((region) => region.getAttribute('aria-label'))

beforeEach(() => {
  useSidebarViewStore.setState({ collapsedGroups: [] })
  globalThis.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('FlatSessionGroups', () => {
  it('groups by status: needs you, working, then the rest', () => {
    const waiting = session('s-wait', 'Migrate auth tokens', '/repo/openagentd', HOUR, { needs_input: true })
    const running = session('s-run', 'Sidebar redesign', '/repo/openagentd', 2 * HOUR, { running: true })
    setup({
      groupBy: 'status',
      all: [waiting, running, session('s-idle', 'Weekly notes', '/home/user', 3 * HOUR)],
      active: [waiting, running],
    })

    expect(groupLabels()).toEqual(['Needs you', 'Working', 'Recent'])
    const recent = screen.getByRole('region', { name: 'Recent' })
    // Active sessions are not repeated under Recent.
    expect(within(recent).queryByText('Sidebar redesign')).toBeNull()
    expect(within(recent).getByText('Weekly notes')).toBeTruthy()
    // Rows name their workspace; the Chat root reads as Chat.
    expect(recent.textContent).toContain('Chat')
  })

  it('groups by date and hides empty groups', () => {
    setup({
      groupBy: 'date',
      all: [
        session('s-today', 'Today work', '/repo/web', 0),
        session('s-old', 'Old work', '/repo/web', 90 * DAY),
      ],
    })

    expect(groupLabels()).toEqual(['Today', 'Older'])
    expect(within(screen.getByRole('region', { name: 'Older' })).getByText('Old work')).toBeTruthy()
  })

  it('lists everything without headers when not grouped', () => {
    setup({
      groupBy: 'none',
      all: [session('s-1', 'First', '/repo/web', 0), session('s-2', 'Second', '/repo/api', DAY)],
    })

    expect(groupLabels()).toEqual([])
    expect(screen.getByText('First')).toBeTruthy()
    expect(screen.getByText('Second')).toBeTruthy()
  })

  it('folds a group and remembers it per view', () => {
    setup({ groupBy: 'date', all: [session('s-today', 'Today work', '/repo/web', 0)] })

    fireEvent.click(screen.getByRole('button', { name: /Today/, expanded: true }))
    expect(screen.queryByText('Today work')).toBeNull()
    expect(useSidebarViewStore.getState().collapsedGroups).toContain('date:today')
  })

  it('shows the open draft on top and one Show more row at the bottom', () => {
    setup({
      groupBy: 'none',
      all: [session('s-1', 'First', '/repo/web', 0)],
      hasMore: true,
      draftWorkspace: '/repo/web',
    })

    const draft = document.querySelector('[data-draft-session]')
    expect(draft?.textContent).toContain('New session')
    expect(draft?.getAttribute('aria-current')).toBe('page')
    expect(screen.getAllByRole('button', { name: 'Show more sessions' })).toHaveLength(1)
  })

  it('says so when there are no sessions', () => {
    setup({ groupBy: 'status', all: [] })
    expect(screen.getByText('No sessions yet.')).toBeTruthy()
  })
})
