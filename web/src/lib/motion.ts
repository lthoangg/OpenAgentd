/**
 * Motion constants — typed counterparts to the CSS `--motion-*` / `--ease-*`
 * tokens defined in `web/src/index.css`.
 *
 * Use these when you need values inside TypeScript (framer-motion props,
 * inline styles computed at render time, animation delays). For static CSS
 * or Tailwind arbitrary values, prefer `var(--motion-*)` directly.
 *
 * Keep these values in sync with the `web/src/index.css` token block.
 */

/** Durations in milliseconds. */
export const DURATIONS = {
  instant: 80,
  fast: 150,
  base: 240,
  slow: 400,
  glacial: 800,
} as const
export type DurationName = keyof typeof DURATIONS

/** Durations in seconds — framer-motion takes seconds. */
export const DURATIONS_S = {
  instant: 0.08,
  fast: 0.15,
  base: 0.24,
  slow: 0.4,
  glacial: 0.8,
} as const

/** Cubic-bezier easings, framer-motion compatible `number[]` form. */
export const EASINGS = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.4, 0, 0.2, 1],
  springSoft: [0.34, 1.2, 0.64, 1],
  springSnappy: [0.22, 1.4, 0.36, 1],
  linear: [0, 0, 1, 1],
} as const satisfies Record<string, [number, number, number, number]>
export type EasingName = keyof typeof EASINGS

/**
 * Spring presets matching the Fluid Functionalism vocabulary.
 * Use these names verbatim in UI copy when letting users pick a preference.
 */
export const SPRINGS = {
  fast: { type: 'spring', stiffness: 380, damping: 28 },
  moderate: { type: 'spring', stiffness: 220, damping: 26 },
  slow: { type: 'spring', stiffness: 140, damping: 24 },
  comfortable: { type: 'spring', stiffness: 180, damping: 30 },
} as const
export type SpringName = keyof typeof SPRINGS

/** Default spring — `moderate` unless the user overrides it. */
export const DEFAULT_SPRING = SPRINGS.moderate
