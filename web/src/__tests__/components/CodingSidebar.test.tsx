import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiBaseUrl } from '@/api/base-url'
import { loadLastCodingWorkspace } from '@/utils/workspace'
import { useTeamStore } from '@/stores/useTeamStore'
import { createDefaultAgentStream } from '@/stores/useTeamStore/defaults'
import {
  addExpandedPaths,
  buildWorktreeSourceByDirectory,
  sourceWorkspacePaths,
  toggleExpandedPath,
  visibleNestedWorktrees,
} from '@/components/CodingSidebar.helpers'
import {
  loadWorkspaceBrowser,
  shouldUseServerWorkspaceBrowser,
  validateTrustedWorkspace,
} from '@/components/CodingSidebar.browser'
import {
  applySessionDelete,
  applySessionSelection,
  getFallbackSessionAfterDelete,
  prepareSessionTitleUpdate,
} from '@/components/CodingSidebar.sessions'
import {
  confirmWorkspaceRemoval,
  selectCodingWorkspace,
} from '@/components/CodingSidebar.workspace'
import {
  consumeTrustedWorkspace,
  selectTrustedWorkspace,
} from '@/components/CodingSidebar.trust'
import {
  beginWorktreeTitleEdit,
  buildOpenWorktreeDialogState,
  prepareWorktreeRename,
  submitWorktreeRename,
} from '@/components/CodingSidebar.worktree-dialog'
import {
  openSessionInNewWindow,
  sessionWindowErrorDescription,
  shouldOpenSessionInNewWindow,
} from '@/components/CodingSidebar.window'
import {
  loadWorktreesForSource,
  recoverCreatedWorktreeAfterTransientError,
  removeManagedWorktree,
} from '@/components/CodingSidebar.worktrees'

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
}

let sessionsData: TestSession[] = []
let workspaceSessionsData: TestSession[] = []
let workspaceHasNextPage = false
let workspaceIsFetchingNextPage = false
const fetchWorkspaceNextPage = mock(() => {})
const workspaceTreeResponse = () => ({
  repositories: Array.from(new Set(sessionsData.filter((session) => session.mode === 'coding' && session.workspace).map((session) => session.workspace as string))).map((path) => ({
    path,
    name: path.split('/').pop() || path,
    worktrees: [],
  })),
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
  Check: Icon,
  ChevronDown: Icon,
  ChevronRight: Icon,
  Copy: Icon,
  Download: Icon,
  ExternalLink: Icon,
  FileText: Icon,
  CircleHelp: Icon,
  Folder: Icon,
  GitBranch: Icon,
  GitCompare: Icon,
  Globe: Icon,
  HelpCircle: Icon,
  Home: Icon,
  Loader2: Icon,
  MoreHorizontal: Icon,
  Plus: Icon,
  Search: Icon,
  Settings: Icon,
  Pencil: Icon,
  Trash2: Icon,
  X: Icon,
}))

mock.module('@/components/ThemeToggle', () => ({
  ThemeToggle: () => <button aria-label="Theme: System. Click to cycle." />,
}))

mock.module('@/components/HealthDot', () => ({
  HealthDot: () => <div aria-label="Connected" />,
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
        infinite: () => ['team', 'sessions', 'infinite'],
        workspace: (workspace: string) => ['team', 'sessions', 'workspace', workspace],
      },
    },
  },
  useTeamSessionsQuery: () => ({
    data: { pages: [{ data: sessionsData }] },
    isFetching: false,
    refetch: mock(() => {}),
  }),
  useCodingWorkspaceSessionsQuery: () => ({
    data: { pages: [{ data: workspaceSessionsData }] },
    isLoading: false,
    hasNextPage: workspaceHasNextPage,
    isFetchingNextPage: workspaceIsFetchingNextPage,
    fetchNextPage: fetchWorkspaceNextPage,
  }),
  useDeleteTeamSessionMutation: () => ({ mutate: deleteSessionMutate }),
  useUpdateTeamSessionTitleMutation: () => ({
    mutate: updateSessionTitleMutate,
    isPending: false,
    isError: false,
  }),
}))

