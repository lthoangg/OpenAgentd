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

  it('allows collapsing and expanding subagents via the chevron button', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const parentSession: SessionResponse = {
      id: 'parent-collapse-test',
      title: 'Refactor parser',
      workspace: '/test/workspace',
      interaction_mode: 'code',
      created_at: new Date().toISOString(),
      updated_at: null,
      agent_name: 'code',
    }

    queryClient.setQueryData(
      queryKeys.session.sessions.workspace('/test/workspace'),
      {
        pages: [{ data: [parentSession], has_more: false, next_cursor: null }],
        pageParams: [null],
      }
    )

    queryClient.setQueryData(
      queryKeys.session.subagents('parent-collapse-test'),
      {
        available_profiles: [{ name: 'explorer' }],
        live_members: [
          {
            session_id: 'sub-789',
            member_id: 'explorer#1',
            profile: 'explorer',
            title: 'explorer#1: Trace AST nodes',
            status: 'completed',
            created_at: new Date().toISOString(),
            has_pending_question: false,
          },
        ],
      }
    )

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSessionList
          path="/test/workspace"
          currentSessionId="parent-collapse-test"
          onSessionSelect={() => {}}
          onSessionDelete={() => {}}
          onSessionEdit={() => {}}
          onSessionLongPress={() => {}}
          onSessionContextActions={() => {}}
        />
      </QueryClientProvider>
    )

    // Initially expanded because it is currentSessionId
    expect(screen.getByText('Trace AST nodes')).toBeTruthy()
    const toggleBtn = screen.getByLabelText('Collapse 1 subagents')
    expect(toggleBtn).toBeTruthy()

    // Collapse
    fireEvent.click(toggleBtn)
    expect(screen.queryByText('Trace AST nodes')).toBeNull()
    expect(screen.getByLabelText('Expand 1 subagents')).toBeTruthy()

    // Expand again
    fireEvent.click(screen.getByLabelText('Expand 1 subagents'))
    expect(screen.getByText('Trace AST nodes')).toBeTruthy()
  })

  it('triggers onSessionDelete when clicking the subagent delete button', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const parentSession: SessionResponse = {
      id: 'parent-del-test',
      title: 'Database migration',
      workspace: '/test/workspace',
      interaction_mode: 'code',
      created_at: new Date().toISOString(),
      updated_at: null,
      agent_name: 'code',
    }

    queryClient.setQueryData(
      queryKeys.session.sessions.workspace('/test/workspace'),
      {
        pages: [{ data: [parentSession], has_more: false, next_cursor: null }],
        pageParams: [null],
      }
    )

    queryClient.setQueryData(
      queryKeys.session.subagents('parent-del-test'),
      {
        available_profiles: [{ name: 'explorer' }],
        live_members: [
          {
            session_id: 'sub-del-1',
            member_id: 'explorer#1',
            profile: 'explorer',
            title: 'explorer#1: Check schema',
            status: 'completed',
            created_at: new Date().toISOString(),
            has_pending_question: false,
          },
        ],
      }
    )

    const handleDelete = mock(() => {})

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSessionList
          path="/test/workspace"
          currentSessionId="parent-del-test"
          onSessionSelect={() => {}}
          onSessionDelete={handleDelete}
          onSessionEdit={() => {}}
          onSessionLongPress={() => {}}
          onSessionContextActions={() => {}}
        />
      </QueryClientProvider>
    )

    const subDeleteBtn = screen.getByLabelText('Delete subagent session explorer#1')
    expect(subDeleteBtn).toBeTruthy()
    fireEvent.click(subDeleteBtn)
    expect(handleDelete).toHaveBeenCalledTimes(1)
    const deletedArg = handleDelete.mock.calls[0][1] as SessionResponse
    expect(deletedArg.id).toBe('sub-del-1')
    expect(deletedArg.parent_session_id).toBe('parent-del-test')
  })
})
