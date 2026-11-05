/**
 * useEdgeSwipe — unified touch-drawer gesture controller for the mobile
 * chat layout.
 *
 * Replaces the two near-identical hand-rolled handler sets that used to
 * live inline in ``AgentChatView`` (left-edge → sidebar, right-edge →
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
 *   - **Drag-follow** — the drawer tracks the finger instead of snapping at
 *     a fixed threshold. The live position goes straight to the drawer's
 *     driver (``lib/drawer-motion``), which writes the DOM: no React state
 *     changes per touchmove, so the chat does not re-render per frame.
 *   - **Velocity / fling** — a fast flick commits with much less travel
 *     than a slow drag, matching native drawer feel. The drawer follows
 *     the finger for the entire gesture and commits only on release; the
 *     release spring keeps the finger's speed.
 *   - **Haptics** — a short tick when a gesture commits.
 *
 * Only active on Tauri iOS/Android shells — desktop pointer swipes are
 * owned by ``useHistorySwipeNavigation`` and must not be hijacked.
 */
import { useCallback, useMemo, useRef } from 'react'
import { usePlatform } from '@/hooks/use-platform'
import { useIsMobile } from '@/hooks/use-mobile'
import { haptic } from '@/lib/haptics'
import { getDrawerMotion } from '@/lib/drawer-motion'

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
  /** Element the touch started on — used to find nested horizontal scrollers. */
  target: EventTarget | null
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

/** px from the screen edge that counts as an edge-start for opening. */
const EDGE_ZONE = 20
/** px of horizontal travel required to commit a *slow* gesture. */
const COMMIT_DISTANCE = 96
/** px/ms flick speed that commits regardless of distance. */
const FLING_VELOCITY = 0.8
/** min travel (px) before a fling is allowed to commit (avoid jitter). */
const FLING_MIN_DISTANCE = 32
/** px move before we lock the axis. */
const AXIS_LOCK_SLOP = 8
/**
 * Horizontal travel must exceed vertical by this factor at the slop point
 * for the gesture to lock as a drawer drag (~34° from horizontal). A
 * thumb scrolling a panel naturally arcs sideways; a laxer rule let those
 * scrolls drag — and fling — the drawer shut. Android's ViewPager uses 2.
 */
const HORIZONTAL_DOMINANCE = 1.5
/** default drawer width (matches CSS ``min(272px, 100vw-2rem)``). */
const DEFAULT_DRAWER_WIDTH = 272
/** A finger that rested this long before lifting has no release speed to carry. */
const VELOCITY_STALE_MS = 80

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

/**
 * True when an element between ``target`` and ``boundary`` (the swipe
 * surface) can still scroll horizontally in the direction the finger is
 * moving — e.g. a wide markdown table or code block inside the Plan panel.
 * That scroller owns the gesture: React's touchmove listener is passive,
 * so ``preventDefault`` can't stop the native scroll, and without this the
 * table scrolls *and* the drawer drags closed at the same time. Once the
 * scroller is pinned at its edge in that direction, the drawer may act.
 */
function canScrollHorizontally(target: EventTarget | null, boundary: EventTarget | null, deltaX: number): boolean {
  let el = target instanceof Element ? target : null
  while (el && el !== boundary) {
    if (el.scrollWidth > el.clientWidth) {
      const { overflowX } = window.getComputedStyle(el)
      // Text fields scroll their own overflowing text without declaring
      // overflow-x (e.g. a long URL in the Preview address bar).
      const isTextField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      if (isTextField || overflowX === 'auto' || overflowX === 'scroll') {
        // Finger moving right reveals content to the left (scrollLeft ↓);
        // finger moving left reveals content to the right (scrollLeft ↑).
        // Math.abs tolerates RTL's negative scrollLeft convention.
        const scrolled = Math.abs(el.scrollLeft)
        const maxScroll = el.scrollWidth - el.clientWidth
        if (deltaX > 0 ? scrolled > 0 : scrolled < maxScroll - 1) return true
      }
    }
    el = el.parentElement
  }
  return false
}

export interface EdgeSwipeHandlers {
  onTouchStart: (event: React.TouchEvent) => void
  onTouchMove: (event: React.TouchEvent) => void
  onTouchEnd: (event?: React.TouchEvent) => void
  onTouchCancel: () => void
}

export interface EdgeSwipeResult {
  handlers: EdgeSwipeHandlers
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

