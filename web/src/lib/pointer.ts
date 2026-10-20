/**
 * True when the primary pointer is precise (mouse / trackpad).
 *
 * Used to gate programmatic focus: focusing a text field on a touch device
 * raises the software keyboard (and on iOS, scrolls/zooms the viewport), which
 * is rarely wanted for an unprompted open. Environments without `matchMedia`
 * (tests, SSR) are treated as fine-pointer so desktop behaviour is unchanged.
 */
export function hasFinePointer(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(pointer: fine)').matches === true
}
