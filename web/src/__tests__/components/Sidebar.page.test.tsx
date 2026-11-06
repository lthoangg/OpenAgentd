/**
 * Sidebar `page` mode: the phone's Sessions screen (the PhoneStack root).
 * The same component as the drawer, drawn as a full screen: a top bar (server
 * chip, small title, ✎), a large title and a search field that scroll with
 * the list, pull to refresh, swipe actions on session rows and a bottom
 * toolbar (Settings · Scheduled · Usage · Theme). No scrim, no drawer
 * motion, no New session row, no Scheduled section.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type React from 'react'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '@/queries'
import { APP_EVENTS } from '@/lib/app-events'
import { themeStorageKey } from '@/lib/theme'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSidebarViewStore } from '@/stores/useSidebarViewStore'
import { useToastStore } from '@/stores/useToastStore'
import { useUIStore } from '@/stores/useUIStore'
import { useUnreadStore } from '@/stores/useUnreadStore'

const navigate = mock(() => {})
let isMobile = true

type TestSession = {
  id: string
  title: string | null
  agent_name: string | null
  created_at: string | null
  updated_at: string | null
  mode?: string
  workspace?: string | null
  running?: boolean
  needs_input?: boolean
  pinned_at?: string | null
  parent_session_id?: string | null
  subagents?: TestSession[]
}

const session = (id: string, title: string, extra: Partial<TestSession> = {}): TestSession => ({
  id,
  title,
  agent_name: 'lead',
  created_at: '2026-05-13T00:00:00Z',
  updated_at: '2026-05-13T00:00:00Z',
  mode: 'coding',
  workspace: '/repo/project',
  ...extra,
})

let workspaceSessionsData: TestSession[] = []
let pinnedSessionsData: TestSession[] = []
let activeSessionsData: TestSession[] = []
const deleteSessionMutate = mock(() => {})
const setSessionPinnedMutate = mock(() => {})

mock.module('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'ios', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'ios', isMacOverlay: false }),
}))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => isMobile }))
// Reduced motion makes a swipe snap, so a release reads at its resting place.
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }))
mock.module('@/lib/haptics', () => ({
  selectionHapticFeedback: () => undefined,
  softHapticFeedback: () => undefined,
  mediumHapticFeedback: () => undefined,
  alignmentHapticFeedback: () => undefined,
  outcomeHapticFeedback: () => undefined,
  haptic: () => undefined,
}))

mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => true,
  useDragControls: () => ({ start: () => {} }),
  motion: {
    aside: ({ children, animate, initial, exit, transition, ...props }: React.ComponentProps<'aside'> & { animate?: unknown; initial?: unknown; exit?: unknown; transition?: unknown }) => {
      void initial
      void exit
      return <aside data-animate={JSON.stringify(animate)} data-transition={JSON.stringify(transition)} {...props}>{children}</aside>
    },
    div: ({ children, initial, animate, exit, transition, ...props }: React.ComponentProps<'div'> & { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }) => {
      void initial
      void animate
      void exit
      void transition
      return <div {...props}>{children}</div>
    },
  },
}))

mock.module('@/components/ThemeToggle', () => ({
  ThemeToggle: () => <button aria-label="Theme: System. Click to cycle." />,
}))
mock.module('@/components/HealthDot', () => ({
  HealthDot: ({ labeled = false }: { labeled?: boolean }) => (
    <button type="button" aria-label="Connected. Change server">{labeled ? 'backend-name' : null}</button>
  ),
}))
// The dialogs and the sheet belong to other primitives; keep them plain so
// what is under test is the Sessions screen, not their motion.
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div data-dialog-content="">{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))
mock.module('@/components/ui/bottom-sheet', () => ({
  BottomSheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div data-bottom-sheet="">{children}</div> : null),
}))

mock.module('@/queries/useSessionsQuery', () => ({
  useSessionsQuery: () => ({ data: { pages: [{ data: workspaceSessionsData }] }, isFetching: false, refetch: () => {} }),
  useWorkspaceSessionsQuery: () => ({
    data: { pages: [{ data: workspaceSessionsData }] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: () => {},
    refetch: () => {},
  }),
  useActiveSessionsQuery: () => ({ data: { pages: [{ data: activeSessionsData }] } }),
  usePinnedSessionsQuery: () => ({ data: { pages: [{ data: pinnedSessionsData }] } }),
  useAllSessionsQuery: () => ({
    data: { pages: [{ data: [] }] },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: () => {},
  }),
  useSessionSubagentsQuery: () => ({ data: undefined }),
  useSetSessionPinnedMutation: () => ({ mutate: setSessionPinnedMutate }),
  useSessionSearchQuery: (query: string) => ({
    data: query ? { pages: [{ data: [session('hit', 'Search hit')], has_more: false }] } : undefined,
    isFetching: false,
  }),
  useDeleteSessionMutation: () => ({ mutate: deleteSessionMutate }),
  useUpdateSessionTitleMutation: () => ({ mutate: () => {}, isPending: false, isError: false }),
}))

const originalFetch = globalThis.fetch

beforeEach(() => {
  isMobile = true
  workspaceSessionsData = [session('s-1', 'Fix login redirect loop')]
  pinnedSessionsData = []
  activeSessionsData = []
  navigate.mockClear()
  deleteSessionMutate.mockClear()
  setSessionPinnedMutate.mockClear()
  useUnreadStore.setState({ ids: [], failed: [] })
  useSidebarViewStore.setState({ groupBy: 'project', showDetails: true, pinnedCollapsed: false, collapsedGroups: [], groupFilter: null })
  useUIStore.setState({ telemetryOpen: false })
  useToastStore.setState({ toasts: [] })
  globalThis.fetch = mock(async (input: unknown) => {
    if (String(input).includes('/api/agent/workspace/tree')) {
      return new Response(JSON.stringify({
        repositories: [{ path: '/repo/project', name: 'project', worktrees: [], group_ids: [] }],
        chat: null,
        groups: [],
      }))
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

type SidebarProps = React.ComponentProps<typeof import('@/components/Sidebar').Sidebar>

/** Let the first workspace-tree fetch land; observers hear of it on a timer. */
async function settleWorkspaceTree(queryClient: QueryClient) {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 20 && queryClient.getQueryState(queryKeys.coding.tree())?.status !== 'success'; i += 1) {
    await act(tick)
  }
  await act(tick)
}