  /**
   * Hand a locked drawer to its release spring: ``goal`` is where it ends
   * (1 open, 0 shut), and the finger's speed (px/ms toward the gesture's
   * target) becomes progress/s. A fling away from the goal starts from rest.
   */
  const settleDrawer = useCallback((state: EdgeSwipeState, goal: number, now: number) => {
    const fresh = now - state.lastT <= VELOCITY_STALE_MS
    const towardTarget = fresh ? (state.velocity * 1000) / drawerWidth : 0
    // An open gesture raises progress as it travels; a close gesture lowers it.
    getDrawerMotion(state.drawerId).settle(goal, state.intent === 'open' ? towardTarget : -towardTarget)
  }, [drawerWidth])

  /** The gesture ended without committing (or was torn up): the drawer returns to where it began. */
  const abandon = useCallback((state: EdgeSwipeState | null, now = performance.now()) => {
    stateRef.current = null
    if (state?.locked && !state.fired) settleDrawer(state, state.intent === 'open' ? 0 : 1, now)
  }, [settleDrawer])

  const onTouchStart = useCallback((event: React.TouchEvent) => {
    stateRef.current = null
    if (!enabled) return
    // Multi-touch (pinch / two-finger pan) is never a drawer swipe.
    if (event.touches.length > 1) return
    if (isSwipeExcluded(event.target)) return
    const touch = event.touches[0]
    if (!touch) return
    const width = window.innerWidth
    const now = event.timeStamp || performance.now()

    const begin = (edge: Edge, drawerId: string, intent: 'open' | 'close') => {
      stateRef.current = {
        edge, drawerId, intent,
        target: event.target,
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
  }, [close, left, right])

  const onTouchMove = useCallback((event: React.TouchEvent) => {
    const state = stateRef.current
    if (!state) return
    // A second finger landing mid-swipe turns it into a pinch — abandon.
    if (event.touches.length > 1) {
      abandon(state)
      return
    }
    const touch = event.touches[0]
    if (!touch) return

    const deltaX = touch.clientX - state.startX
    const deltaY = touch.clientY - state.startY
    const now = event.timeStamp || performance.now()

    // Decide the axis once, on the first move past the slop: lock only a
    // clearly horizontal gesture; anything else belongs to native scroll.
    // React registers touchmove as passive, so the preventDefault below
    // can't stop a scroll — a wrong horizontal lock means the content
    // scrolls *and* the drawer drags.
    if (!state.locked) {
      const absX = Math.abs(deltaX)
      const absY = Math.abs(deltaY)
      if (Math.max(absX, absY) < AXIS_LOCK_SLOP) return
      if (absX < absY * HORIZONTAL_DOMINANCE) {
        stateRef.current = null
        return
      }
      // Horizontal intent — but a nested scroller that can still move in
      // this direction (wide table, code block) owns it, not the drawer.
      if (canScrollHorizontally(state.target, event.currentTarget, deltaX)) {
        stateRef.current = null
        return
      }
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
    }
    state.lastX = touch.clientX
    state.lastT = now

    // ── Drag-follow feedback ──────────────────────────────────────────
    // Hard edges: the finger's travel is clamped to the drawer's width, so
    // the drawer never passes fully open or fully shut. An open drag starts
    // fully hidden and pulls toward open; a close drag the reverse.
    const clampedSigned = Math.max(0, Math.min(drawerWidth, signed))
    const progress = state.intent === 'open'
      ? clampedSigned / drawerWidth
      : 1 - clampedSigned / drawerWidth
    getDrawerMotion(state.drawerId).drag(progress)
    // Once horizontal intent is established, prevent the page from moving
    // beneath the drawer while it tracks the complete finger travel.
    event.preventDefault()
  }, [abandon, drawerWidth])

  const onTouchEnd = useCallback((event?: React.TouchEvent) => {
    const state = stateRef.current
    const now = event?.timeStamp || performance.now()
    if (state && state.locked && !state.fired) {
      const deltaX = state.lastX - state.startX
      const towardOpen = state.edge === 'left' ? deltaX : -deltaX
      const signed = state.intent === 'open' ? towardOpen : -towardOpen
      const flingCommit = state.velocity >= FLING_VELOCITY && signed >= FLING_MIN_DISTANCE
      const distanceCommit = signed >= COMMIT_DISTANCE
      if (flingCommit || distanceCommit) {
        settleDrawer(state, state.intent === 'open' ? 1 : 0, now)
        commit(state)
        return
      }
    }
    abandon(state, now)
  }, [abandon, commit, settleDrawer])

  const onTouchCancel = useCallback(() => {
    abandon(stateRef.current)
  }, [abandon])

  const handlers = useMemo<EdgeSwipeHandlers>(() => ({
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
  }), [onTouchStart, onTouchMove, onTouchEnd, onTouchCancel])

  return { handlers, enabled }
}
