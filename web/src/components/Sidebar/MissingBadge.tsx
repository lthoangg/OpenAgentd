import { TriangleAlert } from 'lucide-react'

/**
 * A workspace or checkout whose folder is gone from disk: a warning, not an
 * error. A small ⚠ in the warning tone beside the name, not a chip, so the
 * name keeps the whole row. It has no tooltip of its own: its row's says
 * "Folder not found at <path>".
 */
export function MissingBadge() {
  return (
    <span
      data-sidebar-missing=""
      role="img"
      aria-label="Folder not found"
      className="flex shrink-0 items-center text-(--accent-orange-text)"
    >
      <TriangleAlert size={12} aria-hidden="true" />
    </span>
  )
}
