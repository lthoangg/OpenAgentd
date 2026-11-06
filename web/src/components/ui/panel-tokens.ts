/**
 * Panel type + icon scale, shared by management surfaces (Settings, Scheduled
 * tasks, Session settings, Keyboard shortcuts, Backend connection). See
 * DESIGN.md → Panels and management surfaces.
 *
 * The settings pages had drifted to five uncoordinated font sizes chosen ad
 * hoc per file (`text-base`, `text-xs` and four px sizes from 9px to 11px)
 * and six icon sizes (11 through 16). That is what
 * made the surface feel unfinished rather than deliberately dense.
 *
 * Two type steps, one icon size. Import these instead of writing raw
 * arbitrary-value classes:
 *
 *   step 1 (text-xs)    - titles, labels, body copy. The default.
 *   step 2 (text-meta)  - hints, errors, secondary metadata.
 *
 * Both are rem steps scaled by the Text size setting (12/11px at Compact,
 * 13/12px at Default, 14/13px at Large); px text classes are not used
 * (design-lint). Dense metadata that is a step larger on phones is written
 * as a responsive pair:
 *
 *   text-xs md:text-meta   - dense metadata (a step larger on phones).
 *   text-meta              - micro badges.
 */

/** Single icon size for every glyph on a panel. */
export const ICON_SIZE = 14

/** Smaller glyph for inline affordances inside buttons and badges. */
export const ICON_SIZE_INLINE = 12

export const TEXT = {
  /** Page heading (one per page). */
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
  hint: 'text-meta leading-relaxed text-(--color-text-muted)',
  /** Lowest-emphasis metadata. */
  subtle: 'text-meta leading-relaxed text-(--color-text-subtle)',
} as const

/** Padding for a row inside a panel card. */
export const ROW_PAD = 'px-3 py-2.5 md:px-4 md:py-3.5'

/**
 * Compact row for long reference lists (shortcuts, tools, servers): the same
 * left/right layout as `PanelRow`, 44px tall instead of 56px (36px on
 * phones, so a small screen shows more of the list).
 */
export const COMPACT_ROW = 'flex min-h-9 items-center gap-3 px-3 py-2 md:min-h-11 md:px-4 md:py-2.5'

/**
 * Scrolling body of a modal `AppOverlay`; stack sections with
 * `space-y-6 md:space-y-8` (tighter on phones).
 */
export const OVERLAY_BODY =
  'relative min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y px-3 py-4 md:px-6 md:py-6'

/**
 * The one bordered card in the transcript (a question, a plan review, a goal
 * check, the Undo notice): a hairline frame on the card fill, `rounded-sm`.
 * Add the margin (`my-2`) and any entrance motion at the call site.
 */
export const TRANSCRIPT_CARD = 'overflow-hidden rounded-sm border border-(--color-border-subtle) bg-(--bg-card)'
