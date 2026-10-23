/**
 * Hover that means the user moved the mouse.
 *
 * Browsers send ``mouseenter``, and Chromium sends a mouse move, whenever
 * content moves under a still pointer: a list opens or loads under it, a
 * filter reorders it, or ↑/↓ scrolls it. A picker that highlights on those
 * steals the keyboard's choice, so Enter runs the row under the parked
 * cursor. Rows spread ``hoverIntent(activate)`` instead of ``onMouseEnter``:
 * it fires only on a move whose position changed.
 */
import type { MouseEvent } from 'react'

let last: { x: number; y: number } | null = null
let moved = false

/** Records every move before React sees it, wherever the pointer is. */
function record(event: globalThis.MouseEvent): void {
  moved = last === null || last.x !== event.clientX || last.y !== event.clientY
  last = { x: event.clientX, y: event.clientY }
}

if (typeof window !== 'undefined') window.addEventListener('mousemove', record, { capture: true, passive: true })

/** Whether the current mouse move changed the pointer's position. */
export function pointerMoved(event: MouseEvent | globalThis.MouseEvent): boolean {
  // The capture listener has already run for this event; if it did not (a
  // handler outside the window), compare positions directly.
  if (last && (last.x !== event.clientX || last.y !== event.clientY)) record(event as globalThis.MouseEvent)
  return moved
}

/** Row props: ``activate`` runs on real mouse movement only. */
export function hoverIntent(activate: () => void): { onMouseMove: (event: MouseEvent) => void } {
  return { onMouseMove: (event) => { if (pointerMoved(event)) activate() } }
}

/** Tests: forget the last position. */
export function resetHoverIntent(): void {
  last = null
  moved = false
}
