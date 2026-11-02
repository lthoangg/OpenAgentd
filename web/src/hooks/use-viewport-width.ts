/**
 * Window width as React state, so geometry derived from it (sidebar clamps,
 * first-run defaults) follows window resizes instead of the width at render.
 */
import { useCallback, useSyncExternalStore } from 'react'

/** Assumed width outside a browser (tests without a window, SSR). */
const FALLBACK_WIDTH = 1280

function subscribe(onChange: () => void) {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

const readWidth = () => window.innerWidth
const fallbackWidth = () => FALLBACK_WIDTH

export function useViewportWidth(): number {
  return useSyncExternalStore(subscribe, readWidth, fallbackWidth)
}

/**
 * Whether the window is at least ``min`` wide. The snapshot is the boolean, so
 * callers re-render only when the threshold is crossed, not on every resize.
 */
export function useViewportAtLeast(min: number): boolean {
  const read = useCallback(() => window.innerWidth >= min, [min])
  const fallback = useCallback(() => FALLBACK_WIDTH >= min, [min])
  return useSyncExternalStore(subscribe, read, fallback)
}

/**
 * A boolean derived from the window width. Like ``useViewportAtLeast``, the
 * caller re-renders only when the answer changes, not on every resize.
 */
export function useViewportMatches(test: (width: number) => boolean): boolean {
  const read = useCallback(() => test(window.innerWidth), [test])
  const fallback = useCallback(() => test(FALLBACK_WIDTH), [test])
  return useSyncExternalStore(subscribe, read, fallback)
}
