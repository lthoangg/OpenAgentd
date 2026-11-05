import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useFakeTimers } from '../fake-timers'
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
  it('groups by status: needs you, running, then the rest', () => {
    const waiting = session('s-wait', 'Migrate auth tokens', '/repo/openagentd', HOUR, { needs_input: true })
    const running = session('s-run', 'Sidebar redesign', '/repo/openagentd', 2 * HOUR, { running: true })
    setup({
      groupBy: 'status',
      all: [waiting, running, session('s-idle', 'Weekly notes', '/home/user', 3 * HOUR)],
      active: [waiting, running],
    })

    expect(groupLabels()).toEqual(['Needs you', 'Running', 'Recent'])
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

    const timers = useFakeTimers()
    try {
      fireEvent.click(screen.getByRole('button', { name: /Today/, expanded: true }))
      // Out of reach at once; gone once the fold has finished closing.
      expect(screen.getByText('Today work').closest('[inert]')).not.toBeNull()
      act(() => timers.tick(300))
      expect(screen.queryByText('Today work')).toBeNull()
    } finally {
      timers.restore()
    }
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
    // The button's accessible name is its visible text; it is busy only while loading
    const showMore = screen.getAllByRole('button', { name: 'Show more' })
    expect(showMore).toHaveLength(1)
    expect(showMore[0].hasAttribute('aria-label')).toBe(false)
    expect(showMore[0].hasAttribute('aria-busy')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Show more sessions' })).toBeNull()
  })

  it('says so when there are no sessions', () => {
    setup({ groupBy: 'status', all: [] })
    expect(screen.getByText('No sessions yet.')).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Loading sessions' })).toBeNull()
  })

  it('heads every group with the one sidebar heading: sentence case, 32px, a visible chevron', () => {
    const waiting = session('s-wait', 'Migrate auth tokens', '/repo/openagentd', HOUR, { needs_input: true })
    const running = session('s-run', 'Sidebar redesign', '/repo/openagentd', 2 * HOUR, { running: true })
    setup({
      groupBy: 'status',
      all: [waiting, running, session('s-idle', 'Weekly notes', '/home/user', 3 * HOUR)],
      active: [waiting, running],
    })

    const headings = Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar-heading]'))
    expect(headings.map((heading) => heading.querySelector('span.truncate')?.textContent)).toEqual(['Needs you', 'Running', 'Recent'])
    for (const heading of headings) {
      // The same classes as the Pinned and Needs you sections' SidebarHeading.
      expect(heading.className).toContain('h-8')
      expect(heading.className).toContain('pointer-coarse:h-(--spacing-list-row)')
      const button = heading.querySelector('button') as HTMLElement
      expect(button.className).toContain('text-xs')
      expect(button.className).toContain('font-medium')
      expect(button.className).toContain('text-(--color-text-muted)')
      expect(button.querySelector('svg')).not.toBeNull()
    }
    // No caps strip, and no 24px header left.
    expect(document.querySelector('.label-caps')).toBeNull()
    expect(document.querySelector('[aria-expanded]')?.className).not.toContain('h-6')
  })

  it('counts a group of sessions waiting on you in words, and the others by number', () => {
    const waiting = session('s-wait', 'Migrate auth tokens', '/repo/openagentd', HOUR, { needs_input: true })
    const running = session('s-run', 'Sidebar redesign', '/repo/openagentd', 2 * HOUR, { running: true })
    setup({ groupBy: 'status', all: [waiting, running], active: [waiting, running] })

    expect(within(screen.getByRole('button', { name: /Needs you/ })).getByText('1 waiting')).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /Running/ })).getByText('1')).toBeTruthy()
  })

  it('keeps the heading sentence case for date groups too', () => {
    setup({ groupBy: 'date', all: [session('s-today', 'Today work', '/repo/web', 0)] })

    const button = screen.getByRole('button', { name: /Today/, expanded: true })
    expect(button.textContent).toBe('Today1')
    expect(button.querySelector('.label-caps')).toBeNull()
  })

  describe('sessions another workspace started', () => {
    const from = { session_id: 's-app', workspace: '/r/app', title: 'Orders API' }
    const infra = session('s-infra', 'Orders table', '/r/infra', HOUR, { running: true, sent_from: from })
    const web = session('s-web', 'Orders page', '/r/web', HOUR, { needs_input: true, sent_from: from })
    const app = session('s-app', 'Orders API', '/r/app', 2 * HOUR, { background_work: true, linked_sessions: [infra, web] })
    /** Titles of the list's own rows (not the ones nested under a sender). */
    const ownRows = (root: ParentNode = document) =>
      Array.from(root.querySelectorAll('[data-session-row]')).map((row) => row.querySelector('[data-sidebar-session]')?.getAttribute('title')?.split(' · ')[0])
    const expandLinked = () => fireEvent.click(screen.getByRole('button', { name: 'Expand 2 sessions in other workspaces' }))
    const nested = () => Array.from(document.querySelectorAll('[data-linked-session]')).map((row) => row.getAttribute('data-linked-session'))

    for (const groupBy of ['date', 'none'] as const) {
      it(`list once, under their sender (${groupBy})`, () => {
        setup({ groupBy, all: [infra, app, web] })
        expect(ownRows()).toEqual(['Orders API'])
        expandLinked()
        expect(nested()).toEqual(['s-infra', 's-web'])
      })
    }

    it('list once by status too, and a question still shows under Needs you', () => {
      setup({ groupBy: 'status', all: [infra, app, web], active: [infra, app, web] })
      // Orders table runs, but only under its sender: no Running group of its own.
      expect(groupLabels()).toEqual(['Needs you', 'Recent'])
      expect(ownRows(screen.getByRole('region', { name: 'Needs you' }))).toEqual(['Orders page'])
      expect(ownRows(screen.getByRole('region', { name: 'Recent' }))).toEqual(['Orders API'])
      expandLinked()
      expect(nested()).toEqual(['s-infra', 's-web'])
    })

    it('keep their own row, marked with the sender, when the sender is not listed', () => {
      setup({ groupBy: 'none', all: [infra] })
      expect(ownRows()).toEqual(['Orders table'])
      expect(document.querySelector('[data-sent-from="s-app"]')?.textContent).toBe('app')
    })
  })
})
