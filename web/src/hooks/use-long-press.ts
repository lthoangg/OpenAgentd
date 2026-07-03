/**
 * useLongPress — shared press-and-hold gesture core.
 *
 * Two call sites need identical timing/tolerance behavior but attach it
 * to different DOM shapes:
 *   - `LongPressButton` (a real `<button>`) — also tracks a `pressing`
 *     boolean for the scale-down visual affordance and fires its own
 *     haptic.
 *   - `useLongPressSurface` (xterm's non-button DOM, e.g. the terminal
 *     viewport) — no visual press state, haptic left to the caller.
 *
 * This hook holds the one piece that must stay identical between them:
 * the 520ms hold threshold, the 10px move-cancel tolerance, and the
 * pointer event plumbing. `onPressChange` is optional so callers that
 * don't need visual press feedback (the terminal surface) don't pay for
 * state they don't use.
 */
import { useCallback, useRef } from 'react'
import type React from 'react'

export const LONG_PRESS_MS = 520
export const LONG_PRESS_MOVE_TOLERANCE = 10

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

  const clear = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    startRef.current = null
    onPressChange?.(false)
  }, [onPressChange])

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled || event.pointerType === 'mouse') return
      startRef.current = { x: event.clientX, y: event.clientY }
      onPressChange?.(true)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        startRef.current = null
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
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (event: React.MouseEvent) => {
      if (enabled) event.preventDefault()
    },
  }
}
