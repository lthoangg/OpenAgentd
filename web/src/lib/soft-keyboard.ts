/**
 * The soft keyboard, with no dependencies, so a component can put it away
 * without pulling in the viewport guards (``hooks/use-mobile-viewport``
 * re-exports this for its existing callers).
 */

/**
 * Dismiss the soft keyboard and snap the app shell back to full height *now*.
 *
 * When the user blurs an input, iOS slides the keyboard down over ~250-300ms
 * and fires `visualViewport` events the whole way. If the shell just tracks
 * those frames it crawls back up with the keyboard, which reads as "slow".
 * Instead we:
 *   1. blur the active editable element (starts the dismiss),
 *   2. enable a one-shot eased transition on the shell (`data-vp-anim`),
 *   3. optimistically write the full layout height so the shell glides back
 *      immediately rather than chasing the keyboard down frame-by-frame.
 * The live `visualViewport` binding stays authoritative; this just front-runs
 * it for the dismiss case. The transition flag clears on the next interaction
 * (handled by the hook) so opening the keyboard stays frame-locked and snappy.
 */
export function dismissKeyboard(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable="true"]')) {
    active.blur()
  }
  const root = document.documentElement
  if (!root.hasAttribute('data-mobile-shell')) return
  root.setAttribute('data-vp-anim', '')
  root.removeAttribute('data-keyboard-open')
  // Optimistically expand to the full layout viewport; the live binding will
  // reconcile to the exact value as the keyboard finishes retracting.
  root.style.setProperty('--app-vh', `${Math.round(window.innerHeight)}px`)
  root.style.setProperty('--app-vt', '0px')
  // Drop the transition flag once the glide is done so a subsequent keyboard
  // open stays frame-locked. (Opening also clears it eagerly in the hook.)
  window.setTimeout(() => root.removeAttribute('data-vp-anim'), 320)
}

/** Whether the soft keyboard is up (``useMobileViewportGuards`` keeps the attribute). */
export function isKeyboardUp(): boolean {
  return document.documentElement.hasAttribute('data-keyboard-open')
}
