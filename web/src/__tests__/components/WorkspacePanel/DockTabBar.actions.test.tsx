/**
 * The Review panel's tab strip, action side (UX consistency cleanup):
 * "+", Maximize and a ⋯ menu (Split right / Split down, Close pane), one 28px
 * size and one 14px glyph for all of them and for the tab's own ×; Refresh
 * lives in the views' toolbars, not here. Every menu row that has a key shows
 * it, read from the same tables the keys are bound from.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DockTabBar, type DockTabBarProps } from '@/components/WorkspacePanel/DockTabBar'
import type { DockOpenItem } from '@/components/WorkspacePanel/DockLauncher'
import { MOVE_TAB_LEFT_CHORD, MOVE_TAB_RIGHT_CHORD, type DockTab } from '@/components/WorkspacePanel/dock-tabs'
import { APP_SHORTCUTS, DOCK_TAB_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { formatChord } from '@/lib/keyboard/chord'
import { _resetKeyboardForTests } from '@/lib/keyboard/dispatcher'
import { _resetTooltipTimingForTests } from '@/components/ui/tooltip'

beforeEach(() => {
  _resetKeyboardForTests()
  _resetTooltipTimingForTests()
})
afterEach(cleanup)

const tab = (id: string): DockTab => ({ id, type: 'file', title: id, file: { name: id, path: id } } as unknown as DockTab)
const openItem: DockOpenItem = { id: 'review', label: 'Git', icon: null, group: 'view', run: () => {} }

function renderStrip(overrides: Partial<DockTabBarProps> = {}) {
  const props: DockTabBarProps = {
    tabs: ['a', 'b', 'c'].map(tab),
    activeTabId: 'a',
    workspace: '/repo',
    terminalMetas: [],
    mobile: false,
    os: 'macos',
    registerTabRef: () => {},
    onActivate: () => {},
    onClose: () => {},
    openItems: [openItem],
    maximized: false,
    onToggleMaximized: () => {},
    onSplitPane: () => {},
    ...overrides,
  }
  return render(<DockTabBar {...props} />)
}

/** The strip's action cluster: the last child of the strip (menus render in a portal). */
const cluster = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-dock-strip]')!.lastElementChild as HTMLElement
const names = (el: HTMLElement) => within(el).getAllByRole('button').map((button) => button.getAttribute('aria-label'))
/** A menu row's label and the key at its end ("" when it has none). */
const rows = (menu: HTMLElement): [string, string][] =>
  Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')).map((item) => [
    item.querySelector('span.flex-1')?.textContent ?? item.textContent ?? '',
    item.querySelector('kbd')?.textContent ?? '',
  ])

describe('tab strip actions', () => {
  it('has "+", Maximize and a ⋯ menu, in that order, and no Refresh', () => {
    const { container } = renderStrip()
    expect(names(cluster(container))).toEqual(['Open in Review panel', 'Maximize Review panel (⌘⇧D)', 'Pane actions'])
    expect(screen.queryByRole('button', { name: /^Refresh/ })).toBeNull()
  })

  it('draws every strip action and the tab × at the same 14px, in one 28px (36px on touch) square', () => {
    const { container } = renderStrip({ maximized: true })
    const buttons = within(cluster(container)).getAllByRole('button')
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      expect(button.querySelector('svg')?.getAttribute('width')).toBe('14')
      expect(button.className).toContain('md:h-7')
      expect(button.className).toContain('md:w-7')
      expect(button.className).toContain('pointer-coarse:size-9')
    }
    const close = container.querySelector('[data-dock-tab="a"] [data-dock-tab-close]')!
    expect(close.querySelector('svg')?.getAttribute('width')).toBe('14')
  })

  it('toggles Maximize', () => {
    const onToggleMaximized = mock(() => {})
    renderStrip({ onToggleMaximized })
    fireEvent.click(screen.getByRole('button', { name: /^Maximize Review panel/ }))
    expect(onToggleMaximized).toHaveBeenCalledTimes(1)
  })

  it('puts a Restore label on Maximize once maximized, with the key spelled', () => {
    renderStrip({ maximized: true, os: 'linux' })
    expect(screen.getByRole('button', { name: `Restore Review panel (${shortcutLabel(APP_SHORTCUTS.maximizeDock, 'linux')})` })).toBeTruthy()
  })
})