describe('CodingSidebar helpers', () => {
  it('exports workspace browser helpers used by the component', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/team/workspace/browse')) {
        return new Response(JSON.stringify(browseResponse))
      }
      if (url.includes('/api/team/workspace/validate')) {
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
    expect(prepareSessionTitleUpdate(session, '  New title  ')).toEqual({
      id: 'session-1',
      title: 'New title',
    })
    expect(prepareSessionTitleUpdate(session, '   ')).toBeNull()
    expect(prepareSessionTitleUpdate(null, 'New title')).toBeNull()

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
      to: '/coding/$sessionId',
      params: { sessionId: 'session-1' },
    })
    expect(onMobileClose).toHaveBeenCalled()

    const deleteNavigate = mock(() => {})
    const mutateDelete = mock(() => {})
    applySessionDelete({
      deleteTarget: session,
      currentSessionId: 'session-1',
      codingSessions: [
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
      to: '/coding/$sessionId',
      params: { sessionId: 'session-2' },
      replace: true,
    })
  })

  it('exports workspace helpers used by the component', async () => {
    const selectionNavigate = mock(() => {})
    const queryClient = new QueryClient()
    let refreshCount = 0
    const selected = await selectCodingWorkspace({
      path: '/repo/project',
      requestedCreate: false,
      currentSessionId: undefined,
      currentWorkspace: null,
      queryClient,
      refreshWorkspaceTree: async () => { refreshCount += 1 },
      navigate: selectionNavigate,
      resolveTeamSessionFn: async () => ({
        id: 'resolved-session',
        title: null,
        agent_name: null,
        mode: 'coding',
        workspace: '/repo/project',
        created_at: null,
        updated_at: null,
        created: true,
      }),
    })
    expect(selected).toEqual({ skipped: false })
    expect(selectionNavigate).toHaveBeenCalledWith({
      to: '/coding/$sessionId',
      params: { sessionId: 'resolved-session' },
    })
    expect(refreshCount).toBe(1)

    useTeamStore.setState({
      sessionId: 'session-1',
      isTeamWorking: false,
      agentNames: ['lead'],
      agentStreams: { lead: createDefaultAgentStream() },
    })
    const skipped = await selectCodingWorkspace({
      path: '/repo/project',
      requestedCreate: true,
      currentSessionId: 'session-1',
      currentWorkspace: '/repo/project',
      queryClient: new QueryClient(),
      refreshWorkspaceTree: async () => undefined,
      navigate: mock(() => {}),
    })
    expect(skipped).toEqual({ skipped: true })

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
    expect(removeNavigate).toHaveBeenCalledWith({ to: '/coding', replace: true })
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
      initialPath: '/coding/session-1',
      initial_path: '/coding/session-1',
    })

    expect(sessionWindowErrorDescription(new Error('boom'), 'fallback')).toBe('boom')
    expect(sessionWindowErrorDescription('nope', 'fallback')).toBe('fallback')
  })
})

