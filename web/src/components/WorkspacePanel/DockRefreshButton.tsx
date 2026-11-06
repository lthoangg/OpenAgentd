/**
 * DockRefreshButton — "Refresh" in a Review panel view's own toolbar (Git,
 * a diff, a file). It used to sit in the tab strip, far from what it
 * reloads; the strip keeps only "+", Maximize and the pane's ⋯ menu.
 * Dense dock size and the 14px toolbar glyph, like the view's other actions.
 */
import { RefreshCw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DOCK_ACTION_BUTTON_CLASS } from './dock-tab-styles'

export function DockRefreshButton({ label, onClick }: {
  /** What it reloads: "Refresh Git status", "Refresh diff", "Refresh file". */
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button type="button" onClick={onClick} className={DOCK_ACTION_BUTTON_CLASS} aria-label={label}>
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
