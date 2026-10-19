import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// The route the layout reads: mutated by the tests, then re-rendered.
let params: Record<string, string> = {}
let search: { workspace?: string } = {}
const navigate = mock((..._args: unknown[]) => {})

mock.module('@tanstack/react-router', () => ({
  Outlet: () => null,
  useParams: () => params,
  useSearch: () => search,
  useNavigate: () => navigate,
}))

const chatViewProps: Array<{ sessionId?: string; workspace: string | null; sessionLoading: boolean }> = []
mock.module('@/components/AgentChatView', () => ({
  AgentChatView: (props: { sessionId?: string; workspace: string | null; sessionLoading: boolean }) => {
    chatViewProps.push(props)
    return null
  },
}))

const realClient = await import('@/api/client')
mock.module('@/api/client', () => ({
  ...realClient,
  // The session the first message created is not fetched yet.
  getSession: () => new Promise(() => {}),
  validateWorkspace: async () => ({}),
}))
mock.module('@/components/Sidebar.workspace', () => ({ latestTopLevelSession: async () => null }))
mock.module('@/lib/broadcast-sync', () => ({ initBroadcastSync: () => () => {}, broadcastMessage: () => {} }))
mock.module('@/lib/window-title', () => ({ syncDesktopWindowTitle: () => {} }))
mock.module('@/hooks/use-needs-you-badge', () => ({ useNeedsYouBadge: () => 0 }))
mock.module('@/queries/useChatWorkspace', () => ({ useChatWorkspace: () => null }))
mock.module('@/lib/fresh-window', () => ({ isFreshDesktopWindow: () => false, clearFreshDesktopWindow: () => {} }))

mock.module('@/stores/useAgentStore', () => {
  type State = Record<string, unknown> & { sessionId: string | null }
  const listeners = new Set<(next: State, prev: State) => void>()
  const state: State = {
    sessionId: null,
    sessionTitle: null,
    sessionModel: null,
    sessionThinkingLevel: null,
    cacheInvalidations: [],
    _workspace: null,
    newSession: () => {},
    beginResolvedSession: () => {},
    _drainCacheInvalidations: () => [],
  }
  return {
    useAgentStore: Object.assign(
      (selector: (s: State) => unknown) => selector(state),
      {
        getState: () => state,
        setState: (partial: Partial<State> | ((draft: State) => void)) => {
          const prev = { ...state }
          if (typeof partial === 'function') partial(state)
          else Object.assign(state, partial)
          for (const listener of listeners) listener(state, prev)
        },
        subscribe: (listener: (next: State, prev: State) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    ),
  }
})

const { useAgentStore } = await import('@/stores/useAgentStore')
const { AppLayout } = await import('@/routes/cockpit')

function renderLayout() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <AppLayout />
    </QueryClientProvider>,
  )
  const rerender = () => view.rerender(
    <QueryClientProvider client={client}>
      <AppLayout />
    </QueryClientProvider>,
  )
  return { rerender }
}

afterEach(cleanup)

beforeEach(() => {
  params = {}
  search = {}
  navigate.mockClear()
  chatViewProps.length = 0
  useAgentStore.setState({ sessionId: null })
})

describe('AppLayout draft → session hand-off', () => {
  it('keeps the draft folder when the first message swaps the URL for the new session', () => {
    search = { workspace: '/repo' }
    const { rerender } = renderLayout()
    expect(chatViewProps.at(-1)).toMatchObject({ workspace: '/repo', sessionLoading: false })

    // POST /agent/chat answered: the store adopts the new id.
    act(() => useAgentStore.setState({ sessionId: 'new-id' }))
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/$sessionId', params: { sessionId: 'new-id' } }))

    // The router lands on /new-id before the session list or getSession knows it.
    params = { sessionId: 'new-id' }
    search = {}
    rerender()

    expect(chatViewProps.at(-1)).toMatchObject({ sessionId: 'new-id', workspace: '/repo', sessionLoading: false })
  })

  it('still waits for getSession on a session it did not adopt', () => {
    params = { sessionId: 'other-id' }
    renderLayout()
    expect(chatViewProps.at(-1)).toMatchObject({ sessionId: 'other-id', workspace: null, sessionLoading: true })
  })
})
