/**
 * The part of the screen the user can actually see, in client (viewport)
 * coordinates.
 *
 * On iOS WKWebView the soft keyboard does not shrink the layout viewport:
 * `window.innerHeight` stays at full height while the keyboard covers the
 * bottom. Only `window.visualViewport` reports the uncovered region. Anything
 * that positions a floating panel (popover, dropdown, combobox list) should
 * measure against this instead of `innerHeight`, or it opens under the
 * keyboard.
 */
export interface VisibleViewport {
  top: number
  bottom: number
  height: number
}

export function getVisibleViewport(): VisibleViewport {
  if (typeof window === 'undefined') return { top: 0, bottom: 0, height: 0 }
  const vv = window.visualViewport
  const layoutHeight = window.innerHeight
  if (!vv || !(vv.height > 0)) return { top: 0, bottom: layoutHeight, height: layoutHeight }
  const top = Math.max(0, vv.offsetTop)
  const bottom = Math.min(layoutHeight, top + vv.height)
  return { top, bottom, height: bottom - top }
}

/**
 * Subscribe to visible-area changes (keyboard open/close, rotation).
 * Returns an unsubscribe function.
 */
export function onVisibleViewportChange(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const vv = window.visualViewport
  window.addEventListener('resize', listener)
  vv?.addEventListener('resize', listener)
  vv?.addEventListener('scroll', listener)
  return () => {
    window.removeEventListener('resize', listener)
    vv?.removeEventListener('resize', listener)
    vv?.removeEventListener('scroll', listener)
  }
}
