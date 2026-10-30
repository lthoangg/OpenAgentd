/**
 * Dock tab keys and the tab menu: ⌘1–⌘9 (Ctrl on Linux) pick a tab by
 * position with 9 as the last, ⌃Tab / ⌃⇧Tab step with wrap-around, both only
 * while the dock is open; focus follows only when it was already in the dock.
 * The tab menu's Close Others / Close to the Right confirm before stopping a
 * running shell.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { gitDiffResponse } from '../git-diff-mock'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { useTerminalStore, _resetTerminalStoreForTests } from '@/stores/useTerminalStore'
import { _resetKeyboardForTests } from '@/lib/keyboard/dispatcher'

const WORKSPACE = '/repo/project'
const filesResponse = { workspace: WORKSPACE, truncated: false, files: [] }
const diffResponse = { workspace: WORKSPACE, is_git_repo: false, diff: '', untracked: [] as string[] }

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
    if (url.includes('/workspace/git-diff')) return gitDiffResponse(url, diffResponse)
    if (url.includes('/workspace/status')) return new Response(JSON.stringify({ workspace: WORKSPACE }))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})
afterEach(cleanup)

/**
 * By default three terminals, then Git: [Terminal 1, Terminal 2, Terminal 3,
 * Git], with Git active (adopted terminals come first, Git opens after them).
 */
async function renderDock({ open = true, exited = false, terminals = 3, git = true, onRequestClose = undefined as (() => void) | undefined } = {}) {
  for (let i = 0; i < terminals; i++) useTerminalStore.getState().open({ workspace: WORKSPACE }, WORKSPACE)
  if (exited) {
    useTerminalStore.setState((state) => ({
      sessions: Object.fromEntries(Object.entries(state.sessions).map(([id, meta]) => [id, { ...meta, status: 'exited' as const }])),
    }))
  }
  const { WorkspacePanel } = await import('@/components/WorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel
          workspace={WORKSPACE}
          open={open}
          terminalOpenKey={0}
          viewRequest={git ? { view: 'review', key: 1 } : null}
          onRequestClose={onRequestClose}
        />
      </QueryClientProvider>,
    )
  })
  if (terminals > 0) await waitFor(() => expect(screen.getByRole('button', { name: `Terminal ${terminals}` })).toBeTruthy())
}

const tab = (name: string) => screen.getByRole('button', { name })
const isActive = (name: string) => tab(name).getAttribute('aria-current') === 'true'
const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })

function press(key: string, mods: { shiftKey?: boolean } = {}, target: EventTarget = document.activeElement ?? document.body) {
  const code = /^[1-9]$/.test(key) ? `Digit${key}` : key
  return act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey: true, bubbles: true, cancelable: true, ...mods }))
  })
}

describe('dock tab keys', () => {
  it('Ctrl+N picks the tab at that position and Ctrl+9 the last', async () => {
    await renderDock()
    expect(isActive('Git')).toBe(true)
    await press('2')
    expect(isActive('Terminal 2')).toBe(true)
    await press('9')
    expect(isActive('Git')).toBe(true)
    await press('1')
    expect(isActive('Terminal 1')).toBe(true)
    // Past the last tab: nothing to pick.
    await press('6')
    expect(isActive('Terminal 1')).toBe(true)
  })

  it('does nothing while the dock is closed', async () => {
    await renderDock({ open: false })
    const git = screen.getByRole('button', { name: 'Git', hidden: true })
    expect(git.getAttribute('aria-current')).toBe('true')
    await press('3')
    await press('Tab')
    expect(git.getAttribute('aria-current')).toBe('true')
  })

  it('Ctrl+Tab and Ctrl+Shift+Tab step through the tabs and wrap', async () => {
    await renderDock()
    await press('Tab', { shiftKey: true })
    expect(isActive('Terminal 3')).toBe(true)
    await press('Tab')
    expect(isActive('Git')).toBe(true)
    await press('Tab')
    expect(isActive('Terminal 1')).toBe(true)
  })

  it('moves focus to the new tab only when focus was in the dock', async () => {
    await renderDock()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    await press('2')
    await frame()
    expect(isActive('Terminal 2')).toBe(true)
    expect(document.activeElement).toBe(outside)

    act(() => tab('Terminal 2').focus())
    await press('3')
    await frame()
    expect(isActive('Terminal 3')).toBe(true)
    expect(document.activeElement).toBe(tab('Terminal 3'))
    // A tab switch is not keyboard navigation inside the strip: no ring.
    expect(tab('Terminal 3').hasAttribute('data-quiet-focus')).toBe(true)
    outside.remove()
  })
})

describe('dock tab menu', () => {
  it('Close Others keeps only the chosen tab, and makes it active', async () => {
    await renderDock({ exited: true })
    fireEvent.contextMenu(tab('Terminal 2'))
    await act(async () => { screen.getByRole('menuitem', { name: 'Close other tabs' }).click() })
    expect(screen.queryByRole('button', { name: 'Terminal 1' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Terminal 3' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
    expect(isActive('Terminal 2')).toBe(true)
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)
  })

  it('Shift+F10 opens the same menu from the keyboard', async () => {
    await renderDock({ exited: true })
    const git = tab('Git')
    await act(async () => {
      git.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    })
    expect(screen.getByRole('menu', { name: 'Actions for Git' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Close' })).toBeTruthy()
    // Git is the last tab: nothing to its right.
    expect((screen.getByRole('menuitem', { name: 'Close tabs to the right' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('menuitem', { name: 'Move right' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('menuitem', { name: 'Move left' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('Close to the Right asks before stopping running shells', async () => {
    await renderDock()
    fireEvent.contextMenu(tab('Terminal 1'))
    await act(async () => { screen.getByRole('menuitem', { name: 'Close tabs to the right' }).click() })
    expect(await screen.findByRole('dialog', { name: 'Close 2 terminals?' })).toBeTruthy()
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(3)

    await act(async () => { screen.getByRole('button', { name: 'Close terminals' }).click() })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Terminal 2' })).toBeNull())
    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)
    // The active Git tab was among them: the kept tab takes over.
    expect(isActive('Terminal 1')).toBe(true)
  })
})

describe('closing tabs', () => {
  it('activates the right neighbour, or the left one for the last tab', async () => {
    await renderDock({ exited: true })
    await press('2')
    await press('w')
    expect(screen.queryByRole('button', { name: 'Terminal 2' })).toBeNull()
    expect(isActive('Terminal 3')).toBe(true)

    // The × button goes through the dock too, not straight to the store.
    await act(async () => { tab('Close Terminal 3').click() })
    expect(isActive('Git')).toBe(true)
    await act(async () => { tab('Close Git').click() })
    expect(isActive('Terminal 1')).toBe(true)
  })

  it('shows the launcher once the last tab closes, and Ctrl+W there closes the dock', async () => {
    const onRequestClose = mock(() => {})
    await renderDock({ terminals: 0, onRequestClose })
    await press('w')
    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
    expect(screen.getByRole('button', { name: /^Git \(/ })).toBeTruthy()
    expect(onRequestClose).not.toHaveBeenCalled()

    await press('w')
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })
})
