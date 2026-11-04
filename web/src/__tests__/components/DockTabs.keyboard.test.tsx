/**
 * Dock tab keys and the tab menu: ⌘1–⌘9 (Ctrl on Linux) pick a tab of the
 * focused pane by position with 9 as the last, ⌃Tab / ⌃⇧Tab step with
 * wrap-around, both only while the dock is open; focus follows only when it
 * was already in the dock. The tab menu's Close Others / Close to the Right
 * act on the tab's own pane and confirm before stopping a running shell.
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
let os: 'linux' | 'macos' = 'linux'
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os, isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os, isMacOverlay: false }),
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
 * By default three terminals, then Git, all in one pane; with the dock open,
 * Git is split up into a pane of its own, which has focus, over the
 * terminals' ([Terminal 1, Terminal 2, Terminal 3], Terminal 1 active).
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
  if (git && terminals > 0 && open) {
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Git' }))
    await act(async () => { screen.getByRole('menuitem', { name: /^Split up/ }).click() })
  }
}

const tab = (name: string) => screen.getByRole('button', { name })
const isActive = (name: string) => tab(name).getAttribute('aria-current') === 'true'
const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })
/** Click a tab: it becomes active and its pane takes the keys. */
const pick = (name: string) => act(async () => { tab(name).click() })

function press(key: string, mods: { shiftKey?: boolean } = {}, target: EventTarget = document.activeElement ?? document.body) {
  const code = /^[1-9]$/.test(key) ? `Digit${key}` : key
  return act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey: true, bubbles: true, cancelable: true, ...mods }))
  })
}

