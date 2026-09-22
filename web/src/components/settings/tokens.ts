/**
 * Settings type + icon scale.
 *
 * The settings pages had drifted to five uncoordinated font sizes chosen ad
 * hoc per file (`text-base`, `text-xs`, `text-[11px]`, `text-[10.5px]`,
 * `text-[10px]`, `text-[9px]`) and six icon sizes (11 through 16). That is what
 * made the surface feel unfinished rather than deliberately dense.
 *
 * Two type steps, one icon size. Import these instead of writing raw
 * arbitrary-value classes:
 *
 *   step 1 (12px / text-xs)  - titles, labels, body copy. The default.
 *   step 2 (11px)            - hints, errors, secondary metadata.
 *
 * Anything below 11px is legible only on a pointer-precision screen, so those
 * sizes are always written as a responsive pair with a mobile floor rather
 * than as a bare arbitrary value:
 *
 *   text-xs md:text-[10px]   - dense metadata (12px on phones, 10px on desktop).
 *   text-[11px] md:text-[9px] - micro badges (11px on phones, 9px on desktop).
 *
 * Every size in the app is a whole pixel; there is no 9.5/10.5/11.5 step.
 */

/** Single icon size for every glyph in settings. */
export const ICON_SIZE = 14

/** Smaller glyph for inline affordances inside buttons and badges. */
export const ICON_SIZE_INLINE = 12

export const TEXT = {
  /** Section / page heading. */
  title: 'text-xs font-semibold text-(--color-text)',
  /** Form control label. */
  label: 'text-xs font-medium text-(--color-text)',
  /** Explanatory paragraph copy. */
  body: 'text-xs leading-relaxed text-(--color-text-muted)',
  /** Body copy without the relaxed leading, for tight containers. */
  bodyTight: 'text-xs leading-snug',
  /** Helper text below a control. */
  hint: 'text-[11px] leading-relaxed text-(--color-text-muted)',
  /** Lowest-emphasis metadata. */
  subtle: 'text-[11px] leading-relaxed text-(--color-text-subtle)',
} as const
