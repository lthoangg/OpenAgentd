import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const navigate = mock(() => {})
const updateSessionTitleMutate = mock(() => {})
let invokeShouldFail = false
const invokeMock = mock(async () => {
  if (invokeShouldFail) throw new Error('window failed')
  return undefined
})
const pushToast = mock(() => {})
let isMobile = false
type TestSession = {
  id: string
  title: string | null
  agent_name: string | null
  created_at: string
  updated_at: string
  mode: string
  workspace?: string
}

let sessionsData: TestSession[] = [
  {
    id: 'session-1',
    title: 'Old title',
    agent_name: 'lead',
    created_at: '2026-05-13T00:00:00Z',
    updated_at: '2026-05-13T00:00:00Z',
    mode: 'normal',
  },
]

class IntersectionObserverStub {
  observe() {}
  disconnect() {}
}

globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver

mock.module('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: true, os: 'macos', isMacOverlay: true }),
  getPlatform: () => ({ isTauri: true, os: 'macos', isMacOverlay: true }),
}))

mock.module('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

mock.module('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}))

const Icon = () => null
mock.module('lucide-react', () => ({
  Check: Icon,
  ChevronRight: Icon,
  Copy: Icon,
  Download: Icon,
  ExternalLink: Icon,
  FileText: Icon,
  Folder: Icon,
  GitCompare: Icon,
  Globe: Icon,
  HelpCircle: Icon,
  Home: Icon,
  Loader2: Icon,
  Pencil: Icon,
  Plus: Icon,
  RefreshCw: Icon,
  Search: Icon,
  Settings: Icon,
  Trash2: Icon,
  X: Icon,
}))

mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    aside: ({ children, animate, ...props }: React.ComponentProps<'aside'> & { animate?: unknown }) => <aside data-animate={JSON.stringify(animate)} {...props}>{children}</aside>,
    div: ({ children, initial, animate, exit, transition, ...props }: React.ComponentProps<'div'> & { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }) => {
      void initial
      void animate
      void exit
      void transition
      return <div {...props}>{children}</div>
    },
    p: ({ children, ...props }: React.ComponentProps<'p'>) => <p {...props}>{children}</p>,
  },
}))

mock.module('@/components/ThemeToggle', () => ({
  ThemeToggle: () => <button aria-label="Theme: System. Click to cycle." />,
}))

mock.module('@/components/HealthDot', () => ({
  HealthDot: () => <div aria-label="Connected" />,
}))

mock.module('@/stores/useToastStore', () => ({
  useToastStore: (selector: (state: { push: typeof pushToast }) => unknown) => selector({ push: pushToast }),
}))

