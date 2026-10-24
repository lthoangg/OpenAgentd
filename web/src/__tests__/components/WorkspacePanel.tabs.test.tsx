/**
 * Review dock editor tabs — diff and commit tabs, neighbour activation on
 * close, and the Git view's segmented control.
 *
 * Diff tabs read the shared whole-workspace diff query; commit tabs read the
 * commit-diff query. Both are opened from row actions in the Git review tab.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { _resetTerminalStoreForTests } from '@/stores/useTerminalStore'

const WORKSPACE = '/repo/project'
const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,2 @@',
  ' const keep = 1',
  '-const before = 2',
  '+const after = 3',
].join('\n')
const COMMIT_DIFF = [
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-old readme line',
  '+new readme line',
].join('\n')
const commit = {
  sha: 'aaaaaaabbbbbbbcccccccddddddd',
  short_sha: 'aaaaaaa',
  author_name: 'Mai Tran',
  author_email: 'mai@example.com',
  timestamp: 1700000000,
  subject: 'docs: refresh readme',
  body: null,
  refs: null,
}
const appFile = { path: 'src/app.ts', name: 'app.ts', size: 40, mtime: 1, mime: 'text/plain' }

const Icon = () => null
mock.module('lucide-react', () => ({
  AlertTriangle: Icon, CheckCircle2: Icon, Info: Icon,
  Globe: Icon, ArrowRight: Icon, MousePointerClick: Icon, RotateCw: Icon, Smartphone: Icon, SquareTerminal: Icon, Send: Icon, Bot: Icon,
  CalendarClock: Icon, ListTodo: Icon, MessageCircleQuestion: Icon, Target: Icon, CircleCheck: Icon, Square: Icon, Unlink: Icon, MessageSquarePlus: Icon, FileVideo: Icon, ImageOff: Icon,
  AlertCircle: Icon, ArrowLeft: Icon, CalendarIcon: Icon, Circle: Icon, Clock: Icon, Minus: Icon,
  Pause: Icon, Play: Icon, Terminal: Icon, Trash2: Icon, Zap: Icon,
  ChevronDownIcon: Icon, ChevronLeftIcon: Icon, ChevronRightIcon: Icon,
  Check: Icon, ChevronDown: Icon, ChevronLeft: Icon, ChevronRight: Icon,
  ChevronsDownUp: Icon, ChevronsUpDown: Icon,
  Copy: Icon, Download: Icon, ExternalLink: Icon, File: Icon, FileDiff: Icon, FileHeadphone: Icon, FileText: Icon,
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
mock.module('@/api/terminal', () => ({ connectTerminal: mock(() => new Promise(() => {})) }))

let requestedUrls: string[] = []

beforeEach(() => {
  _resetTerminalStoreForTests()
  useGitPanelStore.setState({ workspaces: {} })
  requestedUrls = []
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    requestedUrls.push(url)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify({ workspace: WORKSPACE, truncated: false, files: [appFile] }))
    if (url.includes('/workspace/files/read')) return new Response('const after = 3')
    if (url.includes('/workspace/git-diff')) return new Response(JSON.stringify({ workspace: WORKSPACE, is_git_repo: true, diff: DIFF, untracked: [] }))
    if (url.includes('/workspace/status')) return new Response(JSON.stringify({ workspace: WORKSPACE, name: 'project', is_git_repo: true }))
    if (url.includes('/workspace/git/history')) return new Response(JSON.stringify({ workspace: WORKSPACE, is_git_repo: true, commits: [commit], graph: '', next_cursor: null }))
    if (url.includes('/workspace/git/commit-diff')) return new Response(JSON.stringify({ sha: commit.sha, diff: COMMIT_DIFF }))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})
afterEach(cleanup)

async function renderPanel(onFileSelect = mock(() => {}), ready: RegExp | string = /diff for src\/app\.ts/) {
  const { WorkspacePanel } = await import('@/components/WorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel workspace={WORKSPACE} open onFileSelect={onFileSelect} viewRequest={{ view: 'review', key: 1 }} />
      </QueryClientProvider>,
    )
  })
  await waitFor(() => expect(screen.getByRole('button', { name: ready })).toBeTruthy())
}

const tabStrip = () => screen.getByRole('button', { name: 'Git' }).closest('.scrollbar-none') as HTMLElement

describe('Review dock diff tabs', () => {
  it('opens a changed file diff as a full-height tab from the row action', async () => {
    const user = userEvent.setup()
    await renderPanel()

    await user.click(screen.getByRole('button', { name: 'Open diff tab for src/app.ts' }))

    const diffTab = await screen.findByRole('button', { name: 'app.ts diff' })
    expect(diffTab.getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Git' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByText('const before = 2')).toBeTruthy()
    expect(screen.getByText('const after = 3')).toBeTruthy()
    // Same cache entry as the Changes list: no extra diff request.
    expect(requestedUrls.filter((url) => url.includes('/workspace/git-diff'))).toHaveLength(1)
  })

  it('re-opening the same diff focuses the existing tab instead of duplicating it', async () => {
    const user = userEvent.setup()
    await renderPanel()

    await user.click(screen.getByRole('button', { name: 'Open diff tab for src/app.ts' }))
    await user.click(screen.getByRole('button', { name: 'Git' }))
    await user.click(screen.getByRole('button', { name: 'Open diff tab for src/app.ts' }))

    expect(within(tabStrip()).getAllByRole('button', { name: 'app.ts diff' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'app.ts diff' }).getAttribute('aria-current')).toBe('true')
  })

  it('opens and focuses a diff tab for a diffRequest prop', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <WorkspacePanel
            workspace={WORKSPACE}
            open
            diffRequest={{ path: 'src/app.ts', status: 'M', key: 1 }}
          />
        </QueryClientProvider>,
      )
    })

    const diffTab = await screen.findByRole('button', { name: 'app.ts diff' })
    expect(diffTab.getAttribute('aria-current')).toBe('true')
  })

  it('opens the working file from the diff tab toolbar', async () => {
    const user = userEvent.setup()
    const onFileSelect = mock(() => {})
    await renderPanel(onFileSelect)

    await user.click(screen.getByRole('button', { name: 'Open diff tab for src/app.ts' }))
    await screen.findByRole('button', { name: 'app.ts diff' })
    const [toolbarOpen] = screen.getAllByRole('button', { name: 'Open src/app.ts' })
    await user.click(toolbarOpen)

    expect(onFileSelect).toHaveBeenCalledWith(appFile)
    expect(screen.getByRole('button', { name: 'app.ts' }).getAttribute('aria-current')).toBe('true')
  })

  it('opens a tab after the active one, and closing it focuses its right neighbour', async () => {
    const user = userEvent.setup()
    await renderPanel()

    await user.click(screen.getByRole('button', { name: 'Open src/app.ts' }))
    await user.click(screen.getByRole('button', { name: 'Git' }))
    // [Git, app.ts] → the diff opens right after Git: [Git, app.ts diff, app.ts].
    await user.click(screen.getByRole('button', { name: 'Open diff tab for src/app.ts' }))
    await user.click(screen.getByRole('button', { name: 'Close app.ts diff' }))

    expect(screen.queryByRole('button', { name: 'app.ts diff' })).toBeNull()
    expect(screen.getByRole('button', { name: 'app.ts' }).getAttribute('aria-current')).toBe('true')
  })

  it('middle-click closes a closable tab', async () => {
    const user = userEvent.setup()
    await renderPanel()

    await user.click(screen.getByRole('button', { name: 'Open diff tab for src/app.ts' }))
    fireEvent(screen.getByRole('button', { name: 'app.ts diff' }), new MouseEvent('auxclick', { bubbles: true, button: 1 }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'app.ts diff' })).toBeNull())
  })

  it('offers row actions on Shift+F10', async () => {
    await renderPanel()
    const row = screen.getByRole('button', { name: /diff for src\/app\.ts/ })

    await act(async () => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    })
    const menu = screen.getByRole('menu', { name: 'Actions for src/app.ts' })
    expect(within(menu).getByRole('menuitem', { name: /Open diff in tab/ })).toBeTruthy()
  })
})

describe('Review dock commit tabs', () => {
  it('opens a commit as a tab with its header and file patches', async () => {
    const user = userEvent.setup()
    useGitPanelStore.getState().setSubTab(WORKSPACE, 'commits')
    await renderPanel(undefined, 'Open commit aaaaaaa in tab')

    await user.click(screen.getByRole('button', { name: 'Open commit aaaaaaa in tab' }))

    const commitTab = await screen.findByRole('button', { name: 'Commit aaaaaaa' })
    expect(commitTab.getAttribute('aria-current')).toBe('true')
    expect(screen.getByText('docs: refresh readme')).toBeTruthy()
    expect(screen.getByText('Mai Tran')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('new readme line')).toBeTruthy())
    expect(screen.getByRole('button', { name: /README\.md/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('offers "Open in tab" from the desktop commit context menu', async () => {
    const user = userEvent.setup()
    useGitPanelStore.getState().setSubTab(WORKSPACE, 'commits')
    await renderPanel(undefined, 'Open commit aaaaaaa in tab')

    const row = (await screen.findByText('docs: refresh readme')).closest('button')!
    fireEvent.contextMenu(row)
    await user.click(await screen.findByRole('menuitem', { name: /Open in tab/ }))

    expect(await screen.findByRole('button', { name: 'Commit aaaaaaa' })).toBeTruthy()
  })
})

describe('Git view toolbar', () => {
  it('is a real tablist wired to the view panel', async () => {
    await renderPanel()

    const tablist = screen.getByRole('tablist', { name: 'Git view' })
    const tabs = within(tablist).getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Changes (1)', 'History'])
    const panel = screen.getByRole('tabpanel')
    expect(tabs[0].getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0].id)
  })

  it('shows commits under History and swaps in the graph with its toggle', async () => {
    const user = userEvent.setup()
    await renderPanel()

    await user.click(screen.getByRole('tab', { name: 'History' }))
    await waitFor(() => expect(screen.getByText('docs: refresh readme')).toBeTruthy())
    const history = screen.getByRole('tab', { name: 'History' })
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(history.id)
    const graph = screen.getByRole('checkbox', { name: 'Graph' }) as HTMLInputElement
    expect(graph.checked).toBe(false)
    expect(screen.queryByRole('checkbox', { name: 'All branches' })).toBeNull()

    await user.click(graph)

    expect(useGitPanelStore.getState().workspaces[WORKSPACE]?.subTab).toBe('tree')
    expect((screen.getByRole('checkbox', { name: 'Graph' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'All branches' })).toBeTruthy()
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(history.id)
  })

  it('leaves file search to Quick Open and keeps Refresh in the dock actions', async () => {
    await renderPanel()
    expect(screen.queryByRole('button', { name: /Search files/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
  })

  it('expand-all toggles every changed-file diff open and closed', async () => {
    const user = userEvent.setup()
    await renderPanel()

    const toggle = screen.getByRole('button', { name: 'Expand all diffs' })
    await user.click(toggle)
    expect(screen.getByRole('button', { name: /Collapse diff for src\/app\.ts/ })).toBeTruthy()
    // The label carries the state; aria-pressed on top would announce it twice.
    expect(screen.getByRole('button', { name: 'Collapse all diffs' }).hasAttribute('aria-pressed')).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Collapse all diffs' }))
    expect(screen.getByRole('button', { name: /Expand diff for src\/app\.ts/ })).toBeTruthy()
  })

  it('expanding diffs in the list never scrolls ancestors', async () => {
    const user = userEvent.setup()
    await renderPanel()
    const scrollIntoView = mock(() => {})
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      await user.click(screen.getByRole('button', { name: 'Expand all diffs' }))
      expect(screen.getByText('const after = 3')).toBeTruthy()
      // scrollIntoView also scrolls overflow-hidden shells, shifting the app.
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('drops remembered expansions for files that are no longer changed', async () => {
    useGitPanelStore.getState().setExpandedDiffs(WORKSPACE, ['src/committed-earlier.ts', 'src/app.ts'])
    await renderPanel(undefined, /Collapse diff for src\/app\.ts/)

    await waitFor(() => expect(useGitPanelStore.getState().workspaces[WORKSPACE].expandedDiffs).toEqual(['src/app.ts']))
  })
})