describe('dock tab keys', () => {
  it('Ctrl+N picks the tab at that position of the focused pane and Ctrl+9 the last', async () => {
    await renderDock()
    expect(isActive('Git')).toBe(true)
    // Git's pane has only Git: nothing at position 2.
    await press('2')
    expect(isActive('Terminal 1')).toBe(true)
    expect(isActive('Terminal 2')).toBe(false)

    await pick('Terminal 1')
    await press('2')
    expect(isActive('Terminal 2')).toBe(true)
    await press('9')
    expect(isActive('Terminal 3')).toBe(true)
    await press('1')
    expect(isActive('Terminal 1')).toBe(true)
    // Past the last tab: nothing to pick.
    await press('6')
    expect(isActive('Terminal 1')).toBe(true)
    // The other pane keeps its own active tab.
    expect(isActive('Git')).toBe(true)
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
    await pick('Terminal 1')
    await press('Tab', { shiftKey: true })
    expect(isActive('Terminal 3')).toBe(true)
    await press('Tab')
    expect(isActive('Terminal 1')).toBe(true)
    await press('Tab')
    expect(isActive('Terminal 2')).toBe(true)
  })

  // Ctrl+PageUp/PageDown as in browsers on Windows and Linux; the macOS
  // pair (Ctrl+Shift+[ / ] here) is not bound off macOS.
  it('Ctrl+PageUp / PageDown step through the tabs off macOS, Ctrl+Shift+[ / ] do not', async () => {
    await renderDock()
    await pick('Terminal 1')
    const key = (init: KeyboardEventInit) => act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, bubbles: true, cancelable: true, ...init }))
    })
    await key({ key: '}', code: 'BracketRight', shiftKey: true })
    expect(isActive('Terminal 1')).toBe(true)
    await key({ key: 'PageUp', code: 'PageUp' })
    expect(isActive('Terminal 3')).toBe(true)
    await key({ key: 'PageDown', code: 'PageDown' })
    expect(isActive('Terminal 1')).toBe(true)
  })

  it('⌘⇧[ / ⌘⇧] step through the tabs on macOS, Ctrl+PageUp / PageDown do not', async () => {
    os = 'macos'
    try {
      await renderDock()
      await pick('Terminal 1')
      const key = (init: KeyboardEventInit) => act(async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
      })
      await key({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true })
      expect(isActive('Terminal 2')).toBe(true)
      await key({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true })
      expect(isActive('Terminal 1')).toBe(true)
      await key({ key: 'PageUp', code: 'PageUp', ctrlKey: true })
      expect(isActive('Terminal 1')).toBe(true)
    } finally {
      os = 'linux'
    }
  })

  it('moves focus to the new tab only when focus was in the dock', async () => {
    await renderDock()
    await pick('Terminal 1')
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
  it('Close Others keeps only the chosen tab of its pane, and makes it active', async () => {
    await renderDock({ exited: true })
    fireEvent.contextMenu(tab('Terminal 2'))
    await act(async () => { screen.getByRole('menuitem', { name: 'Close others' }).click() })
    expect(screen.queryByRole('button', { name: 'Terminal 1' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Terminal 3' })).toBeNull()
    // Git is in another pane: it stays.
    expect(screen.getByRole('button', { name: 'Git' })).toBeTruthy()
    expect(isActive('Terminal 2')).toBe(true)
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)
  })

  it('Shift+F10 opens the same menu from the keyboard', async () => {
    await renderDock({ exited: true })
    const last = tab('Terminal 3')
    await act(async () => {
      last.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    })
    expect(screen.getByRole('menu', { name: 'Actions for Terminal 3' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Close' })).toBeTruthy()
    // Terminal 3 is the last tab of its pane: nothing to its right.
    expect((screen.getByRole('menuitem', { name: 'Close to the right' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('menuitem', { name: 'Move right' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('menuitem', { name: 'Move left' }) as HTMLButtonElement).disabled).toBe(false)
    // Git is in another pane on screen.
    expect(screen.getByRole('menuitem', { name: 'Move to next pane' })).toBeTruthy()
    expect((screen.getByRole('menuitem', { name: 'Split right' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('Close to the Right asks before stopping running shells', async () => {
    await renderDock()
    await pick('Terminal 3')
    fireEvent.contextMenu(tab('Terminal 1'))
    await act(async () => { screen.getByRole('menuitem', { name: 'Close to the right' }).click() })
    expect(await screen.findByRole('dialog', { name: 'Close 2 terminals?' })).toBeTruthy()
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(3)

    await act(async () => { screen.getByRole('button', { name: 'Close terminals' }).click() })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Terminal 2' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Git' })).toBeTruthy()
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)
    // The active Terminal 3 was among them: the kept tab takes over.
    expect(isActive('Terminal 1')).toBe(true)
  })

  it('Close to the Left and Close All act on the tab\'s own pane', async () => {
    await renderDock({ exited: true })
    await pick('Terminal 3')
    fireEvent.contextMenu(tab('Terminal 1'))
    expect((screen.getByRole('menuitem', { name: 'Close to the left' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { screen.getByRole('menuitem', { name: 'Close' }).click() })

    fireEvent.contextMenu(tab('Terminal 3'))
    await act(async () => { screen.getByRole('menuitem', { name: 'Close to the left' }).click() })
    expect(screen.queryByRole('button', { name: 'Terminal 2' })).toBeNull()
    expect(isActive('Terminal 3')).toBe(true)

    fireEvent.contextMenu(tab('Terminal 3'))
    await act(async () => { screen.getByRole('menuitem', { name: 'Close all' }).click() })
    // The pane goes with its tabs; Git, in another pane, stays.
    expect(screen.queryByRole('button', { name: 'Terminal 3' })).toBeNull()
    expect(screen.queryAllByRole('group', { name: /^Pane \d/ })).toHaveLength(0)
    expect(isActive('Git')).toBe(true)
  })

  // A tab splits off to any side, not only right and down.
  it('splits a tab off to the left, right, top or bottom from its menu', async () => {
    await renderDock({ exited: true })
    fireEvent.contextMenu(tab('Terminal 2'))
    const names = screen.getAllByRole('menuitem').map((item) => item.textContent ?? '').filter((name) => name.startsWith('Split'))
    expect(names.map((name) => name.replace(/Ctrl.*$/, ''))).toEqual(['Split right', 'Split left', 'Split up', 'Split down'])

    await act(async () => { screen.getByRole('menuitem', { name: /^Split left/ }).click() })
    expect(screen.getAllByRole('group', { name: /^Pane \d/ })).toHaveLength(3)
    // Panes are named in layout order: the new one sits left of the
    // terminals', under Git.
    expect(tab('Terminal 2').closest('[data-dock-pane]')).toBe(screen.getByRole('group', { name: 'Pane 2' }))
    expect(tab('Terminal 1').closest('[data-dock-pane]')).toBe(screen.getByRole('group', { name: 'Pane 3' }))
  })
})

describe('closing tabs', () => {
  it('goes back to the tab used before, else the right neighbour, and closes an emptied pane', async () => {
    await renderDock({ exited: true })
    await pick('Terminal 1')
    await press('2')
    await press('w')
    expect(screen.queryByRole('button', { name: 'Terminal 2' })).toBeNull()
    // Back to the tab used before (Terminal 1), not on to Terminal 3.
    expect(isActive('Terminal 1')).toBe(true)

    // The × button goes through the dock too, not straight to the store.
    // Terminal 3 was never shown: its right neighbour takes over.
    await act(async () => { tab('Close Terminal 1').click() })
    expect(isActive('Terminal 3')).toBe(true)
    // The terminal pane's last tab: the pane closes, Git's takes its room.
    expect(screen.getAllByRole('group', { name: /^Pane \d/ })).toHaveLength(2)
    await act(async () => { tab('Close Terminal 3').click() })
    expect(screen.queryAllByRole('group', { name: /^Pane \d/ })).toHaveLength(0)
    expect(isActive('Git')).toBe(true)
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
