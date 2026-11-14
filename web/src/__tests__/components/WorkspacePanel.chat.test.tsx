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
  MoreHorizontal: Icon, SlidersHorizontal: Icon, AlertTriangle: Icon, CheckCircle2: Icon, Info: Icon,
  Globe: Icon, ArrowRight: Icon, MousePointerClick: Icon, RotateCw: Icon, Smartphone: Icon, SquareTerminal: Icon, Send: Icon, Bot: Icon,
  CalendarClock: Icon, ListTodo: Icon, MessageCircleQuestion: Icon, Target: Icon, CircleCheck: Icon, Square: Icon, Unlink: Icon, MessageSquarePlus: Icon, FileVideo: Icon, ImageOff: Icon,
  AlertCircle: Icon, ArrowLeft: Icon, CalendarIcon: Icon, Circle: Icon, Clock: Icon, Minus: Icon,
  Pause: Icon, Play: Icon, Terminal: Icon, Trash2: Icon, Zap: Icon,
  ChevronDownIcon: Icon, ChevronLeftIcon: Icon, ChevronRightIcon: Icon,
  Check: Icon, CheckSquare: Icon, ChevronDown: Icon, ChevronLeft: Icon, ChevronRight: Icon,
  ChevronsDownUp: Icon, ChevronsUpDown: Icon,
  ClipboardPaste: Icon, Copy: Icon, Download: Icon, ExternalLink: Icon, WrapText: Icon, File: Icon, FileDiff: Icon, FileHeadphone: Icon, FileText: Icon,
  Folder: Icon, FolderOpen: Icon, GitCommitHorizontal: Icon, GitCompare: Icon, Loader2: Icon,
  Maximize2: Icon, Columns2: Icon, Rows2: Icon, Minimize2: Icon, Plus: Icon,
  Pencil: Icon, RefreshCw: Icon, RotateCcw: Icon, Search: Icon, TerminalSquare: Icon, Eraser: Icon, Undo2: Icon, X: Icon,
}))
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
}))
mock.module('framer-motion', () => ({
  // The phone's row sheets (ActionSheet → BottomSheet) import it.
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    aside: ({ children, className, 'aria-label': ariaLabel }: { children: React.ReactNode; className?: string; 'aria-label'?: string }) => (
      <aside className={className} aria-label={ariaLabel}>{children}</aside>
    ),
  },
}))

let requestedUrls: string[] = []
/** What the workspace tree says of WORKSPACE: a Git repository, or a plain folder. */
let workspaceIsGit = true
/** The session's goal and side questions, as the server holds them. */
let goal: Record<string, unknown> | null = null
let sideQuestionTotal = 0

beforeEach(() => {
  requestedUrls = []
  workspaceIsGit = true
  goal = null
  sideQuestionTotal = 0
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    requestedUrls.push(url)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify(filesResponse))
    if (url.includes('/workspace/tree')) {
      return new Response(JSON.stringify({ repositories: [{ path: WORKSPACE, name: 'user', worktrees: [], git: workspaceIsGit }], chat: null, groups: [] }))
    }
    if (url.includes('/goal')) return new Response(JSON.stringify({ goal }))
    if (url.includes('/btw/count')) return new Response(JSON.stringify({ total: sideQuestionTotal }))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})

afterEach(cleanup)

async function renderPanel(chatWorkspace: boolean, { openGit = false, sessionId = null as string | null } = {}) {
  const { WorkspacePanel } = await import('@/components/WorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel
          workspace={WORKSPACE}
          open
          sessionId={sessionId}
          chatWorkspace={chatWorkspace}
          viewRequest={openGit ? { view: 'review', key: 1 } : null}
        />
      </QueryClientProvider>,
    )
  })
  // The tree, the goal and the side-question count land after the first paint.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

const launcherRow = (name: string) => screen.queryByRole('button', { name: new RegExp(`^${name}( \\(|$)`) })