describe('CodingSidebar workspace trust flow', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionsData = []
    workspaceSessionsData = []
    workspaceHasNextPage = false
    workspaceIsFetchingNextPage = false
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
    useTeamStore.setState({ isTeamWorking: false, sessionId: null })
    navigate.mockClear()
    invokeMock.mockClear()
    dialogOpen.mockReset()
    dialogOpen.mockImplementation(async () => '/repo/project')
    deleteSessionMutate.mockClear()
    updateSessionTitleMutate.mockClear()
    fetchWorkspaceNextPage.mockClear()
    validateError = null
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/team/workspace/browse')) {
        return new Response(JSON.stringify(browseResponse))
      }
      if (url.includes('/api/team/workspace/validate')) {
        if (validateError) {
          return new Response(JSON.stringify({ detail: validateError.message }), { status: 422 })
        }
        return new Response(JSON.stringify({ workspace: '/repo/project' }))
      }
      if (url.includes('/api/team/workspace/worktrees')) {
        return new Response(JSON.stringify([]))
      }
      if (url.includes('/api/team/workspace/tree')) {
        return new Response(JSON.stringify(workspaceTreeResponse()))
      }
      if (url.endsWith('/api/team/sessions/resolve')) {
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

  async function renderCodingSidebar() {
    const { CodingSidebar } = await import('@/components/CodingSidebar')
    const queryClient = new QueryClient()
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(
        <QueryClientProvider client={queryClient}>
          <CodingSidebar openWorkspaceDialogKey={1} />
        </QueryClientProvider>,
      )
      await Promise.resolve()
    })
    return view
  }

  async function renderCodingSidebarForSessions(currentSessionId?: string) {
    const { CodingSidebar } = await import('@/components/CodingSidebar')
    const queryClient = new QueryClient()
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(
        <QueryClientProvider client={queryClient}>
          <CodingSidebar currentSessionId={currentSessionId} workspace="/repo/project" />
        </QueryClientProvider>,
      )
      await Promise.resolve()
    })
    return view
  }

  async function renderCodingSidebarWithProps(props: React.ComponentProps<typeof import('@/components/CodingSidebar').CodingSidebar>) {
    const { CodingSidebar } = await import('@/components/CodingSidebar')
    const queryClient = new QueryClient()
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(
        <QueryClientProvider client={queryClient}>
          <CodingSidebar {...props} />
        </QueryClientProvider>,
      )
      await Promise.resolve()
    })
    return view!
  }

  it('does not navigate or save the last workspace until the user trusts the validated directory', async () => {
    const user = userEvent.setup()
    let resolveBody: unknown
    globalThis.fetch = mock(async (input: unknown, init: unknown) => {
      const url = String(input)
      if (url.includes('/api/team/workspace/browse')) {
        return new Response(JSON.stringify(browseResponse))
      }
      if (url.includes('/api/team/workspace/validate')) {
        return new Response(JSON.stringify({ workspace: '/repo/project' }))
      }
      if (url.includes('/api/team/workspace/worktrees')) {
        return new Response(JSON.stringify([]))
      }
      if (url.includes('/api/team/workspace/tree')) {
        return new Response(JSON.stringify(workspaceTreeResponse()))
      }
      if (url.endsWith('/api/team/sessions/resolve')) {
        resolveBody = JSON.parse(String((init as RequestInit | undefined)?.body))
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
    await renderCodingSidebar()

    expect(dialogOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Open workspace',
    })

    expect(screen.getByText('Trust this workspace?')).toBeTruthy()
    expect(screen.getByText('/repo/project')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    expect(loadLastCodingWorkspace()).toBeNull()

    await user.click(screen.getByRole('button', { name: /trust and open/i }))

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({
        to: '/coding/$sessionId',
        params: { sessionId: 'resolved-session' },
      })
    })
    expect(resolveBody).toEqual({
      mode: 'coding',
      workspace: '/repo/project',
      model: null,
      thinking_level: null,
      create: false,
    })
    expect(loadLastCodingWorkspace()?.path).toBe('/repo/project')
  })

  it('uses the native desktop folder picker on Linux desktop too', async () => {
    platformOs = 'linux'

    await renderCodingSidebar()

    expect(dialogOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Open workspace',
    })
    expect(screen.getByText('Trust this workspace?')).toBeTruthy()
    expect(screen.getByText('/repo/project')).toBeTruthy()
  })

  it('animates desktop collapse width', async () => {
    const view = await renderCodingSidebarWithProps({ desktopCollapsed: true })
    const sidebar = view.container.querySelector('aside')

    expect(JSON.parse(sidebar?.getAttribute('data-transition') ?? '{}')).toMatchObject({ duration: 0.22 })
  })

  it('keeps the mobile drawer visible after a desktop-collapsed coding sidebar crosses the breakpoint', async () => {
    isMobile = true

    const view = await renderCodingSidebarWithProps({
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

    const view = await renderCodingSidebarWithProps({ mobileOpen: true })
    const backdrop = view.container.querySelector('[aria-hidden="true"]')

    expect(backdrop).toBeTruthy()
  })

  it('lets the user go back from the trust warning without opening the workspace', async () => {
    const user = userEvent.setup()
    await renderCodingSidebar()

    expect(await screen.findByText('Trust this workspace?')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /back/i }))

    expect(screen.getByText('Open workspace')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    expect(loadLastCodingWorkspace()).toBeNull()
  })

  it('shows validation errors without showing the trust confirmation', async () => {
    validateError = new Error('Workspace does not exist')

    await renderCodingSidebar()

    expect(await screen.findByText('Workspace does not exist')).toBeTruthy()
    expect(screen.queryByText('Trust this workspace?')).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
    expect(loadLastCodingWorkspace()).toBeNull()
  })

  it('keeps the server-local browser fallback outside desktop', async () => {
    const user = userEvent.setup()
    isTauri = false

    await renderCodingSidebar()

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

    await renderCodingSidebar()

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

    await renderCodingSidebarForSessions()

    fireEvent.mouseDown(screen.getByTitle(/selected session ·/i), { button: 0, metaKey: true })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('app_new_window', {
        initialPath: '/coding/session-1',
        initial_path: '/coding/session-1',
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

    await renderCodingSidebarForSessions('session-1')

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

    await renderCodingSidebarForSessions(undefined)
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

    await renderCodingSidebarForSessions('session-1')

    expect(screen.getByLabelText('Collapse repository project')).toBeTruthy()
    await user.click(screen.getByLabelText('Actions for project'))
    expect(screen.getByRole('menu', { name: 'Actions for project' })).toBeTruthy()
    await user.click(screen.getByRole('menuitem', { name: /remove from sidebar/i }))
    expect(screen.getByText('Remove workspace from sidebar')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /^remove from sidebar$/i }))

    expect(screen.queryByLabelText('Collapse repository project')).toBeNull()
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/team/workspace/visibility', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ workspace: '/repo/project', hidden: true }),
    }))
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/team/workspace/worktrees', expect.objectContaining({ method: 'DELETE' }))
    expect(navigate).toHaveBeenCalledWith({ to: '/coding', replace: true })
  })

  it('does not create a new session when the current coding session is empty and idle', async () => {
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
    useTeamStore.setState({
      sessionId: 'session-1',
      isTeamWorking: false,
      agentNames: ['lead'],
      agentStreams: {
        lead: {
          blocks: [],
          currentBlocks: [],
          currentText: '',
          currentThinking: '',
          status: 'idle',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
          _completionBase: 0,
          model: null,
          lastError: null,
        },
      },
    })
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof mock>

    await renderCodingSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('Actions for project'))
    await user.click(screen.getByRole('menuitem', { name: /new session/i }))

    expect(fetchSpy).not.toHaveBeenCalledWith('/api/team/sessions/resolve', expect.anything())
    expect(navigate).not.toHaveBeenCalled()
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

    await renderCodingSidebarForSessions('session-1')

    expect(screen.queryByLabelText('Session running')).toBeNull()
  })

  it('loads more sessions at the bottom of a workspace session list', async () => {
    const _user = userEvent.setup()
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

    await renderCodingSidebarForSessions('session-1')

    await waitFor(() => expect(fetchWorkspaceNextPage).toHaveBeenCalled())
  })

  it('keeps known worktree children under their source when probing the worktree itself returns none', async () => {
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
      if (url.includes('/api/team/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.startsWith('/api/team/workspace/worktrees')) return new Response(JSON.stringify([]))
      return new Response(null, { status: 404 })
    }) as typeof fetch

    localStorage.setItem('oa-coding-workspaces', JSON.stringify([
      { id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'worktree', path: '/data/worktrees/project/task-a', createdAt: '2026-05-02T00:00:00Z' },
    ]))

    await renderCodingSidebarWithProps({
      currentSessionId: 'session-1',
      workspace: '/data/worktrees/project/task-a',
    })

    await waitFor(() => expect(screen.getByText('task-a')).toBeTruthy())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByLabelText('Collapse repository project')).toBeTruthy()
    expect(screen.queryByLabelText('Collapse repository task-a')).toBeNull()
    expect(screen.getByLabelText('Collapse worktree task-a')).toBeTruthy()
  })

  it('renders managed worktrees under their source repository with distinct actions', async () => {
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
    let resolveBody: unknown
    globalThis.fetch = mock(async (input: unknown, init: unknown) => {
      const url = String(input)
      if (url.includes('/api/team/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.startsWith('/api/team/workspace/worktrees')) return new Response(JSON.stringify([]))
      if (url.endsWith('/api/team/sessions/resolve')) {
        resolveBody = JSON.parse(String((init as RequestInit | undefined)?.body))
        return new Response(JSON.stringify({
          id: 'resolved-worktree-session',
          title: null,
          agent_name: null,
          mode: 'coding',
          workspace: '/data/worktrees/project/task-a',
          created_at: null,
          updated_at: null,
          created: true,
        }))
      }
      return new Response(JSON.stringify({ workspace: '/repo/project' }))
    }) as typeof fetch

    localStorage.setItem('oa-coding-workspaces', JSON.stringify([{ id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' }]))

    await renderCodingSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project' })
    useTeamStore.setState({
      sessionId: 'session-1',
      isTeamWorking: false,
      agentNames: ['lead'],
      agentStreams: { lead: createDefaultAgentStream() },
    })

    await waitFor(() => expect(screen.getByText('task-a')).toBeTruthy())

    expect(screen.getByLabelText('Collapse repository project')).toBeTruthy()
    expect(screen.getByLabelText('Expand worktree task-a')).toBeTruthy()
    expect(screen.getByText('task-a')).toBeTruthy()
    expect(screen.queryByLabelText('Create worktree from task-a')).toBeNull()

    await user.click(screen.getByLabelText('New session in worktree task-a'))

    await waitFor(() => {
      expect(resolveBody).toEqual({
        mode: 'coding',
        workspace: '/data/worktrees/project/task-a',
        model: null,
        thinking_level: null,
        create: true,
      })
    })
    expect(useTeamStore.getState()._workspace).toBe('/data/worktrees/project/task-a')
    expect(navigate).toHaveBeenCalledWith({
      to: '/coding/$sessionId',
      params: { sessionId: 'resolved-worktree-session' },
    })
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
      if (url.includes('/api/team/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.includes('/api/team/workspace/worktrees')) {
        if ((init as RequestInit | undefined)?.method === 'PATCH') {
          renameBody = JSON.parse(String((init as RequestInit | undefined)?.body))
          return new Response(JSON.stringify({ name: 'Review UI', directory: '/data/worktrees/project/task-a', managed: true }))
        }
        return new Response(JSON.stringify([]))
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch

    await renderCodingSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project' })
    await waitFor(() => expect(screen.getByText('task-a')).toBeTruthy())
    await user.click(screen.getByLabelText('Edit worktree title task-a'))
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
      if (url.includes('/api/team/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.includes('/api/team/workspace/worktrees')) {
        if ((init as RequestInit | undefined)?.method === 'DELETE') return new Response(JSON.stringify({ removed: true }))
        return new Response(JSON.stringify([]))
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch

    localStorage.setItem('oa-coding-workspaces', JSON.stringify([
      { id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'worktree', path: '/data/worktrees/project/task-a', createdAt: '2026-05-02T00:00:00Z' },
    ]))

    await renderCodingSidebarWithProps({
      currentSessionId: 'session-1',
      workspace: '/repo/project',
    })

    await waitFor(() => expect(screen.getByText('task-a')).toBeTruthy())
    await user.click(screen.getByLabelText('Remove worktree task-a'))

    // Managed-worktree removal is destructive, so it now requires
    // confirmation before it commits (error prevention).
    await user.click(screen.getByRole('button', { name: 'Remove worktree' }))

    await waitFor(() => expect(screen.queryByText('task-a')).toBeNull())
    expect(screen.getByLabelText('Collapse repository project')).toBeTruthy()
    expect(screen.queryByLabelText('Collapse repository task-a')).toBeNull()
    expect(screen.queryByLabelText('Expand repository task-a')).toBeNull()
    expect(screen.queryByLabelText('Expand worktree project')).toBeNull()
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
      if (url.includes('/api/team/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.startsWith('/api/team/workspace/worktrees')) return new Response(JSON.stringify([]))
      return new Response(null, { status: 404 })
    }) as typeof fetch

    localStorage.setItem('oa-coding-workspaces', JSON.stringify([
      { id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'worktree', path: '/data/worktrees/project/task-a', createdAt: '2026-05-02T00:00:00Z' },
    ]))

    await renderCodingSidebarWithProps({
      currentSessionId: 'session-1',
      workspace: '/data/worktrees/project/task-a',
    })

    await waitFor(() => expect(screen.getByText('task-a')).toBeTruthy())
    expect(screen.getByLabelText('Collapse repository project')).toBeTruthy()
    expect(screen.getByLabelText('Collapse worktree task-a')).toBeTruthy()
    expect(screen.getAllByText('Worktree session').length).toBeGreaterThan(0)
  })

  it('opens title editing from a coding session card', async () => {
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

    await renderCodingSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('Edit session Old title'))
    const input = screen.getByLabelText('Session title')
    await user.clear(input)
    await user.type(input, 'New title')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(updateSessionTitleMutate).toHaveBeenCalledWith(
      { id: 'session-1', title: 'New title' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    )
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

    await renderCodingSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('Edit session Old title'))
    const input = screen.getByLabelText('Session title')
    await user.clear(input)
    await user.type(input, '  New title  ')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(updateSessionTitleMutate).toHaveBeenCalledWith(
      { id: 'session-1', title: 'New title' },
      expect.anything(),
    )
  })

  it('does not submit empty title edits', async () => {
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

    await renderCodingSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('Edit session Old title'))
    const input = screen.getByLabelText('Session title')
    await user.clear(input)
    await user.type(input, '   ')

    expect(screen.getByRole('button', { name: /^save$/i }).hasAttribute('disabled')).toBe(true)
    await user.keyboard('{Enter}')
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

    await renderCodingSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('Delete session Delete me'))
    await user.click(screen.getByRole('button', { name: /^delete$/i }))

    expect(deleteSessionMutate).toHaveBeenCalledWith('session-1')
    expect(navigate).toHaveBeenCalledWith({
      to: '/coding/$sessionId',
      params: { sessionId: 'session-2' },
      replace: true,
    })
    expect(loadLastCodingWorkspace()?.path).toBe('/repo/project')
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

    await renderCodingSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('Delete session Delete me'))

    expect(deleteSessionMutate).not.toHaveBeenCalled()
    expect(screen.getByText('Delete session')).toBeTruthy()
    expect(screen.getByText(/will be permanently deleted/i)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /^delete$/i }))

    expect(deleteSessionMutate).toHaveBeenCalledWith('session-1')
    expect(navigate).toHaveBeenCalledWith({ to: '/coding', replace: true })
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

    await renderCodingSidebarForSessions('session-1')

    await user.click(screen.getByLabelText('Actions for project'))
    const copyOption = screen.getByRole('menuitem', { name: /copy repo absolute path/i })
    expect(copyOption).toBeTruthy()

    await user.click(copyOption)
    expect(writeText).toHaveBeenCalledWith('/repo/project')
  })
})
