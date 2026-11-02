/**
 * The Review panel's panes: ⌘\ and ⌘⇧\ split the focused pane right and down
 * into an empty pane (its launcher) as often as there is room, a tab's menu
 * splits it off, and a pane closes with its last tab; ⌃` shows the terminal
 * pane under the open tabs and hides it without stopping the shell (closing
 * the panel when nothing else is open); a file opened from a list is an
 * italic preview tab until it is kept; a strip too narrow for its tabs lists
 * them all. (Dragging tabs between panes: ``DockTabs.reorder.test.tsx``.)
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { gitDiffResponse } from '../git-diff-mock'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { useTerminalStore, _resetTerminalStoreForTests } from '@/stores/useTerminalStore'
import { useToastStore } from '@/stores/useToastStore'
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
  Maximize2: Icon, Columns2: Icon, Rows2: Icon, Minimize2: Icon, Plus: Icon,
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

/** The panes on screen, in layout order (one pane is not named a group). */
const panes = () => screen.queryAllByRole('group', { name: /^Pane \d/ })
const pane = (n: number) => screen.getByRole('group', { name: `Pane ${n}` })
/** The pane a tab is in. */
const paneOf = (name: string) => screen.getByRole('button', { name }).closest<HTMLElement>('[data-dock-pane]')!
const GIT: DockViewRequest = { view: 'review', key: 1 }