async function renderSidebar(props: SidebarProps = {}) {
  const { Sidebar } = await import('@/components/Sidebar')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <QueryClientProvider client={queryClient}>
        <Sidebar workspace="/repo/project" {...props} />
      </QueryClientProvider>,
    )
    await Promise.resolve()
  })
  await settleWorkspaceTree(queryClient)
  return { view, queryClient }
}

const renderPage = (props: SidebarProps = {}) => renderSidebar({ page: true, mobileOpen: true, ...props })

const pageEl = (container: HTMLElement) => container.querySelector('aside') as HTMLElement
const scrollerEl = (container: HTMLElement) => container.querySelector('[data-sidebar-scroller]') as HTMLElement

type PointerKind = 'pointerDown' | 'pointerMove' | 'pointerUp'
const pointer = (type: PointerKind, el: Element, x: number, t: number) => {
  const event = createEvent[type](el, { pointerType: 'touch', pointerId: 1, clientX: x, clientY: 20 })
  Object.defineProperty(event, 'timeStamp', { value: 1000 + t })
  fireEvent(el, event)
}
/** A slow drag across 150px of a row, past half way of its two 72px actions. */
const swipeOpen = (el: Element) => {
  pointer('pointerDown', el, 300, 0)
  pointer('pointerMove', el, 150, 100)
  pointer('pointerUp', el, 150, 200)
}
const rowOf = (title: string) => screen.getByText(title).closest('[data-session-row]') as HTMLElement
const swipeRowOf = (title: string) => rowOf(title).closest('[data-swipe-row]') as HTMLElement
/** Hold a row until the session sheet opens (the long-press timer is real). */
async function openSessionSheet(title: string): Promise<HTMLElement> {
  fireEvent.pointerDown(screen.getByText(title).closest('button') as HTMLElement, { pointerType: 'touch', clientX: 20, clientY: 20 })
  return waitFor(
    () => {
      const found = screen.queryByText('Choose a session action.')?.closest('[data-bottom-sheet]')
      if (!found) throw new Error('no session sheet yet')
      return found as HTMLElement
    },
    { timeout: 1500 },
  )
}

