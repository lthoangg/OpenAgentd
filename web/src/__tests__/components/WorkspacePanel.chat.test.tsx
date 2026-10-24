/**
 * Chat workspaces in WorkspacePanel.
 *
 * The chat root is the user's home directory and usually not a git repo, so
 * the dock must not present a Git review tab (or spend git probes on it) while
 * keeping file tabs and terminals available.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const WORKSPACE = '/home/user'
const filesResponse = { workspace: WORKSPACE, truncated: true, files: [] }

const Icon = () => null
mock.module('lucide-react', () => ({
  AlertTriangle: Icon, CheckCircle2: Icon, Info: Icon,
  Globe: Icon, ArrowRight: Icon, MousePointerClick: Icon, RotateCw: Icon, Smartphone: Icon, SquareTerminal: Icon, Send: Icon, Bot: Icon,
  CalendarClock: Icon, ListTodo: Icon, MessageCircleQuestion: Icon, Target: Icon, CircleCheck: Icon, Square: Icon, Unlink: Icon, MessageSquarePlus: Icon, FileVideo: Icon, ImageOff: Icon,
  AlertCircle: Icon, ArrowLeft: Icon, CalendarIcon: Icon, Circle: Icon, Clock: Icon, Minus: Icon,
  Pause: Icon, Play: Icon, Terminal: Icon, Trash2: Icon, Zap: Icon,
  ChevronDownIcon: Icon, ChevronLeftIcon: Icon, ChevronRightIcon: Icon,
  Check: Icon, CheckSquare: Icon, ChevronDown: Icon, ChevronLeft: Icon, ChevronRight: Icon,
  ChevronsDownUp: Icon, ChevronsUpDown: Icon,
  ClipboardPaste: Icon, Copy: Icon, Download: Icon, ExternalLink: Icon, File: Icon, FileDiff: Icon, FileHeadphone: Icon, FileText: Icon,
  Folder: Icon, FolderOpen: Icon, GitCommitHorizontal: Icon, GitCompare: Icon, Loader2: Icon,
  Maximize2: Icon, Minimize2: Icon, Plus: Icon,
  Pencil: Icon, RefreshCw: Icon, RotateCcw: Icon, Search: Icon, TerminalSquare: Icon, Eraser: Icon, Undo2: Icon, X: Icon,
}))
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
}))
mock.module('framer-motion', () => ({
  motion: {
    aside: ({ children, className, 'aria-label': ariaLabel }: { children: React.ReactNode; className?: string; 'aria-label'?: string }) => (
      <aside className={className} aria-label={ariaLabel}>{children}</aside>
    ),
  },
}))

let requestedUrls: string[] = []

beforeEach(() => {
  requestedUrls = []
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    requestedUrls.push(url)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify(filesResponse))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})

afterEach(cleanup)

async function renderPanel(chatWorkspace: boolean, { openGit = false } = {}) {
  const { WorkspacePanel } = await import('@/components/WorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel
          workspace={WORKSPACE}
          open
          chatWorkspace={chatWorkspace}
          viewRequest={openGit ? { view: 'review', key: 1 } : null}
        />
      </QueryClientProvider>,
    )
  })
}

const launcherRow = (name: string) => screen.queryByRole('button', { name: new RegExp(`^${name}( \\(|$)`) })

describe('WorkspacePanel chat workspace', () => {
  it('never offers Git or probes git for a chat root, even when asked to open it', async () => {
    await renderPanel(true, { openGit: true })

    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
    expect(launcherRow('Git')).toBeNull()
    expect(launcherRow('Terminal')).toBeTruthy()
    expect(
      requestedUrls.filter(
        (url) =>
          url.includes('git-diff') ||
          url.includes('/workspace/status') ||
          url.includes('git/history'),
      ),
    ).toEqual([])
  })

  it('starts a coding workspace empty, with Git on the launcher', async () => {
    await renderPanel(false)

    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
    await act(async () => { launcherRow('Git')!.click() })
    const gitTab = screen.getByRole('button', { name: 'Git' })
    expect(gitTab.getAttribute('aria-current')).toBe('true')
    expect(launcherRow('Terminal')).toBeNull()

    // Git is an ordinary tab: closing it goes back to the launcher.
    await act(async () => { screen.getByRole('button', { name: 'Close Git' }).click() })
    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
    expect(launcherRow('Git')).toBeTruthy()
  })

  it('offers Git again when the open dock moves from Chat to a project', async () => {
    // The dock stays open across workspace switches, so the same panel
    // instance receives the new workspace.
    const { WorkspacePanel } = await import('@/components/WorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const panel = (workspace: string, chatWorkspace: boolean) => (
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel workspace={workspace} open chatWorkspace={chatWorkspace} />
      </QueryClientProvider>
    )
    let rerender: (ui: React.ReactElement) => void = () => {}
    await act(async () => {
      rerender = render(panel(WORKSPACE, true)).rerender
    })
    expect(launcherRow('Git')).toBeNull()

    await act(async () => {
      rerender(panel('/home/user/code/site', false))
    })
    expect(launcherRow('Git')).toBeTruthy()
  })
})
