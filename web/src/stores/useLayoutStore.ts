/**
 * useLayoutStore — persisted desktop workbench layout.
 *
 * Owns the geometry that used to be scattered across component state and
 * per-component localStorage keys: sidebar collapse + width and the review
 * dock's width ratio, whether it is open, and how its two groups split.
 * ``dockMaximized`` is session-only (never persisted), so a reload always
 * lands with the chat visible.
 *
 * The layout belongs to the window: each window keeps its own (session
 * storage), and a new window starts from the last layout any window saved.
 *
 * Geometry math lives in ``lib/workbench-layout.ts``; this store only keeps
 * the user's choices.
 */
import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'

import { DOCK_DEFAULT_RATIO, DOCK_SPLIT_DEFAULT_RATIO, SIDEBAR_DEFAULT_WIDTH } from '@/lib/workbench-layout'

export const LAYOUT_STORAGE_KEY = 'oa.layout.v1'
/** Pre-store sidebar width key, read once so existing widths survive. */
export const LEGACY_SIDEBAR_WIDTH_KEY = 'oa.codingSidebar.width'

type Updater<T> = T | ((prev: T) => T)

interface LayoutState {
  /** ``null`` until the user chooses; resolved by ``resolveSidebarCollapsed``. */
  sidebarCollapsed: boolean | null
  sidebarWidth: number
  dockRatio: number
  /** The Review panel is open in this window (desktop). */
  dockOpen: boolean
  /** The upper group's share when the Review panel is split top/bottom. */
  dockSplitRatio: number
  dockMaximized: boolean
  setSidebarCollapsed: (value: Updater<boolean>, fallback: boolean) => void
  setSidebarWidth: (width: number) => void
  setDockRatio: (ratio: number) => void
  resetDockRatio: () => void
  setDockOpen: (open: boolean) => void
  setDockSplitRatio: (ratio: number) => void
  resetDockSplitRatio: () => void
  setDockMaximized: (value: boolean) => void
  toggleDockMaximized: () => void
  /** View → Reset Layout: every size and toggle back to its default. */
  resetLayout: () => void
}

function legacySidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH
  try {
    const parsed = Number(window.localStorage.getItem(LEGACY_SIDEBAR_WIDTH_KEY))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : SIDEBAR_DEFAULT_WIDTH
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

function tryStorage(kind: 'sessionStorage' | 'localStorage'): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window[kind]
  } catch {
    return null
  }
}

/**
 * Reads this window's layout, else the last one saved by any window; writes
 * both, so the next new window starts from here.
 */
export const windowLayoutStorage: StateStorage = {
  getItem: (name) => tryStorage('sessionStorage')?.getItem(name) ?? tryStorage('localStorage')?.getItem(name) ?? null,
  setItem: (name, value) => {
    tryStorage('sessionStorage')?.setItem(name, value)
    tryStorage('localStorage')?.setItem(name, value)
  },
  removeItem: (name) => {
    tryStorage('sessionStorage')?.removeItem(name)
  },
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: null,
      sidebarWidth: legacySidebarWidth(),
      dockRatio: DOCK_DEFAULT_RATIO,
      dockOpen: false,
      dockSplitRatio: DOCK_SPLIT_DEFAULT_RATIO,
      dockMaximized: false,
      setSidebarCollapsed: (value, fallback) => {
        const prev = get().sidebarCollapsed ?? fallback
        const next = typeof value === 'function' ? value(prev) : value
        set({ sidebarCollapsed: next })
      },
      setSidebarWidth: (width) => {
        if (Number.isFinite(width)) set({ sidebarWidth: Math.round(width) })
      },
      setDockRatio: (ratio) => {
        if (Number.isFinite(ratio) && ratio > 0 && ratio < 1) set({ dockRatio: ratio })
      },
      resetDockRatio: () => set({ dockRatio: DOCK_DEFAULT_RATIO }),
      setDockOpen: (open) => {
        if (get().dockOpen !== open) set({ dockOpen: open })
      },
      setDockSplitRatio: (ratio) => {
        if (Number.isFinite(ratio) && ratio > 0 && ratio < 1) set({ dockSplitRatio: ratio })
      },
      resetDockSplitRatio: () => set({ dockSplitRatio: DOCK_SPLIT_DEFAULT_RATIO }),
      setDockMaximized: (value) => {
        if (get().dockMaximized !== value) set({ dockMaximized: value })
      },
      toggleDockMaximized: () => set((state) => ({ dockMaximized: !state.dockMaximized })),
      resetLayout: () => set({
        sidebarCollapsed: null,
        sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
        dockRatio: DOCK_DEFAULT_RATIO,
        dockSplitRatio: DOCK_SPLIT_DEFAULT_RATIO,
        dockMaximized: false,
      }),
    }),
    {
      name: LAYOUT_STORAGE_KEY,
      storage: createJSONStorage(() => windowLayoutStorage),
      partialize: ({ sidebarCollapsed, sidebarWidth, dockRatio, dockOpen, dockSplitRatio }) => ({
        sidebarCollapsed, sidebarWidth, dockRatio, dockOpen, dockSplitRatio,
      }),
    },
  ),
)
