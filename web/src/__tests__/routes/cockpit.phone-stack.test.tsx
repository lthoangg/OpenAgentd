/**
 * A phone opens on Sessions and pushes chats over it: the layout keeps the
 * chat it popped from under the list, never restores a last session over
 * it, goes back by level (a chat to Sessions, Sessions to Servers), and
 * leaves the app on Android Back from Servers, the bottom level. A desktop
 * has the list in its sidebar, so /sessions shows that instead, and
 * /servers is just /.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// The route the layout reads: mutated by the tests, then re-rendered.
let params: Record<string, string> = {}
let search: { workspace?: string } = {}
let pathname = '/'
// The location's own search; null reads the route's (``search``). They
// differ only while a navigation is pending.
let locationSearch: { workspace?: string } | null = null
let phone = true
const navigate = mock((..._args: unknown[]) => {})
const latestTopLevelSession = mock(async () => null)
const invoke = mock(async (..._args: unknown[]) => {})

mock.module('@tanstack/react-router', () => ({
  Outlet: () => null,
  useParams: () => params,
  useSearch: () => search,
  useNavigate: () => navigate,
  useLocation: ({ select }: { select: (location: { pathname: string; search: { workspace?: string } }) => unknown }) =>
    select({ pathname, search: locationSearch ?? search }),
}))

type ChatViewProps = {
  sessionId?: string
  workspace: string | null
  sessionLoading: boolean
  phoneStack?: {
    atSessions: boolean
    atServers?: boolean
    onBack: () => void
    onBackToServers?: () => void
    onOpenSessions?: () => void
  }
}
const chatViewProps: ChatViewProps[] = []
mock.module('@/components/AgentChatView', () => ({
  AgentChatView: (props: ChatViewProps) => {
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
mock.module('@/components/Sidebar.workspace', () => ({ latestTopLevelSession }))
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => phone }))
mock.module('@tauri-apps/api/core', () => ({ invoke }))
mock.module('@/lib/broadcast-sync', () => ({ initBroadcastSync: () => () => {}, broadcastMessage: () => {} }))
mock.module('@/lib/window-title', () => ({ syncDesktopWindowTitle: () => {} }))
mock.module('@/hooks/use-needs-you-badge', () => ({ useNeedsYouBadge: () => 0, useNeedsYouCount: () => 0 }))
const realChatWorkspace = await import('@/queries/useChatWorkspace')
mock.module('@/queries/useChatWorkspace', () => ({ ...realChatWorkspace, useChatWorkspace: () => null }))
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
const { useLayoutStore } = await import('@/stores/useLayoutStore')
const { handleBackPress, _resetBackHandlersForTests } = await import('@/lib/back-button')

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
  pathname = '/'
  locationSearch = null
  phone = true
  navigate.mockClear()
  latestTopLevelSession.mockClear()
  invoke.mockClear()
  chatViewProps.length = 0
  _resetBackHandlersForTests()
  useAgentStore.setState({ sessionId: null })
  useLayoutStore.setState({ sidebarCollapsed: true })
})

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })

describe('the phone stack in the app layout', () => {
  it('opens a bare / on Sessions without restoring the last session over it', async () => {
    renderLayout()
    await settle()
    expect(navigate).toHaveBeenCalledWith({ to: '/sessions', replace: true })
    expect(navigate).not.toHaveBeenCalledWith(expect.objectContaining({ to: '/$sessionId' }))
    expect(latestTopLevelSession).not.toHaveBeenCalled()
    expect(chatViewProps.at(-1)?.phoneStack?.atSessions).toBe(true)
  })

  it('opens a linked chat pushed, with Sessions under it', () => {
    params = { sessionId: 'linked' }
    pathname = '/linked'
    renderLayout()
    expect(chatViewProps.at(-1)).toMatchObject({ sessionId: 'linked', phoneStack: { atSessions: false } })
  })

  it('keeps the chat it popped from under Sessions', () => {
    params = { sessionId: 'open-chat' }
    pathname = '/open-chat'
    const { rerender } = renderLayout()

    params = {}
    pathname = '/sessions'
    rerender()

    expect(chatViewProps.at(-1)).toMatchObject({ sessionId: 'open-chat', phoneStack: { atSessions: true } })
  })

  it('goes back up to /sessions, whatever the history holds', () => {
    params = { sessionId: 'open-chat' }
    pathname = '/open-chat'
    renderLayout()
    chatViewProps.at(-1)?.phoneStack?.onBack()
    expect(navigate).toHaveBeenCalledWith({ to: '/sessions', replace: true })
  })

  it('goes down to /servers from Sessions, and back up from Servers', () => {
    pathname = '/sessions'
    renderLayout()
    expect(chatViewProps.at(-1)?.phoneStack).toMatchObject({ atSessions: true, atServers: false })

    chatViewProps.at(-1)?.phoneStack?.onBackToServers?.()
    expect(navigate).toHaveBeenCalledWith({ to: '/servers', replace: true })

    chatViewProps.at(-1)?.phoneStack?.onOpenSessions?.()
    expect(navigate).toHaveBeenLastCalledWith({ to: '/sessions', replace: true })
  })

  it('keeps Sessions and the chat it popped from under Servers', () => {
    params = { sessionId: 'open-chat' }
    pathname = '/open-chat'
    const { rerender } = renderLayout()

    params = {}
    pathname = '/servers'
    rerender()

    expect(chatViewProps.at(-1)).toMatchObject({ sessionId: 'open-chat', phoneStack: { atSessions: true, atServers: true } })
    // Not a bare route: nothing sends it to /sessions or restores a session.
    expect(navigate).not.toHaveBeenCalled()
  })

  it('leaves the app on Android Back from Servers', async () => {
    pathname = '/servers'
    renderLayout()
    expect(handleBackPress(true)).toBe('handler')
    await settle()
    expect(invoke).toHaveBeenCalledWith('app_move_to_background')
  })

  it('leaves Android Back on Sessions to the stack over Servers, not the app', async () => {
    pathname = '/sessions'
    renderLayout()
    // The chat view (and its stacks) is mocked here, so nothing is registered.
    expect(handleBackPress(true)).toBe('history')
    await settle()
    expect(invoke).not.toHaveBeenCalledWith('app_move_to_background')
  })

  it('lets ✎ push a draft: the pending render on /?workspace= is not sent back to /sessions', async () => {
    pathname = '/sessions'
    const { rerender } = renderLayout()
    await settle()
    navigate.mockClear()

    // The location is at the draft already; the matched route's search not yet.
    pathname = '/'
    locationSearch = { workspace: '/repo' }
    rerender()
    await settle()

    expect(navigate).not.toHaveBeenCalledWith({ to: '/sessions', replace: true })
  })

  it('names the session a popped draft created without pushing it', () => {
    search = { workspace: '/repo' }
    const { rerender } = renderLayout()
    search = {}
    pathname = '/sessions'
    rerender()

    act(() => useAgentStore.setState({ sessionId: 'from-draft' }))

    expect(navigate).not.toHaveBeenCalledWith(expect.objectContaining({ to: '/$sessionId' }))
    expect(chatViewProps.at(-1)).toMatchObject({ sessionId: 'from-draft', phoneStack: { atSessions: true } })
  })

  it('sends /sessions to / with the sidebar shown on a desktop', () => {
    phone = false
    pathname = '/sessions'
    renderLayout()
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(false)
    expect(chatViewProps.at(-1)?.phoneStack).toBeUndefined()
  })

  it('sends /servers to / on a desktop', () => {
    phone = false
    pathname = '/servers'
    renderLayout()
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(true)
  })
})
