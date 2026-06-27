/**
 * useEdgeSwipe — unified touch-drawer gesture controller for the mobile
 * chat layout.
 *
 * Replaces the two near-identical hand-rolled handler sets that used to
 * live inline in ``TeamChatView`` (left-edge → sidebar, right-edge →
 * actions). Those each tracked only their *own* drawer's open state, so
 * an edge swipe could fire while the *opposite* drawer was already open,
 * letting both drawers stack on screen at once.
 *
 * This hook centralises the rule: **at most one drawer open at a time.**
 *
 *   - An *open* gesture (swipe inward from an edge) is ignored unless
 *     ``activeDrawer === null``.
 *   - A *close* gesture (swipe back toward the owning edge) only acts on
 *     the currently-open drawer.
 *
 * Beyond the open/close decision it provides:
 *   - **Drag-follow** — a live ``drag`` descriptor (which drawer, which
 *     edge, signed pixel offset) so the drawer tracks the finger instead
 *     of snapping at a fixed threshold.
 *   - **Velocity / fling** — a fast flick commits with much less travel
 *     than a slow drag, matching native drawer feel.
 *   - **Haptics** — a short tick when a gesture commits.
 *
 * Only active on Tauri iOS/Android shells — desktop pointer swipes are
 * owned by ``useHistorySwipeNavigation`` and must not be hijacked.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { usePlatform } from '@/hooks/use-platform'
import { useIsMobile } from '@/hooks/use-mobile'
import { haptic } from '@/lib/haptics'

/** Identifier for whichever drawer is currently open (or null). */
export type DrawerId = string | null

/** Which screen edge a drawer is anchored to. */
export type Edge = 'left' | 'right'

interface DrawerSpec {
  id: string
  open: () => void
}

interface EdgeSwipeOptions {
  /** The drawer currently open, or null when the layout is at rest. */
  activeDrawer: DrawerId
  /** Drawer opened by an inward swipe from the left edge. */
  left?: DrawerSpec
  /** Drawer opened by an inward swipe from the right edge. */
  right?: DrawerSpec
  /** Close the currently-open drawer (any of them). */
  close: () => void
  /** Drawer track width in px used to normalise/clamp drag. */
  drawerWidth?: number
}

interface EdgeSwipeState {
  edge: Edge
  drawerId: string
  startX: number
  startY: number
  /** 'open' = edge→inward to reveal; 'close' = inward→edge to dismiss. */
  intent: 'open' | 'close'
  /** True once the gesture has committed to horizontal (locks scroll). */
  locked: boolean
  /** Whether the commit action already fired (prevents double-trigger). */
  fired: boolean
  /** Last sample for velocity estimation. */
  lastX: number
  lastT: number
  /** px/ms toward the gesture's target direction (positive = committing). */
  velocity: number
}

/**
 * Live drag descriptor surfaced to consumers so a drawer can follow the
 * finger. ``offset`` is signed in CSS-x terms (negative pulls a left
 * drawer toward its hidden position, positive pushes a right drawer out).
 */
export interface EdgeSwipeDrag {
  drawerId: string
  edge: Edge
  intent: 'open' | 'close'
  /** Signed x offset in px to apply on top of the drawer's resting x. */
  offset: number
  /** 0..1 reveal progress (1 = fully open). */
  progress: number
}

/** px from the screen edge that counts as an edge-start for opening. */
const EDGE_ZONE = 16
/** px of horizontal travel required to commit a *slow* gesture. */
const COMMIT_DISTANCE = 96
/** px/ms flick speed that commits regardless of distance. */
const FLING_VELOCITY = 0.8
/** min travel (px) before a fling is allowed to commit (avoid jitter). */
const FLING_MIN_DISTANCE = 32
/** px move before we lock the axis. */
const AXIS_LOCK_SLOP = 8
/** default drawer width (matches CSS ``min(272px, 100vw-2rem)``). */
const DEFAULT_DRAWER_WIDTH = 272

/**
 * Elements that own their own horizontal drag (toasts, carousels, range
 * inputs, etc.) opt out of edge-swipe by carrying ``data-swipe-ignore``
 * or being a native interactive control. Starting an edge gesture on one
 * of these would fight the element's own gesture, so we skip it.
 */
function isSwipeExcluded(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest('[data-swipe-ignore], input[type="range"]') !== null
}

export interface EdgeSwipeHandlers {
  onTouchStart: (event: React.TouchEvent) => void
  onTouchMove: (event: React.TouchEvent) => void
  onTouchEnd: () => void
  onTouchCancel: () => void
}

export interface EdgeSwipeResult {
  handlers: EdgeSwipeHandlers
  /** Live drag descriptor for the drawer under the finger, or null. */
  drag: EdgeSwipeDrag | null
  /** True only on a Tauri mobile shell where these gestures apply. */
  enabled: boolean
}

