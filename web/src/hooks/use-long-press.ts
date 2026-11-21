/**
 * useLongPress — shared press-and-hold gesture core.
 *
 * Every press-and-hold in the app has the same timing and tolerance:
 * `LongPressButton` (a real `<button>`, which also tracks a `pressing`
 * boolean for the scale-down affordance), rows and bubbles that call this
 * hook directly, and the terminal surface's gestures (`use-terminal-touch`),
 * which read the two constants below.
 *
 * This hook holds the one piece that must stay identical between them: the
 * 520ms hold threshold, the 10px move-cancel tolerance, and the pointer
 * event plumbing. `onPressChange` is optional so callers that don't need
 * visual press feedback don't pay for state they don't use.
 */
import { useCallback, useRef } from 'react'
import type React from 'react'

export const LONG_PRESS_MS = 520
export const LONG_PRESS_MOVE_TOLERANCE = 10
/** How long the click a touch release raises may take to arrive. */
const RELEASE_CLICK_MS = 600

/**
 * Swallow the click a touch release raises, wherever it lands, until the
 * next press. After a hold the release's click goes to whatever the hold
 * put under the finger (a row of the sheet it opened), and Chromium sends
 * it there; a press is a new tap and ends the swallow, so a real tap always
 * goes through. Returns the function that ends it early.
 */
export function swallowReleaseClick(): () => void {
  const swallow = (click: MouseEvent) => {
    stop()
    click.preventDefault()
    click.stopPropagation()
  }
  const timer = window.setTimeout(() => stop(), RELEASE_CLICK_MS)
  function stop() {
    window.clearTimeout(timer)
    document.removeEventListener('click', swallow, true)
    document.removeEventListener('pointerdown', stop, true)
  }
  document.addEventListener('click', swallow, true)
  document.addEventListener('pointerdown', stop, true)
  return stop
}

export interface LongPressHandlers {
  onPointerDown: (event: React.PointerEvent) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerUp: (event: React.PointerEvent) => void
  onPointerCancel: (event: React.PointerEvent) => void
  onPointerLeave: (event: React.PointerEvent) => void
  onContextMenu: (event: React.MouseEvent) => void
}

export function useLongPress(
  enabled: boolean,
  onLongPress: () => void,
  onPressChange?: (pressing: boolean) => void,
): LongPressHandlers {
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  // The hold fired during this press: its release's click is not a tap.
  const firedRef = useRef(false)

  const clear = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    startRef.current = null
    firedRef.current = false
    onPressChange?.(false)
  }, [onPressChange])

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled || event.pointerType === 'mouse') return
      startRef.current = { x: event.clientX, y: event.clientY }
      firedRef.current = false
      onPressChange?.(true)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        startRef.current = null
        firedRef.current = true
        onPressChange?.(false)
        onLongPress()
      }, LONG_PRESS_MS)
    },
    [enabled, onLongPress, onPressChange],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const start = startRef.current
      if (!start) return
      if (
        Math.abs(event.clientX - start.x) > LONG_PRESS_MOVE_TOLERANCE ||
        Math.abs(event.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE
      ) {
        clear()
      }
    },
    [clear],
  )

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: () => {
      if (firedRef.current) swallowReleaseClick()
      clear()
    },
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (event: React.MouseEvent) => {
      if (enabled) event.preventDefault()
    },
  }
}
