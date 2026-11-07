/**
 * Whether the transcript can leave earlier turns landing above the view to
 * the browser's own scroll anchoring, on touch.
 *
 * On touch, every scrollTop write made mid-fling stops the momentum (iOS),
 * so holding the view by hand while a page lands reads as a jump. Browsers
 * with CSS scroll anchoring (Chromium, and WebKit since Safari / iOS 27)
 * adjust the scroll position themselves without touching the fling. They do
 * not anchor at a scroll offset of zero, so callers still hold the view by
 * hand when the reader is at the very top.
 */
export function touchScrollAnchoring(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  if (!window.matchMedia('(pointer: coarse)').matches) return false
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('overflow-anchor', 'auto')
}
