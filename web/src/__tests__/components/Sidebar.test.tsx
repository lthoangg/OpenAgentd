import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiBaseUrl } from '@/api/base-url'
import { queryKeys } from '@/queries'
import { loadLastWorkspace, loadWorkspaces, saveLastWorkspace } from '@/utils/workspace'
import { useAgentStore } from '@/stores/useAgentStore'
import { createDefaultAgentStream } from '@/stores/useAgentStore/defaults'
import { useUnreadStore } from '@/stores/useUnreadStore'
import { useUIStore } from '@/stores/useUIStore'
import { useSidebarViewStore } from '@/stores/useSidebarViewStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { APP_EVENTS } from '@/lib/app-events'
import {
  addExpandedPaths,
  buildWorktreeSourceByDirectory,
  groupSessionsByWorkspace,
  repositoryCheckouts,
  sourceWorkspacePaths,
  toggleExpandedPath,
  visibleNestedWorktrees,
} from '@/components/Sidebar.helpers'
import {
  loadWorkspaceBrowser,
  shouldUseServerWorkspaceBrowser,
  validateTrustedWorkspace,
} from '@/components/Sidebar.browser'
import {
  applySessionDelete,
  applySessionSelection,
  getFallbackSessionAfterDelete,
} from '@/components/Sidebar.sessions'
import {
  confirmWorkspaceRemoval,
  openWorkspaceDraft,
  openWorkspaceLatest,
} from '@/components/Sidebar.workspace'
import {
  consumeTrustedWorkspace,
  selectTrustedWorkspace,
} from '@/components/Sidebar.trust'
import {
  beginWorktreeTitleEdit,
  buildOpenWorktreeDialogState,
  prepareWorktreeRename,
  submitWorktreeRename,
} from '@/components/Sidebar.worktree-dialog'
import {
  openSessionInNewWindow,
  sessionWindowErrorDescription,
  shouldOpenSessionInNewWindow,
} from '@/components/Sidebar.window'
import {
  loadWorktreesForSource,
  recoverCreatedWorktreeAfterTransientError,
  removeManagedWorktree,
} from '@/components/Sidebar.worktrees'

const navigate = mock(() => {})
const originalFetch = globalThis.fetch
const browseResponse = {
  path: '/repo/project',
  parent: '/repo',
  directories: [],
}
const dialogOpen = mock(async () => '/repo/project')
const invokeMock = mock(async () => undefined)
let isTauri = true
let platformOs = 'macos'
let isMobile = false
let validateError: Error | null = null
let appBackendStatus: { base_url: string; sidecar_running: boolean; external: boolean; supports_bundled: boolean; servers: unknown[] } | null = {
  base_url: 'http://127.0.0.1:4082',
  sidecar_running: true,
  external: false,
  supports_bundled: true,
  servers: [],
}
const deleteSessionMutate = mock(() => {})
const updateSessionTitleMutate = mock(() => {})
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
}

