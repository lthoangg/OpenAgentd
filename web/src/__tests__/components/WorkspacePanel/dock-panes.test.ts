/**
 * The Review panel's panes: any number, split right or down as often as
 * there is room; tabs move between them; a pane closes with its last tab;
 * terminals are tabs like any other, in the focused pane; a reusable preview
 * tab per pane; views before documents.
 */
import { describe, expect, it } from 'bun:test'

import {
  EMPTY_DOCK_PANES,
  UPPER_SHARE,
  activateTab,
  canSplitOff,
  closePane,
  closeTabs,
  focusPane,
  joinPanes,
  keepTab,
  layoutBoxes,
  moveTab,
  moveWithinPane,
  nextPaneFor,
  normalizeLayout,
  openTab,
  paneOf,
  paneBeside,
  paneOrder,
  paneTabs,
  planTabToward,
  resizeSplit,
  restoreDockPanes,
  serializeDockPanes,
  sizesWithBarAt,
  splitPane,
  syncTerminalTabs,
  type DockPanes,
  type PaneLayout,
} from '@/components/WorkspacePanel/dock-panes'
import { PLAN_TAB, REVIEW_TAB, TASKS_TAB, type DockTab } from '@/components/WorkspacePanel/dock-tabs'

const file = (path: string): DockTab => ({ id: `file:${path}`, type: 'file', title: path, file: { path, name: path, size: 1, mtime: 0, mime: 'text/plain' } })
const diff = (path: string): DockTab => ({ id: `diff:${path}`, type: 'diff', title: path, path, status: 'M' })
const term = (id: string): DockTab => ({ id: `terminal:${id}`, type: 'terminal', title: `Terminal ${id}`, termId: id })
const attachment = (name: string): DockTab => ({ id: `attachment:${name}`, type: 'attachment', title: name, item: { type: 'image', src: `/u/${name}`, name } })
const ids = (tabs: DockTab[]) => tabs.map((tab) => tab.id)
/** Each pane's tab ids, in layout order. */
const strips = (state: DockPanes) => paneOrder(state.layout).map((pane) => ids(paneTabs(state, pane)))
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9

function withTabs(...tabs: DockTab[]): DockPanes {
  return tabs.reduce((state, tab) => openTab(state, tab), EMPTY_DOCK_PANES)
}

describe('tabs in a pane', () => {
  it('lists views before documents, whatever the opening order', () => {
    const state = withTabs(file('a.ts'), REVIEW_TAB, diff('b.ts'), TASKS_TAB)
    expect(strips(state)).toEqual([['review', 'tasks', 'file:a.ts', 'diff:b.ts']])
  })

  it('reuses one preview tab per pane until it is kept', () => {
    let state = openTab(EMPTY_DOCK_PANES, REVIEW_TAB)
    state = openTab(state, file('a.ts'), { preview: true })
    state = openTab(state, file('b.ts'), { preview: true })
    expect(strips(state)).toEqual([['review', 'file:b.ts']])

    state = keepTab(state, 'file:b.ts')
    state = openTab(state, diff('c.ts'), { preview: true })
    expect(strips(state)).toEqual([['review', 'file:b.ts', 'diff:c.ts']])
    expect(state.panes.p1.preview).toBe('diff:c.ts')
  })

  it('keeps a preview tab once it is opened for keeps', () => {
    let state = openTab(EMPTY_DOCK_PANES, file('a.ts'), { preview: true })
    state = openTab(state, file('a.ts'))
    expect(state.panes.p1.preview).toBeNull()
  })

  // Closing the open tab
  // goes back to the one used before it, not to whatever sits beside it.
  it('shows the tab used before the one that closes', () => {
    let state = withTabs(file('a'), file('b'), file('c'))
    state = activateTab(activateTab(state, 'file:a'), 'file:c')
    expect(closeTabs(state, ['file:c']).panes.p1.active).toBe('file:a')
    // Closing several, the latest used of what stays.
    expect(closeTabs(state, ['file:c', 'file:a']).panes.p1.active).toBe('file:b')
  })

  it('keeps to the closing tab\'s pane when going back', () => {
    let state = withTabs(file('a'), file('b'))
    state = splitPane(state, 'p1', 'right', 'file:b')
    state = openTab(state, file('c'))
    // Used last before c: b, in p2 itself; a, in p1, is not a candidate.
    state = activateTab(state, 'file:a')
    state = activateTab(state, 'file:c')
    expect(closeTabs(state, ['file:c']).panes.p2.active).toBe('file:b')
  })

  it('falls back to the right neighbour, else the left one, with no history', () => {
    let state = activateTab(withTabs(file('a'), file('b'), file('c')), 'file:b')
    expect(closeTabs(state, ['file:b']).panes.p1.active).toBe('file:c')
    state = activateTab(state, 'file:c')
    expect(closeTabs(state, ['file:c']).panes.p1.active).toBe('file:b')
    const restored = restoreDockPanes(JSON.parse(JSON.stringify(serializeDockPanes(activateTab(state, 'file:a')))))!
    expect(closeTabs(restored, ['file:a']).panes.p1.active).toBe('file:b')
  })

  it('reorders within a pane, keeping views before documents', () => {
    let state = withTabs(REVIEW_TAB, PLAN_TAB, file('a'), file('b'))
    state = moveWithinPane(state, 'file:b', 2)
    expect(strips(state)).toEqual([['review', 'plan', 'file:b', 'file:a']])
    state = moveWithinPane(state, 'file:a', 0)
    expect(strips(state)).toEqual([['review', 'plan', 'file:a', 'file:b']])
  })
})

