/**
 * TopbarAction — small icon+label button used in the agent topbar.
 *
 * Pencil component `rFG6A` (TopbarAction): padding 6×10, gap 6,
 * radius-sm, transparent fill, lucide icon at 13px, label at 12px
 * weight-500, both in `--color-text-2`. Hover lifts the surface to
 * `--bg-key`.
 *
 * Used for "Todos", "Files", "Agents" in the topbar.
 */

import { forwardRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TopbarActionProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  Icon: LucideIcon
  label?: string
  /** Optional compact text rendered after the icon (for counters). */
  badge?: string
  /** Show a colored dot to signal an active/in-progress state. */
  indicator?: boolean
  indicatorClassName?: string
  /** Hide the label on small viewports while keeping it for screen readers. */
  hideLabelOnMobile?: boolean
}

export const TopbarAction = forwardRef<HTMLButtonElement, TopbarActionProps>(
  function TopbarAction(
    {
      Icon,
      label,
      badge,
      indicator,
      indicatorClassName,
      hideLabelOnMobile = true,
      className,
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          'inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium leading-none text-(--color-text-2) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent md:h-auto md:min-w-0 md:rounded-md md:px-2.5 md:py-1.5',
          className,
        )}
        {...rest}
      >
        <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
        {label && (
          <span className={cn(hideLabelOnMobile && 'hidden md:inline')}>{label}</span>
        )}
        {badge && (
          <span className="font-mono text-[10px] text-(--color-text-muted)">{badge}</span>
        )}
        {indicator && (
          <span
            aria-hidden="true"
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full bg-(--color-accent)',
              indicatorClassName,
            )}
          />
        )}
      </button>
    )
  },
)
