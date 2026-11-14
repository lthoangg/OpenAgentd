/**
 * The line at a transcript's live end while work is still coming back to it:
 * how many sessions it waits for, and a list (inline on desktop) that opens
 * each one.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { WaitingItem } from '@/api/types'
import { resetWaitingOpenState, WaitingForLine } from '@/components/AgentView/WaitingForLine'
import { queryKeys } from '@/queries'
import { OPEN_SESSION_EVENT, type OpenSessionRequest } from '@/utils/workspace-messages'

afterEach(() => {
  cleanup()
  resetWaitingOpenState()
})

const WORKER: WaitingItem = { kind: 'subagent', session_id: 'sub-1', title: 'Port the settings tests', label: 'worker#1', workspace: '', state: 'working' }
const EXPLORER: WaitingItem = { kind: 'subagent', session_id: 'sub-2', title: 'Map the retry paths', label: 'explorer#1', workspace: '', state: 'working' }
const CLOUD: WaitingItem = { kind: 'session', session_id: 'other-1', title: 'Add the offer route', label: 'agentd-cloud', workspace: '/r/agentd-cloud', state: 'needs_input' }
const IDLE: WaitingItem = { kind: 'subagent', session_id: 'sub-3', title: 'Finished the audit', label: 'explorer#2', workspace: '', state: 'idle' }

function renderLine(items: WaitingItem[] | undefined, sessionId = 'lead-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (items) client.setQueryData(queryKeys.session.waiting(sessionId), { items })
  const view = render(<QueryClientProvider client={client}><WaitingForLine sessionId={sessionId} /></QueryClientProvider>)
  return { client, view }
}

const line = () => screen.queryByRole('button', { name: /^Waiting for/ })
const list = () => screen.queryByRole('region', { name: 'Sessions this one waits for' })

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
    const rows = within(list()!).getAllByRole('button')
    expect(rows.map((row) => row.textContent)).toEqual([
      'Port the settings testsSubagent · worker#1Running',
      'Add the offer routeagentd-cloudNeeds you',
    ])
  })

  it('leaves idle sessions out of the count and the list', () => {
    renderLine([WORKER, IDLE, CLOUD])
    expect(line()?.textContent).toBe('Waiting for 2 sessions · 1 needs you')
    fireEvent.click(line()!)
    expect(list()?.textContent).not.toContain('Finished the audit')
  })

  it('shows nothing when every awaited session is idle', () => {
    renderLine([IDLE])
    expect(line()).toBeNull()
  })

  it('drops a session from the open list once it goes idle', async () => {
    const { client } = renderLine([WORKER, EXPLORER])
    fireEvent.click(line()!)
    act(() => client.setQueryData(queryKeys.session.waiting('lead-1'), { items: [WORKER, { ...EXPLORER, state: 'idle' }] }))
    await waitFor(() => expect(line()?.textContent).toBe('Waiting for 1 session'))
    expect(within(list()!).getAllByRole('button').map((row) => row.textContent)).toEqual(['Port the settings testsSubagent · worker#1Running'])
  })

  it('opens the list inline, not in a popover, and folds it on a second click', () => {
    renderLine([WORKER, CLOUD])
    expect(line()?.getAttribute('aria-expanded')).toBe('false')
    expect(line()?.hasAttribute('aria-haspopup')).toBe(false)
    fireEvent.click(line()!)
    expect(line()?.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByRole('dialog')).toBeNull()
    // The button names the region it controls, and the region sits in the line.
    expect(list()?.id).toBe(line()!.getAttribute('aria-controls')!)
    expect(document.querySelector('[data-waiting-for]')?.contains(list())).toBe(true)
    fireEvent.click(line()!)
    expect(line()?.getAttribute('aria-expanded')).toBe('false')
  })

  it('folds on Escape from inside the list and hands focus back to the line', () => {
    renderLine([WORKER])
    fireEvent.click(line()!)
    const row = within(list()!).getByRole('button')
    row.focus()
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(line()?.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(line())
  })

  it('keeps the list open per session across a remount, and starts closed elsewhere', () => {
    const first = renderLine([WORKER])
    fireEvent.click(line()!)
    first.view.unmount()
    renderLine([WORKER])
    expect(line()?.getAttribute('aria-expanded')).toBe('true')
    cleanup()
    renderLine([WORKER], 'lead-2')
    expect(line()?.getAttribute('aria-expanded')).toBe('false')
  })

  it('forgets the open list once there is nothing left to wait for', async () => {
    const { client } = renderLine([WORKER])
    fireEvent.click(line()!)
    act(() => client.setQueryData(queryKeys.session.waiting('lead-1'), { items: [] }))
    // A boolean: bun prints a whole DOM node when such a check misses, slowly.
    await waitFor(() => expect(line() === null).toBe(true))
    act(() => client.setQueryData(queryKeys.session.waiting('lead-1'), { items: [EXPLORER] }))
    await waitFor(() => expect(line()?.getAttribute('aria-expanded')).toBe('false'))
  })

  it('opens a subagent in this workspace and another session in its own', () => {
    const opened: OpenSessionRequest[] = []
    const listen = (event: Event) => opened.push((event as CustomEvent<OpenSessionRequest>).detail)
    window.addEventListener(OPEN_SESSION_EVENT, listen)
    try {
      renderLine([WORKER, CLOUD])
      fireEvent.click(line()!)
      fireEvent.click(screen.getByRole('button', { name: /Port the settings tests/ }))
      // Inline, the list stays open: coming back finds it as it was left.
      expect(line()?.getAttribute('aria-expanded')).toBe('true')
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
    renderLine([{ ...CLOUD, title: null, state: 'working' }])
    fireEvent.click(line()!)
    expect(screen.getByRole('button', { name: /Untitled session/ }).textContent).toBe('Untitled sessionagentd-cloudRunning')
  })
})
