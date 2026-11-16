// Not compiled, as when this code was part of Sidebar, which the React
// Compiler skipped; compiling it is a change of its own to verify.
'use no memo'
/**
 * The sidebar column's frame: its width (stored, clamped to the window, and
 * dragged by the resize edge), the desktop slide when it shows or hides, and
 * the phone drawer's motion.
 */
import { useCallback } from 'react'
import { PANEL_SLIDE_MS, type LiveWidth } from '@/components/ResizableAside'
import { useDrawerMotion } from '@/hooks/use-drawer-motion'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useToggleTween } from '@/hooks/useToggleTween'
import { useTouchFirst } from '@/hooks/use-touch-first'
import { useViewportWidth } from '@/hooks/use-viewport-width'
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  sidebarMaxWidth,
} from '@/lib/workbench-layout'
import { useLayoutStore } from '@/stores/useLayoutStore'

export function useSidebarFrame({
  isMobile,
  isPage,
  desktopCollapsed,
  drawer,
  dockOpen,
  mobileOpen,
}: {
  isMobile: boolean
  /** The phone's Sessions page, which fills its layer and does not move. */
  isPage: boolean
  desktopCollapsed: boolean
  drawer: boolean
  dockOpen: boolean
  mobileOpen: boolean
}) {
  const prefersReducedMotion = useReducedMotion()
  // Width is persisted in the layout store and clamped against the window so
  // the chat and a side-by-side dock always keep their minimums. A drawer
  // covers the chat, so it only has to leave the chat visible beside it.
  const viewportWidth = useViewportWidth()
  const touch = useTouchFirst()
  const widthContext = { dockOpen: dockOpen && !drawer, touch }
  const storedSidebarWidth = useLayoutStore((s) => s.sidebarWidth)
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth)
  const commitSidebarWidth = useCallback((width: number) => setSidebarWidth(width), [setSidebarWidth])
  const resetSidebarWidth = useCallback(() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH), [setSidebarWidth])
  const sidebarResize = {
    width: clampSidebarWidth(storedSidebarWidth, viewportWidth, widthContext),
    min: SIDEBAR_MIN_WIDTH,
    max: sidebarMaxWidth(viewportWidth, widthContext),
    edge: 'right' as const,
    onCommit: commitSidebarWidth,
    onReset: resetSidebarWidth,
    detent: SIDEBAR_DEFAULT_WIDTH,
    disabled: isMobile || desktopCollapsed,
    label: 'Resize sidebar',
  }
  // Desktop: showing or hiding slides the width (a CSS transition, only for
  // the toggle); the rows keep the open width and ride the moving edge, so
  // they slide rather than rewrap every frame.
  const sliding = useToggleTween(desktopCollapsed, PANEL_SLIDE_MS) && !isMobile
  const pinRows = !isMobile && (desktopCollapsed || sliding)
  // The phone drawer slides by ``translate`` (and its scrim fades) through
  // ``lib/drawer-motion``: an edge swipe writes it per frame without
  // re-rendering, and a release springs on with the finger's speed. Closed
  // sits 280px out so its shadow clears the edge.
  useDrawerMotion('sidebar', { open: mobileOpen, enabled: isMobile && !isPage, hidden: -280, reduced: prefersReducedMotion ?? false })
  const sidebarMotion = ({ width }: LiveWidth) => ({
    // The page fills its layer: no width of its own to animate.
    animate: isPage
      ? {}
      : isMobile
        ? { width: 'min(272px, calc(100vw - 2rem))' }
        : { width: desktopCollapsed ? 0 : width },
    // Desktop sets the width as a style (no frame loop), sliding it only
    // while a toggle runs.
    transition: { duration: 0 },
    instantWidth: !isMobile,
    tweenWidth: sliding,
  })

  return { sidebarResize, sliding, pinRows, sidebarMotion }
}
