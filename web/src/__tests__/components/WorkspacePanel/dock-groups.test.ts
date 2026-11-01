/**
 * The Review panel's groups: one strip or two stacked, a reusable preview
 * tab per group, views before documents, and a join when a group empties.
 */
import { describe, expect, it } from 'bun:test'

import {
  EMPTY_DOCK_GROUPS,
  activateTab,
  canMoveToOtherGroup,
  closeTabs,
  groupTabs,
  keepTab,
  lowerVisible,
  moveToOtherGroup,
  moveWithinGroup,
  openTab,
  restoreDockGroups,
  serializeDockGroups,
  syncTerminalTabs,
  toggleLowerGroup,
  toggleSplit,
  type DockGroups,
} from '@/components/WorkspacePanel/dock-groups'
import { PLAN_TAB, REVIEW_TAB, TASKS_TAB, type DockTab } from '@/components/WorkspacePanel/dock-tabs'

const file = (path: string): DockTab => ({ id: `file:${path}`, type: 'file', title: path, file: { path, name: path, size: 1, mtime: 0, mime: 'text/plain' } })
const diff = (path: string): DockTab => ({ id: `diff:${path}`, type: 'diff', title: path, path, status: 'M' })
const term = (id: string): DockTab => ({ id: `terminal:${id}`, type: 'terminal', title: `Terminal ${id}`, termId: id })
const ids = (tabs: DockTab[]) => tabs.map((tab) => tab.id)

function withTabs(...tabs: DockTab[]): DockGroups {
  return tabs.reduce((state, tab) => openTab(state, tab), EMPTY_DOCK_GROUPS)
}

