/**
 * Menu item blink — the one flash an OS menu gives the row you chose before
 * it runs and the menu closes (DESIGN.md → Motion).
 *
 * The row's highlight goes off for ``BLINK_OFF_MS`` and back on for
 * ``BLINK_ON_MS`` (110ms in all, under the ~120ms that still reads as part
 * of the click), then the action runs. The off phase is ``data-blink="off"``
 * on the row, styled by ``.oa-menu-item`` in index.css. Pointer and keyboard
 * activation both blink; reduced motion skips it.
 */
import { prefersReducedMotion } from '@/lib/motion'

/** Highlight off. */
export const BLINK_OFF_MS = 60
/** Highlight back on, before the action. */
export const BLINK_ON_MS = 50

/**
 * Switch for the blink. Tests turn it off globally (``__tests__/setup.ts``) so
 * a click runs its action synchronously; the blink's own tests turn it on.
 */
export const menuBlink = { enabled: true }

/** A row that opens something rather than acting does not blink. */
function opensSubmenu(item: HTMLElement): boolean {
  return item.hasAttribute('aria-haspopup') || item.hasAttribute('aria-expanded')
}

/** Whether this row is blinking right now: a second activation is ignored, not run. */
export function isBlinking(item: HTMLElement): boolean {
  return item.hasAttribute('data-blink')
}

/** Whether activating this row should blink before it runs. */
export function shouldBlink(item: HTMLElement): boolean {
  if (!menuBlink.enabled || prefersReducedMotion()) return false
  if (item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true') return false
  return !opensSubmenu(item)
}

/** Blink ``item`` once, then call ``run``. Call only after ``shouldBlink(item)``. */
export function blinkThen(item: HTMLElement, run: () => void): void {
  item.setAttribute('data-blink', 'off')
  setTimeout(() => {
    item.setAttribute('data-blink', 'on')
    setTimeout(() => {
      item.removeAttribute('data-blink')
      run()
    }, BLINK_ON_MS)
  }, BLINK_OFF_MS)
}
