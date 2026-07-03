import { describe, expect, it } from 'bun:test'
import { overlaysToClose, type MobileOverlay } from '@/components/TeamChatView/mobileOverlays'

const ALL: MobileOverlay[] = [
  'sidebar', 'actions', 'coding-panel', 'todos', 'files', 'terminal', 'scheduler', 'capabilities', 'palette',
]
const DRAWERS: MobileOverlay[] = ['sidebar', 'actions', 'coding-panel']

describe('overlaysToClose', () => {
  it('never includes the overlay being kept', () => {
    for (const keep of ALL) {
      expect(overlaysToClose(keep)).not.toContain(keep)
    }
  })

  it('opening a non-drawer overlay closes every other overlay (incl. all drawers)', () => {
    // Session settings (capabilities) is a non-drawer overlay.
    const closed = overlaysToClose('capabilities')
    for (const other of ALL) {
      if (other === 'capabilities') continue
      expect(closed).toContain(other)
    }
    // Explicitly: all three drawers are torn down.
    for (const drawer of DRAWERS) expect(closed).toContain(drawer)
  })

  it('opening todos closes the workspace panel, sidebar and session settings', () => {
    const closed = overlaysToClose('todos')
    expect(closed).toContain('coding-panel')
    expect(closed).toContain('sidebar')
    expect(closed).toContain('capabilities')
  })

  it('opening a drawer leaves sibling-drawer teardown to the swipe controller', () => {
    // Opening the sidebar should NOT list other drawers (useEdgeSwipe owns
    // that), but SHOULD close every non-drawer overlay.
    const closed = overlaysToClose('sidebar')
    expect(closed).not.toContain('actions')
    expect(closed).not.toContain('coding-panel')
    expect(closed).toContain('todos')
    expect(closed).toContain('files')
    expect(closed).toContain('scheduler')
    expect(closed).toContain('capabilities')
    expect(closed).toContain('palette')
  })

  it('opening the coding panel closes session settings, todos and palette', () => {
    const closed = overlaysToClose('coding-panel')
    expect(closed).toContain('capabilities')
    expect(closed).toContain('todos')
    expect(closed).toContain('palette')
    // but not the sibling drawers
    expect(closed).not.toContain('sidebar')
    expect(closed).not.toContain('actions')
  })
})
