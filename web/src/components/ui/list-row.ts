/**
 * Sidebar and dock list rows (DESIGN.md → list-row): 28px (44px on touch,
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