describe('splitting', () => {
  it('splits the focused pane right again and again, each new pane taking half the room', () => {
    let state = withTabs(REVIEW_TAB)
    state = splitPane(state, state.focused, 'right')
    expect(paneOrder(state.layout)).toEqual(['p1', 'p2'])
    expect(state.focused).toBe('p2')
    expect(state.panes.p2.tabs).toEqual([])
    state = splitPane(state, state.focused, 'right')
    state = splitPane(state, state.focused, 'right')
    expect(state.layout).toEqual({ axis: 'row', children: [{ pane: 'p1' }, { pane: 'p2' }, { pane: 'p3' }, { pane: 'p4' }], sizes: [0.5, 0.25, 0.125, 0.125] })
    expect(state.focused).toBe('p4')
  })

  it('splits down inside a row, and right inside a column', () => {
    let state = splitPane(withTabs(REVIEW_TAB), 'p1', 'right')
    state = splitPane(state, 'p2', 'down')
    expect(state.layout).toEqual({
      axis: 'row',
      children: [{ pane: 'p1' }, { axis: 'column', children: [{ pane: 'p2' }, { pane: 'p3' }], sizes: [0.5, 0.5] }],
      sizes: [0.5, 0.5],
    })
    state = splitPane(state, 'p1', 'left')
    expect(paneOrder(state.layout)).toEqual(['p4', 'p1', 'p2', 'p3'])
  })

  it('splits with a tab, which moves into the new pane', () => {
    let state = withTabs(REVIEW_TAB, diff('a.ts'))
    state = splitPane(state, 'p1', 'down', 'diff:a.ts')
    expect(strips(state)).toEqual([['review'], ['diff:a.ts']])
    expect(state.panes.p2.active).toBe('diff:a.ts')
    expect(state.panes.p1.active).toBe('review')
  })

  it('never splits a pane with the one tab it holds', () => {
    const state = withTabs(REVIEW_TAB)
    expect(canSplitOff(state, 'review')).toBe(false)
    expect(splitPane(state, 'p1', 'right', 'review')).toBe(state)
  })

  it('takes a lone tab from another pane, which then closes', () => {
    let state = splitPane(withTabs(REVIEW_TAB, diff('a.ts')), 'p1', 'right', 'diff:a.ts')
    expect(canSplitOff(state, 'diff:a.ts', 'p1')).toBe(true)
    state = splitPane(state, 'p1', 'down', 'diff:a.ts')
    expect(paneOrder(state.layout)).toEqual(['p1', 'p3'])
    expect(strips(state)).toEqual([['review'], ['diff:a.ts']])
  })
})

