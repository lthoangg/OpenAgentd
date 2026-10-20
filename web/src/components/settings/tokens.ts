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
 * 11px is the floor on every shell (DESIGN.md); index.css clamps anything
 * smaller, so never write a sub-11px class. Dense metadata that is a step
 * larger on phones is written as a responsive pair:
 *
 *   text-xs md:text-[11px]   - dense metadata (12px on phones, 11px on desktop).
 *   text-[11px]              - micro badges.
 *
 * Every size in the app is a whole pixel; there is no 9.5/10.5/11.5 step.
 */

/** Single icon size for every glyph in settings. */
export const ICON_SIZE = 14

/** Smaller glyph for inline affordances inside buttons and badges. */
export const ICON_SIZE_INLINE = 12

export const TEXT = {
  /** Settings page heading (one per page). */
  pageTitle: 'text-base font-semibold tracking-tight text-(--color-text)',
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

/**
 * Page body column: one reading width and one horizontal inset for every
 * settings page, so headers, sections and the save bar line up.
 */
export const PAGE_BODY = 'mx-auto w-full max-w-3xl px-4 md:px-8'

/** Padding for a row inside a settings card. */
export const ROW_PAD = 'px-4 py-3.5'

/** Body column for editor pages, which sit under their own sub-header. */
export const EDITOR_BODY = `${PAGE_BODY} py-6 md:py-8`
