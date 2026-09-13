import { describe, it, expect, mock, afterEach } from 'bun:test'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorkspaceSessionList } from '@/components/CodingSidebar/WorkspaceSessionList'
import type { SessionResponse } from '@/api/types'
import { queryKeys } from '@/queries/keys'

afterEach(cleanup)

describe('WorkspaceSessionList — subagent sessions', () => {
  it('renders subagent sessions directly indented under parent session and selects them on click', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const parentSession: SessionResponse = {
      id: 'parent-123',
      title: 'Implement feature X',
      workspace: '/test/workspace',
      interaction_mode: 'code',
      created_at: new Date().toISOString(),
      updated_at: null,
      agent_name: 'code',
    }

    // Pre-populate queries
    queryClient.setQueryData(
      queryKeys.session.sessions.workspace('/test/workspace'),
      {
        pages: [{ data: [parentSession], has_more: false, next_cursor: null }],
        pageParams: [null],
      }
    )

    queryClient.setQueryData(
      queryKeys.session.subagents('parent-123'),
      {
        available_profiles: [{ name: 'explorer' }],
        live_members: [
          {
            session_id: 'sub-456',
            member_id: 'explorer#1',
            profile: 'explorer',
            title: 'explorer#1: Audit authentication routes',
            status: 'completed',
            created_at: new Date().toISOString(),
            has_pending_question: false,
          },
        ],
      }
    )

    const handleSelect = mock(() => {})

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSessionList
          path="/test/workspace"
          currentSessionId="parent-123"
          onSessionSelect={handleSelect}
          onSessionDelete={() => {}}
          onSessionEdit={() => {}}
          onSessionLongPress={() => {}}
          onSessionContextActions={() => {}}
        />
      </QueryClientProvider>
    )

    // Both parent and subagent handle should be visible
    expect(screen.getByText('Implement feature X')).toBeTruthy()
    expect(screen.getByText('explorer#1')).toBeTruthy()
    expect(screen.getByText('Audit authentication routes')).toBeTruthy()

    // Click subagent
    fireEvent.click(screen.getByText('explorer#1'))
    expect(handleSelect).toHaveBeenCalledTimes(1)
    const selectedArg = handleSelect.mock.calls[0][0] as SessionResponse
    expect(selectedArg.id).toBe('sub-456')
    expect(selectedArg.parent_session_id).toBe('parent-123')
    expect(selectedArg.title).toBe('explorer#1: Audit authentication routes')
  })
})
