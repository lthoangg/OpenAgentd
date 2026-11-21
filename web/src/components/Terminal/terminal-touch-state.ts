import { defineMachine } from '@/lib/machine'
import { LONG_PRESS_MOVE_TOLERANCE } from '@/hooks/use-long-press'

/**
 * The touch gesture on the terminal surface (``use-terminal-touch.ts``).
 * xterm.js 6 has no touch handling of its own (xtermjs/xterm.js#5489), so
 * every finger on the terminal goes through this one machine:
 *
 * - ``pressed``: a finger is down and has not decided yet.
 * - ``scrolling``: it moved before the hold time; the output scrolls with it.
 * - ``held``: it stayed still for the hold time. Released there, the menu
 *   opens; moved, it becomes ``arrows``.
 * - ``arrows``: a held finger dragged; arrow keys repeat toward it, faster
 *   the farther it is from where the hold began.
 * - ``pinching``: a second finger came down; the spread sets the text size.
 *
 * The hold timer, the arrow repeat, the scroll's momentum and the double tap
 * are effects the hook runs around these moves.
 */
export type TouchGesture =
  | { kind: 'idle' }
  | { kind: 'pressed'; x0: number; y0: number; t0: number }
  /** ``y``/``t``: the last sample; ``velocity``: px per ms, downward positive. */
  | { kind: 'scrolling'; y: number; t: number; velocity: number }
  | { kind: 'held'; x0: number; y0: number }
  | { kind: 'arrows'; x0: number; y0: number; dx: number; dy: number }
  /** ``distance0``/``font0``: the spread and size as the pinch began. */
  | { kind: 'pinching'; distance0: number; font0: number; font: number }

export type TouchGestureEvent =
  | { type: 'down'; x: number; y: number; t: number }
  | { type: 'move'; x: number; y: number; t: number }
  | { type: 'hold' }
  | { type: 'up' }
  | { type: 'cancel' }
  /** A second finger: ``distance`` between the two, ``font`` the size now. */
  | { type: 'pinch'; distance: number; font: number }
  | { type: 'spread'; distance: number }

export const TOUCH_IDLE: TouchGesture = { kind: 'idle' }

export const TERMINAL_FONT_MIN = 10
export const TERMINAL_FONT_MAX = 20

const beyond = (dx: number, dy: number) => Math.abs(dx) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(dy) > LONG_PRESS_MOVE_TOLERANCE

const pinch = (_: TouchGesture, e: { distance: number; font: number }): TouchGesture =>
  ({ kind: 'pinching', distance0: Math.max(1, e.distance), font0: e.font, font: e.font })

export const terminalTouchMachine = defineMachine<TouchGesture, TouchGestureEvent>('terminal touch', {
  idle: {
    down: (_, e) => ({ kind: 'pressed', x0: e.x, y0: e.y, t0: e.t }),
    // A hold timer that fired as the finger lifted: nothing is pressed now.
    hold: (s) => s,
  },
  pressed: {
    move: (s, e) => (beyond(e.x - s.x0, e.y - s.y0) ? { kind: 'scrolling', y: e.y, t: e.t, velocity: 0 } : s),
    hold: (s) => ({ kind: 'held', x0: s.x0, y0: s.y0 }),
    up: () => TOUCH_IDLE,
    cancel: () => TOUCH_IDLE,
    pinch,
  },
  scrolling: {
    move: (s, e) => {
      const dt = Math.max(1, e.t - s.t)
      // Smoothed, so one jittery sample does not decide the fling.
      const velocity = 0.8 * ((e.y - s.y) / dt) + 0.2 * s.velocity
      return { kind: 'scrolling', y: e.y, t: e.t, velocity }
    },
    up: () => TOUCH_IDLE,
    cancel: () => TOUCH_IDLE,
    pinch,
  },
  held: {
    move: (s, e) => (beyond(e.x - s.x0, e.y - s.y0) ? { kind: 'arrows', x0: s.x0, y0: s.y0, dx: e.x - s.x0, dy: e.y - s.y0 } : s),
    up: () => TOUCH_IDLE,
    cancel: () => TOUCH_IDLE,
    pinch,
  },
  arrows: {
    move: (s, e) => ({ ...s, dx: e.x - s.x0, dy: e.y - s.y0 }),
    up: () => TOUCH_IDLE,
    cancel: () => TOUCH_IDLE,
    // A second finger while keys repeat is a slip, not a pinch.
    pinch: (s) => s,
  },
  pinching: {
    spread: (s, e) => ({ ...s, font: pinchFont(s.font0, e.distance / s.distance0) }),
    // The other finger's moves are the spread's; a third finger changes nothing.
    move: (s) => s,
    down: (s) => s,
    pinch: (s) => s,
    up: () => TOUCH_IDLE,
    cancel: () => TOUCH_IDLE,
  },
})

/** The text size for a pinch that scaled the spread by ``scale``, whole px within the limits. */
export function pinchFont(font0: number, scale: number): number {
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(font0 * scale)))
}

export type ArrowKey = 'up' | 'down' | 'left' | 'right'

export const ARROW_SEQUENCES: Record<ArrowKey, string> = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
}

/** Repeat interval (ms) by how far the finger is from the hold: three gears. */
const GEARS: Array<[number, number]> = [[30, 300], [80, 120], [Infinity, 50]]

/**
 * The arrow a drag of ``dx``/``dy`` from the hold sends and how often: along
 * the axis it moved most, ``null`` while it is still within the tolerance.
 */
export function arrowStep(dx: number, dy: number): { key: ArrowKey; interval: number } | null {
  if (!beyond(dx, dy)) return null
  const horizontal = Math.abs(dx) >= Math.abs(dy)
  const distance = horizontal ? Math.abs(dx) : Math.abs(dy)
  const key: ArrowKey = horizontal ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down')
  const interval = GEARS.find(([limit]) => distance < limit)![1]
  return { key, interval }
}

export const DOUBLE_TAP_MS = 300
export const DOUBLE_TAP_DISTANCE = 20

export interface Tap {
  x: number
  y: number
  t: number
}

/** ``next`` is the second tap of a double tap begun by ``last``. */
export function isDoubleTap(last: Tap | null, next: Tap): boolean {
  return last !== null
    && next.t - last.t <= DOUBLE_TAP_MS
    && Math.hypot(next.x - last.x, next.y - last.y) <= DOUBLE_TAP_DISTANCE
}
