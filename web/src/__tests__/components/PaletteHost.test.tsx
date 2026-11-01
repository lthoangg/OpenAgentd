/**
 * The palette's Sessions group wired to the app's data: session titles from
 * every workspace (the sidebar's recent list and title search), opened the
 * way the Switch Workspace/Session… pages open them.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const navigate = mock((_args: unknown) => Promise.resolve())
mock.module('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import { setApiBaseUrl } from '@/api/base-url'
import type { SessionResponse } from '@/api/types'
import { PaletteHost } from '@/components/AgentChatView/PaletteHost'
import { searchTerm, sessionDescription } from '@/components/AgentChatView/usePaletteSessions'

const originalFetch = globalThis.fetch
const HOUR = 3_600_000

function session(id: string, title: string | null, over: Partial<SessionResponse> = {}): SessionResponse {
  return {
    id,
    title,
    agent_name: null,
    created_at: null,
    updated_at: null,
    last_message_at: new Date(Date.now() - 3 * HOUR).toISOString(),
    workspace: '/repo/app',
    ...over,
  }
}

interface Backend {
  recent: SessionResponse[]
  found: SessionResponse[]
  /** Holds the title search until released. */
  gate?: Promise<void>
}

/** Answers the session list endpoint: a title search when ``q`` is set, else the recent list. */
function serve({ recent, found, gate }: Backend) {
  const fetchMock = mock(async (input: unknown) => {
    const url = String(input)
    const searching = new URL(url, 'http://x').searchParams.has('q')
    if (searching && gate) await gate
    return new Response(JSON.stringify({ data: searching ? found : recent, next_cursor: null, has_more: false }))
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

const searched = (fetchMock: ReturnType<typeof serve>) =>
  fetchMock.mock.calls.map(([input]) => new URL(String(input), 'http://x').searchParams.get('q')).filter(Boolean)

function open(props: { sessionId?: string | null; onClose?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={client}>
      <PaletteHost sessionId={props.sessionId ?? 'current'} commands={[]} onClose={props.onClose ?? (() => {})} />
    </QueryClientProvider>,
  )
  return { user, input: screen.getByPlaceholderText('Search commands and sessions…') }
}

beforeEach(() => {
  setApiBaseUrl('')
  navigate.mockClear()
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('PaletteHost — Sessions group', () => {
  it('finds sessions across workspaces, best match first, labelled with workspace and age', async () => {
    serve({
      recent: [],
      found: [
        session('s1', 'Fix login bug'),
        session('s2', 'Login page', { workspace: '/home/me/docs', last_message_at: new Date(Date.now() - 2 * 24 * HOUR).toISOString() }),
        session('child', 'Login helper', { parent_session_id: 's1' }),
        session('current', 'Login for the open session'),
        session('blank', null),
      ],
    })
    const { user, input } = open()

    await user.type(input, 'login')
    const group = await screen.findByRole('group', { name: 'Sessions' })
    await within(group).findByText('Fix login bug')

    // The title that starts with the word first; a subagent, the open session
    // and an untitled one are left out.
    expect(within(group).getAllByRole('button').map((row) => row.textContent)).toEqual([
      'Login pagedocs · 2d',
      'Fix login bugapp · 3h',
    ])
  })

  it('opens the chosen session the way the Switch pages do, then closes', async () => {
    serve({ recent: [], found: [session('s1', 'Fix login bug', { workspace: '/repo/app' })] })
    const onClose = mock(() => {})
    const { user, input } = open({ onClose })

    await user.type(input, 'login')
    await user.click(await screen.findByText('Fix login bug'))

    expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 's1' } })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens the highlighted session on Enter', async () => {
    serve({ recent: [], found: [session('s7', 'Fix login bug')] })
    const { user, input } = open()

    await user.type(input, 'login')
    await screen.findByText('Fix login bug')
    await user.keyboard('{Enter}')

    expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 's7' } })
  })

  it('shows Loading… until the title search answers, and the recent sessions meanwhile', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    serve({ recent: [session('r1', 'Old login chat')], found: [session('s1', 'Fix login bug'), session('r1', 'Old login chat')], gate })
    const { user, input } = open()
    // The recent list is the sidebar's: it is there before anything is typed.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())

    await user.type(input, 'login')
    const group = await screen.findByRole('group', { name: 'Sessions' })
    await within(group).findByText('Old login chat')
    expect(within(group).queryByText('Fix login bug')).toBeNull()

    release()
    await within(group).findByText('Fix login bug')
    // One row for a session in both lists.
    expect(within(group).getAllByText('Old login chat')).toHaveLength(1)
  })

  it('shows a lone Loading… row while nothing is known yet', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    serve({ recent: [], found: [session('s1', 'Fix login bug')], gate })
    const { user, input } = open()

    await user.type(input, 'login')

    const group = await screen.findByRole('group', { name: 'Sessions' })
    expect(within(group).getByText('Loading…').closest('[role=status]')?.getAttribute('aria-live')).toBe('polite')
    expect(screen.queryByText(/No results match/)).toBeNull()

    release()
    await within(group).findByText('Fix login bug')
    expect(within(group).queryByText('Loading…')).toBeNull()
  })

  it('searches the server by the longest word, and only the matching titles show', async () => {
    const fetchMock = serve({
      recent: [],
      found: [session('s1', 'Fix login bug'), session('s2', 'Login page redesign')],
    })
    const { user, input } = open()

    await user.type(input, 'fix login')
    await screen.findByText('Fix login bug')

    expect(searched(fetchMock)).toEqual(['login'])
    // "fix" is not in the other title.
    expect(screen.queryByText('Login page redesign')).toBeNull()
  })

  it('says nothing matches once the search has answered empty', async () => {
    serve({ recent: [], found: [] })
    const { user, input } = open()

    await user.type(input, 'zzz')

    expect(await screen.findByText(/No results match "zzz"/)).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('does not search the server before anything is typed', async () => {
    const fetchMock = serve({ recent: [session('r1', 'Old login chat')], found: [] })
    open()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(searched(fetchMock)).toEqual([])
    expect(screen.queryByText('Old login chat')).toBeNull()
  })
})

describe('session search helpers', () => {
  it('asks the server for the longest word of the query', () => {
    expect(searchTerm('fix login')).toBe('login')
    expect(searchTerm('login')).toBe('login')
    expect(searchTerm('')).toBe('')
    expect(searchTerm('a  bb')).toBe('bb')
  })

  it('describes a session by workspace name and age', () => {
    // Exactly 3h after the fixture's time: a clock read before it could land
    // a millisecond short of 3h under load.
    const at = Date.parse(session('a', 't').last_message_at!)
    const now = new Date(at + 3 * HOUR)
    const lastMessage = new Date(at).toISOString()
    expect(sessionDescription(session('a', 't', { workspace: '/repo/app', last_message_at: lastMessage }), now)).toBe('app · 3h')
    expect(sessionDescription(session('a', 't', { workspace: null, last_message_at: lastMessage }), now)).toBe('3h')
    expect(sessionDescription(session('a', 't', { workspace: '/repo/app', last_message_at: null }), now)).toBe('app')
  })
})
