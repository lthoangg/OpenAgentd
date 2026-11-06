import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Chip } from '@/components/ui/chip'

/**
 * The one header every sidebar section uses (Pinned, Needs you, Workspaces,
 * Scheduled): its name in sentence case, a count, a chevron that is always
 * visible when the section folds, and trailing actions. 32px; the count is
 * a warning chip with a word for sessions waiting on you, so colour is never
 * the only signal.
 */
export function SidebarHeading({
  label,
  count,
  countLabel,
  tone = 'neutral',
  collapsed,
  onToggle,
  controls,
  actions,
  className = '',
}: {
  label: string
  count?: number
  /** Words for the count, e.g. "2 waiting"; the number alone otherwise. */
  countLabel?: string
  /** ``warning``: the count is a chip (sessions waiting on you). */
  tone?: 'neutral' | 'warning'
  /** With ``onToggle``, the section folds and the chevron shows its state. */
  collapsed?: boolean
  onToggle?: () => void
  /** Id of the list the heading folds. */
  controls?: string
  actions?: ReactNode
  className?: string
}) {
  const countNode = count === undefined ? null : tone === 'warning'
    ? <Chip tone="warning" mono={countLabel === undefined}>{countLabel ?? count}</Chip>
    : <span className="tabular-nums text-(--color-text-muted)">{countLabel ?? count}</span>
  const title = (
    <>
      <span className="truncate">{label}</span>
      {countNode}
    </>
  )
  return (
    <div data-sidebar-heading="" className={`flex h-8 shrink-0 items-center gap-1 pr-1.5 pointer-coarse:h-(--spacing-list-row) ${className}`}>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={controls}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm pl-3 pr-1.5 text-left text-xs font-medium text-(--color-text-muted) transition-colors hover:text-(--color-text-2)"
        >
          {title}
          <span className="flex-1" />
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={`shrink-0 text-(--color-text-muted) transition-transform duration-(--motion-fast) ${collapsed ? '' : 'rotate-90'}`}
          />
        </button>
      ) : (
        <h2 className="flex min-w-0 flex-1 items-center gap-1.5 pl-3 text-xs font-medium text-(--color-text-muted)">{title}</h2>
      )}
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  )
}
