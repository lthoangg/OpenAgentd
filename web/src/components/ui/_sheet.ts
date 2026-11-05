/**
 * What the app's two phone sheets share: ``BottomSheet`` (a popover's phone
 * form) and ``AppOverlay``'s full-screen modal sheet. One close threshold, so
 * a pull means the same thing on both; and the detent maths of ``BottomSheet``,
 * kept pure so it can be tested without a finger.
 */

/** A pull this far past a sheet's lowest resting place closes it (px). */
export const SHEET_CLOSE_DISTANCE = 120
/** A release flicked down faster than this (px/s) moves a sheet down a step, or closes it from the lowest. */
export const SHEET_CLOSE_VELOCITY = 500

export type SheetDetent = 'medium' | 'large'

/** Detent heights as shares of the viewport: iOS's medium is half, large leaves the status bar clear. */
export const SHEET_DETENT_VH: Record<SheetDetent, number> = { medium: 0.5, large: 0.92 }
/** Two stops closer than this are one: a sheet barely taller than medium just fits its content. */
const MIN_STOP_GAP_PX = 24
/** Heights within this of a stop are at it. */
const AT_STOP_PX = 1

export interface SheetStop {
  name: SheetDetent
  /** The sheet's height at this stop (px). */
  px: number
}

/**
 * The stops a sheet can rest at, lowest first. A sheet never rests taller
 * than its content (as on iOS, a short sheet sizes itself to what it holds),
 * so a stop the content cannot fill is capped at the content, and stops that
 * then coincide become one. A content height of 0 (not measured) is left to
 * fit: one stop, and the caller leaves the height to the content.
 */
export function sheetStops(viewportHeight: number, contentHeight: number, detents: readonly SheetDetent[]): SheetStop[] {
  const asked = [...new Set(detents)].sort((a, b) => SHEET_DETENT_VH[a] - SHEET_DETENT_VH[b])
  const stopAt = (name: SheetDetent, cap = Infinity): SheetStop => ({ name, px: Math.min(cap, Math.round(SHEET_DETENT_VH[name] * viewportHeight)) })
  // Not measured (no layout yet): fit, at the lowest asked.
  if (contentHeight <= 0) return asked.length > 0 ? [stopAt(asked[0])] : []
  const stops: SheetStop[] = []
  for (const name of asked) {
    const stop = stopAt(name, contentHeight)
    const last = stops[stops.length - 1]
    if (!last || stop.px - last.px >= MIN_STOP_GAP_PX) stops.push(stop)
  }
  return stops
}

export type SheetRelease = { kind: 'close' } | { kind: 'detent'; index: number }

/**
 * Where a released drag goes. ``height`` is the sheet's height at release
 * (between its lowest and highest stop); ``overshoot`` how far the finger
 * pulled it below the lowest stop; ``velocity`` the finger's speed (px/s,
 * positive down).
 *
 * Past ``SHEET_CLOSE_DISTANCE`` below the lowest stop it closes. A flick
 * moves one stop in its direction, and down from the lowest closes. Anything
 * slower settles on the nearest stop.
 */
export function resolveRelease(
  stops: readonly number[],
  { height, overshoot, velocity }: { height: number; overshoot: number; velocity: number },
): SheetRelease {
  if (overshoot > SHEET_CLOSE_DISTANCE) return { kind: 'close' }
  if (velocity > SHEET_CLOSE_VELOCITY) {
    for (let i = stops.length - 1; i >= 0; i--) {
      if (stops[i] < height - AT_STOP_PX) return { kind: 'detent', index: i }
    }
    return { kind: 'close' }
  }
  if (velocity < -SHEET_CLOSE_VELOCITY) {
    for (let i = 0; i < stops.length; i++) {
      if (stops[i] > height + AT_STOP_PX) return { kind: 'detent', index: i }
    }
    return { kind: 'detent', index: stops.length - 1 }
  }
  let nearest = 0
  for (let i = 1; i < stops.length; i++) {
    if (Math.abs(stops[i] - height) < Math.abs(stops[nearest] - height)) nearest = i
  }
  return { kind: 'detent', index: nearest }
}
