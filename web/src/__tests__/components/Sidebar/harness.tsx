/**
 * The world a sidebar test renders in: the mocked platform, router, motion,
 * icons, dialogs and session queries, a fake backend behind ``fetch``, and
 * the helpers that render ``Sidebar`` and let its workspace tree load. A test
 * sets what the backend answers through ``fx`` and calls
 * ``resetSidebarHarness`` / ``cleanupSidebarHarness`` around each case.
 */
import { mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiBaseUrl } from '@/api/base-url'
import { queryKeys } from '@/queries'
import { useAgentStore } from '@/stores/useAgentStore'
import { useUnreadStore } from '@/stores/useUnreadStore'
import { useSidebarViewStore } from '@/stores/useSidebarViewStore'
import { runOf } from '@/stores/useAgentStore/run-state'

export const navigate = mock(() => {})
export const originalFetch = globalThis.fetch
export const browseResponse = {
  path: '/repo/project',
  parent: '/repo',
  directories: [],
}
export const dialogOpen = mock(async () => '/repo/project')
export const invokeMock = mock(async () => undefined)
export const deleteSessionMutate = mock(() => {})
export const updateSessionTitleMutate = mock(() => {})
export type TestSession = {
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
  sent_from?: { session_id: string; workspace: string; title?: string | null } | null
  linked_sessions?: TestSession[]
}

/** What the mocks below and the test's backend answer with; each test sets its own. */
export const fx = {
  isTauri: true,
  platformOs: 'macos',
  isMobile: false,
  validateError: null as Error | null,
  appBackendStatus: {
    base_url: 'http://127.0.0.1:4082',
    sidecar_running: true,
    external: false,
    supports_bundled: true,
    servers: [] as unknown[],
  } as { base_url: string; sidecar_running: boolean; external: boolean; supports_bundled: boolean; servers: unknown[] } | null,
  sessionsData: [] as TestSession[],
  workspaceSessionsData: [] as TestSession[],
  activeSessionsData: [] as TestSession[],
  searchResultsData: [] as TestSession[],
  pinnedSessionsData: [] as TestSession[],
  allSessionsData: [] as TestSession[],
  allSessionsQueryArgs: [] as string[],
  searchQueries: [] as string[],
  workspaceHasNextPage: false,
  workspaceIsFetchingNextPage: false,
  /** What each repository list asked for: one path, or several checkouts. */
  workspaceQueryArgs: [] as Array<string | readonly string[]>,
  chatWorkspaceEntry: null as { path: string; name: string } | null,
  /** Paths the backend has hidden: ``PATCH …/visibility`` adds, a resolve removes. */
  hiddenWorkspacePaths: new Set<string>(),
  /** Worktrees the backend lists under each repository. */
  worktreesByRepo: {} as Record<string, Array<{ path: string; name: string; managed: boolean }>>,
  /** Workspace groups the backend knows, and each repository's tags. */
  workspaceGroupsData: [] as Array<{ id: string; name: string; brief: string | null }>,
  groupIdsByRepo: {} as Record<string, string[]>,
  setGroupsRequests: [] as Array<{ workspace: string; group_ids: string[] }>,
  /** Workspaces the tree reports as plain folders (not in a Git working tree). */
  plainFolders: new Set<string>(),
}

export const setSessionPinnedMutate = mock(() => {})
export const fetchWorkspaceNextPage = mock(() => {})
export const workspaceTreeResponse = () => ({
  repositories: Array.from(new Set(fx.sessionsData.filter((session) => session.mode === 'coding' && session.workspace).map((session) => session.workspace as string)))
    .map((path) => ({
      path,
      name: path.split('/').pop() || path,
      worktrees: (fx.worktreesByRepo[path] ?? []).filter((item) => !fx.hiddenWorkspacePaths.has(item.path)),
      group_ids: fx.groupIdsByRepo[path] ?? [],
      git: !fx.plainFolders.has(path),
    }))
    // Like the backend, a hidden repository still contains its visible worktrees.
    .filter((repo) => !fx.hiddenWorkspacePaths.has(repo.path) || repo.worktrees.length > 0),
  chat: fx.chatWorkspaceEntry,
  groups: fx.workspaceGroupsData,
})

class IntersectionObserverStub {
  private callback: IntersectionObserverCallback

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
  }

  observe(target: Element) {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }

  disconnect() {}
}

globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver

/**
 * A repository's worktree chip: a branch icon and the count, named "3 worktrees",
 * which opens the checkout menu. The filter it applies is in its description.
 */
export const WORKTREE_CHIP = { name: /^\d+ (worktrees?|folders?)( · \d+ folders?)?$/ }
export const worktreeChip = () => screen.getByRole('button', WORKTREE_CHIP)

mock.module('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: fx.isTauri, os: fx.platformOs, isMacOverlay: fx.isTauri && fx.platformOs === 'macos' }),
  getPlatform: () => ({ isTauri: fx.isTauri, os: fx.platformOs, isMacOverlay: fx.isTauri && fx.platformOs === 'macos' }),
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => fx.isMobile,
}))

mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => false,
  // The phone's session-actions bottom sheet drags to close.
  useDragControls: () => ({ start: () => {} }),
  motion: {
    aside: ({ children, animate, initial, exit, transition, ...props }: React.ComponentProps<'aside'> & { animate?: unknown; initial?: unknown; exit?: unknown; transition?: unknown }) => {
      void initial
      void exit
      return <aside data-animate={JSON.stringify(animate)} data-transition={JSON.stringify(transition)} {...props}>{children}</aside>
    },
    div: ({ children, initial, animate, exit, transition, drag, dragConstraints, dragElastic, dragControls, dragListener, onDragEnd, ...props }: React.ComponentProps<'div'> & { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown; drag?: unknown; dragConstraints?: unknown; dragElastic?: unknown; dragControls?: unknown; dragListener?: unknown; onDragEnd?: unknown }) => {
      void initial
      void animate
      void exit
      void transition
      void drag
      void dragConstraints
      void dragElastic
      void dragControls
      void dragListener
      void onDragEnd
      return <div {...props}>{children}</div>
    },
  },
}))

mock.module('@tauri-apps/plugin-dialog', () => ({
  open: dialogOpen,
}))

mock.module('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

mock.module('@/lib/app-backend', () => ({
  getAppBackendStatus: mock(async () => fx.appBackendStatus),
}))

const Icon = () => null
mock.module('lucide-react', () => ({
  SlidersHorizontal: Icon, Activity: Icon,
  AlertCircle: Icon, AlertTriangle: Icon, CheckCircle2: Icon, Info: Icon,
  AppWindow: Icon,
  ArrowLeft: Icon,
  ArrowUpRight: Icon,
  Bot: Icon,
  Check: Icon,
  ChevronDown: Icon,
  ChevronLeft: Icon,
  ChevronRight: Icon,
  ChevronsDownUp: Icon,
  Clock: Icon,
  Command: Icon,
  CornerLeftUp: Icon,
  Copy: Icon,
  Download: Icon,
  ExternalLink: Icon, WrapText: Icon,
  FileText: Icon,
  CircleHelp: Icon,
  Folder: Icon,
  FolderPlus: Icon,
  FolderSearch: Icon,
  GitBranch: Icon,
  GitCompare: Icon,
  Globe: Icon,
  HelpCircle: Icon,
  Home: Icon,
  Link: Icon,
  ListFilter: Icon,
  Loader2: Icon,
  MessageCircle: Icon,
  Monitor: Icon,
  Moon: Icon,
  MoreHorizontal: Icon,
  Pin: Icon,
  PinOff: Icon,
  Plus: Icon,
  Search: Icon,
  Share: Icon,
  SquarePen: Icon,
  Sun: Icon,
  Settings: Icon,
  Settings2: Icon,
  Pencil: Icon,
  Target: Icon,
  Trash2: Icon,
  TriangleAlert: Icon,
  X: Icon,
}))

mock.module('@/components/ThemeToggle', () => ({
  ThemeToggle: () => <button aria-label="Theme: System. Switch to Light." />,
}))

mock.module('@/components/HealthDot', () => ({
  HealthDot: ({ labeled = false }: { labeled?: boolean }) => (
    <button type="button" aria-label={labeled ? 'Connected. Change computer' : 'backend-name. Connected. Change computer'}>{labeled ? 'backend-name' : null}</button>
  ),
}))

mock.module('@/components/ui/button', () => ({
  Button: ({ children, variant, ...props }: React.ComponentProps<'button'> & { variant?: string }) => {
    void variant
    return <button {...props}>{children}</button>
  },
  buttonVariants: () => '',
}))

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  // Records what the sidebar asks of the real primitives: whether the built-in
  // × is on, and any class a footer or header overrides its layout with.
  DialogContent: ({ children, showCloseButton = true }: { children: React.ReactNode; showCloseButton?: boolean }) => (
    <div data-dialog-content="" data-show-close={String(showCloseButton)}>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children, className }: { children: React.ReactNode; className?: string }) => <div data-slot="dialog-footer" data-class={className ?? ''}>{children}</div>,
  DialogHeader: ({ children, className }: { children: React.ReactNode; className?: string }) => <div data-slot="dialog-header" data-class={className ?? ''}>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

