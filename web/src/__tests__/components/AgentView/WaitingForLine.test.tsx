/**
 * The line under a finished answer that still has work coming back to it:
 * how many sessions it waits for, and a list that opens each one.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import type { WaitingItem } from '@/api/types'
import { WaitingForLine } from '@/components/AgentView/WaitingForLine'
import { queryKeys } from '@/queries'
import { OPEN_SESSION_EVENT, type OpenSessionRequest } from '@/utils/workspace-messages'

afterEach(cleanup)

const WORKER: WaitingItem = { kind: 'subagent', session_id: 'sub-1', title: 'Port the settings tests', label: 'worker#1', workspace: '', state: 'working' }
const EXPLORER: WaitingItem = { kind: 'subagent', session_id: 'sub-2', title: 'Map the retry paths', label: 'explorer#1', workspace: '', state: 'working' }
const CLOUD: WaitingItem = { kind: 'session', session_id: 'other-1', title: 'Add the offer route', label: 'agentd-cloud', workspace: '/r/agentd-cloud', state: 'needs_input' }

function renderLine(items: WaitingItem[] | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (items) client.setQueryData(queryKeys.session.waiting('lead-1'), { items })
  render(<QueryClientProvider client={client}><WaitingForLine sessionId="lead-1" /></QueryClientProvider>)
}

const line = () => screen.queryByRole('button', { name: /^Waiting for/ })

describe('WaitingForLine', () => {
  it('counts subagents and other workspaces as sessions, and says how many need you', () => {
    renderLine([WORKER, EXPLORER, CLOUD])
    expect(line()?.textContent).toBe('Waiting for 3 sessions · 1 needs you')
  })

  it('reads in the singular for one session', () => {
    renderLine([WORKER])
    expect(line()?.textContent).toBe('Waiting for 1 session')
  })

  it('shows nothing when the session waits for nothing', () => {
    renderLine([])
    expect(line()).toBeNull()
  })

  it('lists each session with where it runs and its state', () => {
    renderLine([WORKER, CLOUD])
    fireEvent.click(line()!)
    const list = screen.getByRole('dialog', { name: 'Waiting for' })
    const rows = within(list).getAllByRole('button')
    expect(rows.map((row) => row.textContent)).toEqual([
      'Port the settings testsSubagent · worker#1Running',
      'Add the offer routeagentd-cloudNeeds you',
    ])
  })

  it('opens a subagent in this workspace and another session in its own', () => {
    const opened: OpenSessionRequest[] = []
    const listen = (event: Event) => opened.push((event as CustomEvent<OpenSessionRequest>).detail)
    window.addEventListener(OPEN_SESSION_EVENT, listen)
    try {
      renderLine([WORKER, CLOUD])
      fireEvent.click(line()!)
      fireEvent.click(screen.getByRole('button', { name: /Port the settings tests/ }))
      // Opening one closes the list (it leaves the page once its exit ends).
      expect(line()?.getAttribute('aria-expanded')).toBe('false')
      fireEvent.click(line()!)
      fireEvent.click(screen.getByRole('button', { name: /Add the offer route/ }))
    } finally {
      window.removeEventListener(OPEN_SESSION_EVENT, listen)
    }
    expect(opened).toEqual([
      { sessionId: 'sub-1', workspace: '' },
      { sessionId: 'other-1', workspace: '/r/agentd-cloud' },
    ])
  })

  it('names a session that has no title yet', () => {
    renderLine([{ ...CLOUD, title: null, state: 'idle' }])
    fireEvent.click(line()!)
    expect(screen.getByRole('button', { name: /Untitled session/ }).textContent).toBe('Untitled sessionagentd-cloudIdle')
  })
})
