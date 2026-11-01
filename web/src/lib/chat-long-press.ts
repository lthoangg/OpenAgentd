/**
 * Touch long-press for transcript surfaces (``components/ChatContextMenu``).
 *
 * One delegate on the document instead of handlers on every surface: a
 * message, a code block and a link inside it each register their element, and
 * a press goes to the innermost registered one, so a held link opens the
 * link's actions and not the message's. That also lets a surface join without
 * its owner wiring pointer events.
 *
 * Timing is the house long press (``hooks/use-long-press``): the same hold
 * threshold and move tolerance as a held sidebar row. A press is dropped when
 * the finger moves too far, lifts, is taken over by a scroll or a system
 * gesture, or a second finger lands. Text the user is selecting keeps the
 * system's own callout (Copy, Look Up): nothing opens over a selection.
 */
import { LONG_PRESS_MOVE_TOLERANCE, LONG_PRESS_MS } from '@/hooks/use-long-press'
import { hasTextSelection } from '@/lib/desktop-shell'

/** Controls inside a surface keep their own press (a tap on Copy, a link's click). */
const CONTROL = 'button, a[href], input, textarea, select, summary, [role="button"], [role="link"]'

const surfaces = new WeakMap<Element, () => void>()
let registered = 0
let press: { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null

function cancel(): void {
  if (press) clearTimeout(press.timer)
  press = null
}

/** The innermost registered element at or above ``target``, if the press may start there. */
function surfaceFor(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null
  let surface: Element | null = target
  while (surface && !surfaces.has(surface)) surface = surface.parentElement
  if (!surface) return null
  const control = target.closest(CONTROL)
  if (control && control !== surface && surface.contains(control)) return null
  return surface
}

function onPointerDown(event: PointerEvent): void {
  // A second finger is a pinch or a two-finger scroll, never a long press.
  if (press && press.id !== event.pointerId) {
    cancel()
    return
  }
  cancel()
  // Mouse keeps right-click; only a finger or a pen holds.
  if (event.pointerType === 'mouse') return
  const surface = surfaceFor(event.target)
  if (!surface) return
  const timer = setTimeout(() => {
    press = null
    if (hasTextSelection()) return
    surfaces.get(surface)?.()
  }, LONG_PRESS_MS)
  press = { id: event.pointerId, x: event.clientX, y: event.clientY, timer }
}

function onPointerMove(event: PointerEvent): void {
  if (!press || press.id !== event.pointerId) return
  if (Math.abs(event.clientX - press.x) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(event.clientY - press.y) > LONG_PRESS_MOVE_TOLERANCE) {
    cancel()
  }
}

// Capture phase: a handler that stops propagation (the menu's own wrapper)
// must not hide the press from the delegate.
const LISTENERS: ReadonlyArray<[keyof DocumentEventMap, (event: never) => void, AddEventListenerOptions]> = [
  ['pointerdown', onPointerDown, { capture: true, passive: true }],
  ['pointermove', onPointerMove, { capture: true, passive: true }],
  ['pointerup', cancel, { capture: true, passive: true }],
  ['pointercancel', cancel, { capture: true, passive: true }],
  // A scroll the browser started (or momentum) ends the press without a cancel.
  ['scroll', cancel, { capture: true, passive: true }],
]

/**
 * Make ``surface`` open its menu on a long press: ``onLongPress`` runs when the
 * hold completes. Returns the unregister; the document listeners go with the
 * last surface.
 */
export function registerLongPressSurface(surface: Element, onLongPress: () => void): () => void {
  surfaces.set(surface, onLongPress)
  if (registered++ === 0) {
    for (const [type, handler, options] of LISTENERS) document.addEventListener(type, handler as EventListener, options)
  }
  return () => {
    surfaces.delete(surface)
    if (--registered === 0) {
      cancel()
      for (const [type, handler, options] of LISTENERS) document.removeEventListener(type, handler as EventListener, options)
    }
  }
}
