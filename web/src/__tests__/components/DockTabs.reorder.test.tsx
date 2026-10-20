/**
 * Dock tab order: new tabs open after the active one (new terminals at the
 * end), terminal sync never re-sorts the strip, and tabs move by drag,
 * ⌥⇧←/→ (Alt+Shift on Linux), or Move Left / Move Right in the tab menu.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { useTerminalStore, _resetTerminalStoreForTests } from '@/stores/useTerminalStore'
import { _resetKeyboardForTests } from '@/lib/keyboard/dispatcher'
import { dropIndex } from '@/components/WorkspacePanel/useTabDrag'
import type { DockViewRequest } from '@/components/WorkspacePanel/dock-tabs'

const WORKSPACE = '/repo/project'
const filesResponse = { workspace: WORKSPACE, truncated: false, files: [] }
const diffResponse = { workspace: WORKSPACE, is_git_repo: false, diff: '', untracked: [] as string[] }

const Icon = () => null
mock.module('lucide-react', () => ({
  AlertTriangle: Icon, CheckCircle2: Icon, Info: Icon,
  Globe: Icon, ArrowRight: Icon, MousePointerClick: Icon, RotateCw: Icon, Smartphone: Icon, SquareTerminal: Icon, Send: Icon, Bot: Icon,
  CalendarClock: Icon, ListTodo: Icon, MessageCircleQuestion: Icon, Square: Icon, Unlink: Icon, MessageSquarePlus: Icon, FileVideo: Icon, ImageOff: Icon,
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
    if (url.includes('/workspace/git-diff')) return new Response(JSON.stringify(diffResponse))
    if (url.includes('/workspace/status')) return new Response(JSON.stringify({ workspace: WORKSPACE }))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})
afterEach(cleanup)

/** Two terminals, Terminal 1 active: [Terminal 1, Terminal 2]. */
async function renderDock() {
  for (let i = 0; i < 2; i++) useTerminalStore.getState().open({ workspace: WORKSPACE }, WORKSPACE)
  const { WorkspacePanel } = await import('@/components/WorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (viewRequest: DockViewRequest | null) => (
    <QueryClientProvider client={queryClient}>
      <WorkspacePanel workspace={WORKSPACE} open terminalOpenKey={0} viewRequest={viewRequest} />
    </QueryClientProvider>
  )
  let rerender: (node: React.ReactElement) => void = () => {}
  await act(async () => {
    rerender = render(ui(null)).rerender
  })
  await waitFor(() => expect(tab('Terminal 1').getAttribute('aria-current')).toBe('true'))
  return { request: (viewRequest: DockViewRequest) => act(async () => rerender(ui(viewRequest))) }
}

const tab = (name: string) => screen.getByRole('button', { name })
const order = () => Array.from(document.querySelectorAll('[data-dock-tab]')).map((node) => node.textContent)
const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })

function altShift(target: Element, key: 'ArrowLeft' | 'ArrowRight') {
  return act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, shiftKey: true, bubbles: true, cancelable: true }))
  })
}

describe('dock tab order', () => {
  it('opens a new tab right after the active one; reopening only activates it', async () => {
    const { request } = await renderDock()
    await request({ view: 'review', key: 1 })
    expect(order()).toEqual(['Terminal 1', 'Git', 'Terminal 2'])
    expect(tab('Git').getAttribute('aria-current')).toBe('true')

    act(() => tab('Terminal 2').click())
    await request({ view: 'review', key: 2 })
    expect(order()).toEqual(['Terminal 1', 'Git', 'Terminal 2'])
    expect(tab('Git').getAttribute('aria-current')).toBe('true')
  })

  it('puts new terminals at the end', async () => {
    const { request } = await renderDock()
    await request({ view: 'review', key: 1 })
    act(() => tab('Terminal 1').click())
    await act(async () => { tab('New terminal').click() })
    await waitFor(() => expect(order()).toEqual(['Terminal 1', 'Git', 'Terminal 2', 'Terminal 3']))
  })

  it('keeps a moved terminal where it is when the terminal store changes', async () => {
    await renderDock()
    await altShift(tab('Terminal 2'), 'ArrowLeft')
    expect(order()).toEqual(['Terminal 2', 'Terminal 1'])

    const [first] = useTerminalStore.getState().sessionsForContext(WORKSPACE)
    act(() => useTerminalStore.getState().rename(first.id, 'Server'))
    await act(async () => { tab('New terminal').click() })
    await waitFor(() => expect(order()).toEqual(['Terminal 2', 'Server', 'Terminal 3']))
  })
})

describe('moving tabs from the keyboard and the menu', () => {
  it('Alt+Shift+Left/Right moves the focused tab and keeps focus on it', async () => {
    const { request } = await renderDock()
    await request({ view: 'review', key: 1 })
    act(() => tab('Git').focus())

    await altShift(tab('Git'), 'ArrowRight')
    await frame()
    expect(order()).toEqual(['Terminal 1', 'Terminal 2', 'Git'])
    expect(document.activeElement).toBe(tab('Git'))

    // At the end: nothing to move past.
    await altShift(tab('Git'), 'ArrowRight')
    expect(order()).toEqual(['Terminal 1', 'Terminal 2', 'Git'])

    await altShift(tab('Git'), 'ArrowLeft')
    await altShift(tab('Git'), 'ArrowLeft')
    expect(order()).toEqual(['Git', 'Terminal 1', 'Terminal 2'])
  })

  it('Move Left and Move Right in the tab menu', async () => {
    await renderDock()
    fireEvent.contextMenu(tab('Terminal 1'))
    await act(async () => { screen.getByRole('menuitem', { name: 'Move Right' }).click() })
    expect(order()).toEqual(['Terminal 2', 'Terminal 1'])

    fireEvent.contextMenu(tab('Terminal 1'))
    await act(async () => { screen.getByRole('menuitem', { name: 'Move Left' }).click() })
    expect(order()).toEqual(['Terminal 1', 'Terminal 2'])
  })
})

