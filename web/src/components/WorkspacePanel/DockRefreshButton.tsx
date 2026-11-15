/**
 * DockRefreshButton — "Refresh" in a Review panel view's own toolbar (Git,
 * a diff, a file) on phones. These views follow the files on their own, so
 * on desktop the manual reload is one item in the pane's ⋯ menu; a phone has
 * no pane menu and keeps the button.
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
