/**
 * BrandHeader — sidebar brand row with mascot, Caveat title, and dock toggle.
 *
 * Pencil component `dtEOn` (BrandHeader):
 *   [mascot 44]  OpenAgentd                 [⫶]
 *                on-machine ai
 *
 * - Mascot 44×44 (image fill from /brand-assets/openagentd-app-icon.png)
 * - Title: font-hand (Caveat), 28px, weight 700, --color-text
 * - Subtitle: font-mono, 11px, --color-text-muted
 * - Dock toggle: 32×32 outlined button on the right
 * - Container: 64h, gap 12, padding 8×4
 *
 * Caveat is decorative chrome; the brand name is also conveyed by the
 * adjacent app icon and any document/page title, so screen readers will
 * still encounter "OpenAgentd" elsewhere.
 */

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { OPENAGENTD_APP_ICON } from '@/lib/brand-assets'
import { cn } from '@/lib/utils'

export interface BrandHeaderProps {
  /** Whether the sidebar is currently expanded; flips the dock-toggle icon. */
  expanded?: boolean
  onToggle?: () => void
  /** Optional click handler for the brand block (mascot + title). */
  onBrandClick?: () => void
  className?: string
  /** Skip the dock toggle (mobile sheet, etc.). */
  hideToggle?: boolean
}

export function BrandHeader({
  expanded = true,
  onToggle,
  onBrandClick,
  hideToggle = false,
  className,
}: BrandHeaderProps) {
  const ToggleIcon = expanded ? PanelLeftClose : PanelLeftOpen

  const brandContent = (
    <>
      <img
        src={OPENAGENTD_APP_ICON}
        alt=""
        aria-hidden="true"
        className="h-11 w-11 shrink-0 select-none"
        draggable={false}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-hand text-[28px] font-bold leading-none text-(--color-text)">
          OpenAgentd
        </span>
        <span className="font-mono text-[11px] text-(--color-text-muted)">
          on-machine ai
        </span>
      </div>
    </>
  )

  return (
    <div className={cn('flex h-16 items-center gap-3 px-1 py-2', className)}>
      {onBrandClick ? (
        <button
          type="button"
          onClick={onBrandClick}
          title="Home"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md p-1 -ml-1 text-left transition-colors hover:bg-(--bg-key)"
        >
          {brandContent}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {brandContent}
        </div>
      )}
      {!hideToggle && onToggle && (
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
          title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-(--color-border-subtle) text-(--color-text-2) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
        >
          <ToggleIcon size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
