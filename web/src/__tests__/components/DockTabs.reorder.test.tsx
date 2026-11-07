/**
 * Dock tab order: views and terminals open in the focused pane, a view before
 * the documents, a terminal right after the open tab; terminal sync never
 * re-sorts a strip. Tabs move by drag
 * (along the strip, or carried onto another pane's strip, middle or edge),
 * ⌥⇧←/→ (Alt+Shift on Linux), or the tab menu (Move Left / Move Right,
 * Split Right / Split Down, Move to Next Pane). (Order within a strip,
 * views before documents, is covered by ``dock-panes.test.ts``.)
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { gitDiffResponse } from '../git-diff-mock'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { useTerminalStore, _resetTerminalStoreForTests } from '@/stores/useTerminalStore'
import { _resetKeyboardForTests } from '@/lib/keyboard/dispatcher'
import { dropIndex, splitSideAt } from '@/components/WorkspacePanel/useTabDrag'
import type { DockViewRequest } from '@/components/WorkspacePanel/dock-tabs'

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
  Copy: Icon, Download: Icon, ExternalLink: Icon, WrapText: Icon, File: Icon, FileDiff: Icon, FileHeadphone: Icon, FileText: Icon,
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

/** Two terminals (or ``terminals``) in the only pane, Terminal 1 active. */
async function renderDock(terminals = 2) {
  for (let i = 0; i < terminals; i++) useTerminalStore.getState().open({ workspace: WORKSPACE }, WORKSPACE)
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
/** Each pane's tab titles in strip order, panes in layout order (F6's). */
const strips = () => Array.from(document.querySelectorAll<HTMLElement>('[data-dock-pane]:not([hidden])'))
  .sort((a, b) => Number(a.dataset.focusOrder) - Number(b.dataset.focusOrder))
  .map((node) => Array.from(node.querySelectorAll('[data-dock-tab]')).map((item) => item.textContent))
/** Tab titles in strip order, every pane's in layout order. */
const order = () => strips().flat()
/** New terminals open from a pane's "Open…" menu (the pane ``beside`` is in). */
const newTerminal = async (beside = 'Terminal 1') => {
  const terminals = tab(beside).closest<HTMLElement>('[data-dock-pane]')!
  await act(async () => { within(terminals).getByRole('button', { name: 'Open in Review panel' }).click() })
  await act(async () => { screen.getByRole('menuitem', { name: 'Terminal' }).click() })
}
const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })
const menuItem = async (tabName: string, item: string) => {
  fireEvent.contextMenu(tab(tabName))
  await act(async () => { screen.getByRole('menuitem', { name: item }).click() })
}

function altShift(target: Element, key: 'ArrowLeft' | 'ArrowRight') {
  return act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, shiftKey: true, bubbles: true, cancelable: true }))
  })
}

describe('dock tab order', () => {
  it('opens a view before the terminals of the focused pane; reopening only activates it', async () => {
    const { request } = await renderDock()
    await request({ view: 'review', key: 1 })
    expect(strips()).toEqual([['Git', 'Terminal 1', 'Terminal 2']])
    expect(tab('Git').getAttribute('aria-current')).toBe('true')

    act(() => tab('Terminal 2').click())
    await request({ view: 'review', key: 2 })
    expect(order()).toEqual(['Git', 'Terminal 1', 'Terminal 2'])
    expect(tab('Git').getAttribute('aria-current')).toBe('true')
    expect(tab('Terminal 2').hasAttribute('aria-current')).toBe(false)
  })

  it('opens a new terminal right after the open tab, like any tab', async () => {
    const { request } = await renderDock()
    await request({ view: 'review', key: 1 })
    act(() => tab('Terminal 1').click())
    await newTerminal()
    await waitFor(() => expect(strips()).toEqual([['Git', 'Terminal 1', 'Terminal 3', 'Terminal 2']]))
    expect(tab('Terminal 3').getAttribute('aria-current')).toBe('true')
  })

  it('keeps a moved terminal where it is when the terminal store changes', async () => {
    await renderDock()
    await altShift(tab('Terminal 2'), 'ArrowLeft')
    expect(order()).toEqual(['Terminal 2', 'Terminal 1'])

    const [first] = useTerminalStore.getState().sessionsForContext(WORKSPACE)
    act(() => useTerminalStore.getState().rename(first.id, 'Server'))
    await newTerminal('Server')
    await waitFor(() => expect(order()).toEqual(['Terminal 2', 'Server', 'Terminal 3']))
  })
})

