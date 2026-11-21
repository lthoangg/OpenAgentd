/**
 * useTerminalTouch — every finger on the terminal surface, on touch screens.
 *
 * xterm.js 6 handles no touch at all (xtermjs/xterm.js#5489: a drag does not
 * scroll), so this hook owns the surface's touches, as Termius does:
 *
 * - drag: scroll, with a fling (``terminal-touch-scroll.ts``);
 * - hold, then release: the terminal menu (``onMenu``);
 * - hold, then drag: arrow keys toward the finger, repeating faster the
 *   farther it goes;
 * - double tap: Tab;
 * - pinch: the terminal's text size, kept on this device.
 *
 * A single tap is left alone: xterm focuses its input and the soft keyboard
 * comes up. The gesture is one machine (``terminal-touch-state.ts``) held in
 * a ref, so a finger's moves never re-render the view. The surface needs
 * ``touch-action: none`` so the webview does not scroll or zoom under it.
 */
import { useEffect, useRef, type RefObject } from 'react'

import { LONG_PRESS_MS, swallowReleaseClick } from '@/hooks/use-long-press'
import { haptic, mediumHapticFeedback } from '@/lib/haptics'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { getTerminalRuntime, useTerminalStore } from '@/stores/useTerminalStore'
import {
  ARROW_SEQUENCES,
  arrowStep,
  isDoubleTap,
  TOUCH_IDLE,
  terminalTouchMachine,
  type Tap,
  type TouchGesture,
  type TouchGestureEvent,
} from './terminal-touch-state'
import { cellHeight, lineAccumulator, scrollTerminal, startMomentum } from './terminal-touch-scroll'

interface Options {
  enabled: boolean
  sessionId: string
  surfaceRef: RefObject<HTMLElement | null>
  /** A hold released in place: open the terminal menu. */
  onMenu: () => void
}

export function useTerminalTouch({ enabled, sessionId, surfaceRef, onMenu }: Options): void {
  const touchGesture = useRef<TouchGesture>(TOUCH_IDLE)
  const onMenuRef = useRef(onMenu)
  useEffect(() => {
    onMenuRef.current = onMenu
  }, [onMenu])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!enabled || !surface) return

    const pointers = new Map<number, { x: number; y: number }>()
    let holdTimer: number | null = null
    let arrowTimer: number | null = null
    let stopMomentum: () => void = () => {}
    let lastTap: Tap | null = null
    let last = { x: 0, y: 0 }

    const term = () => getTerminalRuntime(sessionId)?.handle?.term
    const send = (data: string) => useTerminalStore.getState().sendInput(sessionId, data)
    const lines = lineAccumulator(() => {
      const t = term()
      return t ? cellHeight(t) : 16
    })
    const scroll = (px: number) => {
      const t = term()
      if (t) scrollTerminal(t, lines(px), last)
    }

    const move = (event: TouchGestureEvent): [TouchGesture, TouchGesture] => {
      const prev = touchGesture.current
      touchGesture.current = terminalTouchMachine.transition(prev, event)
      return [prev, touchGesture.current]
    }

    const clearHold = () => {
      if (holdTimer !== null) window.clearTimeout(holdTimer)
      holdTimer = null
    }
    const stopArrows = () => {
      if (arrowTimer !== null) window.clearTimeout(arrowTimer)
      arrowTimer = null
    }
    // One key now, then again at the gear the finger's distance picks.
    const repeatArrow = () => {
      arrowTimer = null
      const state = touchGesture.current
      if (state.kind !== 'arrows') return
      const step = arrowStep(state.dx, state.dy)
      if (step) send(ARROW_SEQUENCES[step.key])
      arrowTimer = window.setTimeout(repeatArrow, step?.interval ?? 50)
    }

    const spread = () => {
      const [a, b] = [...pointers.values()]
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
    }

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return
      stopMomentum()
      // The primary pointer starts a gesture with no other finger down. A
      // finger whose lift never reached the surface (a sheet or the webview
      // took it) must not turn this press into a pinch.
      if (event.isPrimary && pointers.size > 0) {
        pointers.clear()
        clearHold()
        stopArrows()
        if (touchGesture.current.kind !== 'idle') move({ type: 'cancel' })
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size === 1) {
        last = { x: event.clientX, y: event.clientY }
        move({ type: 'down', x: event.clientX, y: event.clientY, t: event.timeStamp })
        clearHold()
        holdTimer = window.setTimeout(() => {
          holdTimer = null
          const [, next] = move({ type: 'hold' })
          if (next.kind === 'held') mediumHapticFeedback()
        }, LONG_PRESS_MS)
      } else if (pointers.size === 2) {
        clearHold()
        const font = term()?.options.fontSize ?? 13
        move({ type: 'pinch', distance: spread(), font })
      }
    }

    const onMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touchGesture.current.kind === 'idle') return
      if (touchGesture.current.kind === 'pinching') {
        if (pointers.size < 2) return
        const [prev, next] = move({ type: 'spread', distance: spread() })
        if (prev.kind === 'pinching' && next.kind === 'pinching' && next.font !== prev.font) {
          // Whole px only, so the shell hears of a resize a handful of times.
          useTerminalStore.getState().syncFontSize(next.font)
        }
        return
      }
      last = { x: event.clientX, y: event.clientY }
      const [prev, next] = move({ type: 'move', x: event.clientX, y: event.clientY, t: event.timeStamp })
      if (next.kind === 'scrolling') {
        clearHold()
        if (prev.kind === 'scrolling') scroll(next.y - prev.y)
      } else if (next.kind === 'arrows' && prev.kind === 'held') {
        haptic('tick')
        repeatArrow()
      }
    }

    const onEnd = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return
      if (pointers.size > 0) return
      clearHold()
      stopArrows()
      const cancelled = event.type === 'pointercancel'
      const [prev] = move(cancelled ? { type: 'cancel' } : { type: 'up' })
      // A browser may take a still hold for its own long press and cancel the
      // pointer (Chromium does): the hold was ours, so the menu still opens.
      // The pinch's size is already on screen; it is kept either way.
      if (cancelled && prev.kind !== 'held' && prev.kind !== 'pinching') return
      if (prev.kind === 'pressed') {
        const tap = { x: event.clientX, y: event.clientY, t: event.timeStamp }
        if (isDoubleTap(lastTap, tap)) {
          lastTap = null
          haptic('tick')
          send('\t')
        } else {
          lastTap = tap
        }
      } else if (prev.kind === 'held') {
        swallowReleaseClick()
        onMenuRef.current()
      } else if (prev.kind === 'arrows') {
        swallowReleaseClick()
      } else if (prev.kind === 'scrolling') {
        stopMomentum = startMomentum(prev.velocity, scroll)
      } else if (prev.kind === 'pinching') {
        useDisplayPrefsStore.getState().setTerminalFontPx(prev.font)
      }
    }

    surface.addEventListener('pointerdown', onDown)
    surface.addEventListener('pointermove', onMove)
    surface.addEventListener('pointerup', onEnd)
    surface.addEventListener('pointercancel', onEnd)
    return () => {
      surface.removeEventListener('pointerdown', onDown)
      surface.removeEventListener('pointermove', onMove)
      surface.removeEventListener('pointerup', onEnd)
      surface.removeEventListener('pointercancel', onEnd)
      clearHold()
      stopArrows()
      stopMomentum()
      if (touchGesture.current.kind !== 'idle') move({ type: 'cancel' })
    }
  }, [enabled, sessionId, surfaceRef])
}