describe('moving tabs between panes', () => {
  it('drops a tab into another pane at a place, its views still first, and shows it there', () => {
    let state = splitPane(withTabs(REVIEW_TAB, diff('a.ts'), diff('b.ts')), 'p1', 'right', 'diff:b.ts')
    state = openTab(state, PLAN_TAB, { pane: 'p2' })
    state = moveTab(state, 'diff:a.ts', 'p2', 0)
    expect(strips(state)).toEqual([['review'], ['plan', 'diff:a.ts', 'diff:b.ts']])
    expect(state.panes.p2.active).toBe('diff:a.ts')
    expect(state.focused).toBe('p2')
  })

  it('closes the pane a tab leaves empty; its room goes to its neighbour', () => {
    let state = splitPane(withTabs(REVIEW_TAB, diff('a.ts')), 'p1', 'right', 'diff:a.ts')
    state = moveTab(state, 'diff:a.ts', 'p1')
    expect(state.layout).toEqual({ pane: 'p1' })
    expect(strips(state)).toEqual([['review', 'diff:a.ts']])
  })

  it('keeps a moved preview tab', () => {
    let state = openTab(withTabs(REVIEW_TAB), diff('a.ts'), { preview: true })
    state = moveTab(splitPane(state, 'p1', 'right'), 'diff:a.ts', 'p2')
    expect(state.panes.p1.preview).toBeNull()
    expect(state.panes.p2.preview).toBeNull()
  })

  it('names the next pane on screen, round the end', () => {
    let state = splitPane(withTabs(REVIEW_TAB, diff('a.ts')), 'p1', 'right', 'diff:a.ts')
    expect(nextPaneFor(state, 'review')).toBe('p2')
    expect(nextPaneFor(state, 'diff:a.ts')).toBe('p1')
    state = closeTabs(state, ['diff:a.ts'])
    expect(nextPaneFor(state, 'review')).toBeNull()
  })
})

describe('⌃⌥+arrow: the focused tab goes left, right, up or down', () => {
  it('names the pane on screen beside another, on each side', () => {
    // p1 | p2 over p3
    let state = splitPane(withTabs(REVIEW_TAB), 'p1', 'right')
    state = splitPane(state, 'p2', 'down')
    expect(paneBeside(state, 'p1', 'right')).toBe('p2')
    expect(paneBeside(state, 'p2', 'left')).toBe('p1')
    expect(paneBeside(state, 'p3', 'left')).toBe('p1')
    expect(paneBeside(state, 'p2', 'down')).toBe('p3')
    expect(paneBeside(state, 'p3', 'up')).toBe('p2')
    expect(paneBeside(state, 'p1', 'left')).toBeNull()
    expect(paneBeside(state, 'p1', 'up')).toBeNull()
  })

  it('splits the pane with the tab moved in when it has other tabs', () => {
    const state = withTabs(REVIEW_TAB, diff('a.ts'))
    expect(state.panes.p1.active).toBe('diff:a.ts')
    expect(planTabToward(state, 'p1', 'diff:a.ts', 'right')).toEqual({ kind: 'split', pane: 'p1', tabId: 'diff:a.ts' })
    expect(planTabToward(state, 'p1', 'diff:a.ts', 'up')).toEqual({ kind: 'split', pane: 'p1', tabId: 'diff:a.ts' })
  })

  it('moves a pane\'s only tab into the pane on that side', () => {
    const state = splitPane(withTabs(REVIEW_TAB, diff('a.ts')), 'p1', 'right', 'diff:a.ts')
    expect(planTabToward(state, 'p2', 'diff:a.ts', 'left')).toEqual({ kind: 'move', tabId: 'diff:a.ts', target: 'p1' })
  })

  it('opens an empty pane on that side when there is no tab to split off and no pane there', () => {
    const state = splitPane(withTabs(REVIEW_TAB, diff('a.ts')), 'p1', 'right', 'diff:a.ts')
    expect(planTabToward(state, 'p2', 'diff:a.ts', 'right')).toEqual({ kind: 'split', pane: 'p2' })
    // An empty pane (its launcher) splits too.
    const empty = splitPane(withTabs(REVIEW_TAB), 'p1', 'down')
    expect(planTabToward(empty, 'p2', undefined, 'down')).toEqual({ kind: 'split', pane: 'p2' })
  })
})

describe('closing panes', () => {
  it('closes a pane with its last tab; the pane before it takes the room and the focus', () => {
    let state = splitPane(withTabs(REVIEW_TAB, diff('a.ts')), 'p1', 'right', 'diff:a.ts')
    state = splitPane(state, 'p2', 'right')
    state = closePane(state, 'p3')
    expect(paneOrder(state.layout)).toEqual(['p1', 'p2'])
    expect(state.focused).toBe('p2')
    expect(state.layout).toEqual({ axis: 'row', children: [{ pane: 'p1' }, { pane: 'p2' }], sizes: [0.5, 0.5] })
    state = closeTabs(state, ['review'])
    expect(state.layout).toEqual({ pane: 'p2' })
    expect(state.focused).toBe('p2')
  })

  it('keeps the last pane, empty', () => {
    const state = closeTabs(withTabs(REVIEW_TAB), ['review'])
    expect(state.layout).toEqual({ pane: 'p1' })
    expect(state.panes.p1).toEqual({ tabs: [], active: '', preview: null })
  })
})