mock.module('@/components/ui/sidebar-item', () => ({
  SidebarItem: ({ label, onClick }: { label: string; onClick?: () => void }) => <button onClick={onClick}>{label}</button>,
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

mock.module('@/queries', () => ({
  queryKeys: {
    team: {
      sessions: {
        all: () => ['team', 'sessions'],
        infinite: () => ['team', 'sessions', 'infinite'],
        detail: (id: string) => ['team', 'sessions', id],
      },
    },
    coding: {
      files: (workspace: string) => ['coding', 'files', workspace],
      diff: (workspace: string) => ['coding', 'diff', workspace],
    },
  },
  useTeamSessionsQuery: () => ({
    data: { pages: [{ data: sessionsData }] },
    isFetching: false,
    isLoading: false,
    isError: false,
    isSuccess: true,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: mock(() => {}),
    refetch: mock(() => {}),
  }),
  useDeleteTeamSessionMutation: () => ({ mutate: mock(() => {}) }),
  useUpdateTeamSessionTitleMutation: () => ({
    mutate: updateSessionTitleMutate,
    isPending: false,
    isError: false,
  }),
}))

describe('Sidebar session title editing', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionsData = [
      {
        id: 'session-1',
        title: 'Old title',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'normal',
      },
    ]
    isMobile = false
    invokeShouldFail = false
    navigate.mockClear()
    invokeMock.mockClear()
    pushToast.mockClear()
    updateSessionTitleMutate.mockClear()
  })

  afterEach(() => cleanup())

  async function renderSidebar(props: Partial<React.ComponentProps<typeof import('@/components/Sidebar').Sidebar>> = {}) {
    const { Sidebar } = await import('@/components/Sidebar')
    return render(<Sidebar currentSessionId="session-1" {...props} />)
  }

  it('opens the title editor from the edit affordance and submits a trimmed title', async () => {
    const user = userEvent.setup()
    await renderSidebar()

    await user.click(screen.getByLabelText('Edit session Old title'))
    const input = screen.getByLabelText('Session title')
    await user.clear(input)
    await user.type(input, '  New title  ')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(updateSessionTitleMutate).toHaveBeenCalledWith(
      { id: 'session-1', title: 'New title' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    )
  })

  it('opens the title editor on session-card double click', async () => {
    const user = userEvent.setup()
    await renderSidebar()

    await user.dblClick(screen.getByText('Old title'))

    expect(screen.getByText('Edit session title')).toBeTruthy()
    expect((screen.getByLabelText('Session title') as HTMLInputElement).value).toBe('Old title')
  })

  it('blocks blank title submissions', async () => {
    const user = userEvent.setup()
    await renderSidebar()

    await user.click(screen.getByLabelText('Edit session Old title'))
    const input = screen.getByLabelText('Session title')
    await user.clear(input)
    await user.type(input, '   ')

    expect(screen.getByRole('button', { name: /^save$/i }).hasAttribute('disabled')).toBe(true)
    await user.keyboard('{Enter}')
    expect(updateSessionTitleMutate).not.toHaveBeenCalled()
  })

  it('opens a cockpit session in a new desktop window on macOS Command+click', async () => {
    await renderSidebar()

    fireEvent.mouseDown(screen.getByText('Old title'), { button: 0, metaKey: true })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('app_new_window', {
        initialPath: '/cockpit/session-1',
        initial_path: '/cockpit/session-1',
      })
    })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('shows a toast when opening a cockpit session window fails', async () => {
    invokeShouldFail = true

    await renderSidebar()

    fireEvent.mouseDown(screen.getByText('Old title'), { button: 0, metaKey: true })

    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith({
        tone: 'error',
        title: 'Could not open session in new window',
        description: 'window failed',
      })
    })
  })

  it('uses explicit width for the mobile drawer even when the persisted desktop sidebar is collapsed', async () => {
    isMobile = true
    localStorage.setItem('oa-sidebar-collapsed', 'true')

    const view = await renderSidebar()
    const drawer = view.container.querySelector('aside')

    expect(drawer?.className).toContain('mobile-safe-top')
    expect(drawer?.className).toContain('w-[min(272px,calc(100vw-2rem))]')
    expect(JSON.parse(drawer?.getAttribute('data-animate') ?? '{}')).toEqual({
      x: -280,
      width: 'min(272px, calc(100vw - 2rem))',
    })
  })

  it('keeps the cockpit mobile backdrop below the app header', async () => {
    isMobile = true

    const view = await renderSidebar({ mobileOpen: true })
    const backdrop = view.container.querySelector('[aria-hidden="true"]')

    expect(backdrop).toBeTruthy()
    expect(backdrop?.className).toContain('mobile-safe-top')
    expect(backdrop?.className).toContain('bottom-0')
  })

  it('shows prior normal sessions even when mixed-mode data exists in cache', async () => {
    sessionsData = [
      {
        id: 'session-1',
        title: 'Normal session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'normal',
      },
      {
        id: 'session-2',
        title: 'Coding session',
        agent_name: 'lead',
        created_at: '2026-05-14T00:00:00Z',
        updated_at: '2026-05-14T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]

    await renderSidebar()

    expect(screen.getByText('Normal session')).toBeTruthy()
    expect(screen.queryByText('No sessions yet')).toBeNull()
  })
})