describe('Sidebar page mode: the Sessions screen', () => {
  it('fills its parent as a page: large title, no scrim, no drawer, not inert', async () => {
    const { view } = await renderPage()
    const page = pageEl(view.container)

    expect(screen.getByRole('heading', { level: 1, name: 'Sessions' }).className).toContain('text-large-title')
    expect(screen.getByRole('heading', { level: 1, name: 'Sessions' }).className).toContain('font-bold')
    const classes = page.className.split(/\s+/)
    expect(classes).toEqual(expect.arrayContaining(['flex', 'h-full', 'w-full', 'flex-col']))
    expect(classes).not.toContain('fixed')
    expect(page.hasAttribute('data-sidebar-page')).toBe(true)
    expect(page.hasAttribute('inert')).toBe(false)
    expect(page.hasAttribute('data-edge-drawer')).toBe(false)
    expect(view.container.querySelector('[data-edge-drawer-scrim]')).toBeNull()
    // No drawer motion: nothing is translated off screen, and there is no resize edge.
    expect(page.style.translate).toBe('')
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('is not inert when Sessions is covered: the stack owns that, the page stays as it is', async () => {
    const { view } = await renderPage({ mobileOpen: false })

    expect(pageEl(view.container).hasAttribute('inert')).toBe(false)
  })

  it('drops the New session row and the Scheduled section, which ✎ and the toolbar replace', async () => {
    const { view } = await renderPage()

    expect(view.container.querySelector('[data-sidebar-new-session]')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Scheduled' })).toBeNull()
    expect(view.container.querySelector('[data-sidebar-scheduled-scroller]')).toBeNull()
    // One New session: the round ✎ in the floating toolbar.
    expect(screen.getAllByRole('button', { name: 'New session' })).toHaveLength(1)
  })

  it('keeps Pinned, the workspace tree and the list header with View options', async () => {
    pinnedSessionsData = [session('p-1', 'Release notes', { pinned_at: '2026-05-14T00:00:00Z' })]
    await renderPage()

    expect(screen.getByRole('region', { name: 'Pinned' })).toBeTruthy()
    expect(screen.getByText('Release notes')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open workspace project' })).toBeTruthy()
    expect(screen.getByText('Fix login redirect loop')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Workspaces' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View options' })).toBeTruthy()
    // The search field replaces the header's own Search icon.
    expect(screen.queryByRole('button', { name: 'Search sessions' })).toBeNull()
  })

  it('names the server in the top bar, with a small title that waits for the large one to scroll away', async () => {
    const { view } = await renderPage()
    const bar = view.container.querySelector('[data-sessions-page-bar]') as HTMLElement

    expect(within(bar).getByRole('button', { name: /Change server$/ }).textContent).toBe('backend-name')
    expect(bar.hasAttribute('data-title-visible')).toBe(false)
    const small = within(bar).getByText('Sessions')
    expect(small.className).toContain('text-base')
    expect(small.className).toContain('font-semibold')

    const scroller = scrollerEl(view.container)
    scroller.scrollTop = 160
    fireEvent.scroll(scroller)
    expect(bar.hasAttribute('data-title-visible')).toBe(true)

    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(bar.hasAttribute('data-title-visible')).toBe(false)
  })

  it('goes down to Servers from ‹ Servers, naming the server under the large title', async () => {
    const onOpenServers = mock(() => {})
    const { view } = await renderPage({ onOpenServers })
    const bar = view.container.querySelector('[data-sessions-page-bar]') as HTMLElement

    // ‹ Servers takes the server chip's place.
    expect(within(bar).queryByRole('button', { name: /Change server$/ })).toBeNull()
    fireEvent.click(within(bar).getByRole('button', { name: 'Back to Servers' }))
    expect(onOpenServers).toHaveBeenCalledTimes(1)

    // The server stays in sight under the title, and goes to Servers too.
    const line = view.container.querySelector('[data-sessions-server]') as HTMLElement
    expect(line.closest('[data-sessions-page-header]')).not.toBeNull()
    expect(line.textContent).toContain('·')
    // In a browser (no app shell status) it is "This server", the Servers screen's name.
    await waitFor(() => expect(line.textContent).toContain('This server'))
    fireEvent.click(line)
    expect(onOpenServers).toHaveBeenCalledTimes(2)
  })

  it('pushes a fresh draft from ✎, even over an empty draft kept under Sessions', async () => {
    const onNewSession = mock(() => {})
    // No session: the chat under Sessions is an empty draft, where the
    // chat's own handler would do nothing.
    await renderPage({ onNewSession })

    fireEvent.click(screen.getByRole('button', { name: 'New session' }))

    expect(onNewSession).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/', search: { workspace: '/repo/project' } }))
  })

  it('opens a draft in the current workspace from ✎ when the chat has no handler', async () => {
    // A session is on screen, so the draft is a new screen (an empty draft already open stays).
    await renderPage({ currentSessionId: 's-1' })

    fireEvent.click(screen.getByRole('button', { name: 'New session' }))

    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/', search: { workspace: '/repo/project' } }))
  })
})

describe('Sidebar page mode: search', () => {
  it('opens session search from the field, with a Cancel that comes back', async () => {
    const { view } = await renderPage()
    const field = screen.getByRole('button', { name: 'Search' })
    expect(field.className).toContain('bg-(--bg-key)')
    expect(field.className).toContain('h-9')

    fireEvent.click(field)

    expect(screen.getByPlaceholderText('Search sessions')).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: 'Sessions' })).toBeNull()
    expect(scrollerEl(view.container)).toBeNull()
    // The small title takes over while the large one is gone.
    expect(view.container.querySelector('[data-sessions-page-bar]')?.hasAttribute('data-title-visible')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByPlaceholderText('Search sessions')).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Sessions' })).toBeTruthy()
    expect(view.container.querySelector('[data-sessions-page-bar]')?.hasAttribute('data-title-visible')).toBe(false)
  })

  it('has no Cancel in the drawer, which keeps its own Search toggle', async () => {
    await renderSidebar({ mobileOpen: true })

    fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))

    expect(screen.getByPlaceholderText('Search sessions')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })
})

