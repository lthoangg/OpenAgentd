import type { ComponentPropsWithRef, ReactNode } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { rowChipClass } from '@/components/ui/list-row'
import { cn } from '@/lib/utils'

/**
 * The one count pill of a sidebar row: subagents, sessions in other
 * workspaces and worktrees all read the same way, ``[state mark] kind icon ·
 * count [fold chevron]``, in the 20px mono pill (``rowChipClass``) that inks
 * when ``active``. A pill that folds a list shows its chevron
 * (``expanded`` set); one that opens a menu (worktrees) has none.
 */
export function CountChip({
  icon: Icon,
  count,
  active = false,
  expanded,
  mark,
  className,
  ...props
}: Omit<ComponentPropsWithRef<'button'>, 'children'> & {
  /** What is counted: the pill's kind icon, 12px. */
  icon: LucideIcon
  count: number
  active?: boolean
  /** Set for a pill that folds a list: the chevron turns down while open. */
  expanded?: boolean
  /** A live state mark ahead of the icon (work running or waiting inside). */
  mark?: ReactNode
}) {
  return (
    <button type="button" data-count-chip="" className={cn('ml-1', rowChipClass(active), className)} {...props}>
      {mark}
      <Icon size={12} className="shrink-0" aria-hidden="true" />
      <span className="tabular-nums">{count}</span>
      {expanded !== undefined && (
        <ChevronRight
          size={12}
          className={cn('shrink-0 transition-transform duration-(--motion-fast)', expanded && 'rotate-90')}
          aria-hidden="true"
        />
      )}
    </button>
  )
}
