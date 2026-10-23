/**
 * Sidebar and dock list rows (DESIGN.md → list-row): 28px (36px on touch,
 * via ``--spacing-list-row``) ``rounded-sm`` rows in ``text-xs``, a keycap
 * wash on hover and a deeper one on the current row.
 */

/** Row geometry; callers add tone, or use ``listRowClass``. */
export const LIST_ROW_GEOMETRY =
  'flex h-(--spacing-list-row) w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-xs'

/** Background for a row (or the wrapper of a row with inline actions). */
export function listRowSurface(current = false): string {
  return current ? 'bg-(--bg-key)/60' : 'hover:bg-(--bg-key)/35'
}

/** Text tone: current rows are ink, the rest step down and lift on hover. */
export function listRowText(current = false): string {
  return current ? 'text-(--color-text)' : 'text-(--color-text-2) hover:text-(--color-text)'
}

/** A complete clickable row. */
export function listRowClass({ current = false }: { current?: boolean } = {}): string {
  return `${LIST_ROW_GEOMETRY} transition-colors ${listRowSurface(current)} ${listRowText(current)}`
}

/**
 * An icon action inside a list row (DESIGN.md → Sidebar sections): 24px,
 * borderless, keycap wash on hover, 36px on touch so it fills the row. Not
 * `Button`: its 44px touch minimum would outgrow the 36px touch rows. The
 * focus ring is the global `:focus-visible` one.
 */
export const ROW_ACTION =
  'flex size-6 shrink-0 items-center justify-center rounded-xs text-(--color-text-subtle) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) pointer-coarse:size-9'

/** A text action inside a list row (e.g. "Show all"), sized like `ROW_ACTION`. */
export const ROW_TEXT_ACTION =
  'inline-flex h-6 shrink-0 items-center rounded-xs px-2 text-[11px] text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) pointer-coarse:h-9 pointer-coarse:px-2.5'

/**
 * A count chip in a row (subagents, worktrees): a 20px mono pill on a soft
 * keycap wash; `active` (expanded with work, or a filter applied) inks it.
 */
export function rowChipClass(active = false): string {
  return `inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full px-1.5 font-mono text-[11px] leading-4 transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) pointer-coarse:h-9 pointer-coarse:px-2.5 ${
    active ? 'bg-(--bg-key) text-(--color-text)' : 'bg-(--bg-key)/60 text-(--color-text-subtle)'
  }`
}

/**
 * Row actions appear in place of the row's meta on hover or keyboard focus
 * and take no room at rest; touch shows them always. `group` is the row's
 * Tailwind group name (`row`, `sub`, or `''` for an unnamed `group`).
 */
export function rowActionsReveal(group: 'row' | 'sub' | '' = 'row'): string {
  if (group === 'row') return 'hidden group-hover/row:flex group-focus-within/row:flex pointer-coarse:flex'
  if (group === 'sub') return 'hidden group-hover/sub:flex group-focus-within/sub:flex pointer-coarse:flex'
  return 'hidden group-hover:flex group-focus-within:flex pointer-coarse:flex'
}