describe('splitting the Review panel', () => {
  it('splits right and down as often as there is room, each new pane empty and focused', async () => {
    const { update } = await renderPanel({ viewRequest: GIT })
    expect(panes()).toHaveLength(0)

    await update({ layoutRequest: { action: 'split-right', key: 1 } })
    expect(panes()).toHaveLength(2)
    expect(within(pane(1)).getByRole('button', { name: 'Git' })).toBeTruthy()
    // The new pane offers what to open.
    expect(within(pane(2)).getByRole('group', { name: 'Open in Review panel' })).toBeTruthy()
    expect(screen.getByRole('separator', { name: 'Resize panes' }).getAttribute('aria-orientation')).toBe('vertical')

    // ⌘\ again splits the focused (new) pane, not the first one.
    await update({ layoutRequest: { action: 'split-right', key: 2 } })
    expect(panes()).toHaveLength(3)
    await update({ layoutRequest: { action: 'split-down', key: 3 } })
    expect(panes()).toHaveLength(4)
    const bars = screen.getAllByRole('separator', { name: 'Resize panes' })
    expect(bars.map((bar) => bar.getAttribute('aria-orientation'))).toEqual(['vertical', 'vertical', 'horizontal'])
    expect(pane(4).hasAttribute('data-pane-unfocused')).toBe(false)
    expect(pane(1).hasAttribute('data-pane-unfocused')).toBe(true)

    // An empty pane beside others closes from its strip; Git is untouched.
    await act(async () => { within(pane(4)).getByRole('button', { name: /^Close pane/ }).click() })
    expect(panes()).toHaveLength(3)
    expect(within(pane(1)).getByRole('button', { name: 'Git' }).getAttribute('aria-current')).toBe('true')
  })

  it('says so instead of splitting a pane too small for two', async () => {
    useToastStore.setState({ toasts: [] })
    const rect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.hasAttribute('data-dock-pane')
        ? ({ left: 0, top: 0, right: 300, bottom: 600, width: 300, height: 600, x: 0, y: 0 }) as DOMRect
        : rect.call(this)
    }
    try {
      const { update } = await renderPanel({ viewRequest: GIT })
      await update({ layoutRequest: { action: 'split-right', key: 1 } })
      expect(panes()).toHaveLength(0)
      expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual(['No room to split this pane'])

      // Down there is room.
      await update({ layoutRequest: { action: 'split-down', key: 2 } })
      expect(panes()).toHaveLength(2)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect
    }
  })

  it('a tab splits off into a new pane from its menu; closing its last tab closes the pane', async () => {
    await renderPanel({ viewRequest: GIT, selectedFilePath: main.path, selectedFileOpenKey: 1 })
    await waitFor(() => expect(screen.getByRole('button', { name: main.name })).toBeTruthy())

    fireEvent.contextMenu(screen.getByRole('button', { name: main.name }))
    await act(async () => { screen.getByRole('menuitem', { name: 'Split Right' }).click() })
    expect(panes()).toHaveLength(2)
    expect(paneOf(main.name)).toBe(pane(2))
    expect(paneOf('Git')).toBe(pane(1))

    // Git is alone in its pane now: splitting it off would leave nothing.
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Git' }))
    expect((screen.getByRole('menuitem', { name: 'Split Down' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { screen.getByRole('menuitem', { name: 'Move to Next Pane' }).click() })
    expect(panes()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Git' }).getAttribute('aria-current')).toBe('true')

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Git' }))
    await act(async () => { screen.getByRole('menuitem', { name: 'Split Down' }).click() })
    expect(panes()).toHaveLength(2)
    await act(async () => { screen.getByRole('button', { name: 'Close Git' }).click() })
    expect(panes()).toHaveLength(0)
    expect(screen.getByRole('button', { name: main.name })).toBeTruthy()
  })
})

describe('terminal panes', () => {
  const terminalPane = () => screen.queryByRole('button', { name: 'Terminal 1' })?.closest<HTMLElement>('[data-dock-pane]') ?? null

  it('opens a terminal in a pane under the open tabs, hides it without stopping the shell, and shows it again', async () => {
    const { update } = await renderPanel({ viewRequest: GIT })

    await update({ layoutRequest: { action: 'terminal-show', key: 1 } })
    await waitFor(() => expect(terminalPane()).toBeTruthy())
    expect(terminalPane()).toBe(pane(2))
    expect(screen.getByRole('button', { name: 'Git' }).getAttribute('aria-current')).toBe('true')

    await update({ layoutRequest: { action: 'terminal-toggle', key: 2 } })
    expect(panes()).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Terminal 1' })).toBeNull()
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)

    await update({ layoutRequest: { action: 'terminal-toggle', key: 3 } })
    expect(terminalPane()).toBe(pane(2))
    // The same shell, not a new one.
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)
  })

  it('hides from its own strip', async () => {
    const { update } = await renderPanel({ viewRequest: GIT })
    await update({ layoutRequest: { action: 'terminal-show', key: 1 } })
    await waitFor(() => expect(terminalPane()).toBeTruthy())

    await act(async () => { within(terminalPane()!).getByRole('button', { name: /^Hide terminals/ }).click() })

    expect(terminalPane()).toBeNull()
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)
  })

  it('closes the panel when hiding them would leave nothing on screen', async () => {
    const onRequestClose = mock(() => {})
    const { update } = await renderPanel({ onRequestClose })
    await update({ layoutRequest: { action: 'terminal-show', key: 1 } })
    await waitFor(() => expect(terminalPane()).toBeTruthy())

    await update({ layoutRequest: { action: 'terminal-toggle', key: 2 } })

    expect(onRequestClose).toHaveBeenCalledTimes(1)
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)
  })

  // An empty pane (⌘\ with nothing moved in yet) has no terminal to hide:
  // ⌃` starts one there instead of closing the panel.
  it('starts a terminal in an empty focused pane instead of hiding anything', async () => {
    const onRequestClose = mock(() => {})
    const { update } = await renderPanel({ viewRequest: GIT, onRequestClose })
    await update({ layoutRequest: { action: 'split-down', key: 1 } })
    expect(panes()).toHaveLength(2)

    await update({ layoutRequest: { action: 'terminal-toggle', key: 2 } })

    await waitFor(() => expect(terminalPane()).toBe(pane(2)))
    expect(onRequestClose).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)
  })

  it('never opens a document in a terminal pane', async () => {
    const { update } = await renderPanel({ layoutRequest: { action: 'terminal-show', key: 1 } })
    await waitFor(() => expect(terminalPane()).toBeTruthy())
    expect(panes()).toHaveLength(0)

    await update({ selectedFilePath: main.path, selectedFileOpenKey: 1 })
    await waitFor(() => expect(screen.getByRole('button', { name: main.name })).toBeTruthy())
    // A pane above the shells, for documents.
    expect(paneOf(main.name)).toBe(pane(1))
    expect(terminalPane()).toBe(pane(2))
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