describe('dock groups', () => {
  it('lists views before documents in a strip, whatever the opening order', () => {
    const state = withTabs(file('a.ts'), REVIEW_TAB, diff('b.ts'), TASKS_TAB)
    expect(ids(groupTabs(state, 0))).toEqual(['review', 'tasks', 'file:a.ts', 'diff:b.ts'])
  })

  it('reuses one preview tab per group until it is kept', () => {
    let state = openTab(EMPTY_DOCK_GROUPS, REVIEW_TAB)
    state = openTab(state, file('a.ts'), { preview: true })
    state = openTab(state, file('b.ts'), { preview: true })
    expect(ids(groupTabs(state, 0))).toEqual(['review', 'file:b.ts'])
    expect(state.preview[0]).toBe('file:b.ts')

    state = keepTab(state, 'file:b.ts')
    state = openTab(state, diff('c.ts'), { preview: true })
    expect(ids(groupTabs(state, 0))).toEqual(['review', 'file:b.ts', 'diff:c.ts'])
    expect(state.preview[0]).toBe('diff:c.ts')
  })

  it('keeps a preview tab once it is opened for keeps', () => {
    let state = openTab(EMPTY_DOCK_GROUPS, file('a.ts'), { preview: true })
    state = openTab(state, file('a.ts'))
    expect(state.preview[0]).toBeNull()
  })

  it('opens terminals in the lower group, splitting the panel', () => {
    let state = withTabs(REVIEW_TAB, diff('a.ts'))
    state = openTab(state, term('1'), { group: 1 })
    expect(state.split).toBe(true)
    expect(lowerVisible(state)).toBe(true)
    expect(ids(groupTabs(state, 0))).toEqual(['review', 'diff:a.ts'])
    expect(ids(groupTabs(state, 1))).toEqual(['terminal:1'])
    expect(state.active).toEqual(['diff:a.ts', 'terminal:1'])
    expect(state.focused).toBe(1)
  })

  it('hides and shows the lower group without closing its tabs', () => {
    let state = openTab(withTabs(REVIEW_TAB), term('1'), { group: 1 })
    state = toggleLowerGroup(state)
    expect(lowerVisible(state)).toBe(false)
    expect(ids(groupTabs(state, 1))).toEqual(['terminal:1'])
    expect(state.focused).toBe(0)
    state = toggleLowerGroup(state)
    expect(lowerVisible(state)).toBe(true)
    expect(state.focused).toBe(1)
  })

  it('joins the groups when the last tab of one closes', () => {
    let state = openTab(withTabs(REVIEW_TAB, diff('a.ts')), term('1'), { group: 1 })
    state = closeTabs(state, ['terminal:1'])
    expect(state.split).toBe(false)
    expect(state.focused).toBe(0)

    state = openTab(withTabs(diff('a.ts')), term('1'), { group: 1 })
    state = closeTabs(state, ['diff:a.ts'])
    expect(state.split).toBe(false)
    expect(ids(groupTabs(state, 0))).toEqual(['terminal:1'])
    expect(state.active[0]).toBe('terminal:1')
  })

  it('activates the right neighbour, else the left one, in the same group', () => {
    let state = withTabs(file('a'), file('b'), file('c'))
    state = activateTab(state, 'file:b')
    expect(closeTabs(state, ['file:b']).active[0]).toBe('file:c')
    state = activateTab(state, 'file:c')
    expect(closeTabs(state, ['file:c']).active[0]).toBe('file:b')
  })

  it('splits into an empty lower group, and joins back with ⌘\\', () => {
    let state = withTabs(REVIEW_TAB, diff('a.ts'))
    state = toggleSplit(state)
    expect(state.split).toBe(true)
    expect(groupTabs(state, 1)).toEqual([])
    expect(state.focused).toBe(1)
    state = openTab(state, file('b.ts'), { group: 1 })
    state = toggleSplit(state)
    expect(state.split).toBe(false)
    expect(ids(groupTabs(state, 0))).toEqual(['review', 'diff:a.ts', 'file:b.ts'])
    expect(state.active[0]).toBe('file:b.ts')
  })

  it('moves a tab to the other group, but never empties its group that way', () => {
    let state = withTabs(REVIEW_TAB, diff('a.ts'))
    expect(canMoveToOtherGroup(state, 'diff:a.ts')).toBe(true)
    state = moveToOtherGroup(state, 'diff:a.ts')
    expect(ids(groupTabs(state, 0))).toEqual(['review'])
    expect(ids(groupTabs(state, 1))).toEqual(['diff:a.ts'])
    expect(state.active).toEqual(['review', 'diff:a.ts'])
    expect(canMoveToOtherGroup(state, 'review')).toBe(false)
  })

  it('reorders within a group, keeping views before documents', () => {
    let state = withTabs(REVIEW_TAB, PLAN_TAB, file('a'), file('b'))
    state = moveWithinGroup(state, 'file:b', 2)
    expect(ids(groupTabs(state, 0))).toEqual(['review', 'plan', 'file:b', 'file:a'])
    state = moveWithinGroup(state, 'file:a', 0)
    expect(ids(groupTabs(state, 0))).toEqual(['review', 'plan', 'file:a', 'file:b'])
  })

  it('adopts terminals into the lower group and drops the ones that ended', () => {
    let state = withTabs(REVIEW_TAB)
    state = syncTerminalTabs(state, [{ id: '1', title: 'zsh' }, { id: '2', title: 'node' }], true)
    expect(ids(groupTabs(state, 1))).toEqual(['terminal:1', 'terminal:2'])
    expect(state.split).toBe(true)
    state = syncTerminalTabs(state, [{ id: '2', title: 'node' }], true)
    expect(ids(groupTabs(state, 1))).toEqual(['terminal:2'])
    state = syncTerminalTabs(state, [], true)
    expect(state.split).toBe(false)
  })

  it('keeps terminals in the one group on phones', () => {
    const state = syncTerminalTabs(withTabs(REVIEW_TAB), [{ id: '1', title: 'zsh' }], false)
    expect(state.split).toBe(false)
    expect(ids(groupTabs(state, 0))).toEqual(['review', 'terminal:1'])
  })

  it('saves tabs and groups without terminals, and restores them', () => {
    let state = openTab(withTabs(REVIEW_TAB, diff('a.ts')), term('1'), { group: 1 })
    state = moveToOtherGroup(state, 'diff:a.ts')
    const saved = JSON.parse(JSON.stringify(serializeDockGroups(state)))
    expect(saved.tabs.map((tab: DockTab) => tab.id)).toEqual(['review', 'diff:a.ts'])
    const restored = restoreDockGroups(saved)
    expect(restored).not.toBeNull()
    expect(ids(groupTabs(restored!, 0))).toEqual(['review'])
    expect(ids(groupTabs(restored!, 1))).toEqual(['diff:a.ts'])
    expect(restored!.split).toBe(true)
  })

  it('ignores a saved state it cannot read', () => {
    expect(restoreDockGroups(null)).toBeNull()
    expect(restoreDockGroups({ tabs: 'nope' })).toBeNull()
  })
})