describe('the ⋯ pane menu', () => {
  it('lists Split right, Split down and Close pane with their keys, read from APP_SHORTCUTS', async () => {
    const { container } = renderStrip({ onClosePane: () => {} })
    await userEvent.setup().click(within(cluster(container)).getByRole('button', { name: 'Pane actions' }))
    const menu = screen.getByRole('menu', { name: 'Pane actions' })

    expect(rows(menu)).toEqual([
      ['Split right', '⌘\\'],
      ['Split down', '⌘⇧\\'],
      ['Close pane', '⌘W'],
    ])
    expect(rows(menu)).toEqual([
      ['Split right', shortcutLabel(APP_SHORTCUTS.splitDock, 'macos')],
      ['Split down', shortcutLabel(APP_SHORTCUTS.splitDockDown, 'macos')],
      ['Close pane', shortcutLabel(APP_SHORTCUTS.closeTab, 'macos')],
    ])
    // Close pane stands apart from the splits.
    const close = within(menu).getByRole('menuitem', { name: 'Close pane' })
    expect(close.previousElementSibling?.getAttribute('role')).toBe('separator')
  })

  it('spells the keys the way the platform does', async () => {
    const { container } = renderStrip({ os: 'linux', onClosePane: () => {} })
    await userEvent.setup().click(within(cluster(container)).getByRole('button', { name: 'Pane actions' }))
    expect(rows(screen.getByRole('menu', { name: 'Pane actions' }))).toEqual([
      ['Split right', 'Ctrl+\\'],
      ['Split down', 'Ctrl+Shift+\\'],
      ['Close pane', 'Ctrl+W'],
    ])
  })

  it('splits right or down, or closes the pane, from its rows', async () => {
    const onSplitPane = mock(() => {})
    const onClosePane = mock(() => {})
    const { container } = renderStrip({ onSplitPane, onClosePane })
    const open = () => userEvent.setup().click(within(cluster(container)).getByRole('button', { name: 'Pane actions' }))

    await open()
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Split right' }))
    await waitFor(() => expect(onSplitPane).toHaveBeenLastCalledWith('right'))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await open()
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Split down' }))
    await waitFor(() => expect(onSplitPane).toHaveBeenLastCalledWith('down'))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await open()
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Close pane' }))
    await waitFor(() => expect(onClosePane).toHaveBeenCalledTimes(1))
  })

  it('offers Close pane only for an empty pane beside others (the caller passes it then)', async () => {
    const { container } = renderStrip()
    await userEvent.setup().click(within(cluster(container)).getByRole('button', { name: 'Pane actions' }))
    expect(rows(screen.getByRole('menu', { name: 'Pane actions' })).map(([label]) => label)).toEqual(['Split right', 'Split down'])
  })

  it('is absent on phones (no splits there) and when there is nothing to offer', () => {
    const phone = renderStrip({ mobile: true, onClosePane: () => {} })
    expect(screen.queryByRole('button', { name: 'Pane actions' })).toBeNull()
    phone.unmount()
    renderStrip({ onSplitPane: undefined })
    expect(screen.queryByRole('button', { name: 'Pane actions' })).toBeNull()
  })
})

