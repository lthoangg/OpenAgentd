/**
 * Session rows offer Pin and a More button on hover; More opens the same
 * actions as right-click (Pin, Edit title, Delete), so the row carries no
 * one-click delete. Subagent rows offer More too.
 *
 * A row that is running, waiting on you or unread names that state in words
 * (Running, Needs you, Done) in its meta slot in place of its age; the mark
 * beside the title is only the secondary cue.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionResponse } from '@/api/types'
import { useUnreadStore } from '@/stores/useUnreadStore'

mock.module('@/queries/useSessionsQuery', () => ({
  useSessionSubagentsQuery: () => ({ data: undefined }),
}))

const { SessionRow } = await import('@/components/Sidebar/SessionRow')
const { SessionStateWord } = await import('@/components/Sidebar/SessionStatusMark')

beforeEach(() => {
  useUnreadStore.setState({ ids: [], failed: [] })
})

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

function row(
  onContext: (session: SessionResponse, at: { clientX: number; clientY: number }) => void,
  session: SessionResponse = lead,
  props: Partial<ComponentProps<typeof SessionRow>> = {},
) {
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
      {...props}
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

describe('SessionRow state words', () => {
  // No subagents: the lead fixture's running child would make every row Running.
  const idle: SessionResponse = {
    ...lead,
    subagents: undefined,
    last_message_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  }
  const word = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-session-state]')

  it('says Running in place of the age, and keeps the mark and its label', () => {
    const { container } = render(row(() => {}, { ...idle, running: true }))

    expect(word(container)?.textContent).toBe('Running')
    expect(word(container)?.getAttribute('data-session-state')).toBe('running')
    expect(word(container)?.className).toContain('text-(--color-text-muted)')
    expect(screen.getByRole('img', { name: 'Session running' })).toBeTruthy()
    expect(screen.queryByText('3h')).toBeNull()
  })

  it('says Running for a lead whose subagents still work', () => {
    const { container } = render(row(() => {}))

    expect(word(container)?.textContent).toBe('Running')
  })

  it('says Needs you in orange, ahead of Running, and keeps its label', () => {
    const { container } = render(row(() => {}, { ...idle, running: true, needs_input: true }))

    expect(word(container)?.textContent).toBe('Needs you')
    expect(word(container)?.className).toContain('text-(--accent-orange-text)')
    expect(screen.getByRole('img', { name: 'Session needs your input' })).toBeTruthy()
    expect(screen.queryByText('3h')).toBeNull()
  })

  it('says Done for a finished session you have not opened, until it is read', () => {
    useUnreadStore.setState({ ids: [idle.id] })
    const { container } = render(row(() => {}, idle))

    expect(word(container)?.textContent).toBe('Done')
    expect(word(container)?.className).toContain('text-(--color-text-muted)')
    expect(screen.getByRole('img', { name: 'Unread session' })).toBeTruthy()
    expect(screen.queryByText('3h')).toBeNull()

    act(() => useUnreadStore.setState({ ids: [] }))
    expect(word(container)).toBeNull()
    expect(screen.getByText('3h')).toBeTruthy()
  })

  it('keeps the age on an idle row and adds no word or mark', () => {
    const { container } = render(row(() => {}, idle))

    expect(word(container)).toBeNull()
    expect(screen.getByText('3h')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('says Failed in the error tone', () => {
    const { container } = render(<SessionStateWord status="failed" />)

    expect(word(container)?.textContent).toBe('Failed')
    expect(word(container)?.className).toContain('text-(--color-error)')
  })

  it('says Failed on the row when its unread turn ended in an error', () => {
    useUnreadStore.setState({ ids: [idle.id], failed: [idle.id] })
    const { container } = render(row(() => {}, idle))

    expect(word(container)?.textContent).toBe('Failed')
    expect(screen.queryByText('3h')).toBeNull()
  })

  it('says nothing for an idle status', () => {
    const { container } = render(<SessionStateWord status="idle" />)

    expect(container.innerHTML).toBe('')
  })

  it('stays on one line: the word never shrinks or wraps, so the title gives way', () => {
    const { container } = render(row(() => {}, { ...idle, running: true }))

    expect(word(container)?.className).toContain('shrink-0')
    expect(word(container)?.className).toContain('whitespace-nowrap')
    // The mark's label is what assistive technology reads.
    expect(word(container)?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('[data-session-row]')?.className).toContain('h-(--spacing-list-row)')
  })

  it('keeps the word when Show details is off, since it is the state and not a detail', () => {
    const { container } = render(row(() => {}, { ...idle, running: true }, { showDetails: false }))

    expect(word(container)?.textContent).toBe('Running')
    expect(word(container)?.className.split(/\s+/)).not.toContain('hidden')

    cleanup()
    render(row(() => {}, idle, { showDetails: false }))
    expect(screen.getByText('3h').className.split(/\s+/)).toContain('hidden')
  })

  it('gives way to the row actions on hover and focus, and stays on touch', () => {
    const { container } = render(row(() => {}, { ...idle, running: true }))
    const classes = (word(container)?.className ?? '').split(/\s+/)

    expect(classes).toContain('group-hover/row:hidden')
    expect(classes).toContain('group-focus-within/row:hidden')
    expect(classes).not.toContain('pointer-coarse:hidden')
  })

  it('shows no word while the title is being edited', () => {
    const { container } = render(row(() => {}, { ...idle, running: true }, { isEditing: true }))

    expect(word(container)).toBeNull()
  })
})
