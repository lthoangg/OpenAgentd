import { SidebarHeading } from './SidebarHeading'

/**
 * A collapsible group label of the flat views (Needs you, Running, Today …)
 * with its count. It is a ``SidebarHeading``, the one header every sidebar
 * section uses: sentence case, 32px, a chevron that shows the fold. A group
 * of sessions waiting on you counts them in words ("2 waiting"), as the
 * Needs you section does.
 */
export function SessionGroupHeader({
  label,
  count,
  collapsed,
  onToggle,
  controls,
  tone = 'subtle',
}: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
  /** Id of the list this header folds. */
  controls?: string
  /** ``warning`` marks the count (sessions waiting on you). */
  tone?: 'subtle' | 'warning'
}) {
  const waiting = tone === 'warning'
  return (
    <SidebarHeading
      label={label}
      count={count}
      countLabel={waiting ? `${count} waiting` : undefined}
      tone={waiting ? 'warning' : 'neutral'}
      collapsed={collapsed}
      onToggle={onToggle}
      controls={controls}
    />
  )
}