describe('dragging tabs', () => {
  /** Lay the tabs out 100 px wide, by their current place in the strip. */
  function layOut() {
    // A wide strip, so the pointer is never near an edge (no auto-scroll).
    const strip = document.querySelector<HTMLElement>('[data-dock-tab]')!.parentElement!
    strip.getBoundingClientRect = () => ({ left: 0, right: 1000, top: 0, bottom: 30, width: 1000, height: 30, x: 0, y: 0 }) as DOMRect
    for (const node of document.querySelectorAll<HTMLElement>('[data-dock-tab]')) {
      node.getBoundingClientRect = () => {
        const index = Array.from(document.querySelectorAll('[data-dock-tab]')).indexOf(node)
        return { left: index * 100, right: index * 100 + 100, top: 0, bottom: 30, width: 100, height: 30, x: index * 100, y: 0 } as DOMRect
      }
    }
  }
  const pointer = (type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', target: Element, clientX: number) =>
    act(async () => { fireEvent[type](target, { button: 0, pointerId: 1, pointerType: 'mouse', clientX }) })
  const node = (name: string) => tab(name).closest<HTMLElement>('[data-dock-tab]')!
  const shift = (name: string) => node(name).style.transform

  it('picks the tab up: it follows the pointer, neighbours make room, and it drops on release', async () => {
    const { request } = await renderDock()
    await request({ view: 'review', key: 1 })
    layOut()
    const handle = tab('Terminal 1')
    await pointer('pointerDown', handle, 50)
    await pointer('pointerMove', handle, 140)
    expect(shift('Terminal 1')).toBe('translateX(90px)')
    expect(shift('Git')).toBe('')
    expect(node('Terminal 1').hasAttribute('data-dragging')).toBe(true)

    // Past Git's midpoint: Git slides left into the gap; the DOM order holds.
    await pointer('pointerMove', handle, 160)
    expect(shift('Git')).toBe('translateX(-100px)')
    expect(shift('Terminal 2')).toBe('')
    expect(order()).toEqual(['Terminal 1', 'Git', 'Terminal 2'])

    await pointer('pointerMove', handle, 260)
    expect(shift('Terminal 2')).toBe('translateX(-100px)')
    expect(order()).toEqual(['Terminal 1', 'Git', 'Terminal 2'])

    await pointer('pointerUp', handle, 260)
    expect(order()).toEqual(['Git', 'Terminal 2', 'Terminal 1'])
    for (const name of ['Terminal 1', 'Git', 'Terminal 2']) expect(shift(name)).toBe('')
    expect(node('Terminal 1').hasAttribute('data-dragging')).toBe(false)

    // Released: further moves do nothing.
    await pointer('pointerMove', handle, 10)
    expect(order()).toEqual(['Git', 'Terminal 2', 'Terminal 1'])
  })

  it('keeps the tab inside the strip, and Escape or a cancelled pointer puts it back', async () => {
    await renderDock()
    layOut()
    const handle = tab('Terminal 2')
    await pointer('pointerDown', handle, 150)
    await pointer('pointerMove', handle, -400)
    expect(shift('Terminal 2')).toBe('translateX(-100px)')
    expect(shift('Terminal 1')).toBe('translateX(100px)')

    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(shift('Terminal 1')).toBe('')
    expect(shift('Terminal 2')).toBe('')
    await pointer('pointerUp', handle, -400)
    expect(order()).toEqual(['Terminal 1', 'Terminal 2'])

    await pointer('pointerDown', handle, 150)
    await pointer('pointerMove', handle, 20)
    await pointer('pointerCancel', handle, 20)
    expect(order()).toEqual(['Terminal 1', 'Terminal 2'])
    expect(shift('Terminal 2')).toBe('')
  })

  it('a short press is still a click, and the close button is no handle', async () => {
    await renderDock()
    layOut()
    const handle = tab('Terminal 2')
    await pointer('pointerDown', handle, 150)
    await pointer('pointerMove', handle, 152)
    await pointer('pointerUp', handle, 152)
    act(() => handle.click())
    expect(order()).toEqual(['Terminal 1', 'Terminal 2'])
    expect(handle.getAttribute('aria-current')).toBe('true')

    const close = tab('Close Terminal 1')
    await pointer('pointerDown', close, 50)
    await pointer('pointerMove', close, 190)
    expect(order()).toEqual(['Terminal 1', 'Terminal 2'])
  })
})

describe('dropIndex', () => {
  const rects = [0, 1, 2, 3].map((i) => ({ left: i * 100, right: i * 100 + 100 }))
  it('moves past every midpoint the pointer crossed, either way', () => {
    expect(dropIndex(rects, 0, 140)).toBeNull()
    expect(dropIndex(rects, 0, 151)).toBe(1)
    expect(dropIndex(rects, 0, 390)).toBe(3)
    expect(dropIndex(rects, 3, 10)).toBe(0)
    expect(dropIndex(rects, 3, 260)).toBeNull()
    expect(dropIndex(rects, 3, 240)).toBe(2)
    expect(dropIndex(rects, 2, 250)).toBeNull()
  })
})
