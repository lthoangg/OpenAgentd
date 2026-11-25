/**
 * The line at a transcript's live end while work is still coming back to it:
 * how many sessions it waits for, and a list (a popover on desktop) that
 * opens each one.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { WaitingItem } from '@/api/types'
import { WaitingForLine } from '@/components/AgentView/WaitingForLine'
import { queryKeys } from '@/queries'
import { OPEN_SESSION_EVENT, type OpenSessionRequest } from '@/utils/workspace-messages'

afterEach(cleanup)

const WORKER: WaitingItem = { kind: 'subagent', session_id: 'sub-1', title: 'Port the settings tests', label: 'worker#1', workspace: '', state: 'working' }
const EXPLORER: WaitingItem = { kind: 'subagent', session_id: 'sub-2', title: 'Map the retry paths', label: 'explorer#1', workspace: '', state: 'working' }
const CLOUD: WaitingItem = { kind: 'session', session_id: 'other-1', title: 'Add the offer route', label: 'agentd-cloud', workspace: '/r/agentd-cloud', state: 'needs_input' }
const IDLE: WaitingItem = { kind: 'subagent', session_id: 'sub-3', title: 'Finished the audit', label: 'explorer#2', workspace: '', state: 'idle' }
const startedAgo = (seconds: number) => Math.floor(Date.now() / 1000) - seconds
const BUILD: WaitingItem = { kind: 'command', session_id: 'lead-1', number: 3, title: 'Run the backend check', label: 'make verify-v3', workspace: '', state: 'working', waited: true, started_at: startedAgo(134) }
const SERVER: WaitingItem = { kind: 'command', session_id: 'lead-1', number: 2, title: null, label: 'make dev', workspace: '', state: 'working', waited: false, started_at: startedAgo(720) }

function renderLine(items: WaitingItem[] | undefined, sessionId = 'lead-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (items) client.setQueryData(queryKeys.session.waiting(sessionId), { items })
  const view = render(<QueryClientProvider client={client}><WaitingForLine sessionId={sessionId} /></QueryClientProvider>)
  return { client, view }
}

const line = () => screen.queryByRole('button', { name: /^Waiting for/ })
const list = () => screen.queryByRole('dialog', { name: 'Waiting for' })

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

  it('opens the list in a popover outside the transcript, and closes it on Escape', async () => {
    renderLine([WORKER, CLOUD])
    expect(line()?.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(line()!)
    expect(line()?.getAttribute('aria-expanded')).toBe('true')
    // The list floats in a portal: nothing is added to the transcript.
    expect(list() !== null).toBe(true)
    expect(document.querySelector('[data-waiting-for]')?.contains(list())).toBe(false)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
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
      // Opening one closes the list.
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
    renderLine([{ ...CLOUD, title: null, state: 'working' }])
    fireEvent.click(line()!)
    expect(screen.getByRole('button', { name: /Untitled session/ }).textContent).toBe('Untitled sessionagentd-cloudRunning')
  })

  it('counts a background command the session waits for beside its sessions', () => {
    renderLine([WORKER, BUILD, SERVER])
    expect(line()?.textContent).toBe('Waiting for 1 session and 1 command')
  })

  it('does not say it waits for a server: it only says it runs', () => {
    renderLine([SERVER])
    expect(line()).toBeNull()
    const running = screen.getByRole('button', { name: /^1 command running/ })
    // No live dot: nothing is coming back.
    expect(running.querySelector('.animate-pulse')).toBeNull()
    fireEvent.click(running)
    expect(screen.getByRole('dialog', { name: 'Running commands' }).textContent).toMatch(/^make devCommand 2 · \d\d:\d\d · keeps runningStop$/)
  })

  it('lists a command by what the agent called it, with how long it has run', () => {
    renderLine([BUILD, SERVER])
    fireEvent.click(line()!)
    const rows = Array.from(list()!.querySelectorAll('li')).map((row) => row.textContent)
    expect(rows[0]).toMatch(/^Run the backend checkCommand 3 · 02:1\dRunningStop$/)
    expect(rows[1]).toMatch(/^make devCommand 2 · 12:0\d · keeps runningStop$/)
  })

  it('stops a command from its row and reads the list again', async () => {
    const requests: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? 'GET'} ${String(input)}`)
      const body = String(input).endsWith('/waiting') ? JSON.stringify({ items: [SERVER] }) : null
      return Promise.resolve(new Response(body, { status: body ? 200 : 204 }))
    }) as typeof fetch
    try {
      renderLine([BUILD, SERVER])
      fireEvent.click(line()!)
      fireEvent.click(screen.getByRole('button', { name: 'Stop command 3' }))
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop command 3' })).toBeNull())
      expect(requests).toEqual(['POST /api/agent/sessions/lead-1/commands/3/stop', 'GET /api/agent/sessions/lead-1/waiting'])
      // Only the server is left, so the line no longer says it waits.
      expect(screen.getByRole('button', { name: /^1 command running/ })).toBeTruthy()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
