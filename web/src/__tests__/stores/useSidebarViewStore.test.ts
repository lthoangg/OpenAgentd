import { afterEach, describe, expect, it } from 'bun:test'

import { SIDEBAR_VIEW_DEFAULTS, SIDEBAR_VIEW_STORAGE_KEY, useSidebarViewStore } from '@/stores/useSidebarViewStore'

afterEach(() => {
  useSidebarViewStore.setState({ ...SIDEBAR_VIEW_DEFAULTS, pinnedCollapsed: false, collapsedGroups: [] })
  localStorage.removeItem(SIDEBAR_VIEW_STORAGE_KEY)
})

const stored = () => JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) ?? '{}').state

describe('useSidebarViewStore', () => {
  it('starts grouped by project, newest activity first, with details shown', () => {
    const state = useSidebarViewStore.getState()
    expect([state.groupBy, state.sortBy, state.showDetails]).toEqual(['project', 'activity', true])
  })

  it('remembers the view options', () => {
    const state = useSidebarViewStore.getState()
    state.setGroupBy('date')
    state.setSortBy('created')
    state.setShowDetails(false)
    state.toggleGroupCollapsed('today')

    expect(stored()).toEqual({ groupBy: 'date', sortBy: 'created', showDetails: false, pinnedCollapsed: false, collapsedGroups: ['today'], groupFilter: null })
    useSidebarViewStore.getState().toggleGroupCollapsed('today')
    expect(useSidebarViewStore.getState().collapsedGroups).toEqual([])
  })

  it('remembers the workspace group filter, and reset clears it', () => {
    useSidebarViewStore.getState().setGroupFilter('g-1')
    expect(stored().groupFilter).toBe('g-1')
    useSidebarViewStore.getState().reset()
    expect(useSidebarViewStore.getState().groupFilter).toBeNull()
  })

  it('resets the view to the defaults but keeps folded sections', () => {
    const state = useSidebarViewStore.getState()
    state.setGroupBy('none')
    state.setShowDetails(false)
    state.setPinnedCollapsed(true)

    useSidebarViewStore.getState().reset()

    const next = useSidebarViewStore.getState()
    expect([next.groupBy, next.sortBy, next.showDetails, next.pinnedCollapsed]).toEqual(['project', 'activity', true, true])
  })

  it('reads unknown stored values as the defaults', async () => {
    localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, JSON.stringify({
      state: { groupBy: 'environment', sortBy: 'name', showDetails: 'yes', collapsedGroups: [1, 'older'], groupFilter: 7 },
      version: 0,
    }))

    await useSidebarViewStore.persist.rehydrate()

    const state = useSidebarViewStore.getState()
    expect([state.groupBy, state.sortBy, state.showDetails]).toEqual(['project', 'activity', true])
    expect(state.collapsedGroups).toEqual(['older'])
    expect(state.groupFilter).toBeNull()
  })

  it('survives a stored value that is not JSON', async () => {
    localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, '{not json')

    await useSidebarViewStore.persist.rehydrate()

    expect(useSidebarViewStore.getState().groupBy).toBe('project')
  })
})
