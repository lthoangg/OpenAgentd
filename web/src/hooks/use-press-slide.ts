/**
 * usePressSlide — press, slide, and release to pick (iOS's menu gesture).
 *
 * A touch that lands in the container follows the finger across its targets
 * (elements with ``data-slide-id``): ``active`` is the one under the finger,
 * and lifting reports it to ``onRelease`` (``null`` off every target). The
 * targets are found again on each move, so ones that appear mid-gesture (a
 * menu that opens on a hold) can be picked in the same motion.
 *
 * A hold (``LONG_PRESS_MS`` without moving past ``LONG_PRESS_MOVE_TOLERANCE``)
 * calls ``onHold`` with the target it started on, when ``canHold`` allows.
 *
 * Only touch and pen go through here: a mouse and a keyboard keep the
 * buttons' own clicks. The click a touch release raises afterwards is
 * swallowed, since the release already did the work.
 */
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { LONG_PRESS_MOVE_TOLERANCE, LONG_PRESS_MS } from '@/hooks/use-long-press'

export interface PressSlideRelease {
  /** The finger went past the move tolerance at some point. */
  moved: boolean
  /** A hold fired during this press. */
  held: boolean
}

export interface PressSlideOptions {
  /** The target under the finger changed (``null`` off every target). */
  onChange?: (id: string | null) => void
  /** The finger lifted over ``id`` (``null`` off every target). */
  onRelease: (id: string | null, info: PressSlideRelease) => void
  /** The touch was taken away (a system gesture, a call). */
  onCancel?: () => void
  /** A press held still on ``id``; only when ``canHold(id)`` says so. */
  onHold?: (id: string | null) => void
  canHold?: (id: string | null) => boolean
}

export interface PressSlideHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void
}

/** The ``data-slide-id`` target under a point inside ``container``. */
export function slideTargetAt(container: HTMLElement, x: number, y: number): string | null {
  for (const element of container.querySelectorAll<HTMLElement>('[data-slide-id]')) {
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return element.dataset.slideId ?? null
    }
  }
  return null
}

export function usePressSlide(options: PressSlideOptions): { active: string | null; handlers: PressSlideHandlers } {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [active, setActive] = useState<string | null>(null)
  const press = useRef<{
    pointerId: number
    container: HTMLElement
    x: number
    y: number
    active: string | null
    moved: boolean
    held: boolean
  } | null>(null)
  const holdTimer = useRef<number | null>(null)
  const swallowClick = useRef<number | null>(null)

  const clearHold = () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = null
  }
  useEffect(() => () => {
    clearHold()
    if (swallowClick.current !== null) window.clearTimeout(swallowClick.current)
  }, [])

  const point = (id: string | null) => {
    const current = press.current
    if (!current || current.active === id) return
    current.active = id
    setActive(id)
    optionsRef.current.onChange?.(id)
  }

  const end = () => {
    clearHold()
    press.current = null
    setActive(null)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' || press.current) return
    const container = event.currentTarget
    const id = slideTargetAt(container, event.clientX, event.clientY)
    press.current = { pointerId: event.pointerId, container, x: event.clientX, y: event.clientY, active: null, moved: false, held: false }
    // Keep the moves coming here even once the finger leaves the container.
    try { container.setPointerCapture?.(event.pointerId) } catch { /* not capturable */ }
    point(id)
    const { onHold, canHold } = optionsRef.current
    if (onHold && (canHold?.(id) ?? true)) {
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null
        const current = press.current
        if (!current) return
        current.held = true
        optionsRef.current.onHold?.(current.active)
      }, LONG_PRESS_MS)
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const current = press.current
    if (!current || event.pointerId !== current.pointerId) return
    if (
      !current.moved &&
      (Math.abs(event.clientX - current.x) > LONG_PRESS_MOVE_TOLERANCE ||
        Math.abs(event.clientY - current.y) > LONG_PRESS_MOVE_TOLERANCE)
    ) {
      current.moved = true
      clearHold()
    }
    point(slideTargetAt(current.container, event.clientX, event.clientY))
  }

  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const current = press.current
    if (!current || event.pointerId !== current.pointerId) return
    const id = slideTargetAt(current.container, event.clientX, event.clientY)
    const info = { moved: current.moved, held: current.held }
    end()
    // The release did the work; the click it raises next must not again.
    if (swallowClick.current !== null) window.clearTimeout(swallowClick.current)
    swallowClick.current = window.setTimeout(() => { swallowClick.current = null }, 600)
    optionsRef.current.onRelease(id, info)
  }

  const onPointerCancel = (event: React.PointerEvent<HTMLElement>) => {
    const current = press.current
    if (!current || event.pointerId !== current.pointerId) return
    end()
    optionsRef.current.onCancel?.()
  }

  const onClickCapture = (event: React.MouseEvent<HTMLElement>) => {
    if (swallowClick.current === null) return
    window.clearTimeout(swallowClick.current)
    swallowClick.current = null
    event.preventDefault()
    event.stopPropagation()
  }

  // A held touch can raise the system's context menu (Android); the hold is ours.
  const onContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    if (press.current) event.preventDefault()
  }

  return { active, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture, onContextMenu } }
}