describe('terminals', () => {
  it('opens a terminal in the focused pane, after its open tab, like any tab', () => {
    let state = activateTab(withTabs(REVIEW_TAB, diff('a.ts'), diff('b.ts')), 'diff:a.ts')
    state = openTab(state, term('1'))
    expect(state.layout).toEqual({ pane: 'p1' })
    expect(strips(state)).toEqual([['review', 'diff:a.ts', 'terminal:1', 'diff:b.ts']])
    expect(state.panes.p1.active).toBe('terminal:1')
  })

  it('opens documents beside a terminal, in its pane', () => {
    let state = openTab(EMPTY_DOCK_PANES, term('1'))
    state = openTab(state, diff('a.ts'), { preview: true })
    expect(state.layout).toEqual({ pane: 'p1' })
    expect(strips(state)).toEqual([['terminal:1', 'diff:a.ts']])
  })

  it('opens a terminal in the pane it is asked for', () => {
    let state = splitPane(withTabs(REVIEW_TAB, diff('a.ts')), 'p1', 'right', 'diff:a.ts')
    state = openTab(state, term('1'), { pane: 'p1' })
    expect(strips(state)).toEqual([['review', 'terminal:1'], ['diff:a.ts']])
    expect(state.focused).toBe('p1')
  })

  it('adopts new shells into the focused pane without showing them, and drops the ones that ended', () => {
    let state = splitPane(withTabs(REVIEW_TAB, diff('a.ts')), 'p1', 'right', 'diff:a.ts')
    state = syncTerminalTabs(state, [{ id: '1', title: 'zsh' }, { id: '2', title: 'node' }])
    expect(strips(state)).toEqual([['review'], ['diff:a.ts', 'terminal:1', 'terminal:2']])
    expect(state.panes.p2.active).toBe('diff:a.ts')
    state = syncTerminalTabs(state, [{ id: '2', title: 'node' }])
    expect(strips(state)).toEqual([['review'], ['diff:a.ts', 'terminal:2']])
  })

  it('shows an adopted shell in an empty pane', () => {
    const state = syncTerminalTabs(EMPTY_DOCK_PANES, [{ id: '1', title: 'zsh' }])
    expect(strips(state)).toEqual([['terminal:1']])
    expect(state.panes.p1.active).toBe('terminal:1')
  })

  it('shows the preferred shell, not the first, when adopting into an empty pane', () => {
    const state = syncTerminalTabs(EMPTY_DOCK_PANES, [{ id: '1', title: 'a' }, { id: '2', title: 'b' }, { id: '3', title: 'c' }], '2')
    expect(strips(state)).toEqual([['terminal:1', 'terminal:2', 'terminal:3']])
    expect(state.panes.p1.active).toBe('terminal:2')
  })

  it('never lets the preferred shell take over a pane that already shows a tab', () => {
    const state = syncTerminalTabs(withTabs(file('a.ts')), [{ id: '1', title: 'a' }, { id: '2', title: 'b' }], '2')
    expect(state.panes.p1.active).toBe('file:a.ts')
    expect(strips(state)).toEqual([['file:a.ts', 'terminal:1', 'terminal:2']])
  })

  it('ignores a preferred shell that is not being adopted', () => {
    const state = syncTerminalTabs(EMPTY_DOCK_PANES, [{ id: '1', title: 'a' }], '9')
    expect(state.panes.p1.active).toBe('terminal:1')
  })
})