describe('moving tabs from the keyboard and the menu', () => {
  it('Alt+Shift+Left/Right moves the focused tab and keeps focus on it', async () => {
    await renderDock(3)
    act(() => tab('Terminal 1').focus())

    await altShift(tab('Terminal 1'), 'ArrowRight')
    await frame()
    expect(order()).toEqual(['Terminal 2', 'Terminal 1', 'Terminal 3'])
    expect(document.activeElement).toBe(tab('Terminal 1'))

    await altShift(tab('Terminal 1'), 'ArrowRight')
    // At the end: nothing to move past.
    await altShift(tab('Terminal 1'), 'ArrowRight')
    expect(order()).toEqual(['Terminal 2', 'Terminal 3', 'Terminal 1'])

    await altShift(tab('Terminal 1'), 'ArrowLeft')
    await altShift(tab('Terminal 1'), 'ArrowLeft')
    expect(order()).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3'])
  })

  it('Move Left and Move Right in the tab menu', async () => {
    await renderDock()
    await menuItem('Terminal 1', 'Move right')
    expect(order()).toEqual(['Terminal 2', 'Terminal 1'])

    await menuItem('Terminal 1', 'Move left')
    expect(order()).toEqual(['Terminal 1', 'Terminal 2'])
  })

  it('Split Down takes a tab into a new pane below, and Move to Next Pane takes it back', async () => {
    await renderDock()
    // One pane: nowhere to move to.
    fireEvent.contextMenu(tab('Terminal 2'))
    expect(screen.queryByRole('menuitem', { name: 'Move to next pane' })).toBeNull()
    await act(async () => { screen.getByRole('menuitem', { name: 'Split down' }).click() })
    expect(strips()).toEqual([['Terminal 1'], ['Terminal 2']])
    expect(tab('Terminal 2').getAttribute('aria-current')).toBe('true')

    // Terminal 2 is alone in its pane: it cannot split off from it.
    fireEvent.contextMenu(tab('Terminal 2'))
    expect((screen.getByRole('menuitem', { name: 'Split right' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { screen.getByRole('menuitem', { name: 'Move to next pane' }).click() })
    // Its pane closed with its last tab.
    expect(strips()).toEqual([['Terminal 1', 'Terminal 2']])
  })
})

describe('dragging tabs', () => {
  /** Lay the tabs of the only pane out 100 px wide, by their current place in the strip. */
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
  const pointer = (type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', target: Element, clientX: number, clientY = 0) =>
    act(async () => { fireEvent[type](target, { button: 0, pointerId: 1, pointerType: 'mouse', clientX, clientY }) })
  const node = (name: string) => tab(name).closest<HTMLElement>('[data-dock-tab]')!
  const shift = (name: string) => node(name).style.transform

  it('picks the tab up: it follows the pointer, neighbours make room, and it drops on release', async () => {
    await renderDock(3)
    layOut()
    const handle = tab('Terminal 1')
    await pointer('pointerDown', handle, 50)
    await pointer('pointerMove', handle, 140)
    expect(shift('Terminal 1')).toBe('translateX(90px)')
    expect(shift('Terminal 2')).toBe('')
    expect(node('Terminal 1').hasAttribute('data-dragging')).toBe(true)

    // Past Terminal 2's midpoint: it slides left into the gap; the DOM order holds.
    await pointer('pointerMove', handle, 160)
    expect(shift('Terminal 2')).toBe('translateX(-100px)')
    expect(shift('Terminal 3')).toBe('')
    expect(order()).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3'])

    await pointer('pointerMove', handle, 260)
    expect(shift('Terminal 3')).toBe('translateX(-100px)')
    expect(order()).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3'])

    await pointer('pointerUp', handle, 260)
    expect(order()).toEqual(['Terminal 2', 'Terminal 3', 'Terminal 1'])
    for (const name of ['Terminal 1', 'Terminal 2', 'Terminal 3']) expect(shift(name)).toBe('')
    expect(node('Terminal 1').hasAttribute('data-dragging')).toBe(false)

    // Released: further moves do nothing.
    await pointer('pointerMove', handle, 10)
    expect(order()).toEqual(['Terminal 2', 'Terminal 3', 'Terminal 1'])
  })

  it('keeps the tab along the strip near it, and Escape or a cancelled pointer puts it back', async () => {
    await renderDock()
    layOut()
    const handle = tab('Terminal 2')
    await pointer('pointerDown', handle, 150)
    // A little past the strip's start: still along it, held at its end.
    await pointer('pointerMove', handle, -10)
    expect(shift('Terminal 2')).toBe('translateX(-100px)')
    expect(shift('Terminal 1')).toBe('translateX(100px)')
    expect(document.querySelector('[data-dock-tab-ghost]')).toBeNull()

    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(shift('Terminal 1')).toBe('')
    expect(shift('Terminal 2')).toBe('')
    await pointer('pointerUp', handle, -10)
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

describe('dragging tabs between panes', () => {
  interface Box { left: number; top: number; right: number; bottom: number }
  const rect = ({ left, top, right, bottom }: Box) =>
    ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top }) as DOMRect
  /**
   * Lay the panes out: ``p1`` over ``p2`` (each 400 × 300) and any others off
   * screen, a 30 px strip on top of each with its tabs 100 px wide.
   */
  function layOutPanes(boxes: Record<string, Box> = { p1: { left: 0, top: 0, right: 400, bottom: 300 }, p2: { left: 0, top: 300, right: 400, bottom: 600 } }) {
    for (const node of document.querySelectorAll<HTMLElement>('[data-dock-pane]')) {
      const box = boxes[node.dataset.dockPane!] ?? { left: -1, top: -1, right: -1, bottom: -1 }
      const strip = { ...box, bottom: box.top + 30 }
      node.getBoundingClientRect = () => rect(box)
      const stripNode = node.querySelector<HTMLElement>('[data-dock-strip]')!
      stripNode.getBoundingClientRect = () => rect(strip)
      ;(stripNode.firstElementChild as HTMLElement).getBoundingClientRect = () => rect(strip)
      node.querySelector<HTMLElement>('[data-dock-pane-body]')!.getBoundingClientRect = () => rect({ ...box, top: box.top + 30 })
      for (const item of node.querySelectorAll<HTMLElement>('[data-dock-tab]')) {
        item.getBoundingClientRect = () => {
          const index = Array.from(node.querySelectorAll('[data-dock-tab]')).indexOf(item)
          return rect({ left: box.left + index * 100, right: box.left + index * 100 + 100, top: box.top, bottom: box.top + 30 })
        }
      }
    }
  }
  const pointer = (type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', target: Element, clientX: number, clientY: number) =>
    act(async () => { fireEvent[type](target, { button: 0, pointerId: 1, pointerType: 'mouse', clientX, clientY }) })
  const ghost = () => document.querySelector<HTMLElement>('[data-dock-tab-ghost]')
  const marker = () => document.querySelector<HTMLElement>('[data-dock-drop]')
  /** Terminals 1 and 2 in ``p1``, Terminal 3 split down into ``p2``. */
  async function twoPanes() {
    await renderDock(3)
    await menuItem('Terminal 3', 'Split down')
    expect(strips()).toEqual([['Terminal 1', 'Terminal 2'], ['Terminal 3']])
    layOutPanes()
  }

  it('carries a copy onto another pane\'s strip and drops the tab where the caret shows', async () => {
    await twoPanes()
    const handle = tab('Terminal 1')
    await pointer('pointerDown', handle, 50, 15)
    await pointer('pointerMove', handle, 150, 315)
    expect(ghost()?.textContent).toBe('Terminal 1')
    expect(ghost()?.getAttribute('aria-hidden')).toBe('true')
    expect(handle.closest<HTMLElement>('[data-dock-tab]')!.style.opacity).toBe('0.4')
    expect(marker()?.getAttribute('data-dock-drop')).toBe('caret')
    // After Terminal 3 (0–100), at its right edge.
    expect(marker()?.style.left).toBe('100px')

    await pointer('pointerUp', handle, 150, 315)
    expect(strips()).toEqual([['Terminal 2'], ['Terminal 3', 'Terminal 1']])
    expect(tab('Terminal 1').getAttribute('aria-current')).toBe('true')
    expect(ghost()).toBeNull()
    expect(marker()).toBeNull()
  })

  it('drops onto a pane\'s middle; its own middle is no target', async () => {
    await twoPanes()
    const handle = tab('Terminal 2')
    await pointer('pointerDown', handle, 150, 15)
    await pointer('pointerMove', handle, 200, 150)
    expect(ghost()).toBeTruthy()
    expect(marker()).toBeNull()
    await pointer('pointerMove', handle, 200, 450)
    expect(marker()?.getAttribute('data-dock-drop-target')).toBe('pane')
    expect(marker()?.style.top).toBe('330px')

    await pointer('pointerUp', handle, 200, 450)
    expect(strips()).toEqual([['Terminal 1'], ['Terminal 3', 'Terminal 2']])
  })

  it('splits a pane when dropped on its edge, the tab in the new half', async () => {
    await twoPanes()
    const handle = tab('Terminal 1')
    await pointer('pointerDown', handle, 50, 15)
    await pointer('pointerMove', handle, 390, 450)
    expect(marker()?.getAttribute('data-dock-drop-target')).toBe('split:right')
    // The half the new pane would take.
    expect([marker()?.style.left, marker()?.style.width]).toEqual(['200px', '200px'])

    await pointer('pointerUp', handle, 390, 450)
    expect(strips()).toEqual([['Terminal 2'], ['Terminal 3'], ['Terminal 1']])
    expect(tab('Terminal 1').closest('[data-dock-pane]')!.getAttribute('aria-label')).toBe('Pane 3')
    expect(screen.getAllByRole('separator', { name: 'Resize panes' }).map((bar) => bar.getAttribute('aria-orientation')))
      .toEqual(['horizontal', 'vertical'])
  })

  it('a pane\'s only tab cannot split its own pane', async () => {
    await twoPanes()
    const handle = tab('Terminal 3')
    await pointer('pointerDown', handle, 50, 315)
    await pointer('pointerMove', handle, 390, 450)
    expect(marker()).toBeNull()
    await pointer('pointerUp', handle, 390, 450)
    expect(strips()).toEqual([['Terminal 1', 'Terminal 2'], ['Terminal 3']])
  })

  it('puts the tab back when let go over nothing, or on Escape', async () => {
    await twoPanes()
    const handle = tab('Terminal 1')
    await pointer('pointerDown', handle, 50, 15)
    await pointer('pointerMove', handle, 900, 900)
    expect(ghost()).toBeTruthy()
    expect(marker()).toBeNull()
    await pointer('pointerUp', handle, 900, 900)
    expect(strips()).toEqual([['Terminal 1', 'Terminal 2'], ['Terminal 3']])
    expect(ghost()).toBeNull()
    expect(handle.closest<HTMLElement>('[data-dock-tab]')!.style.opacity).toBe('')

    await pointer('pointerDown', handle, 50, 15)
    await pointer('pointerMove', handle, 200, 450)
    expect(marker()).toBeTruthy()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(ghost()).toBeNull()
    expect(marker()).toBeNull()
    await pointer('pointerUp', handle, 200, 450)
    expect(strips()).toEqual([['Terminal 1', 'Terminal 2'], ['Terminal 3']])
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

describe('splitSideAt', () => {
  const body = { left: 0, top: 0, right: 400, bottom: 300 }
  it('picks the nearest edge within a fifth of the shorter side', () => {
    expect(splitSideAt(body, 200, 150)).toBeNull()
    expect(splitSideAt(body, 50, 150)).toBe('left')
    expect(splitSideAt(body, 390, 150)).toBe('right')
    expect(splitSideAt(body, 200, 10)).toBe('up')
    expect(splitSideAt(body, 200, 290)).toBe('down')
    // In a corner, the closer edge wins.
    expect(splitSideAt(body, 395, 290)).toBe('right')
  })

  it('offers no split along a side too short for two panes', () => {
    const narrow = { left: 0, top: 0, right: 300, bottom: 600 }
    expect(splitSideAt(narrow, 290, 300)).toBeNull()
    expect(splitSideAt(narrow, 150, 590)).toBe('down')
  })
})
