import { describe, expect, it } from 'bun:test'

import {
  CHAT_MIN_WIDTH,
  DOCK_DEFAULT_RATIO,
  DOCK_MIN_WIDTH,
  DOCK_GROUP_MIN_HEIGHT,
  DOCK_SPLIT_DEFAULT_RATIO,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  clampSplitRatio,
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
    expect(clampSidebarWidth(440, 1180)).toBe(1180 - CHAT_MIN_WIDTH - DOCK_MIN_WIDTH)
    expect(clampSidebarWidth(440, 820)).toBe(SIDEBAR_MIN_WIDTH)
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
  // full width under it; a 1024px window keeps the chat beside the panel,
  // wide enough for a one-line run deck (it stacks under 520px).
  it('covers the chat on an 820px tablet and sits beside it in a 1024px window', () => {
    expect(dockOverlaysChat(820, false)).toBe(true)
    const side = resolveDockLayout({ centerWidth: 1024, ratio: DOCK_DEFAULT_RATIO, maximized: false })
    expect(side.mode).toBe('side')
    expect(1024 - side.width).toBeGreaterThanOrEqual(520)
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
  it('covers the content below 1180px instead of pushing it', () => {
    expect(sidebarIsDrawer(1179)).toBe(true)
    expect(sidebarIsDrawer(1024)).toBe(true)
    expect(sidebarIsDrawer(1180)).toBe(false)
    expect(sidebarIsDrawer(1440)).toBe(false)
  })
})

describe('clampSplitRatio', () => {
  it('keeps both Review panel groups at least DOCK_GROUP_MIN_HEIGHT tall', () => {
    expect(clampSplitRatio(0.5, 800)).toBe(0.5)
    expect(clampSplitRatio(0.02, 800)).toBe(DOCK_GROUP_MIN_HEIGHT / 800)
    expect(clampSplitRatio(0.99, 800)).toBe(1 - DOCK_GROUP_MIN_HEIGHT / 800)
  })

  it('falls back to the default for an invalid ratio or a panel too short to split', () => {
    expect(clampSplitRatio(Number.NaN, 800)).toBe(DOCK_SPLIT_DEFAULT_RATIO)
    expect(clampSplitRatio(0.8, 200)).toBe(0.5)
  })
})