let sessionsData: TestSession[] = []
let workspaceSessionsData: TestSession[] = []
let activeSessionsData: TestSession[] = []
let searchResultsData: TestSession[] = []
let pinnedSessionsData: TestSession[] = []
let allSessionsData: TestSession[] = []
let allSessionsQueryArgs: string[] = []
const setSessionPinnedMutate = mock(() => {})
let searchQueries: string[] = []
let workspaceHasNextPage = false
let workspaceIsFetchingNextPage = false
/** What each repository list asked for: one path, or several checkouts. */
let workspaceQueryArgs: Array<string | readonly string[]> = []
const fetchWorkspaceNextPage = mock(() => {})
let chatWorkspaceEntry: { path: string; name: string } | null = null
/** Paths the backend has hidden: ``PATCH …/visibility`` adds, a resolve removes. */
let hiddenWorkspacePaths = new Set<string>()
/** Worktrees the backend lists under each repository. */
let worktreesByRepo: Record<string, Array<{ path: string; name: string; managed: boolean }>> = {}
/** Workspace groups the backend knows, and each repository's tags. */
let workspaceGroupsData: Array<{ id: string; name: string; brief: string | null }> = []
let groupIdsByRepo: Record<string, string[]> = {}
let setGroupsRequests: Array<{ workspace: string; group_ids: string[] }> = []
const workspaceTreeResponse = () => ({
  repositories: Array.from(new Set(sessionsData.filter((session) => session.mode === 'coding' && session.workspace).map((session) => session.workspace as string)))
    .map((path) => ({
      path,
      name: path.split('/').pop() || path,
      worktrees: (worktreesByRepo[path] ?? []).filter((item) => !hiddenWorkspacePaths.has(item.path)),
      group_ids: groupIdsByRepo[path] ?? [],
    }))
    // Like the backend, a hidden repository still contains its visible worktrees.
    .filter((repo) => !hiddenWorkspacePaths.has(repo.path) || repo.worktrees.length > 0),
  chat: chatWorkspaceEntry,
  groups: workspaceGroupsData,
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

mock.module('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri, os: platformOs, isMacOverlay: isTauri && platformOs === 'macos' }),
  getPlatform: () => ({ isTauri, os: platformOs, isMacOverlay: isTauri && platformOs === 'macos' }),
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => false,
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

mock.module('@tauri-apps/plugin-dialog', () => ({
  open: dialogOpen,
}))

mock.module('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

mock.module('@/lib/app-backend', () => ({
  getAppBackendStatus: mock(async () => appBackendStatus),
}))

const Icon = () => null
mock.module('lucide-react', () => ({
  Activity: Icon,
  Check: Icon,
  ChevronDown: Icon,
  ChevronRight: Icon,
  ChevronsDownUp: Icon,
  Clock: Icon,
  Copy: Icon,
  Download: Icon,
  ExternalLink: Icon,
  FileText: Icon,
  CircleHelp: Icon,
  Folder: Icon,
  FolderPlus: Icon,
  GitBranch: Icon,
  GitCompare: Icon,
  Globe: Icon,
  HelpCircle: Icon,
  Home: Icon,
  ListFilter: Icon,
  Loader2: Icon,
  MessageCircle: Icon,
  MoreHorizontal: Icon,
  Pin: Icon,
  PinOff: Icon,
  Plus: Icon,
  Search: Icon,
  SquarePen: Icon,
  Settings: Icon,
  Settings2: Icon,
  Pencil: Icon,
  Trash2: Icon,
  X: Icon,
}))

mock.module('@/components/ThemeToggle', () => ({
  ThemeToggle: () => <button aria-label="Theme: System. Click to cycle." />,
}))

mock.module('@/components/HealthDot', () => ({
  HealthDot: ({ labeled = false }: { labeled?: boolean }) => (
    <div aria-label="Connected">{labeled ? 'backend-name' : null}</div>
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
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
    data: { pages: [{ data: sessionsData }] },
    isFetching: false,
    refetch: mock(() => {}),
  }),
  useWorkspaceSessionsQuery: (workspace: string | readonly string[]) => {
    workspaceQueryArgs.push(workspace)
    return {
      data: { pages: [{ data: workspaceSessionsData }] },
      isLoading: false,
      hasNextPage: workspaceHasNextPage,
      isFetchingNextPage: workspaceIsFetchingNextPage,
      fetchNextPage: fetchWorkspaceNextPage,
    }
  },
  useActiveSessionsQuery: () => ({
    data: { pages: [{ data: activeSessionsData }] },
  }),
  usePinnedSessionsQuery: () => ({
    data: { pages: [{ data: pinnedSessionsData }] },
  }),
  useAllSessionsQuery: (sort: string) => {
    allSessionsQueryArgs.push(sort)
    return {
      data: { pages: [{ data: allSessionsData }] },
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: mock(() => {}),
    }
  },
  useSetSessionPinnedMutation: () => ({ mutate: setSessionPinnedMutate }),
  useSessionSearchQuery: (query: string) => {
    searchQueries.push(query)
    return { data: query ? { pages: [{ data: searchResultsData, has_more: false }] } : undefined, isFetching: false }
  },
  useDeleteSessionMutation: () => ({ mutate: deleteSessionMutate }),
  useUpdateSessionTitleMutation: () => ({
    mutate: updateSessionTitleMutate,
    isPending: false,
    isError: false,
  }),
}))

describe('Sidebar helpers', () => {
  it('exports workspace browser helpers used by the component', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/browse')) {
        return new Response(JSON.stringify(browseResponse))
      }
      if (url.includes('/api/agent/workspace/validate')) {
        return new Response(JSON.stringify({ workspace: '/repo/project' }))
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch

    expect(await loadWorkspaceBrowser()).toEqual(browseResponse)
    expect(await validateTrustedWorkspace('/repo/project')).toBe('/repo/project')

    isTauri = false
    expect(await shouldUseServerWorkspaceBrowser(isTauri, false)).toBe(true)

    isTauri = true
    appBackendStatus = {
      base_url: 'https://remote.example.com',
      sidecar_running: false,
      external: true,
      supports_bundled: false,
      servers: [],
    }
    expect(await shouldUseServerWorkspaceBrowser(isTauri, false)).toBe(true)

    globalThis.fetch = originalFetch
  })

  it('toggles expanded paths and can batch-add active paths', () => {
    expect([...toggleExpandedPath(new Set<string>(), '/repo')]).toEqual(['/repo'])
    expect([...toggleExpandedPath(new Set<string>(['/repo']), '/repo')]).toEqual([])
    expect([...addExpandedPaths(new Set<string>(), ['/repo', null, '/worktree'])]).toEqual([
      '/repo',
      '/worktree',
    ])
  })

  it('builds worktree source lookup and filters removed worktrees', () => {
    const workspaceTree = [
      {
        path: '/repo',
        name: 'repo',
        worktrees: [
          { path: '/repo-wt', name: 'repo-wt', managed: true },
        ],
      },
    ]
    const removed = new Set<string>(['/repo-wt'])
    const sources = buildWorktreeSourceByDirectory(workspaceTree)

    expect(sources.get('/repo-wt')).toBe('/repo')
    expect(sourceWorkspacePaths(workspaceTree, removed)).toEqual(['/repo'])
    expect(visibleNestedWorktrees(workspaceTree[0], removed)).toEqual([])
  })

  it('lists every checkout of a repository unless one is selected', () => {
    const repository = {
      path: '/repo',
      name: 'repo',
      worktrees: [
        { path: '/wt/a', name: 'a', managed: true },
        { path: '/wt/b', name: 'b', managed: false },
      ],
    }
    const none = new Set<string>()

    const all = repositoryCheckouts('/repo', repository, none, undefined)
    expect(all.selected).toBeNull()
    expect(all.selectedWorktree).toBeNull()
    expect(all.listPaths).toEqual(['/repo', '/wt/a', '/wt/b'])
    expect([...all.worktreeNames]).toEqual([['/wt/a', 'a'], ['/wt/b', 'b']])

    const oneWorktree = repositoryCheckouts('/repo', repository, none, '/wt/b')
    expect(oneWorktree.selected).toBe('/wt/b')
    expect(oneWorktree.selectedWorktree?.name).toBe('b')
    expect(oneWorktree.listPaths).toEqual(['/wt/b'])

    const mainOnly = repositoryCheckouts('/repo', repository, none, '/repo')
    expect(mainOnly.selected).toBe('/repo')
    expect(mainOnly.selectedWorktree).toBeNull()
    expect(mainOnly.listPaths).toEqual(['/repo'])

    // A selection that no longer exists (removed or unknown) falls back to all.
    const removed = repositoryCheckouts('/repo', repository, new Set(['/wt/a']), '/wt/a')
    expect(removed.selected).toBeNull()
    expect(removed.listPaths).toEqual(['/repo', '/wt/b'])
    expect(repositoryCheckouts('/chat', undefined, none, '/elsewhere').listPaths).toEqual(['/chat'])
  })

  it('groups sessions by workspace and drops sessions without one', () => {
    const makeSession = (id: string, workspace: string | null) => ({
      id,
      title: null,
      agent_name: null,
      created_at: null,
      updated_at: null,
      workspace,
    })

    const sessions = [
      makeSession('a', '/repo'),
      makeSession('b', '/repo-wt'),
      makeSession('c', '/repo'),
      makeSession('d', null),
    ]

    const byWorkspace = groupSessionsByWorkspace(sessions)

    expect(byWorkspace.get('/repo')?.map((s) => s.id)).toEqual(['a', 'c'])
    expect(byWorkspace.get('/repo-wt')?.map((s) => s.id)).toEqual(['b'])
    expect([...byWorkspace.keys()]).toEqual(['/repo', '/repo-wt'])
  })

  it('exports worktree helpers used by the component', async () => {
    expect(await loadWorktreesForSource('/repo', async () => [{
      name: 'task-a',
      directory: '/repo/task-a',
      branch: 'feat',
      managed: true,
    }])).toEqual([{ name: 'task-a', directory: '/repo/task-a', branch: 'feat', managed: true }])

    expect(await loadWorktreesForSource('/repo', async () => { throw new Error('boom') })).toEqual([])

    const removed = await removeManagedWorktree(
      { name: 'task-a', directory: '/repo/task-a', branch: 'feat', managed: true },
      {
        worktreeTarget: '/repo',
        worktreeSourceByDirectory: new Map([['/repo/task-a', '/repo']]),
        loadWorktreesForSource: async () => [],
        refreshWorkspaceTree: async () => undefined,
        removeWorktreeFn: async () => undefined,
      },
    )
    expect(removed?.removedDirectory).toBe('/repo/task-a')

    const recovered = await recoverCreatedWorktreeAfterTransientError({
      error: new TypeError('Failed to fetch'),
      worktreeTarget: '/repo',
      worktreeName: 'task a',
      loadWorktreesForSource: async () => [{
        name: 'task-a',
        directory: '/repo/task-a',
        branch: 'feat',
        managed: true,
      }],
      refreshWorkspaceTree: async () => undefined,
      navigate: () => undefined,
      onMobileClose: () => undefined,
    })
    expect(recovered).toEqual({ kind: 'recovered', workspace: '/repo/task-a' })
  })

  it('exports session helpers used by the component', () => {
    const session = {
      id: 'session-1',
      title: 'Session one',
      agent_name: 'lead',
      created_at: '2026-05-13T00:00:00Z',
      updated_at: '2026-05-13T00:00:00Z',
      mode: 'coding',
      workspace: '/repo/project',
    }
    const fallback = getFallbackSessionAfterDelete(
      session,
      'session-1',
      [
        session,
        {
          id: 'session-2',
          title: 'Session two',
          agent_name: 'lead',
          created_at: '2026-05-12T00:00:00Z',
          updated_at: '2026-05-12T00:00:00Z',
          mode: 'coding',
          workspace: '/repo/project',
        },
      ],
    )
    expect(fallback?.id).toBe('session-2')

    const selectionNavigate = mock(() => {})
    const onMobileClose = mock(() => {})
    applySessionSelection({
      session,
      workspacePath: '/repo/project',
      navigate: selectionNavigate,
      onMobileClose,
    })
    expect(selectionNavigate).toHaveBeenCalledWith({
      to: '/$sessionId',
      params: { sessionId: 'session-1' },
    })
    expect(onMobileClose).toHaveBeenCalled()

    const deleteNavigate = mock(() => {})
    const mutateDelete = mock(() => {})
    applySessionDelete({
      deleteTarget: session,
      currentSessionId: 'session-1',
      workspaceSessions: [
        session,
        {
          id: 'session-2',
          title: 'Session two',
          agent_name: 'lead',
          created_at: '2026-05-12T00:00:00Z',
          updated_at: '2026-05-12T00:00:00Z',
          mode: 'coding',
          workspace: '/repo/project',
        },
      ],
      mutateDelete,
      navigate: deleteNavigate,
    })
    expect(mutateDelete).toHaveBeenCalledWith('session-1')
    expect(deleteNavigate).toHaveBeenCalledWith({
      to: '/$sessionId',
      params: { sessionId: 'session-2' },
      replace: true,
    })
  })

  it('exports workspace helpers used by the component', async () => {
    const selectionNavigate = mock(() => {})
    // A workspace with sessions opens its latest one.
    await openWorkspaceLatest({
      path: '/repo/project',
      navigate: selectionNavigate,
      listSessionsFn: async () => ({
        data: [{ id: 'latest-session', title: null, agent_name: null, workspace: '/repo/project', created_at: null, updated_at: null }],
        next_cursor: null,
        has_more: false,
      }),
    })
    expect(selectionNavigate).toHaveBeenCalledWith({
      to: '/$sessionId',
      params: { sessionId: 'latest-session' },
    })

    // One without sessions opens a draft; nothing is created.
    const draftNavigate = mock((..._args: unknown[]) => {})
    await openWorkspaceLatest({
      path: '/repo/empty',
      navigate: draftNavigate,
      listSessionsFn: async () => ({ data: [], next_cursor: null, has_more: false }),
    })
    expect(draftNavigate).toHaveBeenCalledWith({ to: '/', search: { workspace: '/repo/empty' }, replace: false })

    // Open folder on a folder the sidebar does not list registers it first.
    const setVisibility = mock(async (..._args: unknown[]) => ({ workspace: '/repo/new', hidden: false, updated: 0 }))
    let refreshCount = 0
    const folderNavigate = mock((..._args: unknown[]) => {})
    await openWorkspaceDraft({
      path: '/repo/new',
      listed: false,
      refreshWorkspaceTree: async () => { refreshCount += 1 },
      navigate: folderNavigate,
      setCodingWorkspaceVisibilityFn: setVisibility as never,
    })
    expect(setVisibility).toHaveBeenCalledWith('/repo/new', false)
    expect(refreshCount).toBe(1)
    expect(folderNavigate).toHaveBeenCalledWith({ to: '/', search: { workspace: '/repo/new' }, replace: false })
    await openWorkspaceDraft({
      path: '/repo/listed',
      listed: true,
      refreshWorkspaceTree: async () => { refreshCount += 1 },
      navigate: folderNavigate,
      setCodingWorkspaceVisibilityFn: setVisibility as never,
    })
    expect(setVisibility).toHaveBeenCalledTimes(1)
    expect(refreshCount).toBe(1)

    const removeNavigate = mock(() => {})
    const nextExpanded = await confirmWorkspaceRemoval({
      path: '/repo/project',
      activeWorkspace: '/repo/project',
      expandedWorkspaces: new Set<string>(['/repo/project', '/repo/other']),
      queryClient: new QueryClient(),
      refreshWorkspaceTree: async () => undefined,
      navigate: removeNavigate,
      setCodingWorkspaceVisibilityFn: async () => ({
        workspace: '/repo/project',
        hidden: true,
        updated: 1,
      }),
    })
    expect(nextExpanded.has('/repo/project')).toBe(false)
    expect(nextExpanded.has('/repo/other')).toBe(true)
    expect(removeNavigate).toHaveBeenCalledWith({ to: '/', replace: true })
  })

  it('exports worktree dialog helpers used by the component', async () => {
    expect(buildOpenWorktreeDialogState('/repo/project', [{
      name: 'task-a',
      directory: '/repo/project/task-a',
      branch: 'feat',
      managed: true,
    }])).toEqual({
      target: '/repo/project',
      name: '',
      branch: '',
      options: [{
        name: 'task-a',
        directory: '/repo/project/task-a',
        branch: 'feat',
        managed: true,
      }],
      removing: null,
      error: null,
    })

    const editState = beginWorktreeTitleEdit({
      name: 'task-a',
      directory: '/repo/project/task-a',
      branch: 'feat',
      managed: true,
    })
    expect(editState).toEqual({
      target: {
        name: 'task-a',
        directory: '/repo/project/task-a',
        branch: 'feat',
        managed: true,
      },
      title: 'task-a',
    })

    expect(prepareWorktreeRename(editState.target, '  Review UI  ')).toEqual({
      directory: '/repo/project/task-a',
      title: 'Review UI',
    })
    expect(prepareWorktreeRename(editState.target, '   ')).toBeNull()
    expect(prepareWorktreeRename(null, 'Review UI')).toBeNull()

    const renameWorktreeFn = mock(async () => ({
      name: 'Review UI',
      directory: '/repo/project/task-a',
      managed: true,
    }))
    let refreshed = 0
    expect(await submitWorktreeRename({
      target: editState.target,
      title: '  Review UI  ',
      refreshWorkspaceTree: async () => { refreshed += 1 },
      renameWorktreeFn,
    })).toBe(true)
    expect(renameWorktreeFn).toHaveBeenCalledWith('/repo/project/task-a', 'Review UI')
    expect(refreshed).toBe(1)
    expect(await submitWorktreeRename({
      target: editState.target,
      title: '   ',
      refreshWorkspaceTree: async () => undefined,
      renameWorktreeFn,
    })).toBe(false)
  })

  it('exports trust helpers used by the component', async () => {
    expect(await selectTrustedWorkspace('/repo/project', async (path) => path)).toBe('/repo/project')
    expect(await selectTrustedWorkspace(null, async (path) => path)).toBeNull()
    expect(consumeTrustedWorkspace('/repo/project')).toEqual({
      workspaceToOpen: '/repo/project',
      nextTrustWorkspace: null,
      nextDialogOpen: false,
    })
    expect(consumeTrustedWorkspace(null)).toEqual({
      workspaceToOpen: null,
      nextTrustWorkspace: null,
      nextDialogOpen: true,
    })
  })

  it('exports session window helpers used by the component', async () => {
    const event = {
      metaKey: true,
      ctrlKey: false,
    } as React.MouseEvent
    expect(shouldOpenSessionInNewWindow(event, true, 'macos')).toBe(true)
    expect(shouldOpenSessionInNewWindow({ metaKey: false, ctrlKey: true } as React.MouseEvent, true, 'linux')).toBe(true)
    expect(shouldOpenSessionInNewWindow(undefined, true, 'macos')).toBe(false)
    expect(shouldOpenSessionInNewWindow(event, false, 'macos')).toBe(false)

    const invoke = mock(async () => undefined)
    await openSessionInNewWindow({
      session: {
        id: 'session-1',
        title: 'Selected session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
      importCore: async () => ({ invoke }),
    })
    expect(invoke).toHaveBeenCalledWith('app_new_window', {
      initialPath: '/session-1',
      initial_path: '/session-1',
    })

    expect(sessionWindowErrorDescription(new Error('boom'), 'fallback')).toBe('boom')
    expect(sessionWindowErrorDescription('nope', 'fallback')).toBe('fallback')
  })
})

describe('Sidebar workspace trust flow', () => {
  beforeEach(() => {
    localStorage.clear()
    useUnreadStore.setState({ ids: [] })
    sessionsData = []
    workspaceSessionsData = []
    activeSessionsData = []
    searchResultsData = []
    pinnedSessionsData = []
    allSessionsData = []
    allSessionsQueryArgs = []
    setSessionPinnedMutate.mockClear()
    searchQueries = []
    chatWorkspaceEntry = null
    hiddenWorkspacePaths = new Set()
    worktreesByRepo = {}
    workspaceGroupsData = []
    groupIdsByRepo = {}
    setGroupsRequests = []
    useSidebarViewStore.setState({ groupFilter: null })
    workspaceHasNextPage = false
    workspaceIsFetchingNextPage = false
    workspaceQueryArgs = []
    isTauri = true
    platformOs = 'macos'
    isMobile = false
    setApiBaseUrl('')
    appBackendStatus = {
      base_url: 'http://127.0.0.1:4082',
      sidecar_running: true,
      external: false,
      supports_bundled: true,
      servers: [],
    }
    useAgentStore.setState({ isAgentWorking: false, sessionId: null })
    navigate.mockClear()
    invokeMock.mockClear()
    dialogOpen.mockReset()
    dialogOpen.mockImplementation(async () => '/repo/project')
    deleteSessionMutate.mockClear()
    updateSessionTitleMutate.mockClear()
    fetchWorkspaceNextPage.mockClear()
    validateError = null
    globalThis.fetch = mock(async (input: unknown, init: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/browse')) {
        return new Response(JSON.stringify(browseResponse))
      }
      if (url.endsWith('/api/agent/workspace/visibility')) {
        const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as { workspace: string; hidden: boolean }
        if (body.hidden) hiddenWorkspacePaths.add(body.workspace)
        else hiddenWorkspacePaths.delete(body.workspace)
        return new Response(JSON.stringify(body))
      }
      if (url.includes('/api/agent/workspace/validate')) {
        if (validateError) {
          return new Response(JSON.stringify({ detail: validateError.message }), { status: 422 })
        }
        return new Response(JSON.stringify({ workspace: '/repo/project' }))
      }
      if (url.includes('/api/agent/workspace/worktrees')) {
        return new Response(JSON.stringify([]))
      }
      if (url.endsWith('/api/agent/workspace/groups/members')) {
        const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as { workspace: string; group_ids: string[] }
        setGroupsRequests.push(body)
        groupIdsByRepo[body.workspace] = body.group_ids
        return new Response(JSON.stringify(body))
      }
      if (url.endsWith('/api/agent/workspace/groups')) {
        const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as { name: string; brief: string | null }
        const group = { id: `g-${body.name}`, name: body.name, brief: body.brief }
        workspaceGroupsData = [...workspaceGroupsData, group]
        return new Response(JSON.stringify({ ...group, members: [] }))
      }
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify(workspaceTreeResponse()))
      }
      if (url.endsWith('/api/agent/sessions/resolve')) {
        // Resolving a session in a workspace un-hides it.
        hiddenWorkspacePaths.delete('/repo/project')
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
  })

  afterEach(() => {
    cleanup()
    globalThis.fetch = originalFetch
  })

  /**
   * Let the first workspace-tree fetch land. Query observers hear about it on
   * a timer, so a single microtask is not enough.
   */
  async function settleWorkspaceTree(queryClient: QueryClient) {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 20 && queryClient.getQueryState(queryKeys.coding.tree())?.status !== 'success'; i += 1) {
      await act(tick)
    }
    await act(tick)
  }

  async function renderSidebar() {
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

  async function renderSidebarForSessions(currentSessionId?: string) {
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

  async function renderSidebarWithProps(props: React.ComponentProps<typeof import('@/components/Sidebar').Sidebar>) {
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

  it('renders Telemetry in mobile sidebar footer, but no search bar or top nav item', async () => {
    isMobile = true
    const onMobileClose = mock(() => {})
    const onCommandPalette = mock(() => {})

    await renderSidebarWithProps({ mobileOpen: true, onMobileClose, onCommandPalette })

    expect(screen.getAllByRole('button', { name: 'Telemetry' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Open Quick Open' })).toBeNull()
  })

  it('shows the connected backend name in the mobile sidebar footer', async () => {
    isMobile = true

    await renderSidebarWithProps({ mobileOpen: true })

    expect(screen.getByText('backend-name')).toBeTruthy()
  })

  it('opens command palette and closes mobile drawer from the (?) help button', async () => {
    isMobile = true
    const onMobileClose = mock(() => {})
    const onCommandPalette = mock(() => {})

    await renderSidebarWithProps({ mobileOpen: true, onMobileClose, onCommandPalette })

    const helpBtn = screen.getByRole('button', { name: 'Help and shortcuts' })
    fireEvent.click(helpBtn)
    expect(onCommandPalette).toHaveBeenCalledTimes(1)
    expect(onMobileClose).toHaveBeenCalledTimes(1)
  })

  it('does not render a search bar on desktop', async () => {
    isMobile = false

    await renderSidebarWithProps({})

    expect(screen.queryByRole('button', { name: 'Open Quick Open' })).toBeNull()
  })

  it('does not navigate or save the last workspace until the user trusts the validated directory', async () => {
    const user = userEvent.setup()
    let visibilityBody: unknown
    let resolveCalled = false
    globalThis.fetch = mock(async (input: unknown, init: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/browse')) {
        return new Response(JSON.stringify(browseResponse))
      }
      if (url.endsWith('/api/agent/workspace/visibility')) {
        visibilityBody = JSON.parse(String((init as RequestInit | undefined)?.body))
        return new Response(JSON.stringify({ ...(visibilityBody as object), updated: 0 }))
      }
      if (url.includes('/api/agent/workspace/validate')) {
        return new Response(JSON.stringify({ workspace: '/repo/project' }))
      }
      if (url.includes('/api/agent/workspace/worktrees')) {
        return new Response(JSON.stringify([]))
      }
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify(workspaceTreeResponse()))
      }
      if (url.endsWith('/api/agent/sessions/resolve')) {
        resolveCalled = true
        return new Response(null, { status: 500 })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch
    await renderSidebar()

    expect(dialogOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Open workspace',
    })

    expect(screen.getByText('Trust this workspace?')).toBeTruthy()
    expect(screen.getByText('/repo/project')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    expect(loadLastWorkspace()).toBeNull()

    await user.click(screen.getByRole('button', { name: /trust and open/i }))

    // A new folder is registered so it has a row, then opens as a draft:
    // no session is created until the first message.
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({
        to: '/',
        search: { workspace: '/repo/project' },
        replace: false,
      })
    })
    expect(visibilityBody).toEqual({ workspace: '/repo/project', hidden: false })
    expect(resolveCalled).toBe(false)
    expect(loadLastWorkspace()?.path).toBe('/repo/project')
  })

  it('uses the native desktop folder picker on Linux desktop too', async () => {
    platformOs = 'linux'

    await renderSidebar()

    expect(dialogOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Open workspace',
    })
    expect(screen.getByText('Trust this workspace?')).toBeTruthy()
    expect(screen.getByText('/repo/project')).toBeTruthy()
  })

  it('animates desktop collapse width', async () => {
    const view = await renderSidebarWithProps({ desktopCollapsed: true })
    const sidebar = view.container.querySelector('aside')

    expect(JSON.parse(sidebar?.getAttribute('data-transition') ?? '{}')).toMatchObject({ duration: 0.22 })
  })

  it('keeps a collapsed sidebar out of Tab order', async () => {
    const collapsed = await renderSidebarWithProps({ desktopCollapsed: true })
    expect(collapsed.container.querySelector('aside')?.hasAttribute('inert')).toBe(true)
    collapsed.unmount()
    const open = await renderSidebarWithProps({ desktopCollapsed: false })
    expect(open.container.querySelector('aside')?.hasAttribute('inert')).toBe(false)
  })

  it('re-clamps the resize bounds when the window shrinks, not only on the next unrelated render', async () => {
    const originalWidth = window.innerWidth
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
      await renderSidebarWithProps({ desktopCollapsed: false })
      const separator = screen.getByRole('separator', { name: 'Resize sidebar' })
      expect(separator.getAttribute('aria-valuemax')).toBe('440')

      // 1000 - 400 (chat) - 340 (dock) leaves 260px for the sidebar.
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(separator.getAttribute('aria-valuemax')).toBe('260')
      expect(separator.getAttribute('aria-valuenow')).toBe('260')
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    }
  })

  it('keeps the mobile drawer visible after a desktop-collapsed coding sidebar crosses the breakpoint', async () => {
    isMobile = true

    const view = await renderSidebarWithProps({
      desktopCollapsed: true,
      mobileOpen: true,
      workspace: '/repo/project',
    })
    const drawer = view.container.querySelector('aside')

    expect(drawer).toBeTruthy()
    expect(JSON.parse(drawer?.getAttribute('data-animate') ?? '{}')).toEqual({
      x: 0,
      width: 'min(272px, calc(100vw - 2rem))',
    })
  })

  it('renders a backdrop when the mobile coding sidebar is open', async () => {
    isMobile = true

    const view = await renderSidebarWithProps({ mobileOpen: true })
    const backdrop = view.container.querySelector('[aria-hidden="true"]')

    expect(backdrop).toBeTruthy()
  })

  it('lets the user go back from the trust warning without opening the workspace', async () => {
    const user = userEvent.setup()
    await renderSidebar()

    expect(await screen.findByText('Trust this workspace?')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /back/i }))

    expect(screen.getByText('Open workspace')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    expect(loadLastWorkspace()).toBeNull()
  })

  it('shows validation errors without showing the trust confirmation', async () => {
    validateError = new Error('Workspace does not exist')

    await renderSidebar()

    expect(await screen.findByText('Workspace does not exist')).toBeTruthy()
    expect(screen.queryByText('Trust this workspace?')).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
    expect(loadLastWorkspace()).toBeNull()
  })

  it('keeps the server-local browser fallback outside desktop', async () => {
    const user = userEvent.setup()
    isTauri = false

    await renderSidebar()

    expect(dialogOpen).not.toHaveBeenCalled()
    expect(await screen.findByText('/repo/project')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /open this folder/i }))

    expect(screen.getByText('Trust this workspace?')).toBeTruthy()
    expect(dialogOpen).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('uses the server-local browser when the desktop app is connected to a remote backend', async () => {
    const user = userEvent.setup()
    appBackendStatus = {
      base_url: 'http://192.168.1.20:4082',
      sidecar_running: false,
      external: true,
      supports_bundled: true,
      servers: [],
    }

    await renderSidebar()

    expect(dialogOpen).not.toHaveBeenCalled()
    expect(await screen.findByText('/repo/project')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /open this folder/i }))

    expect(screen.getByText('Trust this workspace?')).toBeTruthy()
    expect(dialogOpen).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('opens a coding session in a new desktop window on macOS Command+click', async () => {
    sessionsData = [
      {
        id: 'session-1',
        title: 'Selected session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData

    await renderSidebarForSessions()

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Selected session' }), { button: 0, metaKey: true })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('app_new_window', {
        initialPath: '/session-1',
        initial_path: '/session-1',
      })
    })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('shows a running indicator on every running coding session', async () => {
    sessionsData = [
      {
        id: 'session-2',
        title: 'Background running session',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
        running: true,
      },
    ]
    workspaceSessionsData = [
      {
        id: 'session-1',
        title: 'Selected idle session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
      {
        id: 'session-2',
        title: 'Background running session',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
        running: true,
      },
    ]

    await renderSidebarForSessions('session-1')

    expect(screen.getByLabelText('Session running')).toBeTruthy()
    expect(screen.getByText('Selected idle session')).toBeTruthy()
    expect(screen.getByText('Background running session')).toBeTruthy()
  })


  it('keeps running sessions visible when a workspace is collapsed', async () => {
    sessionsData = [
      {
        id: 'session-2',
        title: 'Background running session',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
        running: true,
      },
    ]
    workspaceSessionsData = sessionsData

    await renderSidebarForSessions(undefined)
    await userEvent.setup().click(screen.getByLabelText('Collapse repository project'))

    expect(screen.getByLabelText('Expand repository project')).toBeTruthy()
    expect(screen.getByText('Background running session')).toBeTruthy()
    expect(screen.getByLabelText('Session running')).toBeTruthy()
  })

  it('hides a main repository from the sidebar without deleting it', async () => {
    const user = userEvent.setup()
    sessionsData = [
      {
        id: 'session-1',
        title: 'Main session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData
    localStorage.setItem('oa-coding-workspaces', JSON.stringify([{ id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' }]))

    await renderSidebarForSessions('session-1')

    expect(screen.getByLabelText('Collapse repository project')).toBeTruthy()
    await user.click(screen.getByLabelText('Actions for project'))
    expect(screen.getByRole('menu', { name: 'Actions for project' })).toBeTruthy()
    await user.click(screen.getByRole('menuitem', { name: /remove from sidebar/i }))
    expect(screen.getByText('Remove workspace from sidebar')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /^remove from sidebar$/i }))

    expect(screen.queryByLabelText('Collapse repository project')).toBeNull()
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/agent/workspace/visibility', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ workspace: '/repo/project', hidden: true }),
    }))
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/agent/workspace/worktrees', expect.objectContaining({ method: 'DELETE' }))
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
  })

  describe('Remove from sidebar', () => {
    const session = (id: string, workspace: string): TestSession => ({
      id,
      title: `Session in ${workspace}`,
      agent_name: 'lead',
      created_at: '2026-05-13T00:00:00Z',
      updated_at: '2026-05-13T00:00:00Z',
      mode: 'coding',
      workspace,
    })

    async function removeFromSidebar(name: string) {
      const user = userEvent.setup()
      await user.click(screen.getByLabelText(`Actions for ${name}`))
      await user.click(screen.getByRole('menuitem', { name: /remove from sidebar/i }))
      await user.click(screen.getByRole('button', { name: /^remove from sidebar$/i }))
    }

    it('drops the repository row once the backend has hidden it', async () => {
      sessionsData = [session('session-1', '/repo/project'), session('session-2', '/repo/other')]
      workspaceSessionsData = sessionsData
      // The tree was fetched moments ago, so a cached copy is still fresh.
      await renderSidebarWithProps({ currentSessionId: 'session-2', workspace: '/repo/other' })
      await waitFor(() => expect(screen.getByLabelText('Actions for project')).toBeTruthy())

      await removeFromSidebar('project')

      await waitFor(() => expect(screen.queryByLabelText('Actions for project')).toBeNull())
      expect(hiddenWorkspacePaths.has('/repo/project')).toBe(true)
      expect(screen.getByLabelText('Actions for other')).toBeTruthy()
    })

    it('forgets the removed workspace before leaving it, so the empty route cannot reopen it', async () => {
      sessionsData = [session('session-1', '/repo/project')]
      workspaceSessionsData = sessionsData
      saveLastWorkspace('/repo/project')
      // The empty route restores the last workspace the moment it renders.
      let lastWorkspaceAtNavigation: string | null | undefined
      navigate.mockImplementation(() => { lastWorkspaceAtNavigation = loadLastWorkspace()?.path ?? null })

      await renderSidebarForSessions('session-1')
      await removeFromSidebar('project')

      expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
      expect(lastWorkspaceAtNavigation).toBeNull()
      expect(loadWorkspaces()).not.toContain('/repo/project')
      await waitFor(() => expect(screen.queryByLabelText('Actions for project')).toBeNull())
    })

    it('hides the repository worktrees too, which would otherwise keep it listed', async () => {
      sessionsData = [session('session-1', '/repo/project'), session('session-2', '/repo/other')]
      workspaceSessionsData = sessionsData
      worktreesByRepo = { '/repo/project': [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }
      await renderSidebarWithProps({ currentSessionId: 'session-2', workspace: '/repo/other' })
      await waitFor(() => expect(screen.getByLabelText('Actions for project')).toBeTruthy())

      await removeFromSidebar('project')

      await waitFor(() => expect(screen.queryByLabelText('Actions for project')).toBeNull())
      expect(screen.queryByText('task-a')).toBeNull()
      expect([...hiddenWorkspacePaths].sort()).toEqual(['/data/worktrees/project/task-a', '/repo/project'])
    })

    it('lists a hidden workspace again once reopening it has un-hidden it', async () => {
      const user = userEvent.setup()
      sessionsData = [session('session-1', '/repo/project')]
      workspaceSessionsData = sessionsData
      hiddenWorkspacePaths = new Set(['/repo/project'])

      await renderSidebar()
      expect(screen.queryByLabelText('Actions for project')).toBeNull()
      await user.click(screen.getByRole('button', { name: /trust and open/i }))

      // Opening a folder the sidebar does not list un-hides it first.
      await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/', search: { workspace: '/repo/project' }, replace: false }))
      await waitFor(() => expect(screen.getByLabelText('Actions for project')).toBeTruthy())
    })

    it('follows workspace-tree refreshes made outside the sidebar', async () => {
      sessionsData = [session('session-1', '/repo/project')]
      workspaceSessionsData = sessionsData
      hiddenWorkspacePaths = new Set(['/repo/project'])
      const { Sidebar } = await import('@/components/Sidebar')
      const queryClient = new QueryClient()
      await act(async () => {
        render(
          <QueryClientProvider client={queryClient}>
            <Sidebar />
          </QueryClientProvider>,
        )
        await Promise.resolve()
      })
      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/agent/workspace/tree'))
      expect(screen.queryByLabelText('Actions for project')).toBeNull()

      // The command palette's workspace switch refreshes the shared query.
      hiddenWorkspacePaths.delete('/repo/project')
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.coding.tree() })
      })

      await waitFor(() => expect(screen.getByLabelText('Actions for project')).toBeTruthy())
    })
  })

  it('opens a draft from the workspace menu without creating a session', async () => {
    const user = userEvent.setup()
    sessionsData = [
      {
        id: 'session-1',
        title: null,
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData
    useAgentStore.setState({
      sessionId: 'session-1',
      isAgentWorking: false,
      agentNames: ['lead'],
      agentStreams: {
        lead: {
          blocks: [],
          currentBlocks: [],
          currentText: '',
          currentThinking: '',
          status: 'idle',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
                model: null,
          lastError: null,
        },
      },
    })
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof mock>

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('Actions for project'))
    await user.click(screen.getByRole('menuitem', { name: /new session/i }))

    expect(fetchSpy).not.toHaveBeenCalledWith('/api/agent/sessions/resolve', expect.anything())
    expect(navigate).toHaveBeenCalledWith({ to: '/', search: { workspace: '/repo/project' }, replace: false })
    expect(useAgentStore.getState().sessionId).toBeNull()
  })

  it('does not show a running indicator for idle coding sessions', async () => {
    sessionsData = [
      {
        id: 'session-1',
        title: 'Idle session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData

    await renderSidebarForSessions('session-1')

    expect(screen.queryByLabelText('Session running')).toBeNull()
  })

  /**
   * A session suspended on `ask_user` is still "running", so without a
   * distinct marker it is indistinguishable from one that is busy working — and
   * the whole point is that it is busy waiting for *this* user.
   */
  it('badges a session that is waiting for the user to answer a question', async () => {
    sessionsData = [
      {
        id: 'session-1',
        title: 'Waiting session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
        running: true,
        needs_input: true,
      },
    ]
    workspaceSessionsData = sessionsData

    await renderSidebarForSessions(undefined)

    expect(screen.getByLabelText('Session needs your input')).toBeTruthy()
    expect(screen.queryByLabelText('Session running')).toBeNull()
  })

  it('refreshes the repository tree only when another window changes the saved workspaces', async () => {
    await renderSidebarForSessions(undefined)
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof mock>
    const treeFetches = () => fetchSpy.mock.calls.filter(([input]) => String(input).includes('/api/agent/workspace/tree')).length
    const before = treeFetches()

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'oa.unread-sessions.v1' }))
      await Promise.resolve()
    })
    expect(treeFetches()).toBe(before)

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'oa-coding-workspaces' }))
      await Promise.resolve()
    })
    await waitFor(() => expect(treeFetches()).toBe(before + 1))
  })

  it('searches session titles across workspaces in place of the tree', async () => {
    const user = userEvent.setup()
    sessionsData = [
      {
        id: 'session-1',
        title: 'Current session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData
    searchResultsData = [
      {
        id: 'm1',
        title: 'Migration plan',
        agent_name: 'lead',
        created_at: '2026-01-02T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        workspace: '/repo/other',
      },
      // An older server ignores ``q`` and sends a normal page.
      {
        id: 'x',
        title: 'Unrelated',
        agent_name: 'lead',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace: '/repo/project',
      },
    ]

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByRole('button', { name: 'Search sessions' }))
    const input = await screen.findByRole('searchbox', { name: 'Search sessions' })
    await waitFor(() => expect(document.activeElement).toBe(input))
    await user.type(input, 'MIGR')

    const results = await screen.findByRole('region', { name: 'Search results' })
    await waitFor(() => expect(results.textContent).toContain('Migration plan'))
    expect(results.textContent).toContain('other')
    expect(results.textContent).not.toContain('Unrelated')
    expect(searchQueries).toContain('MIGR')
    expect(screen.queryByLabelText('Collapse repository project')).toBeNull()

    await user.click(screen.getByRole('button', { name: /Migration plan/ }))
    expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 'm1' } })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByLabelText('Collapse repository project')).toBeTruthy()
  })

  it('opens session search on the searchSessions event and closes it on Escape', async () => {
    const user = userEvent.setup()
    await renderSidebarForSessions(undefined)

    act(() => { window.dispatchEvent(new Event(APP_EVENTS.searchSessions)) })
    const input = await screen.findByRole('searchbox', { name: 'Search sessions' })
    await waitFor(() => expect(document.activeElement).toBe(input))

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Search sessions' }))
  })

  it('lists upcoming scheduled tasks soonest first and opens the scheduler on one', async () => {
    const user = userEvent.setup()
    const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
    const task = (id: string, name: string, next: string | null, enabled = true) => ({
      id, slug: id, name, workspace: '/repo/project', schedule_type: 'every', at_datetime: null, every_seconds: 3600,
      cron_expression: null, timezone: 'UTC', prompt: 'p', session_id: null, max_runs: null, enabled,
      status: enabled ? 'pending' : 'paused', run_count: 0, last_run_at: null, last_error: null, next_fire_at: next,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    })
    const baseFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
      if (String(input).includes('/api/scheduler/tasks')) {
        return new Response(JSON.stringify({ tasks: [
          task('later', 'Weekly report', inMinutes(120)),
          task('soon', 'Nightly build', inMinutes(30)),
          task('paused', 'Paused digest', inMinutes(10), false),
          task('done', 'One-off reminder', null),
        ] }))
      }
      return baseFetch(input as RequestInfo, init as RequestInit | undefined)
    }) as typeof fetch
    const opened = mock(() => {})
    window.addEventListener(APP_EVENTS.openScheduler, opened)

    await renderSidebarForSessions(undefined)
    const section = await screen.findByRole('region', { name: 'Scheduled' })
    await waitFor(() => expect(section.textContent).toContain('Nightly build'))
    const names = Array.from(section.querySelectorAll('li')).map((row) => row.textContent ?? '')
    expect(names[0]).toContain('Nightly build')
    expect(names[1]).toContain('Weekly report')
    expect(section.textContent).not.toContain('Paused digest')
    expect(section.textContent).not.toContain('One-off reminder')

    await user.click(screen.getByRole('button', { name: /Nightly build/ }))
    window.removeEventListener(APP_EVENTS.openScheduler, opened)

    expect(useUIStore.getState().scheduledTaskFocus).toBe('soon')
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('keeps the sidebar on the page tone in light mode and the rail in dark', async () => {
    const view = await renderSidebarForSessions(undefined)
    const aside = view?.container.querySelector('aside') as HTMLElement
    expect(aside.className).toContain('bg-(--bg-page)')
    expect(aside.className).toContain('dark:bg-(--bg-sidebar)')
    expect(aside.className.split(' ')).not.toContain('bg-(--bg-sidebar)')
  })

  it('lists sessions that need you from every workspace above the workspaces', async () => {
    const user = userEvent.setup()
    activeSessionsData = [
      {
        id: 'ask-1',
        title: 'Pick a migration plan',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        workspace: '/repo/project',
        running: true,
        needs_input: true,
      },
      {
        id: 'ask-2',
        title: 'Confirm the release notes',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        workspace: '/repo/other',
        running: true,
        needs_input: true,
      },
      // An older server ignores ``active`` and sends a normal page.
      {
        id: 'busy',
        title: 'Still working',
        agent_name: 'lead',
        created_at: '2026-05-11T00:00:00Z',
        updated_at: '2026-05-11T00:00:00Z',
        workspace: '/repo/project',
        running: true,
      },
    ]

    await renderSidebarForSessions(undefined)

    const section = screen.getByRole('region', { name: 'Needs you' })
    expect(section.textContent).toContain('Pick a migration plan')
    expect(section.textContent).toContain('Confirm the release notes')
    expect(section.textContent).toContain('other')
    expect(section.textContent).not.toContain('Still working')

    await user.click(screen.getByRole('button', { name: /Confirm the release notes/ }))
    expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 'ask-2' } })
  })

  it('hides the Needs you section when nothing is waiting', async () => {
    await renderSidebarForSessions(undefined)

    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull()
  })

  it('marks a session that finished while you were elsewhere as unread', async () => {
    sessionsData = [
      {
        id: 'session-1',
        title: 'Current session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
      {
        id: 'session-2',
        title: 'Finished elsewhere',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData
    useUnreadStore.setState({ ids: ['session-2'] })

    await renderSidebarForSessions('session-1')

    expect(screen.getAllByLabelText('Unread session')).toHaveLength(1)
    expect(screen.getByText('Finished elsewhere').closest('button')?.querySelector('[aria-label="Unread session"]')).toBeTruthy()
  })

  it('shows a waiting or running state instead of the unread mark', async () => {
    sessionsData = [
      {
        id: 'session-1',
        title: 'Waiting session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
        running: true,
        needs_input: true,
      },
      {
        id: 'session-2',
        title: 'Running session',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
        running: true,
      },
    ]
    workspaceSessionsData = sessionsData
    useUnreadStore.setState({ ids: ['session-1', 'session-2'] })

    await renderSidebarForSessions(undefined)

    expect(screen.getByLabelText('Session needs your input')).toBeTruthy()
    expect(screen.getByLabelText('Session running')).toBeTruthy()
    expect(screen.queryByLabelText('Unread session')).toBeNull()
  })

  it('loads more sessions from an explicit "Show more" row instead of a nested scroller', async () => {
    const user = userEvent.setup()
    sessionsData = [
      {
        id: 'session-1',
        title: 'First page session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData
    workspaceHasNextPage = true

    await renderSidebarForSessions('session-1')

    const showMore = await screen.findByRole('button', { name: 'Show more sessions' })
    expect(fetchWorkspaceNextPage).not.toHaveBeenCalled()
    await user.click(showMore)
    expect(fetchWorkspaceNextPage).toHaveBeenCalledTimes(1)
  })

  it('lists worktree sessions in the source repository, tagged with the worktree', async () => {
    sessionsData = [
      {
        id: 'session-1',
        title: 'Worktree session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/data/worktrees/project/task-a',
      },
    ]
    workspaceSessionsData = sessionsData
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.startsWith('/api/agent/workspace/worktrees')) return new Response(JSON.stringify([]))
      return new Response(null, { status: 404 })
    }) as typeof fetch

    localStorage.setItem('oa-coding-workspaces', JSON.stringify([
      { id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'worktree', path: '/data/worktrees/project/task-a', createdAt: '2026-05-02T00:00:00Z' },
    ]))

    await renderSidebarWithProps({
      currentSessionId: 'session-1',
      workspace: '/data/worktrees/project/task-a',
    })

    await waitFor(() => expect(screen.getByText('task-a')).toBeTruthy())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByLabelText('Collapse repository project')).toBeTruthy()
    expect(screen.queryByLabelText('Collapse repository task-a')).toBeNull()
    // No nested worktree row: its sessions sit in the repository list, tagged.
    expect(screen.queryByLabelText(/(Expand|Collapse) worktree/)).toBeNull()
    const row = screen.getByText('Worktree session').closest('[data-session-row]')
    expect(row?.querySelector('[data-checkout-tag]')?.textContent).toBe('task-a')
    expect(workspaceQueryArgs.at(-1)).toEqual(['/repo/project', '/data/worktrees/project/task-a'])
  })

  it('filters a repository to one worktree and starts sessions there', async () => {
    const user = userEvent.setup()
    sessionsData = [
      {
        id: 'session-1',
        title: 'Worktree session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/data/worktrees/project/task-a',
      },
    ]
    workspaceSessionsData = sessionsData
    let resolveCalled = false
    globalThis.fetch = mock(async (input: unknown, init: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.startsWith('/api/agent/workspace/worktrees')) return new Response(JSON.stringify([]))
      if (url.endsWith('/api/agent/sessions/resolve')) {
        void init
        resolveCalled = true
        return new Response(null, { status: 500 })
      }
      return new Response(JSON.stringify({ workspace: '/repo/project' }))
    }) as typeof fetch

    localStorage.setItem('oa-coding-workspaces', JSON.stringify([{ id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' }]))

    await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project' })
    useAgentStore.setState({
      sessionId: 'session-1',
      isAgentWorking: false,
      agentNames: ['lead'],
      agentStreams: { lead: createDefaultAgentStream() },
    })

    const chip = await screen.findByRole('button', { name: 'Checkouts in project: all' })
    expect(screen.getByLabelText('Collapse repository project')).toBeTruthy()
    expect(screen.queryByLabelText(/(Expand|Collapse) worktree/)).toBeNull()
    // The filter chip grows on touch like the row actions (DESIGN.md touch parity).
    expect(chip.className).toContain('pointer-coarse:h-9')

    await user.click(chip)
    const menu = screen.getByRole('menu', { name: 'Checkouts in project' })
    expect(within(menu).getByRole('menuitemradio', { name: 'All checkouts' }).getAttribute('aria-checked')).toBe('true')
    expect(within(menu).getByRole('menuitemradio', { name: 'Main worktree' }).getAttribute('aria-checked')).toBe('false')
    await user.click(within(menu).getByRole('menuitemradio', { name: 'task-a' }))

    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Checkouts in project: task-a' })).toBeTruthy()
    expect(workspaceQueryArgs.at(-1)).toBe('/data/worktrees/project/task-a')
    // One checkout listed: the tag would only repeat the chip.
    expect(document.querySelector('[data-checkout-tag]')).toBeNull()
    const newSession = screen.getByLabelText('New session in worktree task-a')
    expect(newSession.className).toContain('pointer-coarse:size-9')

    await user.click(newSession)

    // The worktree's "+" opens a draft there; nothing is created yet.
    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: { workspace: '/data/worktrees/project/task-a' },
      replace: false,
    })
    expect(useAgentStore.getState()._workspace).toBe('/data/worktrees/project/task-a')
    expect(useAgentStore.getState().sessionId).toBeNull()
    expect(resolveCalled).toBe(false)

    // The list names its filter and clears it in one step.
    await user.click(screen.getByRole('button', { name: 'Show all checkouts in project' }))
    expect(screen.getByRole('button', { name: 'Checkouts in project: all' })).toBeTruthy()
    expect(workspaceQueryArgs.at(-1)).toEqual(['/repo/project', '/data/worktrees/project/task-a'])
  })

  it('renames a worktree sidebar title', async () => {
    const user = userEvent.setup()
    sessionsData = [
      {
        id: 'session-1',
        title: 'Worktree session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/data/worktrees/project/task-a',
      },
    ]
    workspaceSessionsData = sessionsData
    let renameBody: unknown
    globalThis.fetch = mock(async (input: unknown, init: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.includes('/api/agent/workspace/worktrees')) {
        if ((init as RequestInit | undefined)?.method === 'PATCH') {
          renameBody = JSON.parse(String((init as RequestInit | undefined)?.body))
          return new Response(JSON.stringify({ name: 'Review UI', directory: '/data/worktrees/project/task-a', managed: true }))
        }
        return new Response(JSON.stringify([]))
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch

    await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project' })
    await user.click(await screen.findByRole('button', { name: 'Checkouts in project: all' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'task-a' }))
    // Worktree actions act on the selected worktree.
    await user.click(screen.getByRole('button', { name: 'Checkouts in project: task-a' }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename task-a…' }))
    const input = screen.getByLabelText('Worktree title')
    await user.clear(input)
    await user.type(input, 'Review UI')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(renameBody).toEqual({ directory: '/data/worktrees/project/task-a', name: 'Review UI' })
  })

  it('removes deleted managed worktrees without promoting stale inverse relationships', async () => {
    const user = userEvent.setup()
    sessionsData = [
      {
        id: 'session-1',
        title: 'Worktree session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/data/worktrees/project/task-a',
      },
    ]
    workspaceSessionsData = sessionsData
    globalThis.fetch = mock(async (input: unknown, init: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.includes('/api/agent/workspace/worktrees')) {
        if ((init as RequestInit | undefined)?.method === 'DELETE') return new Response(JSON.stringify({ removed: true }))
        return new Response(JSON.stringify([]))
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch

    localStorage.setItem('oa-coding-workspaces', JSON.stringify([
      { id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'worktree', path: '/data/worktrees/project/task-a', createdAt: '2026-05-02T00:00:00Z' },
    ]))

    await renderSidebarWithProps({
      currentSessionId: 'session-1',
      workspace: '/repo/project',
    })

    await user.click(await screen.findByRole('button', { name: 'Checkouts in project: all' }))
    // No worktree is selected yet, so there is nothing to remove.
    expect(screen.queryByRole('menuitem', { name: /^Remove / })).toBeNull()
    await user.click(screen.getByRole('menuitemradio', { name: 'task-a' }))
    await user.click(screen.getByRole('button', { name: 'Checkouts in project: task-a' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove task-a…' }))

    // Managed-worktree removal is destructive, so it now requires
    // confirmation before it commits (error prevention).
    await user.click(screen.getByRole('button', { name: 'Remove worktree' }))

    await waitFor(() => expect(screen.queryByText('task-a')).toBeNull())
    // Without worktrees the filter chip goes, and the list is the repository alone.
    expect(screen.queryByRole('button', { name: /^Checkouts in project/ })).toBeNull()
    expect(workspaceQueryArgs.at(-1)).toBe('/repo/project')
    expect(screen.getByLabelText('Collapse repository project')).toBeTruthy()
    expect(screen.queryByLabelText('Collapse repository task-a')).toBeNull()
    expect(screen.queryByLabelText('Expand repository task-a')).toBeNull()
  })

  it('keeps the source repository visible when the active session is a worktree', async () => {
    sessionsData = [
      {
        id: 'session-1',
        title: 'Worktree session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/data/worktrees/project/task-a',
      },
    ]
    workspaceSessionsData = sessionsData
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.startsWith('/api/agent/workspace/worktrees')) return new Response(JSON.stringify([]))
      return new Response(null, { status: 404 })
    }) as typeof fetch

    localStorage.setItem('oa-coding-workspaces', JSON.stringify([
      { id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'worktree', path: '/data/worktrees/project/task-a', createdAt: '2026-05-02T00:00:00Z' },
    ]))

    await renderSidebarWithProps({
      currentSessionId: 'session-1',
      workspace: '/data/worktrees/project/task-a',
    })

    await waitFor(() => expect(screen.getByText('task-a')).toBeTruthy())
    expect(screen.getByLabelText('Collapse repository project')).toBeTruthy()
    expect(workspaceQueryArgs.at(-1)).toEqual(['/repo/project', '/data/worktrees/project/task-a'])
    expect(screen.getAllByText('Worktree session').length).toBeGreaterThan(0)
  })

  it('shows every checkout again when the current session is filtered out', async () => {
    const user = userEvent.setup()
    sessionsData = [
      {
        id: 'main-1',
        title: 'Main session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.startsWith('/api/agent/workspace/worktrees')) return new Response(JSON.stringify([]))
      return new Response(null, { status: 404 })
    }) as typeof fetch

    const { Sidebar } = await import('@/components/Sidebar')
    const queryClient = new QueryClient()
    const sidebar = (currentSessionId: string) => (
      <QueryClientProvider client={queryClient}>
        <Sidebar currentSessionId={currentSessionId} workspace="/repo/project" />
      </QueryClientProvider>
    )
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(sidebar('main-1'))
      await Promise.resolve()
    })
    await settleWorkspaceTree(queryClient)

    // Picking a worktree is deliberate, even though it hides the open session.
    await user.click(screen.getByRole('button', { name: 'Checkouts in project: all' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'task-a' }))
    expect(screen.getByRole('button', { name: 'Checkouts in project: task-a' })).toBeTruthy()

    // Opening another main-checkout session (Needs you, search) brings it back.
    await act(async () => { view!.rerender(sidebar('main-2')) })
    expect(screen.getByRole('button', { name: 'Checkouts in project: all' })).toBeTruthy()
  })

  it('renames a session in place from its row', async () => {
    const user = userEvent.setup()
    sessionsData = [
      {
        id: 'session-1',
        title: 'Old title',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('Edit session Old title'))
    const input = screen.getByLabelText('Session title')
    await user.clear(input)
    await user.type(input, 'New title{Enter}')

    expect(updateSessionTitleMutate).toHaveBeenCalledWith(
      { id: 'session-1', title: 'New title' },
      expect.objectContaining({ onError: expect.any(Function) }),
    )
    expect(screen.queryByLabelText('Session title')).toBeNull()
    expect(screen.queryByText('Edit session title')).toBeNull()
  })

  describe('keyboard', () => {
    const twoSessions = () => {
      sessionsData = ['First', 'Second'].map((title, i) => ({
        id: `session-${i + 1}`,
        title,
        agent_name: 'lead',
        created_at: `2026-05-1${3 - i}T00:00:00Z`,
        updated_at: `2026-05-1${3 - i}T00:00:00Z`,
        mode: 'coding',
        workspace: '/repo/project',
      }))
      workspaceSessionsData = sessionsData
    }
    const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    const row = (title: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar-session]')).find((el) => el.textContent?.includes(title))!

    it('keeps every row and its actions in Tab order', async () => {
      twoSessions()
      await renderSidebarForSessions('session-1')
      await frame()
      expect(row('First').getAttribute('aria-current')).toBe('page')
      for (const el of [
        row('First'),
        row('Second'),
        screen.getByLabelText('Collapse repository project'),
        screen.getByLabelText('Pin session First'),
        screen.getByLabelText('Edit session First'),
        screen.getByLabelText('Delete session First'),
        screen.getByLabelText('Actions for project'),
      ]) expect(el.tabIndex).toBe(0)
    })

    it('climbs and folds the workspace with Left/Right', async () => {
      const user = userEvent.setup()
      twoSessions()
      await renderSidebarForSessions('session-1')
      row('Second').focus()
      await user.keyboard('{ArrowLeft}')
      const header = screen.getByLabelText('Collapse repository project')
      expect(document.activeElement).toBe(header)
      await user.keyboard('{ArrowLeft}')
      expect(screen.getByLabelText('Expand repository project')).toBe(header)
      await user.keyboard('{ArrowRight}')
      expect(screen.getByLabelText('Collapse repository project')).toBe(header)
    })

    it('renames with F2, deletes with Delete and opens the row menu with Shift+F10', async () => {
      const user = userEvent.setup()
      twoSessions()
      await renderSidebarForSessions('session-1')
      row('Second').focus()
      await user.keyboard('{Shift>}{F10}{/Shift}')
      expect(screen.getByRole('menu', { name: 'Actions for Second' })).toBeTruthy()
      await user.keyboard('{Escape}')
      row('Second').focus()
      await user.keyboard('{Delete}')
      expect(screen.getByText('Delete session')).toBeTruthy()
      await user.keyboard('{Escape}')
      row('Second').focus()
      await user.keyboard('{F2}')
      expect(screen.getByLabelText('Session title')).toBeTruthy()
    })
  })

  it('trims title edits before submitting', async () => {
    const user = userEvent.setup()
    sessionsData = [
      {
        id: 'session-1',
        title: 'Old title',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData

    await renderSidebarForSessions('session-1')
    await user.dblClick(screen.getByText('Old title'))
    const input = screen.getByLabelText('Session title')
    await user.clear(input)
    await user.type(input, '  New title  {Enter}')

    expect(updateSessionTitleMutate).toHaveBeenCalledWith(
      { id: 'session-1', title: 'New title' },
      expect.anything(),
    )
  })

  it('does not submit empty or cancelled title edits', async () => {
    const user = userEvent.setup()
    sessionsData = [
      {
        id: 'session-1',
        title: 'Old title',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('Edit session Old title'))
    await user.clear(screen.getByLabelText('Session title'))
    await user.type(screen.getByLabelText('Session title'), '   {Enter}')
    expect(screen.queryByLabelText('Session title')).toBeNull()

    await user.click(screen.getByLabelText('Edit session Old title'))
    await user.type(screen.getByLabelText('Session title'), 'Other{Escape}')

    expect(screen.queryByLabelText('Session title')).toBeNull()
    expect(screen.getByText('Old title')).toBeTruthy()
    expect(updateSessionTitleMutate).not.toHaveBeenCalled()
  })

  it('selects another coding session after deleting the current one', async () => {
    const user = userEvent.setup()
    sessionsData = [
      {
        id: 'session-1',
        title: 'Delete me',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
      {
        id: 'session-2',
        title: 'Keep me',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('Delete session Delete me'))
    await user.click(screen.getByRole('button', { name: /^delete$/i }))

    expect(deleteSessionMutate).toHaveBeenCalledWith('session-1')
    expect(navigate).toHaveBeenCalledWith({
      to: '/$sessionId',
      params: { sessionId: 'session-2' },
      replace: true,
    })
    expect(loadLastWorkspace()?.path).toBe('/repo/project')
  })

  it('requires confirmation before deleting a coding session', async () => {
    const user = userEvent.setup()
    sessionsData = [
      {
        id: 'session-1',
        title: 'Delete me',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('Delete session Delete me'))

    expect(deleteSessionMutate).not.toHaveBeenCalled()
    expect(screen.getByText('Delete session')).toBeTruthy()
    expect(screen.getByText(/will be permanently deleted/i)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /^delete$/i }))

    expect(deleteSessionMutate).toHaveBeenCalledWith('session-1')
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
  })

  it('copies repo absolute path from the workspace actions menu', async () => {
    const user = userEvent.setup()
    const writeText = mock(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    sessionsData = [
      {
        id: 'session-1',
        title: 'Feature session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData

    await renderSidebarForSessions('session-1')

    await user.click(screen.getByLabelText('Actions for project'))
    const copyOption = screen.getByRole('menuitem', { name: /copy repo absolute path/i })
    expect(copyOption).toBeTruthy()

    await user.click(copyOption)
    expect(writeText).toHaveBeenCalledWith('/repo/project')
  })

  it('marks grouped repositories and narrows the tree to one group', async () => {
    const user = userEvent.setup()
    sessionsData = [
      { id: 'session-1', title: 'Feature', agent_name: 'lead', created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z', mode: 'coding', workspace: '/repo/project' },
      { id: 'session-2', title: 'Other', agent_name: 'lead', created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z', mode: 'coding', workspace: '/repo/other' },
    ]
    workspaceSessionsData = sessionsData
    workspaceGroupsData = [{ id: 'g-acme', name: 'acme', brief: 'project = app' }]
    groupIdsByRepo = { '/repo/project': ['g-acme'] }

    await renderSidebarForSessions('session-1')

    expect(screen.getByRole('img', { name: 'Groups: acme' })).toBeTruthy()
    expect(screen.getByLabelText(/repository other/)).toBeTruthy()

    await act(async () => { useSidebarViewStore.getState().setGroupFilter('g-acme') })
    expect(screen.queryByLabelText(/repository other/)).toBeNull()
    expect(screen.getByLabelText(/repository project/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Show all workspaces' }))
    expect(useSidebarViewStore.getState().groupFilter).toBeNull()
    expect(screen.getByLabelText(/repository other/)).toBeTruthy()
  })

  it('toggles a repository\'s groups from its actions menu and links to group settings', async () => {
    const user = userEvent.setup()
    sessionsData = [
      { id: 'session-1', title: 'Feature', agent_name: 'lead', created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z', mode: 'coding', workspace: '/repo/project' },
    ]
    workspaceSessionsData = sessionsData
    workspaceGroupsData = [
      { id: 'g-acme', name: 'acme', brief: null },
      { id: 'g-shared', name: 'shared', brief: null },
    ]
    groupIdsByRepo = { '/repo/project': ['g-acme'] }
    const realOpenSettings = useSettingsStore.getState().openSettings
    const openSettings = mock(() => {})
    useSettingsStore.setState({ openSettings })

    await renderSidebarForSessions('session-1')

    await user.click(screen.getByLabelText('Actions for project'))
    const toggle = (name: string) => screen.getByRole('menuitemcheckbox', { name })
    expect(toggle('acme').getAttribute('aria-checked')).toBe('true')
    expect(toggle('shared').getAttribute('aria-checked')).toBe('false')

    // A toggle saves at once and keeps the menu open for the next one.
    await user.click(toggle('shared'))
    await waitFor(() => expect(setGroupsRequests).toEqual([{ workspace: '/repo/project', group_ids: ['g-acme', 'g-shared'] }]))
    await waitFor(() => expect(toggle('shared').getAttribute('aria-checked')).toBe('true'))
    await user.click(toggle('acme'))
    await waitFor(() => expect(setGroupsRequests.at(-1)).toEqual({ workspace: '/repo/project', group_ids: ['g-shared'] }))

    await user.click(screen.getByRole('menuitem', { name: 'Manage groups…' }))
    expect(openSettings).toHaveBeenCalledWith('workspaces')
    expect(screen.queryByRole('menu')).toBeNull()
    useSettingsStore.setState({ openSettings: realOpenSettings })
  })

  it('pins the chat workspace and keeps repository actions off it', async () => {
    chatWorkspaceEntry = { path: '/home/user', name: 'Chat' }
    sessionsData = [
      {
        id: 'chat-1',
        title: 'Trip planning',
        agent_name: 'code',
        created_at: '2026-09-15T00:00:00Z',
        updated_at: '2026-09-15T00:00:00Z',
        workspace: '/home/user',
      },
    ]
    workspaceSessionsData = sessionsData

    await renderSidebarForSessions('chat-1')

    // Labelled "Chat" rather than the home directory's basename, and the
    // session list under it is reachable from the pinned row.
    expect(screen.getByText('Chat')).toBeTruthy()
    expect(screen.queryByText('user')).toBeNull()

    // No worktree/repo action menu: the chat root is not a repository.
    expect(screen.queryByLabelText('Actions for Chat')).toBeNull()
    expect(screen.getByLabelText('New session in Chat')).toBeTruthy()
  })

  it('offers a new chat session from the long-press action list on touch', async () => {
    // On a touch build the inline "+" is hidden, so the pinned Chat row is the
    // only affordance left — long-pressing it has to surface "New session"
    // rather than bailing out the way repository-only actions do.
    isMobile = true
    platformOs = 'ios'
    chatWorkspaceEntry = { path: '/home/user', name: 'Chat' }
    sessionsData = [
      {
        id: 'chat-1',
        title: 'Trip planning',
        agent_name: 'code',
        created_at: '2026-09-15T00:00:00Z',
        updated_at: '2026-09-15T00:00:00Z',
        workspace: '/home/user',
      },
    ]
    workspaceSessionsData = sessionsData

    await renderSidebarWithProps({
      currentSessionId: 'chat-1',
      workspace: '/home/user',
      mobileOpen: true,
    })

    const chatRow = screen.getByRole('button', { name: /chat workspace Chat$/ })
    fireEvent.pointerDown(chatRow, { pointerType: 'touch', clientX: 20, clientY: 20 })

    const newSession = await waitFor(
      () => screen.getByRole('button', { name: 'New session' }),
      { timeout: 1500 },
    )

    // Repository-shaped actions stay off the chat root.
    expect(screen.queryByRole('button', { name: /copy repo absolute path/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /create worktree/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /remove from sidebar/i })).toBeNull()

    fireEvent.click(newSession)

    // A session is on screen, so the Chat draft opens; nothing is created.
    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: { workspace: '/home/user' },
      replace: false,
    })
  })

  it('keeps repository rows and their action menu unchanged', async () => {
    chatWorkspaceEntry = { path: '/home/user', name: 'Chat' }
    sessionsData = [
      {
        id: 'session-1',
        title: 'Feature session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    workspaceSessionsData = sessionsData

    await renderSidebarForSessions('session-1')

    expect(screen.getByText('project')).toBeTruthy()
    expect(screen.getByLabelText('Actions for project')).toBeTruthy()
  })

  describe('sections and view options', () => {
    const projectSession = (id: string, title: string, extra: Partial<TestSession> = {}): TestSession => ({
      id,
      title,
      agent_name: 'lead',
      created_at: '2026-05-13T00:00:00Z',
      updated_at: '2026-05-13T00:00:00Z',
      mode: 'coding',
      workspace: '/repo/project',
      ...extra,
    })

    beforeEach(async () => {
      const { useSidebarViewStore } = await import('@/stores/useSidebarViewStore')
      useSidebarViewStore.setState({ groupBy: 'project', sortBy: 'activity', showDetails: true, pinnedCollapsed: false, collapsedGroups: [] })
    })

    it('keeps New session off the desktop header in Project mode', async () => {
      sessionsData = [projectSession('session-1', 'Feature')]
      workspaceSessionsData = sessionsData
      await renderSidebarForSessions('session-1')

      expect(screen.queryByRole('button', { name: 'New session' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Collapse all workspaces' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'View options' })).toBeTruthy()
      expect(allSessionsQueryArgs).toEqual([])
    })

    it('switches to a flat list with a header New session in Status mode', async () => {
      const { useSidebarViewStore } = await import('@/stores/useSidebarViewStore')
      useSidebarViewStore.setState({ groupBy: 'status' })
      sessionsData = [projectSession('session-1', 'Feature')]
      workspaceSessionsData = sessionsData
      allSessionsData = [projectSession('session-2', 'Flat row')]

      await renderSidebarForSessions('session-1')

      expect(screen.getByText('Flat row')).toBeTruthy()
      expect(allSessionsQueryArgs.at(-1)).toBe('activity')
      // The tree's controls belong to Project mode.
      expect(screen.queryByRole('button', { name: 'Collapse all workspaces' })).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'New session' }))
      expect(navigate).toHaveBeenCalledWith({ to: '/', search: { workspace: '/repo/project' }, replace: false })
    })

    it('shows the header New session in Project mode on mobile', async () => {
      isMobile = true
      platformOs = 'ios'
      sessionsData = [projectSession('session-1', 'Feature')]
      workspaceSessionsData = sessionsData

      await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project', mobileOpen: true })

      expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy()
    })

    it('lists pinned sessions above the tree and unpins from the row menu', async () => {
      pinnedSessionsData = [projectSession('pinned-1', 'Pinned review', { pinned_at: '2026-10-18T00:00:00Z' })]
      sessionsData = [projectSession('session-1', 'Feature')]
      workspaceSessionsData = sessionsData

      await renderSidebarForSessions('session-1')

      // The row names its workspace and that it is pinned.
      const pinnedRow = screen.getByRole('button', { name: /^Pinned review.*pinned$/ })
      fireEvent.contextMenu(pinnedRow)
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }))
      expect(setSessionPinnedMutate).toHaveBeenCalledWith(
        { id: 'pinned-1', pinned: false },
        expect.anything(),
      )
    })

    it('pins a session from its context menu', async () => {
      sessionsData = [projectSession('session-1', 'Feature')]
      workspaceSessionsData = sessionsData

      await renderSidebarForSessions('session-1')

      fireEvent.contextMenu(screen.getByRole('button', { name: /^Feature/ }))
      const items = within(await screen.findByRole('menu')).getAllByRole('menuitem')
      // Pin leads the menu.
      expect(items[0].textContent).toContain('Pin')
      fireEvent.click(items[0])
      expect(setSessionPinnedMutate).toHaveBeenCalledWith(
        { id: 'session-1', pinned: true },
        expect.anything(),
      )
    })

    it('pins from the row action left of Edit', async () => {
      sessionsData = [projectSession('session-1', 'Feature')]
      workspaceSessionsData = sessionsData

      await renderSidebarForSessions('session-1')

      const pin = screen.getByRole('button', { name: 'Pin session Feature' })
      const edit = screen.getByRole('button', { name: 'Edit session Feature' })
      expect(pin.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      fireEvent.click(pin)
      expect(setSessionPinnedMutate).toHaveBeenCalledWith(
        { id: 'session-1', pinned: true },
        expect.anything(),
      )
    })

    it('unpins a pinned session from its row action', async () => {
      pinnedSessionsData = [projectSession('pinned-1', 'Pinned review', { pinned_at: '2026-10-18T00:00:00Z' })]
      sessionsData = [projectSession('session-1', 'Feature')]
      workspaceSessionsData = sessionsData

      await renderSidebarForSessions('session-1')

      fireEvent.click(screen.getByRole('button', { name: 'Unpin session Pinned review' }))
      expect(setSessionPinnedMutate).toHaveBeenCalledWith(
        { id: 'pinned-1', pinned: false },
        expect.anything(),
      )
    })

    it('keeps pinning behind long-press on mobile', async () => {
      isMobile = true
      platformOs = 'ios'
      sessionsData = [projectSession('session-1', 'Feature')]
      workspaceSessionsData = sessionsData

      await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project', mobileOpen: true })

      // The inline actions never show; long-press opens the action sheet.
      const actions = screen.getByLabelText('Pin session Feature').parentElement!
      expect(actions.className.split(' ')).toContain('hidden')
      expect(actions.className).not.toContain('group-hover/row:flex')
    })
  })
})