export function useEdgeSwipe({
  activeDrawer,
  left,
  right,
  close,
  drawerWidth = DEFAULT_DRAWER_WIDTH,
}: EdgeSwipeOptions): EdgeSwipeResult {
  const { os } = usePlatform()
  const isMobile = useIsMobile()
  const enabled = isMobile && (os === 'ios' || os === 'android')

  const stateRef = useRef<EdgeSwipeState | null>(null)
  const [drag, setDrag] = useState<EdgeSwipeDrag | null>(null)

  const clearDrag = useCallback(() => setDrag(null), [])

  const onTouchStart = useCallback((event: React.TouchEvent) => {
    stateRef.current = null
    if (!enabled) return
    if (isSwipeExcluded(event.target)) return
    const touch = event.touches[0]
    if (!touch) return
    const width = window.innerWidth
    const now = event.timeStamp || performance.now()

    const begin = (edge: Edge, drawerId: string, intent: 'open' | 'close') => {
      stateRef.current = {
        edge, drawerId, intent,
        startX: touch.clientX,
        startY: touch.clientY,
        locked: false,
        fired: false,
        lastX: touch.clientX,
        lastT: now,
        velocity: 0,
      }
    }

    // A drawer is open → only a *close* gesture (swipe back toward its
    // owning edge) is allowed. Any inward open gesture is suppressed so
    // two drawers can never coexist.
    if (activeDrawer !== null) {
      if (left && activeDrawer === left.id) begin('left', left.id, 'close')
      else if (right && activeDrawer === right.id) begin('right', right.id, 'close')
      return
    }

    // Nothing open → an edge-start can begin an open gesture.
    if (left && touch.clientX <= EDGE_ZONE) begin('left', left.id, 'open')
    else if (right && width - touch.clientX <= EDGE_ZONE) begin('right', right.id, 'open')
  }, [activeDrawer, enabled, left, right])

  const commit = useCallback((state: EdgeSwipeState) => {
    state.fired = true
    haptic('tick')
    if (state.intent === 'open') {
      if (state.edge === 'left') left?.open()
      else right?.open()
    } else {
      close()
    }
    stateRef.current = null
    clearDrag()
  }, [close, left, right, clearDrag])

  const onTouchMove = useCallback((event: React.TouchEvent) => {
    const state = stateRef.current
    if (!state) return
    const touch = event.touches[0]
    if (!touch) return

    const deltaX = touch.clientX - state.startX
    const deltaY = touch.clientY - state.startY
    const now = event.timeStamp || performance.now()

    // Lock to horizontal on first meaningful move; bail to scroll if the
    // gesture has vertical dominance.
    if (!state.locked) {
      if (Math.abs(deltaY) > 15 && Math.abs(deltaY) > Math.abs(deltaX) * 0.5) {
        stateRef.current = null
        clearDrag()
        return
      }
      if (Math.abs(deltaX) < AXIS_LOCK_SLOP) return
      state.locked = true
    }

    // Signed travel "toward committing the gesture":
    //   left edge open  = +x ;  left edge close  = -x
    //   right edge open = -x ;  right edge close = +x
    const towardOpen = state.edge === 'left' ? deltaX : -deltaX
    const signed = state.intent === 'open' ? towardOpen : -towardOpen

    // Velocity (px/ms) in the committing direction, EMA-smoothed.
    const dt = now - state.lastT
    if (dt >= 4) {
      const instX = (touch.clientX - state.lastX) / dt
      const instSigned = state.edge === 'left'
        ? (state.intent === 'open' ? instX : -instX)
        : (state.intent === 'open' ? -instX : instX)
      state.velocity = state.velocity * 0.7 + instSigned * 0.3
      state.lastX = touch.clientX
      state.lastT = now
    }

    // ── Drag-follow feedback ──────────────────────────────────────────
    // Resting x for the drawer: open drawers rest at 0; for a close drag
    // we start from fully-open and pull toward hidden. For an open drag
    // we start from fully-hidden and pull toward 0.
    const clampedSigned = Math.max(0, Math.min(drawerWidth, signed))
    const progress = state.intent === 'open'
      ? clampedSigned / drawerWidth
      : 1 - clampedSigned / drawerWidth
    // Offset to apply on top of resting x=0 (drawer fully open).
    // left drawer hides at -drawerWidth, right drawer hides at +drawerWidth.
    const hidden = state.edge === 'left' ? -drawerWidth : drawerWidth
    const offset = hidden * (1 - progress)

    setDrag({ drawerId: state.drawerId, edge: state.edge, intent: state.intent, offset, progress })

    if (state.fired) return

    const flingCommit = state.velocity >= FLING_VELOCITY && signed >= FLING_MIN_DISTANCE
    const distanceCommit = signed >= COMMIT_DISTANCE
    if (flingCommit || distanceCommit) {
      event.preventDefault()
      commit(state)
    }
  }, [clearDrag, commit, drawerWidth])

  const onTouchEnd = useCallback(() => {
    stateRef.current = null
    clearDrag()
  }, [clearDrag])

  const handlers = useMemo<EdgeSwipeHandlers>(() => ({
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel: onTouchEnd,
  }), [onTouchStart, onTouchMove, onTouchEnd])

  return { handlers, drag, enabled }
}