describe('Sidebar page mode: pull to refresh', () => {
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', el: Element, y: number) =>
    fireEvent[type](el, { touches: type === 'touchEnd' ? [] : [{ clientX: 100, clientY: y }] })

  it('draws the list inside a pull-to-refresh scroller that reloads sessions and the workspace tree', async () => {
    const { view, queryClient } = await renderPage()
    const scroller = scrollerEl(view.container)
    expect(scroller.hasAttribute('data-pull-to-refresh')).toBe(true)
    const invalidate = spyOn(queryClient, 'invalidateQueries')

    touch('touchStart', scroller, 100)
    touch('touchMove', scroller, 300)
    touch('touchEnd', scroller, 300)

    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey)
    expect(keys).toContainEqual(queryKeys.session.sessions.all())
    expect(keys).toContainEqual(queryKeys.coding.tree())
  })

  it('keeps the drawer a plain scroller', async () => {
    const { view } = await renderSidebar({ mobileOpen: true })

    expect(scrollerEl(view.container).hasAttribute('data-pull-to-refresh')).toBe(false)
  })
})

describe('Sidebar page mode: bottom toolbar', () => {
  it('floats a pill of four icon buttons and the round New session button', async () => {
    const openSettings = mock(() => {})
    const real = useSettingsStore.getState().openSettings
    useSettingsStore.setState({ openSettings })
    const onOpenScheduler = mock(() => {})
    try {
      const { view } = await renderPage({ onOpenScheduler, onOpenPalette: () => {} })
      const toolbar = view.container.querySelector('[data-sessions-page-toolbar]') as HTMLElement
      const pill = within(toolbar).getByRole('toolbar', { name: 'Sessions' })
      const names = within(pill).getAllByRole('button').map((button) => button.getAttribute('aria-label'))
      expect(names).toEqual(['Settings', 'Scheduled', 'Usage', 'Theme: System. Tap for Light.'])
      // Icons only: actions, not tabs, so no captions.
      expect(pill.textContent).toBe('')
      expect(toolbar.className).toContain('absolute')
      expect(toolbar.className).toContain('pb-safe')
      expect(within(toolbar).getByRole('button', { name: 'New session' }).dataset.sessionsNew).toBe('')

      fireEvent.click(within(toolbar).getByRole('button', { name: 'Settings' }))
      expect(openSettings).toHaveBeenCalledTimes(1)

      fireEvent.click(within(toolbar).getByRole('button', { name: 'Scheduled' }))
      expect(onOpenScheduler).toHaveBeenCalledTimes(1)

      expect(useUIStore.getState().telemetryOpen).toBe(false)
      fireEvent.click(within(toolbar).getByRole('button', { name: 'Usage' }))
      expect(useUIStore.getState().telemetryOpen).toBe(true)
    } finally {
      useSettingsStore.setState({ openSettings: real })
    }
  })

  it('has no Commands button: the palette is a keyboard surface', async () => {
    await renderPage({ onOpenScheduler: () => {}, onOpenPalette: () => {} })

    expect(screen.queryByRole('button', { name: 'Commands' })).toBeNull()
  })

  it('cycles the theme System → Light → Dark → System, showing the current one', async () => {
    localStorage.removeItem(themeStorageKey())
    try {
      const { view } = await renderPage()
      const toolbar = view.container.querySelector('[data-sessions-page-toolbar]') as HTMLElement
      const themeButton = () => within(toolbar).getByRole('button', { name: /^Theme:/ })

      expect(themeButton().getAttribute('aria-label')).toBe('Theme: System. Tap for Light.')
      expect(themeButton().getAttribute('title')).toBe('Theme: System')
      for (const [next, label] of [['Light', 'Theme: Light. Tap for Dark.'], ['Dark', 'Theme: Dark. Tap for System.'], ['System', 'Theme: System. Tap for Light.']]) {
        fireEvent.click(themeButton())
        await waitFor(() => expect(themeButton().getAttribute('title')).toBe(`Theme: ${next}`))
        expect(themeButton().getAttribute('aria-label')).toBe(label)
      }
    } finally {
      localStorage.removeItem(themeStorageKey())
    }
  })

  it('steps aside while searching, so it never rides up on the soft keyboard', async () => {
    const { view } = await renderPage()
    const toolbar = () => view.container.querySelector('[data-sessions-page-toolbar]')
    expect(toolbar()).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(toolbar()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(toolbar()).not.toBeNull()
  })

  it('opens Scheduled the way the drawer\'s section does when the caller gives no handler', async () => {
    const opened = mock(() => {})
    window.addEventListener(APP_EVENTS.openScheduler, opened)
    useUIStore.getState().focusScheduledTask('stale-task')
    try {
      await renderPage()

      fireEvent.click(screen.getByRole('button', { name: 'Scheduled' }))

      expect(opened).toHaveBeenCalledTimes(1)
      // No task is picked: the list opens, not a leftover detail.
      expect(useUIStore.getState().scheduledTaskFocus).toBeNull()
    } finally {
      window.removeEventListener(APP_EVENTS.openScheduler, opened)
    }
  })
})

describe('Sidebar page mode: swipe actions', () => {
  const actionsOf = (swipeRow: HTMLElement) =>
    Array.from((swipeRow.firstElementChild as HTMLElement).querySelectorAll('button'))

  it('wraps a session row in a SwipeRow with Pin, then Delete at the edge', async () => {
    await renderPage()

    const swipeRow = swipeRowOf('Fix login redirect loop')
    expect(swipeRow).toBeTruthy()
    const actions = actionsOf(swipeRow)
    expect(actions.map((button) => button.textContent)).toEqual(['Pin', 'Delete'])
    // Neutral for Pin, destructive for Delete: only Delete is loud.
    expect(actions[0].className).toContain('bg-(--bg-key)')
    expect(actions[1].className).toContain('bg-(--color-error)')
  })

  it('offers Unpin on a pinned session', async () => {
    pinnedSessionsData = [session('p-1', 'Release notes', { pinned_at: '2026-05-14T00:00:00Z' })]
    workspaceSessionsData = []
    await renderPage()

    expect(actionsOf(swipeRowOf('Release notes')).map((button) => button.textContent)).toEqual(['Unpin', 'Delete'])
  })

  it('pins through the same handler as the row menu', async () => {
    await renderPage()
    const swipeRow = swipeRowOf('Fix login redirect loop')
    swipeOpen(rowOf('Fix login redirect loop'))

    fireEvent.click(within(swipeRow).getByRole('button', { name: 'Pin' }))

    expect(setSessionPinnedMutate).toHaveBeenCalledTimes(1)
    expect((setSessionPinnedMutate.mock.calls[0] as unknown as [{ id: string; pinned: boolean }])[0]).toEqual({ id: 's-1', pinned: true })
  })

  it('opens the delete confirmation instead of deleting', async () => {
    await renderPage()
    const swipeRow = swipeRowOf('Fix login redirect loop')
    swipeOpen(rowOf('Fix login redirect loop'))

    fireEvent.click(within(swipeRow).getByRole('button', { name: 'Delete' }))

    expect(screen.getByText('Delete this session?')).toBeTruthy()
    expect(deleteSessionMutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(deleteSessionMutate).not.toHaveBeenCalled()

    // The row shut after the action; swipe it open again and confirm this time.
    swipeOpen(rowOf('Fix login redirect loop'))
    fireEvent.click(within(swipeRow).getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))
    expect(deleteSessionMutate).toHaveBeenCalledTimes(1)
  })

  it('reveals the actions only while Sessions is the screen on top', async () => {
    const { view } = await renderPage()
    const swipeRow = swipeRowOf('Fix login redirect loop')
    swipeOpen(rowOf('Fix login redirect loop'))
    expect(within(swipeRow).getByRole('button', { name: 'Pin' })).toBeTruthy()

    // A chat is pushed over Sessions: nothing stays revealed or can be swiped.
    cleanup()
    await renderPage({ mobileOpen: false })
    // Rows keep their shape while the chat slides over them.
    expect((screen.getByText('Fix login redirect loop').closest('button') as HTMLElement).className).toContain('[-webkit-touch-callout:none]')
    const covered = swipeRowOf('Fix login redirect loop')
    swipeOpen(rowOf('Fix login redirect loop'))
    expect(within(covered).queryByRole('button', { name: 'Pin' })).toBeNull()
    expect(view.container).toBeTruthy()
  })

  it('does not wrap a subagent row', async () => {
    const child = session('child', 'explorer#1: List files', { parent_session_id: 's-1', running: true })
    workspaceSessionsData = [session('s-1', 'Fix login redirect loop', { subagents: [child] })]
    // The open subagent keeps its lead's list unfolded.
    await renderPage({ currentSessionId: 'child' })

    const subagent = screen.getByText('List files').closest('button') as HTMLElement
    expect(subagent).toBeTruthy()
    expect(subagent.closest('[data-swipe-row]')).toBeNull()
    expect(swipeRowOf('Fix login redirect loop')).toBeTruthy()
  })

  it('keeps long-press actions on so a held row opens the session sheet', async () => {
    await renderPage()

    const title = screen.getByText('Fix login redirect loop').closest('button') as HTMLElement
    // A held row opens the sheet in a phone browser too, so the row stops the
    // system callout, and the inline Pin and More are not drawn.
    expect(title.className).toContain('[-webkit-touch-callout:none]')
    const inlineActions = screen.getByRole('button', { name: 'More actions for Fix login redirect loop' }).parentElement as HTMLElement
    expect(inlineActions.className.split(/\s+/)).toContain('hidden')
    expect(inlineActions.className).not.toContain('group-hover/row:flex')
  })

  it('opens the session sheet from a held row', async () => {
    await renderPage()
    const title = screen.getByText('Fix login redirect loop').closest('button') as HTMLElement

    fireEvent.pointerDown(title, { pointerType: 'touch', clientX: 20, clientY: 20 })

    const sheet = await waitFor(
      () => {
        const found = screen.queryByText('Choose a session action.')?.closest('[data-bottom-sheet]')
        if (!found) throw new Error('no session sheet yet')
        return found as HTMLElement
      },
      { timeout: 1500 },
    )
    expect(within(sheet).getByRole('button', { name: 'Delete session…' })).toBeTruthy()
  })
})
describe('Sidebar page mode: section order', () => {
  const waiting = () => session('w-1', 'Approve the plan', { needs_input: true })
  const pin = () => session('p-1', 'Release notes', { pinned_at: '2026-05-14T00:00:00Z' })
  /** ``first`` comes before ``second`` in the document. */
  const before = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('puts Needs you first, then Pinned, then the workspaces', async () => {
    activeSessionsData = [waiting()]
    pinnedSessionsData = [pin()]
    const { view } = await renderPage()

    const header = view.container.querySelector('[data-sessions-page-header]') as HTMLElement
    const needsYou = screen.getByRole('region', { name: 'Needs you' })
    const pinned = screen.getByRole('region', { name: 'Pinned' })
    const workspaces = screen.getByRole('heading', { name: 'Workspaces' })

    // Under the large title and search field, above everything else.
    expect(before(header, needsYou)).toBe(true)
    expect(before(needsYou, pinned)).toBe(true)
    expect(before(pinned, workspaces)).toBe(true)
  })

  it('keeps the sidebar\'s own order: Pinned, then Needs you', async () => {
    activeSessionsData = [waiting()]
    pinnedSessionsData = [pin()]
    await renderSidebar({ mobileOpen: true })

    const needsYou = screen.getByRole('region', { name: 'Needs you' })
    const pinned = screen.getByRole('region', { name: 'Pinned' })
    expect(before(pinned, needsYou)).toBe(true)
    expect(before(needsYou, screen.getByRole('heading', { name: 'Workspaces' }))).toBe(true)
  })

  it('lists the waiting sessions once in Status grouping, as the sidebar does', async () => {
    activeSessionsData = [waiting()]
    useSidebarViewStore.setState({ groupBy: 'status' })
    await renderPage()

    // The group of the flat list itself, not a second section above it.
    expect(screen.getAllByRole('region', { name: 'Needs you' })).toHaveLength(1)
    expect(screen.getAllByText('Approve the plan')).toHaveLength(1)
  })

  // J2: the phone opens on "what needs me, what is running" before anything else.
  const working = () => session('r-1', 'Refactor auth middleware', { running: true })

  it('puts Running right under Needs you on the page', async () => {
    activeSessionsData = [waiting(), working()]
    pinnedSessionsData = [pin()]
    await renderPage()

    const needsYou = screen.getByRole('region', { name: 'Needs you' })
    const running = screen.getByRole('region', { name: 'Running' })
    expect(within(running).getByText('Refactor auth middleware')).toBeTruthy()
    expect(before(needsYou, running)).toBe(true)
    expect(before(running, screen.getByRole('region', { name: 'Pinned' }))).toBe(true)
  })

  it('shows no Running section when nothing runs', async () => {
    activeSessionsData = [waiting()]
    await renderPage()
    expect(screen.queryByRole('region', { name: 'Running' })).toBeNull()
  })

  it('lists running sessions once in Status grouping', async () => {
    activeSessionsData = [working()]
    useSidebarViewStore.setState({ groupBy: 'status' })
    await renderPage()
    expect(screen.getAllByText('Refactor auth middleware')).toHaveLength(1)
  })
})

describe('Sidebar page mode: deleting the chat kept under Sessions', () => {
  // ``currentSessionId`` is the chat the user popped back from. It is not on
  // screen, so deleting it must not open a fallback (a chat over Sessions).
  const keptChat = () => {
    workspaceSessionsData = [session('s-1', 'Fix login redirect loop'), session('s-2', 'Profile file listing')]
  }
  const confirmDelete = () => fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))

  it('does not navigate when the swipe action deletes it', async () => {
    keptChat()
    await renderPage({ currentSessionId: 's-1' })
    const swipeRow = swipeRowOf('Fix login redirect loop')
    swipeOpen(rowOf('Fix login redirect loop'))

    fireEvent.click(within(swipeRow).getByRole('button', { name: 'Delete' }))
    confirmDelete()

    expect(deleteSessionMutate).toHaveBeenCalledTimes(1)
    expect((deleteSessionMutate.mock.calls[0] as unknown as [{ id: string }])[0].id).toBe('s-1')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not navigate when the long-press menu deletes it', async () => {
    keptChat()
    await renderPage({ currentSessionId: 's-1' })

    const sheet = await openSessionSheet('Fix login redirect loop')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete session…' }))
    confirmDelete()

    expect(deleteSessionMutate).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not go back to it on Undo either', async () => {
    keptChat()
    await renderPage({ currentSessionId: 's-1' })
    const swipeRow = swipeRowOf('Fix login redirect loop')
    swipeOpen(rowOf('Fix login redirect loop'))
    fireEvent.click(within(swipeRow).getByRole('button', { name: 'Delete' }))
    confirmDelete()

    const undo = useToastStore.getState().toasts.find((toast) => toast.action?.label === 'Undo')
    expect(undo).toBeTruthy()
    act(() => undo?.action?.onAction())

    expect(navigate).not.toHaveBeenCalled()
  })

  it('still leaves for another session when the drawer deletes the open one', async () => {
    keptChat()
    await renderSidebar({ mobileOpen: true, currentSessionId: 's-1' })

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Fix login redirect loop' }))
    fireEvent.click(within(screen.getByText('Choose a session action.').closest('[data-bottom-sheet]') as HTMLElement).getByRole('button', { name: 'Delete session…' }))
    confirmDelete()

    expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 's-2' }, replace: true })
  })

  it('applySessionDelete keeps the screen with `stay`, and opens the fallback without it', async () => {
    const { applySessionDelete } = await import('@/components/Sidebar.sessions')
    const target = session('s-1', 'Open one') as never
    const others = [target, session('s-2', 'Other')] as never[]
    const stayNav = mock(() => {})
    const mutate = mock(() => {})

    applySessionDelete({ deleteTarget: target, currentSessionId: 's-1', workspaceSessions: others, stay: true, mutateDelete: mutate, navigate: stayNav })
    expect(mutate).toHaveBeenCalledWith('s-1')
    expect(stayNav).not.toHaveBeenCalled()

    applySessionDelete({ deleteTarget: target, currentSessionId: 's-1', workspaceSessions: others, mutateDelete: mutate, navigate: stayNav })
    expect(stayNav).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 's-2' }, replace: true })
  })
})

