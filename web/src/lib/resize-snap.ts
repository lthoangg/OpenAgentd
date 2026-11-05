/**
 * Detent snapping for resize drags (Finder/Xcode split views): while the
 * pointer is within ``threshold`` of a default size the value sticks to it.
 */

/** How close, in px, a drag must come to a default size to snap onto it. */
export const SNAP_THRESHOLD_PX = 8

export interface Snapped {
  value: number
  /** Whether ``value`` is the detent (the drag is held on it). */
  snapped: boolean
}

/**
 * ``value``, or ``detent`` itself when it lies within ``threshold`` (same
 * unit as both; for a ratio pass the px threshold over the container size).
 * A non-finite input never snaps.
 */
export function snapToDetent(value: number, detent: number, threshold: number = SNAP_THRESHOLD_PX): Snapped {
  if (!Number.isFinite(value) || !Number.isFinite(detent) || !(threshold > 0)) return { value, snapped: false }
  return Math.abs(value - detent) <= threshold ? { value: detent, snapped: true } : { value, snapped: false }
}
