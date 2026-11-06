/**
 * A team call that started or messaged a subagent shows that subagent in the
 * call's own row, without opening the details: its state in words and one
 * tap to its session (no row of its own under the call). The backend answers a spawn in plain text
 * ("Subagent 'explorer#1' dispatched…"), so the handle comes from there and
 * where the member is now comes from the live roster.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ToolCall } from '@/components/ToolCall'
import { useAgentStore } from '@/stores/useAgentStore'
import { queryKeys } from '@/queries/keys'
import { OPEN_SESSION_EVENT } from '@/utils/workspace-messages'

const SUB = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const SPAWN_ARGS = JSON.stringify({ action: 'spawn', profile: 'explorer', task: 'List the files' })
const SPAWNED = "Subagent 'explorer#1' dispatched. Its deliverable will arrive as a message when it finishes."
const opened: unknown[] = []
const onOpen = (event: Event) => opened.push((event as CustomEvent).detail)

function renderWithRoster(ui: React.ReactNode, members: Array<Record<string, unknown>> | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAgentStore.setState({ sessionId: 'lead-1' })
  if (members) client.setQueryData(queryKeys.session.subagents('lead-1'), { available_profiles: [], live_members: members })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  opened.length = 0
  window.addEventListener(OPEN_SESSION_EVENT, onOpen)
})
afterEach(() => {
  cleanup()
  window.removeEventListener(OPEN_SESSION_EVENT, onOpen)
  useAgentStore.setState({ sessionId: null })
})

describe('a team call\'s subagent link', () => {
  it('shows the spawned subagent under the closed call and opens its session in one click', () => {
    renderWithRoster(<ToolCall name="team" args={SPAWN_ARGS} done result={SPAWNED} />, [
      { member_id: 'explorer#1', status: 'completed', session_id: SUB, created_at: new Date().toISOString(), has_pending_question: false },
    ])

    const row = screen.getByRole('button', { name: /Expand team details/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Open explorer#1 session, Done' }))
    expect(opened).toEqual([{ sessionId: SUB, workspace: '' }])
    // The chip sits in the row line; a tap on it opens the session and leaves the row shut.
    const chip = row.querySelector('[data-row-link]') as HTMLElement
    expect(chip.textContent).toContain('Done')
    fireEvent.click(chip)
    expect(opened).toHaveLength(2)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-subagent-row]')).toBeNull()
  })

  it('names the subagent a message went to', () => {
    renderWithRoster(
      <ToolCall
        name="team"
        args={JSON.stringify({ target: 'explorer#1', task: 'Only src/' })}
        done
        result="Message delivered to subagent 'explorer#1'. It is running in the background and will deliver its response as a message to you once finished."
      />,
      [{ member_id: 'explorer#1', status: 'working', session_id: SUB, has_pending_question: false }],
    )
    expect(screen.getByRole('button', { name: 'Open explorer#1 session, Running' })).toBeTruthy()
  })

  it('offers nothing to open until the roster knows the subagent\'s session', () => {
    renderWithRoster(<ToolCall name="team" args={SPAWN_ARGS} done result={SPAWNED} />, null)
    expect(screen.queryByRole('button', { name: /Open explorer#1/ })).toBeNull()
    expect(document.querySelector('[data-row-link]')).toBeNull()
  })

  it('shows nothing for a failed call, a running call or a list', () => {
    renderWithRoster(
      <>
        <ToolCall name="team" args={SPAWN_ARGS} done result="Error delegating to subagent: unknown profile 'x'" />
        <ToolCall name="team" args={SPAWN_ARGS} />
        <ToolCall name="team" args={JSON.stringify({ action: 'list' })} done result="No subagents yet." />
      </>,
      [],
    )
    expect(document.querySelector('[data-row-link]')).toBeNull()
  })
})