describe('the tab menu', () => {
  async function openTabMenu(overrides: Partial<DockTabBarProps> = {}) {
    renderStrip({
      onCloseOthers: () => {},
      onCloseToLeft: () => {},
      onCloseToRight: () => {},
      onCloseAll: () => {},
      onMove: () => {},
      onSplit: () => {},
      ...overrides,
    })
    fireEvent.contextMenu(screen.getByRole('button', { name: 'b' }))
    return screen.getByRole('menu', { name: 'Actions for b' })
  }

  it('shows ⌘W beside Close, and a separator before Close all', async () => {
    const menu = await openTabMenu()
    expect(rows(menu)[0]).toEqual(['Close', '⌘W'])
    const labels = rows(menu).map(([label]) => label)
    expect(labels.slice(0, 5)).toEqual(['Close', 'Close others', 'Close to the left', 'Close to the right', 'Close all'])
    const closeAll = within(menu).getByRole('menuitem', { name: 'Close all' })
    expect(closeAll.previousElementSibling?.getAttribute('role')).toBe('separator')
    // ...and Close all is not run on into the splits below it.
    expect(closeAll.nextElementSibling?.getAttribute('role')).toBe('separator')
  })

  it('shows every key a row has: ⌘W, the splits (⌃⌥+arrow) and the moves (⌥⇧+arrow)', async () => {
    const menu = await openTabMenu()
    const keys = Object.fromEntries(rows(menu))
    expect(keys).toMatchObject({
      Close: '⌘W',
      'Split right': '⌃⌥→',
      'Split left': '⌃⌥←',
      'Split up': '⌃⌥↑',
      'Split down': '⌃⌥↓',
      'Move left': '⌥⇧←',
      'Move right': '⌥⇧→',
    })
    // Rows with no key show none.
    expect(keys['Close others']).toBe('')
    expect(keys['Close all']).toBe('')
    // The menu spells the same chords the strip's key handler matches.
    expect(keys['Move left']).toBe(formatChord(MOVE_TAB_LEFT_CHORD, 'macos'))
    expect(keys['Move right']).toBe(formatChord(MOVE_TAB_RIGHT_CHORD, 'macos'))
  })

  it('spells them for Windows and Linux too', async () => {
    const menu = await openTabMenu({ os: 'linux' })
    const keys = Object.fromEntries(rows(menu))
    expect(keys).toMatchObject({ Close: 'Ctrl+W', 'Split right': 'Ctrl+Alt+→', 'Move left': 'Alt+Shift+←' })
  })
})

