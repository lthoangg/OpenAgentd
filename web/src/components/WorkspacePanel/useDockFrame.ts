/**
 * The Review dock's frame: how it opens, closes, sizes and slides, apart
 * from what it shows.
 *
 * Desktop geometry is a ratio of the shell's center region in ``side``
 * mode, or the whole center in ``overlay`` mode (maximized, or a window too
 * narrow for a side-by-side split). Desktop sets the width as a style and
 * slides it only while showing, hiding, maximizing or beside a sliding
 * sidebar; a drag-resize is instant. The mobile sheet and the phone's page
 * follow an edge swipe through the drawer driver instead. A closed dock
 * parks, hidden and inert, once its close tween is done.
 */
import { useEffect, useLayoutEffect, useState } from 'react'
import { useDrawerMotion } from '@/hooks/use-drawer-motion'
import { useElementWidth } from '@/hooks/use-element-width'
import { useToggleTween } from '@/hooks/useToggleTween'
import { useTouchFirst } from '@/hooks/use-touch-first'
import {
  PANEL_SLIDE_MS,
  onPanelSlideBeside,
  settledWidthBesidePanels,
  usePanelSlideBeside,
  type LiveWidth,
} from '@/components/ResizableAside'
import {
  DOCK_DEFAULT_RATIO,
  DOCK_MIN_WIDTH,
  dockMaxWidth,
  ratioFromWidth,
  resolveDockLayout,
  sideDockWidth,
  type DockLayout,
} from '@/lib/workbench-layout'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { usePhonePageWidth } from './usePhonePageWidth'

/** A closed dock parks (hidden, inert) once its close tween (0.22 s) is done. */
const PARK_AFTER_MS = 260
/** A phone's page leaves on the drawer spring, which takes about half a second to come to rest. */
const PHONE_PARK_AFTER_MS = 500
/** px a narrow mouse window's drawer slides (the phone's page slides its whole width). */
const DRAWER_TRAVEL_PX = 272

