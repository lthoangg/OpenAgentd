/**
 * Session rows offer Pin and a More button on hover; More opens the same
 * actions as right-click (Pin, Edit title, Delete), so the row carries no
 * one-click delete. Subagent rows offer More too.
 *
 * A row that is waiting on you, unread or failed names that state in words
 * (Needs you, Done, Failed) in its meta slot in place of its age; the mark
 * beside the title is only the secondary cue. A running row shows its
 * spinner alone.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionResponse } from '@/api/types'
import { useUnreadStore } from '@/stores/useUnreadStore'
import { formatRelativeDate } from '@/utils/format'
import { useFakeTimers } from '../../fake-timers'

mock.module('@/queries/useSessionsQuery', () => ({
  useSessionSubagentsQuery: () => ({ data: undefined }),
}))

const { DraftSessionRow, SessionRow } = await import('@/components/Sidebar/SessionRow')
const { SessionStateWord } = await import('@/components/Sidebar/SessionStatusMark')
const { TREE_INDENT_PX } = await import('@/components/Sidebar/tree-indent')

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
  // No 🎯 on the row: it sat beside the state and squeezed the title. The
  // goal stays in what assistive tech reads.
  it('draws no goal icon, and still names the goal for assistive tech', () => {
    const { container, rerender } = render(row(() => {}, { ...lead, goal_status: 'active' }))
    expect(container.querySelector('[data-goal-status]')).toBeNull()
    expect(screen.getByText(/goal active/)).toBeTruthy()

    rerender(row(() => {}, { ...lead, goal_status: 'paused' }))
    expect(container.querySelector('[data-goal-status]')).toBeNull()
    expect(screen.getByText(/goal paused/)).toBeTruthy()
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

  // The leading spinner already says it runs: no word beside it, which only
  // squeezed the title and swapped out on hover.
  it('shows only the spinner for a running session: no word, no age', () => {
    const { container } = render(row(() => {}, { ...idle, running: true }))

    expect(word(container)).toBeNull()
    expect(screen.queryByText('Running')).toBeNull()
    expect(screen.getByRole('img', { name: 'Session running' })).toBeTruthy()
    expect(screen.queryByText('3h')).toBeNull()
  })

  it('says no word for a lead whose subagents still work either', () => {
    const { container } = render(row(() => {}))

    expect(word(container)).toBeNull()
    expect(screen.queryByText('Running')).toBeNull()
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
    const { container } = render(row(() => {}, { ...idle, needs_input: true }))

    expect(word(container)?.className).toContain('shrink-0')
    expect(word(container)?.className).toContain('whitespace-nowrap')
    // The mark's label is what assistive technology reads.
    expect(word(container)?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('[data-session-row]')?.className).toContain('h-(--spacing-list-row)')
  })

  it('keeps the word when Show details is off, since it is the state and not a detail', () => {
    const { container } = render(row(() => {}, { ...idle, needs_input: true }, { showDetails: false }))

    expect(word(container)?.textContent).toBe('Needs you')
    expect(word(container)?.className.split(/\s+/)).not.toContain('hidden')

    cleanup()
    render(row(() => {}, idle, { showDetails: false }))
    expect(screen.getByText('3h').className.split(/\s+/)).toContain('hidden')
  })

  it('gives way to the row actions on hover and focus, and stays on touch', () => {
    const { container } = render(row(() => {}, { ...idle, needs_input: true }))
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

describe('SessionRow sessions in other workspaces', () => {
  const linkedSession = (id: string, title: string, workspace: string, extra: Partial<SessionResponse> = {}): SessionResponse => ({
    id,
    title,
    workspace,
    interaction_mode: 'code',
    created_at: '2026-09-01T10:05:00Z',
    updated_at: null,
    agent_name: 'code',
    sent_from: { session_id: 'origin', workspace: '/r/app', title: 'Orders API' },
    ...extra,
  })
  const origin: SessionResponse = {
    id: 'origin',
    title: 'Orders API',
    workspace: '/r/app',
    interaction_mode: 'code',
    created_at: '2026-09-01T10:00:00Z',
    updated_at: null,
    agent_name: 'code',
    linked_sessions: [
      linkedSession('infra-1', 'Orders table', '/r/infra', { running: true }),
      linkedSession('web-1', 'Orders page', '/r/web', { needs_input: true }),
    ],
  }

  it('folds them behind a count pill that shows their state, and lists each with its workspace', () => {
    const timers = useFakeTimers()
    try {
      render(row(() => {}, origin, { isCurrent: false, currentSessionId: 'other' }))
      const toggle = screen.getByRole('button', { name: 'Expand 2 sessions in other workspaces' })
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(toggle.textContent).toContain('2')
      // Folded, the pill still says one of them waits on you.
      expect(screen.getByRole('img', { name: 'A session in another workspace needs you' })).toBeTruthy()
      // Folded rows are not mounted.
      expect(document.querySelector('[data-linked-session]')).toBeNull()

      fireEvent.click(toggle)
      act(() => timers.tick(300))
      const rows = Array.from(document.querySelectorAll('[data-linked-session]'))
      expect(rows.map((r) => r.querySelector('[data-linked-workspace]')?.textContent)).toEqual(['infra', 'web'])
      expect(screen.getByRole('button', { name: 'Orders table, in infra, Running' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Orders page, in web, Needs you' })).toBeTruthy()
      expect(screen.queryByRole('img', { name: 'A session in another workspace needs you' })).toBeNull()
    } finally {
      timers.restore()
    }
  })

  it('opens a nested session in its own workspace', () => {
    const calls: [SessionResponse, string][] = []
    const onSelect = (selected: SessionResponse, path: string) => { calls.push([selected, path]) }
    render(row(() => {}, origin, { isCurrent: false, currentSessionId: 'other', onSessionSelect: onSelect }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand 2 sessions in other workspaces' }))
    fireEvent.click(screen.getByRole('button', { name: 'Orders page, in web, Needs you' }))
    expect(calls).toHaveLength(1)
    expect(calls[0][0].id).toBe('web-1')
    expect(calls[0][1]).toBe('/r/web')
  })

  it('stays open while one of them is the open session', () => {
    render(row(() => {}, origin, { isCurrent: false, currentSessionId: 'infra-1' }))
    const toggle = screen.getByRole('button', { name: 'Collapse 2 sessions in other workspaces' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Orders table, in infra, Running' }).getAttribute('aria-current')).toBe('page')
  })

  it('marks a session another workspace started, and the mark opens the sender', () => {
    const calls: [SessionResponse, string][] = []
    const onSelect = (selected: SessionResponse, path: string) => { calls.push([selected, path]) }
    const started = linkedSession('infra-1', 'Orders table', '/r/infra')
    render(row(() => {}, started, { isCurrent: false, currentSessionId: 'other', path: '/r/infra', onSessionSelect: onSelect }))
    const mark = screen.getByRole('button', { name: 'Open the session that sent this, in app' })
    expect(mark.textContent).toBe('app')
    expect(mark.getAttribute('title')).toBe('Sent from "Orders API" in app')
    fireEvent.click(mark)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toMatchObject({ id: 'origin', workspace: '/r/app' })
    expect(calls[0][1]).toBe('/r/app')
    // The row's own name says it too.
    expect(screen.getByText(', sent from app')).toBeTruthy()
  })

  it('shows no pill or mark on a session with neither', () => {
    render(row(() => {}, { ...origin, linked_sessions: undefined }))
    expect(document.querySelector('[data-linked-toggle]')).toBeNull()
    expect(document.querySelector('[data-sent-from]')).toBeNull()
  })

  // The row menu lists F2 beside Rename and Delete beside Delete session…:
  // the keys must do those things on every row the menu opens from.
  it('renames on F2 and asks to delete on Delete, like the menu beside them says', () => {
    const onEdit = mock(() => {})
    const onDelete = mock(() => {})
    render(row(() => {}, origin, { isCurrent: false, currentSessionId: 'infra-1', onSessionEdit: onEdit, onSessionDelete: onDelete }))
    const linkedRow = screen.getByRole('button', { name: 'Orders table, in infra, Running' })

    fireEvent.keyDown(linkedRow, { key: 'F2' })
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect((onEdit.mock.calls[0] as unknown as [SessionResponse])[0].id).toBe('infra-1')

    fireEvent.keyDown(linkedRow, { key: 'Delete' })
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect((onDelete.mock.calls[0] as unknown as [unknown, SessionResponse])[1].id).toBe('infra-1')
  })
})

describe('SessionRow meta slot', () => {
  const DAY = 24 * 60 * 60 * 1000
  const lastUsed = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
  const created = new Date(Date.now() - 30 * DAY).toISOString()
  const idle: SessionResponse = { ...lead, subagents: undefined, created_at: created, last_message_at: lastUsed }
  const tooltipOf = (container: HTMLElement) => container.querySelector('[data-sidebar-session]')?.getAttribute('title') ?? ''

  it('reads the age and nothing else at rest: the workspace and worktree are in the tooltip', () => {
    const { container } = render(row(() => {}, idle, { checkoutName: 'task-a', contextLabel: 'acme', isCurrent: false }))

    expect(screen.getByText('3h')).toBeTruthy()
    expect(container.querySelector('[data-checkout-tag]')).toBeNull()
    expect(container.querySelector('[data-context-label]')).toBeNull()
    expect(tooltipOf(container)).toContain('acme')
    expect(tooltipOf(container)).toContain('worktree task-a')
    // Assistive tech still hears where it is.
    expect(screen.getByText(', in worktree task-a')).toBeTruthy()
    expect(screen.getByText(', in acme')).toBeTruthy()
  })

  it('reads the state word and nothing else when the session needs you', () => {
    const { container } = render(row(() => {}, { ...idle, needs_input: true }, { checkoutName: 'task-a', contextLabel: 'acme' }))

    expect(container.querySelector('[data-session-state]')?.textContent).toBe('Needs you')
    expect(screen.queryByText('3h')).toBeNull()
    expect(container.querySelector('[data-checkout-tag]')).toBeNull()
    expect(container.querySelector('[data-context-label]')).toBeNull()
    expect(tooltipOf(container)).toContain('Needs you')
  })

  it('puts the last-activity time in the tooltip, the same time the age counts from', () => {
    const { container } = render(row(() => {}, idle))

    const tooltip = tooltipOf(container)
    expect(tooltip).toContain(formatRelativeDate(lastUsed))
    expect(tooltip).not.toContain(formatRelativeDate(created))
    // The age ("3h") counts from that same last use, not from creation.
    expect(screen.getByText('3h')).toBeTruthy()
  })

  it('keeps the place on the row where there is no tooltip: touch with long-press sheets', () => {
    const { container } = render(row(() => {}, idle, { checkoutName: 'task-a', contextLabel: 'acme', mobileLongPressActions: true }))

    expect(container.querySelector('[data-checkout-tag]')?.textContent).toBe('task-a')
    expect(container.querySelector('[data-context-label]')?.textContent).toBe('acme')
  })
})

describe('SessionRow weight and icons', () => {
  const idle: SessionResponse = { ...lead, subagents: undefined }
  const titleOf = () => screen.getByText('Refactor sidebar rows').parentElement as HTMLElement

  it('emphasises the open row with medium weight, and no row is semibold', () => {
    const { container, rerender } = render(row(() => {}, idle, { isCurrent: true }))
    expect(titleOf().className.split(' ')).toContain('font-medium')
    expect(container.innerHTML).not.toContain('font-semibold')

    // A row that is not open is regular: one emphasis per row.
    rerender(row(() => {}, idle, { isCurrent: false }))
    expect(titleOf().className).not.toContain('font-medium')
    expect(container.innerHTML).not.toContain('font-semibold')
  })

  it('draws every glyph at 12px, in the row and in its pin mark', () => {
    const { container } = render(row(() => {}, { ...idle, pinned_at: '2026-09-01T10:00:00Z', running: true }, { isCurrent: false }))
    const sizes = Array.from(container.querySelectorAll('svg')).map((svg) => svg.getAttribute('width'))
    expect(sizes.length).toBeGreaterThan(2)
    expect(new Set(sizes)).toEqual(new Set(['12']))
  })
})

describe('SessionRow count pills and child rows', () => {
  const done = { ...lead.subagents![0], running: false }
  const parent: SessionResponse = {
    ...lead,
    subagents: [done],
    linked_sessions: [{
      id: 'infra-1',
      title: 'Orders table',
      workspace: '/r/infra',
      interaction_mode: 'code',
      created_at: null,
      updated_at: null,
      agent_name: 'code',
    }],
  }

  it('draws the subagent and linked pills in one style: kind icon, count, fold chevron', () => {
    const { container } = render(row(() => {}, parent, { isCurrent: false, currentSessionId: 'other' }))

    const [subagents, linked] = Array.from(container.querySelectorAll<HTMLElement>('[data-count-chip]'))
    expect(subagents.getAttribute('aria-label')).toBe('Expand 1 subagents')
    expect(linked.getAttribute('aria-label')).toBe('Expand 1 session in other workspaces')
    // Same shape, tone and size (muted, 20px mono pill, 36px on touch).
    expect(subagents.className).toBe(linked.className)
    expect(subagents.className).toContain('text-(--color-text-muted)')
    expect(subagents.className).toContain('pointer-coarse:h-9')
    for (const pill of [subagents, linked]) {
      const icons = Array.from(pill.querySelectorAll('svg'))
      expect(icons.map((svg) => svg.getAttribute('width'))).toEqual(['12', '12'])
      expect(pill.querySelector('.lucide-chevron-right')).toBeTruthy()
      expect(pill.textContent).toBe('1')
    }
  })

  it('gives child rows the geometry and text of every other row, with the name as their one emphasis', () => {
    const { container } = render(row(() => {}, parent, { isCurrent: false, currentSessionId: 'other' }))
    fireEvent.click(screen.getByLabelText('Expand 1 subagents'))
    fireEvent.click(screen.getByLabelText('Expand 1 session in other workspaces'))

    const children = [
      container.querySelector('[data-linked-session]') as HTMLElement,
      screen.getByLabelText('More actions for subagent explorer#1').parentElement as HTMLElement,
    ]
    for (const child of children) {
      // 28px (36px on touch) from the row token, like the session row above.
      expect(child.className).toContain('h-(--spacing-list-row)')
      expect(child.className).not.toContain('h-6 ')
      const button = child.querySelector('[data-sidebar-session]') as HTMLElement
      expect(button.className).toContain('h-(--spacing-list-row)')
      expect(button.className).toContain('text-xs')
      expect(button.className).not.toContain('h-6 ')
      // The name is mono, medium; the title is regular, inheriting the row's text.
      const [name, title] = Array.from(button.querySelectorAll<HTMLElement>(':scope > span')).slice(-2)
      expect(name.className).toContain('font-medium')
      expect(name.className).toContain('font-mono')
      expect(`${name.className} ${title.className}`).not.toContain('text-meta')
      expect(`${name.className} ${title.className}`).not.toContain('font-semibold')
    }
  })

  it('indents child rows by the tree indent, the same constant the workspace guide uses', () => {
    const { container } = render(row(() => {}, parent, { isCurrent: false, currentSessionId: 'other' }))
    fireEvent.click(screen.getByLabelText('Expand 1 subagents'))
    fireEvent.click(screen.getByLabelText('Expand 1 session in other workspaces'))

    const subagentRows = screen.getByLabelText('More actions for subagent explorer#1').closest('.space-y-px') as HTMLElement
    expect(subagentRows.style.paddingLeft).toBe(`${TREE_INDENT_PX}px`)
    expect((container.querySelector('[data-linked-sessions]') as HTMLElement).style.paddingLeft).toBe(`${TREE_INDENT_PX}px`)
  })
})

describe('DraftSessionRow', () => {
  it('reads "New session" upright in the open row\'s medium weight', () => {
    const { container } = render(<DraftSessionRow label="acme" />)

    const title = screen.getByText('New session')
    expect(title.className).toContain('font-medium')
    expect(title.className).not.toContain('italic')
    expect(title.className).not.toContain('font-semibold')
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('12')
  })
})
