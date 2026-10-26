/**
 * Session rows offer Pin and a More button on hover; More opens the same
 * actions as right-click (Pin, Edit title, Delete), so the row carries no
 * one-click delete. Subagent rows offer More too.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionResponse } from '@/api/types'

mock.module('@/queries/useSessionsQuery', () => ({
  useSessionSubagentsQuery: () => ({ data: undefined }),
}))

const { SessionRow } = await import('@/components/Sidebar/SessionRow')

afterEach(cleanup)

const lead: SessionResponse = {
  id: 'lead',
  title: 'Refactor sidebar rows',
  workspace: '/repo',
  interaction_mode: 'code',
  created_at: '2026-09-01T10:00:00Z',
  updated_at: null,
  agent_name: 'code',
  subagents: [{
    id: 'child',
    parent_session_id: 'lead',
    title: 'explorer#1: List the top-level files and directories in the workspace root',
    workspace: '/repo',
    interaction_mode: 'code',
    created_at: null,
    updated_at: null,
    agent_name: 'explorer#1',
    running: true,
  }],
}

function row(onContext: (session: SessionResponse, at: { clientX: number; clientY: number }) => void, session: SessionResponse = lead) {
  return (
    <SessionRow
      session={session}
      isCurrent
      isEditing={false}
      currentSessionId="lead"
      path="/repo"
      checkoutName={null}
      mobileLongPressActions={false}
      onSessionSelect={() => {}}
      onSessionDelete={() => {}}
      onSessionEdit={() => {}}
      onSessionRename={() => {}}
      onSessionRenameCancel={() => {}}
      onSessionLongPress={() => {}}
      onSessionContextActions={onContext}
      onSessionPinToggle={() => {}}
    />
  )
}

describe('SessionRow actions', () => {
  it('offers Pin and More, and More opens the row actions', () => {
    const onContext = mock(() => {})
    render(row(onContext))

    expect(screen.getByLabelText('Pin session Refactor sidebar rows')).toBeTruthy()
    expect(screen.queryByLabelText('Edit session Refactor sidebar rows')).toBeNull()
    expect(screen.queryByLabelText('Delete session Refactor sidebar rows')).toBeNull()

    fireEvent.click(screen.getByLabelText('More actions for Refactor sidebar rows'))
    expect(onContext).toHaveBeenCalledTimes(1)
    const [session] = onContext.mock.calls[0] as unknown as [SessionResponse]
    expect(session.id).toBe('lead')
  })

  it('offers More on a subagent row instead of a delete button', () => {
    const onContext = mock(() => {})
    render(row(onContext))

    expect(screen.queryByLabelText('Delete subagent session explorer#1')).toBeNull()
    fireEvent.click(screen.getByLabelText('Expand 1 subagents'))
    fireEvent.click(screen.getByLabelText('More actions for subagent explorer#1'))
    const [session] = onContext.mock.calls[0] as unknown as [SessionResponse]
    expect(session).toMatchObject({ id: 'child', parent_session_id: 'lead' })
  })
})

describe('SessionRow goal mark', () => {
  it('marks a session working toward a goal, and one whose goal is paused', () => {
    const { container, rerender } = render(row(() => {}, { ...lead, goal_status: 'active' }))
    expect(container.querySelector('[data-goal-status]')?.getAttribute('title')).toBe('Working toward a goal')
    expect(screen.getByText(/goal active/)).toBeTruthy()

    rerender(row(() => {}, { ...lead, goal_status: 'paused' }))
    expect(container.querySelector('[data-goal-status]')?.getAttribute('title')).toBe('Goal paused')

    rerender(row(() => {}, { ...lead, goal_status: null }))
    expect(container.querySelector('[data-goal-status]')).toBeNull()
  })
})
