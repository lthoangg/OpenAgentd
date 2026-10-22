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
  linger: 2,
} as const

/** Cubic-bezier easings, framer-motion compatible `number[]` form. */
export const EASINGS = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.4, 0, 0.2, 1],
  springSoft: [0.34, 1.2, 0.64, 1],
  springSnappy: [0.22, 1.4, 0.36, 1],
  sheet: [0.32, 0.72, 0, 1],
  linear: [0, 0, 1, 1],
} as const satisfies Record<string, [number, number, number, number]>

/**
 * Enter/exit for a card in the floating notices column (the TypeScript tools
 * prompt, the update card): rises in at ``base``, fades out at ``fast``.
 * Spread onto a ``motion`` element that is a direct child of
 * ``AnimatePresence``. Reduced motion: no movement at all.
 */
export function noticePresence(reduced: boolean) {
  if (reduced) return { initial: false as const }
  return {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0, transition: { duration: DURATIONS_S.base, ease: EASINGS.out } },
    exit: { opacity: 0, scale: 0.98, transition: { duration: DURATIONS_S.fast, ease: EASINGS.inOut } },
  }
}

/** The drag-offset spring for floating cards; reduced motion snaps. */
export function dragSettle(reduced: boolean) {
  return reduced ? { duration: 0 } : { type: 'spring' as const, stiffness: 380, damping: 32 }
}