export function useDockFrame({
  open,
  mobile,
  phone,
  slideIn,
  centerRef,
  centerWidth,
  prefersReducedMotion,
}: {
  open: boolean
  mobile: boolean
  /** A phone (touch and narrow): the dock is a page pushed over the chat. */
  phone: boolean
  /** Mounted by the show toggle: slide in from 0 like a later open. */
  slideIn: boolean
  centerRef: React.RefObject<HTMLElement | null>
  centerWidth?: number
  prefersReducedMotion: boolean | null
}) {
  const phonePageWidth = usePhonePageWidth(phone)
  // Closed and done animating: hidden and inert until it opens again. Not
  // inert at once, so the shell can still see focus inside it and return it.
  const [parked, setParked] = useState(false)
  useEffect(() => {
    if (open) {
      setParked(false)
      return
    }
    const timer = window.setTimeout(() => setParked(true), phone ? PHONE_PARK_AFTER_MS : PARK_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [open, phone])
  // Whether the open or close tween (mounting counts as opening on a phone)
  // is still running. Only then, and while closed, is the body pinned to the
  // open width; any other width change moves the body with the dock's edge.
  // The phone sheet settles on its animation's end; desktop slides its width
  // with a CSS transition for a fixed time (``useToggleTween``).
  const [toggle, setToggle] = useState({ open, running: mobile })
  if (toggle.open !== open) setToggle({ open, running: mobile })
  const settleToggle = () => setToggle((current) => (current.running ? { ...current, running: false } : current))
  // Mounted by the toggle: lay out one frame at 0 wide, so the width has a
  // start to slide from (layout is flushed before the second render).
  const [entering, setEntering] = useState(slideIn && open && !mobile)
  useLayoutEffect(() => {
    if (!entering) return
    void document.body.getBoundingClientRect()
    setEntering(false)
  }, [entering])
  const shownOpen = open && !entering
  const sliding = useToggleTween(shownOpen, PANEL_SLIDE_MS) && !mobile

  // ── Geometry ───────────────────────────────────────────────────────────────
  const dockRatio = useLayoutStore((s) => s.dockRatio)
  const dockMaximized = useLayoutStore((s) => s.dockMaximized)
  // Maximize, restore and Escape slide the width like open and close; a
  // drag-resize never sets this, so it stays instant.
  const maximizeSliding = useToggleTween(dockMaximized, PANEL_SLIDE_MS) && !mobile
  // The sidebar showing or hiding changes the center: re-measured in the
  // commit its slide starts, the dock slides to its new ratio alongside it,
  // on the same curve, and the chat between them moves in one motion.
  const measuredCenter = useElementWidth(centerRef, settledWidthBesidePanels, onPanelSlideBeside)
  const besideSliding = usePanelSlideBeside(centerRef) && !mobile
  const center = centerWidth ?? measuredCenter
  const touch = useTouchFirst()
  const liveLayout = resolveDockLayout({ centerWidth: center, ratio: dockRatio, maximized: dockMaximized, touch })
  // A dock that was beside the chat closes beside it. Closing frees room the
  // sidebar may take at once (its clamp leaves an open dock 340px), which can
  // drop the center under the side-by-side minimum mid-slide: switching to
  // the overlay then would pull the dock out of the row, snap the chat to
  // full width and slide the dock over it.
  const [openMode, setOpenMode] = useState(liveLayout.mode)
  if (open && openMode !== liveLayout.mode) setOpenMode(liveLayout.mode)
  const layout: DockLayout = !open && openMode === 'side' && liveLayout.mode === 'overlay' && !dockMaximized
    ? { mode: 'side', width: sideDockWidth(center, dockRatio, { touch }) }
    : liveLayout
  const overlay = !mobile && layout.mode === 'overlay'
  // The default width a drag snaps onto: where a double-click puts the edge.
  const dockDetent = sideDockWidth(center, DOCK_DEFAULT_RATIO, { touch })
  const dockResize = {
    width: layout.width,
    min: DOCK_MIN_WIDTH,
    max: dockMaxWidth(center, { touch }),
    edge: 'left' as const,
    detent: dockDetent,
    // Snapped onto the default, it is the default ratio, not a rounded one.
    onCommit: (width: number) => useLayoutStore.getState().setDockRatio(width === dockDetent ? DOCK_DEFAULT_RATIO : ratioFromWidth(width, center)),
    onReset: () => useLayoutStore.getState().resetDockRatio(),
    disabled: mobile || overlay || !open,
    label: 'Resize Review panel',
  }
  // Desktop sets the width as a style and slides it only while showing or
  // hiding (never for a drag or a window resize). Closed or sliding, the
  // body keeps its open width, clipped rather than reflowed, so it rides
  // the moving edge.
  // The phone sheet follows an edge swipe by ``translate`` (see
  // ``lib/drawer-motion``): no re-render per frame, and a release springs on
  // with the finger's speed. A narrow mouse window's drawer fades (below) as it
  // slides 272px; a phone's page is opaque and slides its whole width, in from
  // the right when the toggle mounts it.
  useDrawerMotion('workspace-panel', {
    open: shownOpen,
    enabled: mobile,
    hidden: phone ? phonePageWidth : DRAWER_TRAVEL_PX,
    reduced: prefersReducedMotion ?? false,
    slideIn: phone && slideIn,
  })
  const dockMotion = ({ width, isResizing }: LiveWidth) => ({
    // A phone's page has nothing for framer to animate: the drawer driver slides it.
    animate: phone
      ? {}
      : !shownOpen
        ? (mobile ? { opacity: 0 } : { width: 0 })
        : !mobile
          ? { width: overlay ? layout.width : width }
          : { opacity: 1 },
    transition: { duration: !mobile || isResizing || prefersReducedMotion ? 0.01 : DURATIONS_S.base, ease: EASINGS.inOut },
    pinWidth: !mobile && (!open || toggle.running || sliding || maximizeSliding) ? (overlay ? layout.width : width) : undefined,
    instantWidth: !mobile,
    tweenWidth: sliding || maximizeSliding || besideSliding,
  })
  // The toggle is meaningless while a narrow window already forces overlay.
  const maximizeState = mobile || (overlay && !dockMaximized) ? null : dockMaximized

  return {
    parked,
    settleToggle,
    shownOpen,
    sliding,
    dockMaximized,
    overlay,
    dockResize,
    dockMotion,
    maximizeState,
  }
}