mock.module('@/queries/useSessionsQuery', () => ({
  queryKeys: {
    team: {
      sessions: {
        infinite: () => ['session', 'sessions', 'infinite'],
        workspace: (workspace: string) => ['session', 'sessions', 'workspace', workspace],
      },
    },
  },
  useSessionsQuery: () => ({
    data: { pages: [{ data: fx.sessionsData }] },
    isFetching: false,
    refetch: mock(() => {}),
  }),
  useWorkspaceSessionsQuery: (workspace: string | readonly string[]) => {
    fx.workspaceQueryArgs.push(workspace)
    return {
      data: { pages: [{ data: fx.workspaceSessionsData }] },
      isLoading: false,
      hasNextPage: fx.workspaceHasNextPage,
      isFetchingNextPage: fx.workspaceIsFetchingNextPage,
      fetchNextPage: fetchWorkspaceNextPage,
    }
  },
  useActiveSessionsQuery: () => ({
    data: { pages: [{ data: fx.activeSessionsData }] },
  }),
  usePinnedSessionsQuery: () => ({
    data: { pages: [{ data: fx.pinnedSessionsData }] },
  }),
  useAllSessionsQuery: () => {
    fx.allSessionsQueryArgs.push('called')
    return {
      data: { pages: [{ data: fx.allSessionsData }] },
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: mock(() => {}),
    }
  },
  useSetSessionPinnedMutation: () => ({ mutate: setSessionPinnedMutate }),
  useSessionSearchQuery: (query: string) => {
    fx.searchQueries.push(query)
    return { data: query ? { pages: [{ data: fx.searchResultsData, has_more: false }] } : undefined, isFetching: false }
  },
  useDeleteSessionMutation: () => ({ mutate: deleteSessionMutate }),
  useUpdateSessionTitleMutation: () => ({
    mutate: updateSessionTitleMutate,
    isPending: false,
    isError: false,
  }),
}))