describe('keys the menus spell still work', () => {
  it('⌥⇧→ / ⌥⇧← move the focused tab one place; other chords do not', () => {
    const onMove = mock((..._args: unknown[]) => {})
    renderStrip({ onMove })
    const b = screen.getByRole('button', { name: 'b' })

    fireEvent.keyDown(b, { key: 'ArrowRight', altKey: true, shiftKey: true })
    expect(onMove).toHaveBeenLastCalledWith('b', 2)
    fireEvent.keyDown(b, { key: 'ArrowLeft', altKey: true, shiftKey: true })
    expect(onMove).toHaveBeenLastCalledWith('b', 0)

    onMove.mockClear()
    fireEvent.keyDown(b, { key: 'ArrowRight', altKey: true, shiftKey: true, ctrlKey: true })
    fireEvent.keyDown(b, { key: 'ArrowRight', altKey: true, shiftKey: true, metaKey: true })
    fireEvent.keyDown(b, { key: 'ArrowRight', altKey: true })
    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('the "All tabs" list', () => {
  const savedObserver = globalThis.ResizeObserver
  const widths = { scroll: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth'), client: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth') }

  beforeEach(() => {
    // A strip too narrow for its tabs: the list button shows.
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 1000 })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 100 })
  })
  afterEach(() => {
    globalThis.ResizeObserver = savedObserver
    for (const [name, descriptor] of [['scrollWidth', widths.scroll], ['clientWidth', widths.client]] as const) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    }
  })

  const ten = Array.from({ length: 10 }, (_, i) => tab(`t${i + 1}`))

  it('spells ⌘1–⌘8 by position and ⌘9 on the last tab, as the keys pick them', async () => {
    const { container } = renderStrip({ tabs: ten, activeTabId: 't1', numberKeys: true })
    await userEvent.setup().click(within(cluster(container)).getByRole('button', { name: 'All tabs (10)' }))
    const menu = screen.getByRole('menu', { name: 'All tabs' })
    const keys = within(menu).getAllByRole('menuitemradio').map((row) => row.querySelector('kbd')?.textContent ?? '')

    const key = (name: (typeof DOCK_TAB_SHORTCUTS)[number]) => shortcutLabel(APP_SHORTCUTS[name], 'macos')
    expect(keys).toEqual([
      key('dockTab1'), key('dockTab2'), key('dockTab3'), key('dockTab4'), key('dockTab5'), key('dockTab6'), key('dockTab7'), key('dockTab8'),
      '', // the 9th of ten has no number: ⌘9 is the last tab
      key('dockTab9'),
    ])
    expect(keys[0]).toBe('⌘1')
    expect(keys[9]).toBe('⌘9')
  })

  it('a strip of three spells ⌘1–⌘3', async () => {
    const { container } = renderStrip({ tabs: ten.slice(0, 3), activeTabId: 't1', numberKeys: true })
    // Not overflowing by count: the list button needs more than one tab, which it has.
    await userEvent.setup().click(within(cluster(container)).getByRole('button', { name: 'All tabs (3)' }))
    const keys = within(screen.getByRole('menu', { name: 'All tabs' })).getAllByRole('menuitemradio').map((row) => row.querySelector('kbd')?.textContent)
    expect(keys).toEqual(['⌘1', '⌘2', '⌘3'])
  })

  it('spells none where the keys do not reach: an unfocused pane, or a browser', async () => {
    const { container } = renderStrip({ tabs: ten, activeTabId: 't1' })
    await userEvent.setup().click(within(cluster(container)).getByRole('button', { name: 'All tabs (10)' }))
    expect(screen.getByRole('menu', { name: 'All tabs' }).querySelector('kbd')).toBeNull()
  })
})

describe('the tab ×', () => {
  it('is the shared CloseButton at row size, named for its tab', () => {
    const { container } = renderStrip()
    for (const id of ['a', 'b', 'c']) {
      const close = container.querySelector<HTMLElement>(`[data-dock-tab="${id}"] [data-dock-tab-close]`)!
      expect(close.getAttribute('aria-label')).toBe(`Close ${id}`)
      expect(close.hasAttribute('data-close-button')).toBe(true)
      expect(close.className).toContain('size-6')
      expect(close.className).toContain('pointer-coarse:size-9')
    }
  })

  // The hint opens after the shared hover delay; each tab gets its own render so
  // one hint's exit never has to finish before the next is read.
  it('hints "Close tab (⌘W)" on the open tab, the one ⌘W closes', async () => {
    const { container } = renderStrip()
    await userEvent.setup().hover(container.querySelector<HTMLElement>('[data-dock-tab="a"] [data-dock-tab-close]')!)
    expect((await screen.findByRole('tooltip', {}, { timeout: 4000 })).textContent).toBe('Close tab (⌘W)')
  })

  it('hints "Close tab" on a tab that is not open (⌘W does not close it)', async () => {
    const { container } = renderStrip()
    await userEvent.setup().hover(container.querySelector<HTMLElement>('[data-dock-tab="b"] [data-dock-tab-close]')!)
    expect((await screen.findByRole('tooltip', {}, { timeout: 4000 })).textContent).toBe('Close tab')
  })

  it('closes its tab', () => {
    const onClose = mock((..._args: unknown[]) => {})
    const { container } = renderStrip({ onClose })
    fireEvent.click(container.querySelector('[data-dock-tab="b"] [data-dock-tab-close]')!)
    expect(onClose).toHaveBeenCalledWith('b')
  })
})
