import { describe, expect, it } from 'bun:test'

import {
  CHAT_MIN_WIDTH,
  DOCK_DEFAULT_RATIO,
  DOCK_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  TOUCH_CHAT_MIN_WIDTH,
  clampSidebarWidth,
  dockOverlaysChat,
  ratioFromWidth,
  resolveDockLayout,
  resolveSidebarCollapsed,
  sidebarIsDrawer,
} from '@/lib/workbench-layout'

describe('resolveSidebarCollapsed', () => {
  it('keeps an explicit user choice regardless of viewport', () => {
    expect(resolveSidebarCollapsed(true, true)).toBe(true)
    expect(resolveSidebarCollapsed(false, false)).toBe(false)
  })

  it('defaults to expanded on wide windows and collapsed on narrow ones', () => {
    expect(resolveSidebarCollapsed(null, true)).toBe(false)
    expect(resolveSidebarCollapsed(undefined, false)).toBe(true)
  })
})

describe('clampSidebarWidth', () => {
  it('clamps into the min/max band on wide windows', () => {
    expect(clampSidebarWidth(100, 1920)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(900, 1920)).toBe(SIDEBAR_MAX_WIDTH)
    expect(clampSidebarWidth(300, 1920)).toBe(300)
  })

  it('never exceeds what leaves room for chat + dock, but never drops below the minimum', () => {
    expect(clampSidebarWidth(440, 1100)).toBe(1100 - CHAT_MIN_WIDTH - DOCK_MIN_WIDTH)
    expect(clampSidebarWidth(440, 820)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('only keeps room for the chat while the Review panel is closed', () => {
    expect(clampSidebarWidth(440, 780, { dockOpen: false })).toBe(780 - CHAT_MIN_WIDTH)
    expect(clampSidebarWidth(264, 856, { dockOpen: false })).toBe(264)
  })

  it('falls back to the default for non-finite widths', () => {
    expect(clampSidebarWidth(Number.NaN, 1920)).toBe(264)
  })
})

describe('resolveDockLayout', () => {
  it('sizes the dock as a ratio of the center at common window widths', () => {
    expect(resolveDockLayout({ centerWidth: 1280 - 264, ratio: DOCK_DEFAULT_RATIO, maximized: false }))
      .toEqual({ mode: 'side', width: 457 })
    expect(resolveDockLayout({ centerWidth: 1280, ratio: DOCK_DEFAULT_RATIO, maximized: false }))
      .toEqual({ mode: 'side', width: 576 })
    expect(resolveDockLayout({ centerWidth: 1920 - 264, ratio: DOCK_DEFAULT_RATIO, maximized: false }))
      .toEqual({ mode: 'side', width: 745 })
  })

  it('keeps the chat at least CHAT_MIN wide and the dock at least DOCK_MIN wide', () => {
    const center = 1280 - 264
    expect(resolveDockLayout({ centerWidth: center, ratio: 0.95, maximized: false }).width).toBe(center - CHAT_MIN_WIDTH)
    expect(resolveDockLayout({ centerWidth: center, ratio: 0.05, maximized: false }).width).toBe(DOCK_MIN_WIDTH)
  })

  it('overlays the chat when maximized or when the center is too narrow for a split', () => {
    expect(resolveDockLayout({ centerWidth: 1016, ratio: 0.45, maximized: true })).toEqual({ mode: 'overlay', width: 1016 })
    expect(resolveDockLayout({ centerWidth: 820 - 264, ratio: 0.45, maximized: false })).toEqual({ mode: 'overlay', width: 556 })
    expect(resolveDockLayout({ centerWidth: CHAT_MIN_WIDTH + DOCK_MIN_WIDTH, ratio: 0.45, maximized: false }).mode).toBe('side')
  })

  it('treats an invalid ratio as the default', () => {
    expect(resolveDockLayout({ centerWidth: 1000, ratio: Number.NaN, maximized: false }).width).toBe(450)
  })

  it('agrees with dockOverlaysChat, which the shell reads on its own', () => {
    const split = CHAT_MIN_WIDTH + DOCK_MIN_WIDTH
    for (const centerWidth of [split - 0.6, split - 0.4, split, 1200]) {
      for (const maximized of [false, true]) {
        const overlay = resolveDockLayout({ centerWidth, ratio: 0.45, maximized }).mode === 'overlay'
        expect(dockOverlaysChat(centerWidth, maximized)).toBe(overlay)
      }
    }
    expect(dockOverlaysChat(split - 0.6, false)).toBe(true)
    expect(dockOverlaysChat(split - 0.4, false)).toBe(false)
  })

  // layout.html: an 820px tablet in portrait gets the overlay, the composer
  // full width under it; a 1024px tablet keeps the chat beside the panel,
  // wide enough for a one-line run deck (it stacks under 520px).
  it('covers the chat on an 820px touch tablet and sits beside it at 1024px', () => {
    expect(dockOverlaysChat(820, false, { touch: true })).toBe(true)
    const side = resolveDockLayout({ centerWidth: 1024, ratio: DOCK_DEFAULT_RATIO, maximized: false, touch: true })
    expect(side.mode).toBe('side')
    expect(1024 - side.width).toBeGreaterThanOrEqual(TOUCH_CHAT_MIN_WIDTH)
  })

  // A desktop window is driven by a pointer: like any desktop app the panel
  // sits beside the chat while both fit (740px of center, layout.html), and
  // only covers it below that.
  it('keeps the panel beside the chat in an 856px desktop window', () => {
    const side = resolveDockLayout({ centerWidth: 856, ratio: DOCK_DEFAULT_RATIO, maximized: false })
    expect(side.mode).toBe('side')
    expect(856 - side.width).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH)
    expect(dockOverlaysChat(856, false)).toBe(false)
    expect(dockOverlaysChat(739, false)).toBe(true)
    expect(dockOverlaysChat(740, false)).toBe(false)
  })
})

describe('ratioFromWidth', () => {
  it('converts a committed width back to a bounded ratio', () => {
    expect(ratioFromWidth(500, 1000)).toBe(0.5)
    expect(ratioFromWidth(5000, 1000)).toBe(0.95)
    expect(ratioFromWidth(500, 0)).toBe(DOCK_DEFAULT_RATIO)
  })
})

describe('sidebarIsDrawer', () => {
  it('pushes the chat in a desktop window whenever the chat keeps its width', () => {
    expect(sidebarIsDrawer(820)).toBe(false)
    expect(sidebarIsDrawer(856)).toBe(false)
    expect(sidebarIsDrawer(1024)).toBe(false)
    expect(sidebarIsDrawer(1440)).toBe(false)
  })

  it('covers the content when pushing would squeeze the chat and the open Review panel', () => {
    expect(sidebarIsDrawer(856, { dockOpen: true })).toBe(true)
    expect(sidebarIsDrawer(SIDEBAR_MIN_WIDTH + CHAT_MIN_WIDTH + DOCK_MIN_WIDTH - 1, { dockOpen: true })).toBe(true)
    expect(sidebarIsDrawer(SIDEBAR_MIN_WIDTH + CHAT_MIN_WIDTH + DOCK_MIN_WIDTH, { dockOpen: true })).toBe(false)
    expect(sidebarIsDrawer(1024, { dockOpen: true })).toBe(false)
  })

  it('covers the content below 1180px on a touch tablet, as iPadOS sidebars do', () => {
    expect(sidebarIsDrawer(1179, { touch: true })).toBe(true)
    expect(sidebarIsDrawer(820, { touch: true })).toBe(true)
    expect(sidebarIsDrawer(1180, { touch: true })).toBe(false)
  })
})