describe('WorkspacePanel chat workspace', () => {
  it('never offers Git or probes git for a chat root, even when asked to open it', async () => {
    await renderPanel(true, { openGit: true })

    expect(screen.queryByRole('button', { name: 'Changes' })).toBeNull()
    expect(launcherRow('Changes')).toBeNull()
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

    expect(screen.queryByRole('button', { name: 'Changes' })).toBeNull()
    await act(async () => { launcherRow('Changes')!.click() })
    const gitTab = screen.getByRole('button', { name: 'Changes' })
    expect(gitTab.getAttribute('aria-current')).toBe('true')
    expect(launcherRow('Terminal')).toBeNull()

    // Git is an ordinary tab: closing it goes back to the launcher.
    await act(async () => { screen.getByRole('button', { name: 'Close Changes' }).click() })
    expect(screen.queryByRole('button', { name: 'Changes' })).toBeNull()
    expect(launcherRow('Changes')).toBeTruthy()
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
    expect(launcherRow('Changes')).toBeNull()

    await act(async () => {
      rerender(panel('/home/user/code/site', false))
    })
    expect(launcherRow('Changes')).toBeTruthy()
  })
})

/** Where you are decides: a folder without Git gets no Git view, as Chat does. */
describe('WorkspacePanel in a folder without Git', () => {
  it('offers no Changes row and leads with what it can show: files, preview, terminal', async () => {
    workspaceIsGit = false
    await renderPanel(false)

    expect(launcherRow('Changes')).toBeNull()
    const names = Array.from(document.querySelectorAll('[data-dock-launcher] button'), (row) => row.querySelector('span')?.textContent)
    expect(names).toEqual(['Find file…', 'Preview', 'Terminal', 'Tasks', 'Scheduled tasks'])
    // Tools lead, so the hairline sits between Terminal and Tasks.
    const divider = document.querySelector('[data-launcher-divider]') as HTMLElement
    expect(divider.previousElementSibling?.textContent).toContain('Terminal')
  })

  it('does not open the Git view when asked to, and probes no git', async () => {
    workspaceIsGit = false
    await renderPanel(false, { openGit: true })

    expect(screen.queryByRole('button', { name: 'Changes' })).toBeNull()
    expect(screen.queryByText(/Not a git repository/i)).toBeNull()
    expect(requestedUrls.filter((url) => url.includes('git-diff') || url.includes('git/history'))).toEqual([])
  })

  it('keeps Changes first in a repository', async () => {
    await renderPanel(false)
    const names = Array.from(document.querySelectorAll('[data-dock-launcher] button'), (row) => row.querySelector('span')?.textContent)
    expect(names).toEqual(['Changes', 'Tasks', 'Scheduled tasks', 'Terminal', 'Preview', 'Find file…'])
  })
})

/** Empty things take no room: Goal and Side questions show once the session has one. */
describe('WorkspacePanel launcher rows for things a session may not have', () => {
  it('lists neither Goal nor Side questions for a session without them', async () => {
    await renderPanel(false, { sessionId: 's1' })
    expect(launcherRow('Goal')).toBeNull()
    expect(launcherRow('Side questions')).toBeNull()
    expect(launcherRow('Tasks')).toBeTruthy()
  })

  it('lists Goal once the session has a goal, and Side questions once it has one', async () => {
    goal = { id: 'g1', session_id: 's1', objective: 'Ship it', status: 'active', pause_reason: null, detail: null, max_turns: 50, token_budget: null, turns_used: 1, tokens_used: 10, active_seconds: 5, rejected_claims: 0, created_at: '2026-11-14T00:00:00Z', updated_at: '2026-11-14T00:00:00Z', ended_at: null }
    sideQuestionTotal = 2
    await renderPanel(false, { sessionId: 's1' })
    expect(launcherRow('Goal')).toBeTruthy()
    expect(launcherRow('Side questions')).toBeTruthy()
  })
})
