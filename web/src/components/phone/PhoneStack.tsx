/**
 * PhoneStack — the phone's navigation stack, two levels deep: a root screen
 * (Sessions) with one page pushed over it (a chat), as UINavigationController
 * draws it.
 *
 * Both layers stay mounted, so popping back to Sessions keeps its scroll and
 * pushing a chat does not remount the transcript. ``pushed`` comes from the
 * route; the stack only animates toward it. A push slides the page in from
 * the right while the root drifts a third of the way left under a dimming
 * scrim (iOS's parallax); a pop reverses it.
 *
 * Back is by level, not by history: the ‹ button, a swipe from the left edge
 * and Android Back all call ``onBack``, which routes to the parent. The edge
 * swipe follows the finger exactly (``SpringValue`` writes ``translate``
 * straight to the DOM, so the transcript never re-renders per frame) and on
 * release springs on with the finger's speed: past a third of the width or a
 * flick pops, otherwise the page springs back.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react'

import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useBackHandler } from '@/lib/back-button'
import { SpringValue } from '@/lib/drawer-motion'

/** px from the left screen edge where a back swipe may start (iOS: ~20). */
export const EDGE_ZONE = 24
/** px of travel before the axis locks. */
const AXIS_LOCK_SLOP = 8
/** Horizontal travel must beat vertical by this much to be a back swipe (as use-edge-swipe). */
const HORIZONTAL_DOMINANCE = 1.5
/** Fraction of the width past which a slow release pops. */
const COMMIT_FRACTION = 1 / 3
/** px/ms: a flick this fast pops whatever the distance. */
const FLING_VELOCITY = 0.5
/** A flick still needs this much travel, so a tap's jitter never pops. */
const FLING_MIN_DISTANCE = 32
/** How far (fraction of the width) the root drifts left under a pushed page. */
const PARALLAX = 0.3
/** Scrim strength over the root at full push. */
const SCRIM = 0.12

export interface PhoneStackProps {
  root: ReactNode
  page: ReactNode
  /** A page is pushed over the root (the route says so). */
  pushed: boolean
  /** Route to the parent: the ‹ button, the edge swipe and Android Back. */
  onBack: () => void
  /** Edge swipe and Android Back may pop; off while a sheet or overlay is up. */
  backEnabled?: boolean
}

interface Drag {
  startX: number
  startY: number
  width: number
  axis: 'pending' | 'x' | 'y'
  dx: number
  lastX: number
  lastT: number
  velocity: number
}

export function PhoneStack({ root, page, pushed, onBack, backEnabled = true }: PhoneStackProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion() === true
  // Which layer is at rest on top, for ``inert`` and hiding the covered
  // page. Only the two ends set state; frames in between write the DOM.
  const [settled, setSettled] = useState<0 | 1>(pushed ? 1 : 0)
  const settledRef = useRef(settled)
  const drag = useRef<Drag | null>(null)

  // Created once; ``pushed`` only seeds where it starts.
  const [spring] = useState(
    () =>
      new SpringValue(
        (progress) => {
          const pageEl = pageRef.current
          const rootEl = rootRef.current
          if (pageEl) pageEl.style.translate = progress >= 1 ? '' : `${(1 - progress) * 100}% 0`
          if (rootEl) rootEl.style.translate = progress <= 0 ? '' : `${-PARALLAX * progress * 100}% 0`
          if (scrimRef.current) scrimRef.current.style.opacity = String(progress * SCRIM)
          const end = progress >= 1 ? 1 : progress <= 0 ? 0 : null
          if (end !== null && end !== settledRef.current) {
            settledRef.current = end
            setSettled(end)
          }
        },
        { initial: pushed ? 1 : 0, min: 0, max: 1 },
      ),
  )

  useLayoutEffect(() => {
    spring.set(spring.value)
    return () => spring.cancel()
  }, [spring])

  useEffect(() => {
    spring.reduced = reduced
  }, [spring, reduced])

  // The route moved: animate to it, unless the finger is still on the page.
  useEffect(() => {
    if (drag.current?.axis === 'x') return
    spring.settle(pushed ? 1 : 0)
  }, [spring, pushed])

  useBackHandler(pushed && backEnabled, onBack)

  const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (!pushed || !backEnabled || event.touches.length !== 1) return
    const touch = event.touches[0]
    if (touch.clientX > EDGE_ZONE) return
    const width = pageRef.current?.getBoundingClientRect().width || window.innerWidth
    drag.current = { startX: touch.clientX, startY: touch.clientY, width, axis: 'pending', dx: 0, lastX: touch.clientX, lastT: event.timeStamp, velocity: 0 }
  }

  const onTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.axis === 'y') return
    const touch = event.touches[0]
    const dx = touch.clientX - state.startX
    const dy = touch.clientY - state.startY
    if (state.axis === 'pending') {
      if (Math.hypot(dx, dy) < AXIS_LOCK_SLOP) return
      state.axis = dx > 0 && Math.abs(dx) > HORIZONTAL_DOMINANCE * Math.abs(dy) ? 'x' : 'y'
      if (state.axis === 'y') return
    }
    const dt = event.timeStamp - state.lastT
    if (dt > 0) state.velocity = (touch.clientX - state.lastX) / dt
    state.lastX = touch.clientX
    state.lastT = event.timeStamp
    state.dx = Math.max(0, dx)
    spring.set(1 - state.dx / state.width)
  }

  const onTouchEnd = () => {
    const state = drag.current
    drag.current = null
    if (!state || state.axis !== 'x') return
    // px/ms of the finger → progress/s of the page (rightwards lowers it).
    const velocity = (-state.velocity * 1000) / state.width
    const flung = state.velocity > FLING_VELOCITY && state.dx > FLING_MIN_DISTANCE
    if (flung || state.dx > state.width * COMMIT_FRACTION) {
      spring.settle(0, velocity)
      onBack()
    } else {
      spring.settle(1, velocity)
    }
  }

  const atRoot = settled === 0 && !pushed
  return (
    <div data-phone-stack="" className="relative h-full w-full overflow-hidden">
      <div ref={rootRef} data-phone-stack-root="" inert={pushed && settled === 1} aria-hidden={pushed && settled === 1 ? true : undefined} className="absolute inset-0">
        {root}
        <div ref={scrimRef} aria-hidden="true" className="pointer-events-none absolute inset-0 bg-(--color-overlay) opacity-0" />
      </div>
      <div
        ref={pageRef}
        data-phone-stack-page=""
        inert={!pushed}
        aria-hidden={!pushed ? true : undefined}
        className={atRoot ? 'invisible absolute inset-0' : 'absolute inset-0 bg-(--bg-page) shadow-(--shadow-depth)'}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        {page}
      </div>
    </div>
  )
}
