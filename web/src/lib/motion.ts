/**
 * Motion constants — typed counterparts to the CSS `--motion-*` / `--ease-*`
 * tokens defined in `web/src/index.css`.
 *
 * Use these when you need values inside TypeScript (framer-motion props,
 * inline styles computed at render time, animation delays). For static CSS
 * or Tailwind arbitrary values, prefer `var(--motion-*)` directly.
 *
 * Parity with the CSS token block is enforced by
 * `src/__tests__/lib/motion.test.ts` — it parses `index.css` and fails if the
 * two drift, so these values do not have to be kept in sync by hand.
 */

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
