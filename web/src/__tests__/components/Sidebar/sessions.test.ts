import { describe, expect, it, mock } from 'bun:test'
import {
  applySessionDelete,
  applySessionSelection,
  getFallbackSessionAfterDelete,
} from '@/components/Sidebar/sessions'

describe('Sidebar helpers', () => {
  it('exports session helpers used by the component', () => {
    const session = {
      id: 'session-1',
      title: 'Session one',
      agent_name: 'lead',
      created_at: '2026-05-13T00:00:00Z',
      updated_at: '2026-05-13T00:00:00Z',
      mode: 'coding',
      workspace: '/repo/project',
    }
    const fallback = getFallbackSessionAfterDelete(
      session,
      'session-1',
      [
        session,
        {
          id: 'session-2',
          title: 'Session two',
          agent_name: 'lead',
          created_at: '2026-05-12T00:00:00Z',
          updated_at: '2026-05-12T00:00:00Z',
          mode: 'coding',
          workspace: '/repo/project',
        },
      ],
    )
    expect(fallback?.id).toBe('session-2')

    const selectionNavigate = mock(() => {})
    const onMobileClose = mock(() => {})
    applySessionSelection({
      session,
      workspacePath: '/repo/project',
      navigate: selectionNavigate,
      onMobileClose,
    })
    expect(selectionNavigate).toHaveBeenCalledWith({
      to: '/$sessionId',
      params: { sessionId: 'session-1' },
    })
    expect(onMobileClose).toHaveBeenCalled()

    const deleteNavigate = mock(() => {})
    const mutateDelete = mock(() => {})
    applySessionDelete({
      deleteTarget: session,
      currentSessionId: 'session-1',
      workspaceSessions: [
        session,
        {
          id: 'session-2',
          title: 'Session two',
          agent_name: 'lead',
          created_at: '2026-05-12T00:00:00Z',
          updated_at: '2026-05-12T00:00:00Z',
          mode: 'coding',
          workspace: '/repo/project',
        },
      ],
      mutateDelete,
      navigate: deleteNavigate,
    })
    expect(mutateDelete).toHaveBeenCalledWith('session-1')
    expect(deleteNavigate).toHaveBeenCalledWith({
      to: '/$sessionId',
      params: { sessionId: 'session-2' },
      replace: true,
    })
  })
})