describe('layout', () => {
  it('tidies splits inside splits of the same axis and splits of one child', () => {
    const nested: PaneLayout = { axis: 'row', children: [{ pane: 'a' }, { axis: 'row', children: [{ pane: 'b' }, { axis: 'column', children: [{ pane: 'c' }], sizes: [1] }], sizes: [1, 1] }], sizes: [1, 1] }
    expect(normalizeLayout(nested)).toEqual({ axis: 'row', children: [{ pane: 'a' }, { pane: 'b' }, { pane: 'c' }], sizes: [0.5, 0.25, 0.25] })
  })

  it('places each pane on screen and a bar between neighbours, skipping hidden panes', () => {
    const layout: PaneLayout = { axis: 'row', children: [{ pane: 'a' }, { axis: 'column', children: [{ pane: 'b' }, { pane: 'c' }], sizes: [0.25, 0.75] }], sizes: [0.5, 0.5] }
    const all = layoutBoxes(layout, new Set(['a', 'b', 'c']))
    expect(all.panes.get('c')).toEqual({ left: 0.5, top: 0.25, width: 0.5, height: 0.75 })
    expect(all.bars.map((bar) => [bar.path, bar.axis, bar.before, bar.after, bar.at])).toEqual([[[], 'row', 0, 1, 0.5], [[1], 'column', 0, 1, 0.25]])

    const hidden = layoutBoxes(layout, new Set(['a', 'b']))
    expect(hidden.panes.get('b')).toEqual({ left: 0.5, top: 0, width: 0.5, height: 1 })
    expect(hidden.bars).toHaveLength(1)
  })

  it('moves a bar within its two panes, neither below its floor', () => {
    const bar = { before: 0, after: 1, shown: [0, 1, 2] }
    const sizes = sizesWithBarAt([0.25, 0.25, 0.5], bar, 0.4, 0.1)
    expect(close(sizes[0], 0.4) && close(sizes[1], 0.1) && sizes[2] === 0.5).toBe(true)
    expect(sizesWithBarAt([0.25, 0.25, 0.5], bar, 0.49, 0.1).map((v) => Math.round(v * 100))).toEqual([40, 10, 50])
    expect(sizesWithBarAt([0.25, 0.25, 0.5], bar, 0, 0.1).map((v) => Math.round(v * 100))).toEqual([10, 40, 50])
  })

  it('stores a split\'s new sizes by its place', () => {
    let state = splitPane(splitPane(withTabs(REVIEW_TAB), 'p1', 'right'), 'p2', 'down')
    state = resizeSplit(state, [1], [0.3, 0.7])
    expect(state.layout).toMatchObject({ children: [{ pane: 'p1' }, { sizes: [0.3, 0.7] }] })
  })

  it('joins every pane into one on a phone', () => {
    let state = splitPane(withTabs(REVIEW_TAB, diff('a.ts')), 'p1', 'right', 'diff:a.ts')
    state = openTab(state, term('1'))
    state = focusPane(joinPanes(state), 'p1')
    expect(strips(state)).toEqual([['review', 'diff:a.ts', 'terminal:1']])
    expect(state.panes.p1.active).toBe('terminal:1')
  })
})

describe('memory', () => {
  it('saves panes and their tabs, terminals by id, and restores them', () => {
    let state = splitPane(withTabs(REVIEW_TAB, diff('a.ts')), 'p1', 'right', 'diff:a.ts')
    state = openTab(state, term('1'))
    state = resizeSplit(state, [], [0.6, 0.4])
    const restored = restoreDockPanes(JSON.parse(JSON.stringify(serializeDockPanes(state))))!
    expect(restored.layout).toEqual(state.layout)
    expect(strips(restored)).toEqual(strips(state))
    expect(restored.focused).toBe(state.focused)
  })

  it('leaves uploads out, closing a pane that held only them', () => {
    let state = splitPane(withTabs(REVIEW_TAB, attachment('a.png')), 'p1', 'right', 'attachment:a.png')
    const restored = restoreDockPanes(JSON.parse(JSON.stringify(serializeDockPanes(state))))!
    expect(restored.layout).toEqual({ pane: 'p1' })
    expect(strips(restored)).toEqual([['review']])
    state = closeTabs(state, [])
    expect(paneOf(state, 'attachment:a.png')).toBe('p2')
  })

  it('restores a save from the two-group panel as two stacked panes', () => {
    const saved = {
      tabs: [REVIEW_TAB, diff('a.ts'), diff('b.ts')],
      lower: ['diff:b.ts'],
      active: ['diff:a.ts', 'diff:b.ts'],
      focused: 1,
      split: true,
      lowerHidden: false,
      preview: ['diff:a.ts', null],
    }
    const restored = restoreDockPanes(saved)!
    expect(strips(restored)).toEqual([['review', 'diff:a.ts'], ['diff:b.ts']])
    expect(restored.focused).toBe('p2')
    expect(restored.panes.p1.preview).toBe('diff:a.ts')
    expect(restored.layout).toMatchObject({ axis: 'column', sizes: [UPPER_SHARE, 1 - UPPER_SHARE] })
  })

  it('ignores a save it cannot read', () => {
    expect(restoreDockPanes(null)).toBeNull()
    expect(restoreDockPanes({ tabs: 'nope' })).toBeNull()
    expect(restoreDockPanes({ v: 2, tabs: [], panes: {}, layout: { axis: 'row', children: [{ pane: 'a' }, { pane: 'a' }] } })).toBeNull()
  })
})
