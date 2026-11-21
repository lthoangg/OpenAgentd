/**
 * Touch scrolling for the terminal. xterm.js 6 scrolls only for a wheel or
 * a mouse on its scrollbar (xtermjs/xterm.js#5489), so a finger's travel is
 * turned into lines here:
 *
 * - The normal buffer with no mouse reporting: the scrollback moves
 *   (``term.scrollLines``).
 * - A full-screen program (vim, less, htop: the alternate buffer) or one
 *   that asked for the mouse (tmux with ``mouse on``): one line-mode wheel
 *   event per line, dispatched on the terminal, so xterm does what it does
 *   for a mouse wheel there: arrow keys, or wheel reports to the program.
 *
 * A fling keeps going after the finger lifts and slows to a stop.
 */

/** The parts of an xterm ``Terminal`` scrolling needs (a fake in tests). */
export interface ScrollableTerminal {
  element?: HTMLElement
  rows: number
  options: { fontSize?: number }
  buffer: { active: { type: 'normal' | 'alternate' } }
  modes: { mouseTrackingMode: string }
  scrollLines: (amount: number) => void
}

/** One row's height in CSS px: the screen's height over its rows. */
export function cellHeight(term: ScrollableTerminal): number {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  const height = screen ? screen.clientHeight / Math.max(1, term.rows) : 0
  return height > 0 ? height : (term.options.fontSize ?? 13) * 1.2
}

/** Scroll ``lines`` (negative: back toward older output). */
export function scrollTerminal(term: ScrollableTerminal, lines: number, at: { x: number; y: number }): void {
  if (lines === 0) return
  const wheel = term.buffer.active.type === 'alternate' || term.modes.mouseTrackingMode !== 'none'
  if (!wheel) {
    term.scrollLines(lines)
    return
  }
  const target = term.element
  if (!target) return
  for (let i = 0; i < Math.abs(lines); i++) {
    target.dispatchEvent(new WheelEvent('wheel', {
      deltaY: Math.sign(lines),
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      clientX: at.x,
      clientY: at.y,
      bubbles: true,
      cancelable: true,
    }))
  }
}

/**
 * Turns a finger's travel (px, downward positive) into whole lines to scroll,
 * carrying the remainder: a finger moving down shows older output, so it
 * scrolls back (negative lines).
 */
export function lineAccumulator(rowHeight: () => number): (px: number) => number {
  let rest = 0
  return (px) => {
    const height = rowHeight()
    rest += px
    const lines = Math.trunc(rest / height)
    rest -= lines * height
    return -lines
  }
}

/** Below this speed (px/ms) a fling stops. */
const MIN_VELOCITY = 0.02
/** Speed kept per 16 ms frame. */
const FRICTION = 0.95

/**
 * Keep scrolling after a fling at ``velocity`` (px/ms), slowing each frame;
 * ``onTravel`` gets each frame's px. Returns the function that stops it.
 */
export function startMomentum(
  velocity: number,
  onTravel: (px: number) => void,
  raf: (callback: (time: number) => void) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame,
): () => void {
  if (Math.abs(velocity) < MIN_VELOCITY) return () => {}
  let v = velocity
  let last: number | null = null
  let id = 0
  const frame = (time: number) => {
    const dt = last === null ? 16 : Math.min(64, time - last)
    last = time
    onTravel(v * dt)
    v *= FRICTION ** (dt / 16)
    if (Math.abs(v) >= MIN_VELOCITY) id = raf(frame)
  }
  id = raf(frame)
  return () => cancel(id)
}
