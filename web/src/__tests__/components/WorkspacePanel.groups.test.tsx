/**
 * The Review panel's two groups: ⌘\ splits into an empty lower group (its
 * launcher) and joins again; ⌃` shows the terminal group under the open
 * tabs and hides it without stopping the shell (closing the panel when
 * nothing else is open); a file opened from a list is an italic preview tab
 * until it is kept; a strip too narrow for its tabs lists them all.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { gitDiffResponse } from '../git-diff-mock'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { useTerminalStore, _resetTerminalStoreForTests } from '@/stores/useTerminalStore'
import { _resetKeyboardForTests } from '@/lib/keyboard/dispatcher'
import type { WorkspaceFileInfo } from '@/api/types'
import type { DockLayoutRequest, DockViewRequest } from '@/components/WorkspacePanel/dock-tabs'

const WORKSPACE = '/repo/project'
const main: WorkspaceFileInfo = { path: 'main.ts', name: 'main.ts', size: 24, mtime: 1, mime: 'text/plain' }
const other: WorkspaceFileInfo = { path: 'other.ts', name: 'other.ts', size: 12, mtime: 1, mime: 'text/plain' }
const filesResponse = { workspace: WORKSPACE, truncated: false, files: [main, other] }
const diffResponse = { workspace: WORKSPACE, is_git_repo: false, diff: '', untracked: [] as string[] }

const Icon = () => null
mock.module('lucide-react', () => ({
  MoreHorizontal: Icon, SlidersHorizontal: Icon, AlertTriangle: Icon, CheckCircle2: Icon, Info: Icon,
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
mock.module('@/api/terminal', () => ({
  connectTerminal: mock(() => new Promise(() => {})),
}))

beforeEach(() => {
  _resetKeyboardForTests()
  _resetTerminalStoreForTests()
  useGitPanelStore.setState({ workspaces: {} })
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify(filesResponse))
    if (url.includes('/workspace/files/read')) return new Response('const x = 1')
    if (url.includes('/workspace/git-diff')) return gitDiffResponse(url, diffResponse)
    if (url.includes('/workspace/status')) return new Response(JSON.stringify({ workspace: WORKSPACE }))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})
afterEach(cleanup)

interface PanelProps {
  viewRequest?: DockViewRequest | null
  layoutRequest?: DockLayoutRequest | null
  selectedFilePath?: string
  selectedFileOpenKey?: number
  onRequestClose?: () => void
}

async function renderPanel(initial: PanelProps = {}) {
  const { WorkspacePanel } = await import('@/components/WorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let props = initial
  const ui = () => (
    <QueryClientProvider client={queryClient}>
      <WorkspacePanel
        workspace={WORKSPACE}
        open
        terminalOpenKey={0}
        viewRequest={props.viewRequest ?? null}
        layoutRequest={props.layoutRequest ?? null}
        selectedFilePath={props.selectedFilePath}
        selectedFileOpenKey={props.selectedFileOpenKey}
        onFileSelect={() => {}}
        onRequestClose={props.onRequestClose}
      />
    </QueryClientProvider>
  )
  let rerender: (node: React.ReactElement) => void = () => {}
  await act(async () => {
    rerender = render(ui()).rerender
  })
  return {
    update: (next: PanelProps) => act(async () => {
      props = { ...props, ...next }
      rerender(ui())
    }),
  }
}

const lowerGroup = () => screen.queryByRole('group', { name: 'Lower group' })
const GIT: DockViewRequest = { view: 'review', key: 1 }

describe('splitting the Review panel', () => {
  it('splits into an empty lower group that offers what to open, and joins again', async () => {
    const { update } = await renderPanel({ viewRequest: GIT })
    expect(lowerGroup()).toBeNull()

    await update({ layoutRequest: { action: 'split', key: 1 } })
    const lower = lowerGroup()!
    expect(lower).toBeTruthy()
    expect(within(lower).getByRole('group', { name: 'Open in Review panel' })).toBeTruthy()
    expect(within(screen.getByRole('group', { name: 'Upper group' })).getByRole('button', { name: 'Git' })).toBeTruthy()
    expect(screen.getByRole('separator', { name: 'Resize Review panel groups' })).toBeTruthy()

    await update({ layoutRequest: { action: 'split', key: 2 } })
    expect(lowerGroup()).toBeNull()
    expect(screen.getByRole('button', { name: 'Git' }).getAttribute('aria-current')).toBe('true')
  })
})

describe('the terminal group', () => {
  it('opens a terminal under the open tabs, hides it without stopping the shell, and shows it again', async () => {
    const { update } = await renderPanel({ viewRequest: GIT })

    await update({ layoutRequest: { action: 'terminal-show', key: 1 } })
    await waitFor(() => expect(lowerGroup()).toBeTruthy())
    expect(within(lowerGroup()!).getByRole('button', { name: 'Terminal 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Git' }).getAttribute('aria-current')).toBe('true')

    await update({ layoutRequest: { action: 'terminal-toggle', key: 2 } })
    expect(lowerGroup()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Terminal 1' })).toBeNull()
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)

    await update({ layoutRequest: { action: 'terminal-toggle', key: 3 } })
    expect(within(lowerGroup()!).getByRole('button', { name: 'Terminal 1' })).toBeTruthy()
    // The same shell, not a new one.
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)
  })

  it('hides from its own strip', async () => {
    const { update } = await renderPanel({ viewRequest: GIT })
    await update({ layoutRequest: { action: 'terminal-show', key: 1 } })
    await waitFor(() => expect(lowerGroup()).toBeTruthy())

    await act(async () => { within(lowerGroup()!).getByRole('button', { name: /^Hide this group/ }).click() })

    expect(lowerGroup()).toBeNull()
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)
  })

  it('closes the panel when hiding it would leave nothing on screen', async () => {
    const onRequestClose = mock(() => {})
    const { update } = await renderPanel({ onRequestClose })
    await update({ layoutRequest: { action: 'terminal-show', key: 1 } })
    await waitFor(() => expect(lowerGroup()).toBeTruthy())

    await update({ layoutRequest: { action: 'terminal-toggle', key: 2 } })

    expect(onRequestClose).toHaveBeenCalledTimes(1)
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)
  })
})

describe('preview tabs', () => {
  const tabNode = (name: string) => screen.getByRole('button', { name }).closest<HTMLElement>('[data-dock-tab]')!

  it('a file opened from a list replaces the preview tab; a kept one stays', async () => {
    const { update } = await renderPanel({ selectedFilePath: main.path, selectedFileOpenKey: 1 })
    await waitFor(() => expect(screen.getByRole('button', { name: main.name })).toBeTruthy())
    expect(tabNode(main.name).hasAttribute('data-dock-tab-preview')).toBe(true)

    await update({ selectedFilePath: other.path, selectedFileOpenKey: 2 })
    await waitFor(() => expect(screen.getByRole('button', { name: other.name })).toBeTruthy())
    expect(screen.queryByRole('button', { name: main.name })).toBeNull()

    fireEvent.contextMenu(screen.getByRole('button', { name: other.name }))
    await act(async () => { screen.getByRole('menuitem', { name: 'Keep Open' }).click() })
    expect(tabNode(other.name).hasAttribute('data-dock-tab-preview')).toBe(false)

    await update({ selectedFilePath: main.path, selectedFileOpenKey: 3 })
    await waitFor(() => expect(screen.getByRole('button', { name: main.name })).toBeTruthy())
    expect(screen.getByRole('button', { name: other.name })).toBeTruthy()
  })

  it('says it is a preview in its description, keeping the file name as its name', async () => {
    await renderPanel({ selectedFilePath: main.path, selectedFileOpenKey: 1 })
    await waitFor(() => expect(screen.getByRole('button', { name: main.name })).toBeTruthy())
    const button = screen.getByRole('button', { name: main.name })
    expect(button.getAttribute('aria-description')).toContain('Preview')
    expect(button.querySelector('.italic')?.textContent).toBe(main.name)
  })
})

describe('a strip that cannot show every tab', () => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
  afterEach(() => {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', descriptor)
    else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth
  })

  it('lists every tab, and picks one from the list', async () => {
    // Strips scroll sideways ("scrollbar-none"); pretend each is overfull.
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('scrollbar-none') ? 2000 : 0 },
    })
    for (let i = 0; i < 2; i++) useTerminalStore.getState().open({ workspace: WORKSPACE }, WORKSPACE)
    await renderPanel()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Terminal 2' })).toBeTruthy())

    await act(async () => { screen.getByRole('button', { name: 'All tabs (2)' }).click() })
    const list = screen.getByRole('menu', { name: 'All tabs' })
    const rows = within(list).getAllByRole('menuitemradio')
    expect(rows.map((row) => row.textContent)).toEqual(['Terminal 1', 'Terminal 2'])
    expect(rows[0].getAttribute('aria-checked')).toBe('true')

    await act(async () => { rows[1].click() })
    expect(screen.queryByRole('menu', { name: 'All tabs' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Terminal 2' }).getAttribute('aria-current')).toBe('true')
  })
})