describe('Sidebar without page mode', () => {
  it('stays the drawer: scrim, New session row, footer icons, no toolbar and no large title', async () => {
    const { view } = await renderSidebar({ mobileOpen: true })

    expect(view.container.querySelector('[data-edge-drawer-scrim="sidebar"]')).toBeTruthy()
    expect(pageEl(view.container).getAttribute('data-edge-drawer')).toBe('sidebar')
    expect(pageEl(view.container).hasAttribute('data-sidebar-page')).toBe(false)
    expect(view.container.querySelector('[data-sidebar-new-session]')).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: 'Sessions' })).toBeNull()
    expect(view.container.querySelector('[data-sessions-page-toolbar]')).toBeNull()
    expect(view.container.querySelector('[data-sessions-page-bar]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Scheduled' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Scheduled' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings' }).textContent).toBe('')
    expect(screen.getByRole('button', { name: /^Theme:/ })).toBeTruthy()
    expect(view.container.querySelector('[data-swipe-row]')).toBeNull()
  })

  it('is not a page on a desktop window either', async () => {
    isMobile = false
    const { view } = await renderSidebar()

    expect(view.container.querySelector('[data-sidebar-page]')).toBeNull()
    expect(view.container.querySelector('[data-swipe-row]')).toBeNull()
    expect(screen.queryByRole('heading', { level: 1, name: 'Sessions' })).toBeNull()
  })
})