export function resetSidebarHarness() {
  localStorage.clear()
  useUnreadStore.setState({ ids: [] })
  fx.sessionsData = []
  fx.workspaceSessionsData = []
  fx.activeSessionsData = []
  fx.searchResultsData = []
  fx.pinnedSessionsData = []
  fx.allSessionsData = []
  fx.allSessionsQueryArgs = []
  setSessionPinnedMutate.mockClear()
  fx.searchQueries = []
  fx.chatWorkspaceEntry = null
  fx.hiddenWorkspacePaths = new Set()
  fx.worktreesByRepo = {}
  fx.workspaceGroupsData = []
  fx.groupIdsByRepo = {}
  fx.plainFolders = new Set()
  fx.setGroupsRequests = []
  useSidebarViewStore.setState({ groupFilter: null })
  fx.workspaceHasNextPage = false
  fx.workspaceIsFetchingNextPage = false
  fx.workspaceQueryArgs = []
  fx.isTauri = true
  fx.platformOs = 'macos'
  fx.isMobile = false
  setApiBaseUrl('')
  fx.appBackendStatus = {
    base_url: 'http://127.0.0.1:4082',
    sidecar_running: true,
    external: false,
    supports_bundled: true,
    servers: [],
  }
  useAgentStore.setState({ sessionRun: runOf(false), sessionId: null })
  navigate.mockClear()
  invokeMock.mockClear()
  dialogOpen.mockReset()
  dialogOpen.mockImplementation(async () => '/repo/project')
  deleteSessionMutate.mockClear()
  updateSessionTitleMutate.mockClear()
  fetchWorkspaceNextPage.mockClear()
  fx.validateError = null
  globalThis.fetch = mock(async (input: unknown, init: unknown) => {
    const url = String(input)
    if (url.includes('/api/agent/workspace/browse')) {
      return new Response(JSON.stringify(browseResponse))
    }
    if (url.endsWith('/api/agent/workspace/visibility')) {
      const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as { workspace: string; hidden: boolean }
      if (body.hidden) fx.hiddenWorkspacePaths.add(body.workspace)
      else fx.hiddenWorkspacePaths.delete(body.workspace)
      return new Response(JSON.stringify(body))
    }
    if (url.includes('/api/agent/workspace/validate')) {
      if (fx.validateError) {
        return new Response(JSON.stringify({ detail: fx.validateError.message }), { status: 422 })
      }
      return new Response(JSON.stringify({ workspace: '/repo/project' }))
    }
    if (url.includes('/api/agent/workspace/worktrees')) {
      return new Response(JSON.stringify([]))
    }
    if (url.endsWith('/api/agent/workspace/groups/members')) {
      const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as { workspace: string; group_ids: string[] }
      fx.setGroupsRequests.push(body)
      fx.groupIdsByRepo[body.workspace] = body.group_ids
      return new Response(JSON.stringify(body))
    }
    if (url.endsWith('/api/agent/workspace/groups')) {
      const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as { name: string; brief: string | null }
      const group = { id: `g-${body.name}`, name: body.name, brief: body.brief }
      fx.workspaceGroupsData = [...fx.workspaceGroupsData, group]
      return new Response(JSON.stringify({ ...group, members: [] }))
    }
    if (url.includes('/api/agent/workspace/tree')) {
      return new Response(JSON.stringify(workspaceTreeResponse()))
    }
    // No scheduled task, as on a new install; a test with tasks answers this itself.
    if (url.includes('/api/scheduler/tasks')) {
      return new Response(JSON.stringify({ tasks: [] }))
    }
    if (url.endsWith('/api/agent/sessions/resolve')) {
      // Resolving a session in a workspace un-hides it.
      fx.hiddenWorkspacePaths.delete('/repo/project')
      return new Response(JSON.stringify({
        id: 'resolved-session',
        title: null,
        agent_name: null,
        mode: 'coding',
        workspace: '/repo/project',
        created_at: null,
        updated_at: null,
        created: true,
      }))
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
}

export function cleanupSidebarHarness() {
  cleanup()
  globalThis.fetch = originalFetch
}

/**
 * Let the first workspace-tree fetch land. Query observers hear about it on
 * a timer, so a single microtask is not enough.
 */
export async function settleWorkspaceTree(queryClient: QueryClient) {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 20 && queryClient.getQueryState(queryKeys.coding.tree())?.status !== 'success'; i += 1) {
    await act(tick)
  }
  await act(tick)
}

export async function renderSidebar() {
  const { Sidebar } = await import('@/components/Sidebar')
  const queryClient = new QueryClient()
  let view: ReturnType<typeof render> | undefined
  await act(async () => {
    view = render(
      <QueryClientProvider client={queryClient}>
        <Sidebar openWorkspaceDialogKey={1} />
      </QueryClientProvider>,
    )
    await Promise.resolve()
  })
  await settleWorkspaceTree(queryClient)
  return view
}

export async function renderSidebarForSessions(currentSessionId?: string) {
  const { Sidebar } = await import('@/components/Sidebar')
  const queryClient = new QueryClient()
  let view: ReturnType<typeof render> | undefined
  await act(async () => {
    view = render(
      <QueryClientProvider client={queryClient}>
        <Sidebar currentSessionId={currentSessionId} workspace="/repo/project" />
      </QueryClientProvider>,
    )
    await Promise.resolve()
  })
  await settleWorkspaceTree(queryClient)
  return view
}

export async function renderSidebarWithProps(props: React.ComponentProps<typeof import('@/components/Sidebar').Sidebar>) {
  const { Sidebar } = await import('@/components/Sidebar')
  const queryClient = new QueryClient()
  let view: ReturnType<typeof render> | undefined
  await act(async () => {
    view = render(
      <QueryClientProvider client={queryClient}>
        <Sidebar {...props} />
      </QueryClientProvider>,
    )
    await Promise.resolve()
  })
  await settleWorkspaceTree(queryClient)
  return view!
}
