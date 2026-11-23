/**
 * A tool in a Browser tab's bar: an icon button with a tooltip that says why
 * it is disabled while it is.
 */
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { DOCK_ACTION_BUTTON_CLASS } from '../WorkspacePanel/dock-tab-styles'

/** A phone's bar tool: 44px and round. Forced, or the dock button's own 28px touch size wins. */
const PHONE_TOOL_CLASS = 'size-11! rounded-full! [&_svg]:size-5'

export function ToolbarButton({
  label,
  onClick,
  disabled,
  disabledReason,
  pressed,
  children,
  className,
  tooltipSide = 'bottom',
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  /** Why it is disabled; the tooltip says this instead of the label while it is. */
  disabledReason?: string
  pressed?: boolean
  children: React.ReactNode
  className?: string
  /** Where the tooltip goes; above, for a bar over a page the app cannot draw on. */
  tooltipSide?: 'top' | 'bottom'
}) {
  const reason = disabled ? disabledReason : undefined
  // A phone's bottom bar: thumb-sized 44px round buttons with 20px glyphs.
  const phone = useIsMobile()
  return (
    <Tooltip>
      {/* The trigger wraps the button in a span, so a disabled one still gets the hover. */}
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            aria-description={reason}
            aria-pressed={pressed}
            className={cn(DOCK_ACTION_BUTTON_CLASS, phone && PHONE_TOOL_CLASS, pressed && 'bg-(--bg-key) text-(--color-text)', className)}
          >
            {children}
          </button>
        }
      />
      <TooltipContent side={tooltipSide}>{reason ?? label}</TooltipContent>
    </Tooltip>
  )
}
