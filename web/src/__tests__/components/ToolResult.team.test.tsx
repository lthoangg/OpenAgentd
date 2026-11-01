/**
 * Subagent rows in a team tool result: each opens the subagent's session,
 * reads its state in words, and runs a live elapsed timer while it works.
 * A subagent's question has no answer route for the user, so its card
 * links to the subagent's session instead.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

// The shared clock, stepped by hand: a test ticks it, nothing waits a second.
const listeners = new Set<(now: number) => void>()
mock.module('@/components/ToolCall/liveClock', () => ({
  subscribeLiveClock: (listener: (now: number) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}))

const { ToolResult } = await import('@/components/ToolResult')
const { useAgentStore } = await import('@/stores/useAgentStore')
const { queryKeys } = await import('@/queries/keys')
const { OPEN_SESSION_EVENT } = await import('@/utils/workspace-messages')
const { formatClock, subagentStatusView, parseStartedAt } = await import('@/components/ToolCall/subagentStatus')

const SUB = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const opened: unknown[] = []
const onOpen = (event: Event) => opened.push((event as CustomEvent).detail)

beforeEach(() => {
  opened.length = 0
  listeners.clear()
  window.addEventListener(OPEN_SESSION_EVENT, onOpen)
})
afterEach(() => {
  cleanup()
  window.removeEventListener(OPEN_SESSION_EVENT, onOpen)
  useAgentStore.setState({ sessionId: null })
})

const isoAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()
const tick = (offsetSeconds: number) => act(() => { listeners.forEach((listener) => listener(Date.now() + offsetSeconds * 1000)) })

function roster(client: QueryClient, lead: string, members: Array<Record<string, unknown>>) {
  client.setQueryData(queryKeys.session.subagents(lead), { available_profiles: [], live_members: members })
}
function withClient(client: QueryClient, ui: ReactNode) {
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('status words and clock', () => {
  it('says Running, Done, Failed and Needs you, and keeps an unknown state as it is', () => {
    expect(subagentStatusView('working')?.label).toBe('Running')
    expect(subagentStatusView('spawned')?.label).toBe('Running')
    expect(subagentStatusView('completed')?.label).toBe('Done')
    expect(subagentStatusView('error')?.label).toBe('Failed')
    expect(subagentStatusView('waiting_lead')?.label).toBe('Needs you')
    expect(subagentStatusView('working', true)?.label).toBe('Needs you')
    expect(subagentStatusView('stopped')?.label).toBe('Stopped')
    expect(subagentStatusView('hibernating')).toMatchObject({ label: 'hibernating', tone: 'neutral', running: false })
    expect(subagentStatusView(null)).toBeNull()
    expect(subagentStatusView('working')?.running).toBe(true)
    expect(subagentStatusView('waiting_lead')?.running).toBe(false)
  })

  it('formats mm:ss, with hours past the hour, and never negative', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(7_400)).toBe('00:07')
    expect(formatClock(65_000)).toBe('01:05')
    expect(formatClock(12 * 60_000 + 3_000)).toBe('12:03')
    expect(formatClock(3_600_000 + 2 * 60_000 + 9_000)).toBe('1:02:09')
    expect(formatClock(-5_000)).toBe('00:00')
    expect(parseStartedAt('2026-07-01T00:00:00+00:00')).toBe(Date.parse('2026-07-01T00:00:00Z'))
    expect(parseStartedAt('nope')).toBeNull()
    expect(parseStartedAt(undefined)).toBeNull()
  })
})

describe('subagent rows', () => {
  const roster1 = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      live_members: [{ member_id: 'explorer#1', status: 'working', session_id: SUB, created_at: isoAgo(65), ...extra }],
    })

  it('open the subagent session from the row, in one step', () => {
    render(<ToolResult toolName="team" result={roster1()} />)
    const row = screen.getByRole('button', { name: 'Open explorer#1 session, Running' })
    expect(row.tagName).toBe('BUTTON')
    fireEvent.click(row)
    expect(opened).toEqual([{ sessionId: SUB, workspace: '' }])
  })

  it('are 28px rows (36px on touch) with a visible keyboard focus', () => {
    render(<ToolResult toolName="team" result={roster1()} />)
    const row = screen.getByRole('button', { name: /Open explorer#1 session/ })
    expect(row.className).toContain('h-(--spacing-list-row)')
    expect(row.className).toContain('focus-visible:outline-2')
    expect(row.className).not.toMatch(/(?<![\w-])border(?![\w-])/)
    expect(row.getAttribute('title')).toBeNull()
  })

  it('show the state in words and a tabular elapsed timer while it runs', () => {
    render(<ToolResult toolName="team" result={roster1()} />)
    const row = screen.getByRole('button', { name: /Open explorer#1 session/ })
    expect(row.querySelector('[data-slot="chip"]')?.textContent).toBe('Running')
    const clock = row.querySelector('[data-subagent-elapsed]') as HTMLElement
    expect(clock.textContent).toBe('01:05')
    expect(clock.className).toContain('tabular-nums')

    tick(5)
    expect(clock.textContent).toBe('01:10')
    tick(60)
    expect(clock.textContent).toBe('02:05')
  })

  it('tick only while running, and let go of the clock when they stop or unmount', () => {
    const done = JSON.stringify({ live_members: [{ member_id: 'explorer#1', status: 'completed', session_id: SUB, created_at: isoAgo(65) }] })
    const { unmount } = render(<ToolResult toolName="team" result={done} />)
    expect(screen.getByText('Done')).toBeTruthy()
    expect(document.querySelector('[data-subagent-elapsed]')).toBeNull()
    expect(listeners.size).toBe(0)
    unmount()

    const running = render(<ToolResult toolName="team" result={roster1()} />)
    expect(listeners.size).toBe(1)
    running.rerender(<ToolResult toolName="team" result={done} />)
    expect(document.querySelector('[data-subagent-elapsed]')).toBeNull()
    expect(listeners.size).toBe(0)

    running.rerender(<ToolResult toolName="team" result={roster1()} />)
    expect(listeners.size).toBe(1)
    running.unmount()
    expect(listeners.size).toBe(0)
  })

  it('show no timer when nothing says when the member started', () => {
    render(<ToolResult toolName="team" result={JSON.stringify({ live_members: [{ member_id: 'explorer#1', status: 'working', session_id: SUB }] })} />)
    expect(screen.getByText('Running')).toBeTruthy()
    expect(document.querySelector('[data-subagent-elapsed]')).toBeNull()
    expect(listeners.size).toBe(0)
  })

  it('read Failed and Needs you, and Needs you whatever the state says when a question is open', () => {
    const res = JSON.stringify({
      live_members: [
        { member_id: 'a#1', status: 'error', session_id: SUB },
        { member_id: 'b#1', status: 'waiting_lead', session_id: SUB },
        { member_id: 'c#1', status: 'working', has_pending_question: true, session_id: SUB },
      ],
    })
    render(<ToolResult toolName="team" result={res} />)
    expect(screen.getByText('Failed').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('error')
    expect(screen.getAllByText('Needs you')).toHaveLength(2)
    // A waiting member shows its dot but runs no clock.
    expect(document.querySelector('[data-subagent-elapsed]')).toBeNull()
  })

  it('are plain rows, not buttons, where no session is known', () => {
    render(<ToolResult toolName="team" result={JSON.stringify({ live_members: [{ member_id: 'explorer#1', status: 'working' }] })} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('explorer#1').closest('[data-subagent-row]')?.tagName).toBe('DIV')
  })

  it('open from a single member result and from a team_wait result too', () => {
    const spawn = JSON.stringify({ status: 'spawned', member_id: 'explorer#3', session_id: SUB })
    const { unmount } = render(<ToolResult toolName="team_spawn" result={spawn} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open explorer#3 session, Running' }))
    unmount()

    const wait = JSON.stringify({ status: 'completed', results: { 'researcher#1': { status: 'completed', output: 'Fetched docs', session_id: SUB } } })
    render(<ToolResult toolName="team_wait" result={wait} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open researcher#1 session, Done' }))
    expect(opened).toEqual([{ sessionId: SUB, workspace: '' }, { sessionId: SUB, workspace: '' }])
    expect(screen.getByText(/Fetched docs/)).toBeTruthy()
  })
})

describe('subagent rows with the live roster', () => {
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

  it('learn a member\'s session and current state from the roster, over the call\'s snapshot', () => {
    const qc = client()
    useAgentStore.setState({ sessionId: 'lead-1' })
    roster(qc, 'lead-1', [{ member_id: 'researcher#1', status: 'working', session_id: SUB, created_at: isoAgo(30), has_pending_question: false }])
    // The call said completed (when it ran); the roster says it was set going again.
    const wait = JSON.stringify({ status: 'completed', results: { 'researcher#1': { status: 'completed', output: 'Fetched docs' } } })
    withClient(qc, <ToolResult toolName="team_wait" result={wait} />)

    const row = screen.getByRole('button', { name: 'Open researcher#1 session, Running' })
    expect(row.querySelector('[data-subagent-elapsed]')?.textContent).toBe('00:30')
    fireEvent.click(row)
    expect(opened).toEqual([{ sessionId: SUB, workspace: '' }])
  })

  it('fall back to the snapshot without a roster', () => {
    const qc = client()
    useAgentStore.setState({ sessionId: 'lead-with-no-roster' })
    const wait = JSON.stringify({ results: { 'researcher#1': { status: 'completed', output: 'Fetched docs' } } })
    withClient(qc, <ToolResult toolName="team_wait" result={wait} />)
    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Open researcher#1/ })).toBeNull()
  })
})

describe('a subagent\'s question', () => {
  const asked = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      status: 'waiting_lead',
      member_id: 'explorer#2',
      session_id: SUB,
      pending_question: { question: 'Should I include OAuth routes?', options: ['yes', 'no'] },
      ...extra,
    })

  it('links to the subagent session instead of offering answers that go nowhere', () => {
    render(<ToolResult toolName="team_send" result={asked()} />)
    // Not buttons: the options are a list; the one control is the link.
    const options = screen.getByRole('list', { name: 'Options' })
    expect(options.querySelector('button')).toBeNull()
    const link = screen.getByRole('button', { name: /Answer in subagent session/ })
    expect(link.getAttribute('data-slot')).toBe('button')
    expect(link.className).not.toMatch(/(?<![\w-])border(?![\w-])/)
    fireEvent.click(link)
    expect(opened).toEqual([{ sessionId: SUB, workspace: '' }])
  })

  it('has no link where the member\'s session is not known', () => {
    render(<ToolResult toolName="team_send" result={asked({ session_id: undefined })} />)
    expect(screen.getByText('Should I include OAuth routes?')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Answer in subagent session/ })).toBeNull()
  })

  it('drops the link once the roster shows the member moved on', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    useAgentStore.setState({ sessionId: 'lead-1' })
    roster(qc, 'lead-1', [{ member_id: 'explorer#2', status: 'working', session_id: SUB, has_pending_question: false }])
    withClient(qc, <ToolResult toolName="team_send" result={asked()} />)
    expect(screen.getByText('Should I include OAuth routes?')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Answer in subagent session/ })).toBeNull()
    // The row reads the live state, not the stale one.
    expect(screen.getByText('Running')).toBeTruthy()
  })

  it('keeps the link while the roster still shows it waiting', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    useAgentStore.setState({ sessionId: 'lead-1' })
    roster(qc, 'lead-1', [{ member_id: 'explorer#2', status: 'waiting_lead', session_id: SUB, has_pending_question: true }])
    withClient(qc, <ToolResult toolName="team_send" result={asked({ session_id: undefined })} />)
    expect(screen.getByRole('button', { name: /Answer in subagent session/ })).toBeTruthy()
  })
})
