import { ChevronRight } from 'lucide-react'

/**
 * A collapsible group label in ``label-caps`` with its count: the Pinned
 * section and the groups of the flat views.
 */
export function SessionGroupHeader({
  label,
  count,
  collapsed,
  onToggle,
  controls,
  tone = 'subtle',
  tall = false,
}: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
  /** Id of the list this header folds. */
  controls?: string
  /** ``warning`` colours the count (sessions waiting on you). */
  tone?: 'subtle' | 'warning'
  /** A section header (32px) rather than a group header (24px). */
  tall?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={controls}
      className={`group/header flex w-full items-center gap-1.5 rounded-sm pl-3 pr-2 text-left text-[11px] leading-none transition-colors hover:bg-(--bg-key)/35 pointer-coarse:h-(--spacing-list-row) ${tall ? 'h-8' : 'h-6'}`}
    >
      <span className="label-caps text-(--color-text-subtle)">{label}</span>
      <span className={`tabular-nums ${tone === 'warning' ? 'text-(--color-warning)' : 'text-(--color-text-subtle)'}`}>{count}</span>
      <span className="flex-1" />
      <ChevronRight
        size={11}
        aria-hidden="true"
        className={`shrink-0 text-(--color-text-subtle) opacity-0 transition-transform duration-(--motion-fast) group-hover/header:opacity-100 group-focus-visible/header:opacity-100 pointer-coarse:opacity-100 ${collapsed ? '' : 'rotate-90'}`}
      />
    </button>
  )
}
