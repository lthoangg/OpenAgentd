import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
/**
 * Sidebar re-renders often (agent status, queries, routing) and passes
 * inline callbacks. Session rows are memoized behind stable handlers, so a
 * parent re-render with unchanged sessions does not re-run every row.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionResponse } from '@/api/types'

const sessions: SessionResponse[] = ['a', 'b', 'c'].map((id) => ({
  id,
  title: `Session ${id}`,
  workspace: '/repo',
  interaction_mode: 'code',
  created_at: '2026-09-01T10:00:00Z',
  updated_at: null,
  agent_name: 'code',
}))
const listResult = {
  data: { pages: [{ data: sessions, has_more: false, next_cursor: null }] },
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: () => {},
  isLoading: false,
}
let rowRenders = 0
mock.module('@/queries/useSessionsQuery', () => ({
  useWorkspaceSessionsQuery: () => listResult,
  useSessionSubagentsQuery: () => {
    rowRenders += 1
    return { data: undefined }
  },
}))

const { WorkspaceSessionList } = await import('@/components/Sidebar/WorkspaceSessionList')

afterEach(() => {
  cleanup()
  rowRenders = 0
})

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function list(currentSessionId: string, onEdit: (session: SessionResponse) => void) {
  return (
    <QueryClientProvider client={queryClient}>
    <WorkspaceSessionList
      path="/repo"
      currentSessionId={currentSessionId}
      onSessionSelect={() => {}}
      onSessionDelete={() => {}}
      onSessionEdit={onEdit}
      onSessionLongPress={() => {}}
      onSessionContextActions={() => {}}
    />
    </QueryClientProvider>
  )
}

describe('WorkspaceSessionList row memoization', () => {
  it('skips unchanged rows when the parent re-renders with new inline callbacks', () => {
    const first = mock(() => {})
    const { rerender } = render(list('a', first))
    expect(rowRenders).toBe(3)

    const latest = mock(() => {})
    rerender(list('a', latest))
    expect(rowRenders).toBe(3)

    // Rows still call the latest handler, not the one from their last render.
    fireEvent.doubleClick(screen.getByText('Session b'))
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
  })

  it('re-renders rows when the current session changes', () => {
    const { rerender } = render(list('a', () => {}))
    rerender(list('b', () => {}))
    expect(rowRenders).toBe(6)
  })
})
