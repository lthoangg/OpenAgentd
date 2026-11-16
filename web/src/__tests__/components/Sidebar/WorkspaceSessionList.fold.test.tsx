/**
 * Collapsing a workspace whose session is working folds its idle rows away
 * around the working one (each row's own fold), and expanding unfolds them;
 * it no longer holds the list, then swaps it for the working rows at once.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorkspaceSessionList } from '@/components/Sidebar/WorkspaceSessionList'
import type { SessionResponse } from '@/api/types'
import { queryKeys } from '@/queries/keys'

afterEach(cleanup)

const session = (id: string, title: string): SessionResponse => ({
  id,
  title,
  workspace: '/w',
  interaction_mode: 'code',
  created_at: new Date().toISOString(),
  updated_at: null,
  agent_name: 'code',
})

const idle = session('idle-1', 'Idle session')
const busy = session('busy-1', 'Working session')

function renderList(collapsed: boolean, client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <WorkspaceSessionList
        path="/w"
        collapsed={collapsed}
        runningSessions={[busy]}
        onSessionSelect={() => {}}
        onSessionDelete={() => {}}
        onSessionEdit={() => {}}
        onSessionLongPress={() => {}}
        onSessionContextActions={() => {}}
      />
    </QueryClientProvider>
  )
}

const foldOf = (text: string) => screen.getByText(text).closest('[data-slot="collapsible"]')

describe('WorkspaceSessionList — folding around a working session', () => {
  it('folds the idle rows and keeps the working one open, then unfolds them again', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(queryKeys.session.sessions.workspace('/w', 'activity'), {
      pages: [{ data: [idle, busy], has_more: false, next_cursor: null }],
      pageParams: [null],
    })
    const { rerender } = render(renderList(false, client))
    expect(foldOf('Idle session')?.getAttribute('data-state')).toBe('open')

    rerender(renderList(true, client))
    // Still on screen while it folds closed, not swapped out.
    expect(foldOf('Idle session')?.getAttribute('data-state')).toBe('closed')
    expect(foldOf('Working session')?.getAttribute('data-state')).toBe('open')

    rerender(renderList(false, client))
    expect(foldOf('Idle session')?.getAttribute('data-state')).toBe('open')
  })

  it('lists only the working session when the list was never loaded', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
    render(renderList(true, client))
    expect(screen.getByText('Working session')).toBeTruthy()
    expect(screen.queryByText('Idle session')).toBeNull()
  })
})
