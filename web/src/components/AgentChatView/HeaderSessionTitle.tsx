/**
 * HeaderSessionTitle — the session's name in the desktop header, read-only:
 * sessions are renamed from the sidebar. Plain text, not a control, so in the
 * desktop app a press on it drags the window and a double-click maximizes it,
 * like anywhere else on the header (`useTauriDrag`). The tooltip shows the
 * whole title when it is truncated.
 */
import { AnimatedTitle } from '@/components/ui/animated-title'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface HeaderSessionTitleProps {
  sessionId: string | null
  title: string
}

export function HeaderSessionTitle({ sessionId, title }: HeaderSessionTitleProps) {
  return (
    <Tooltip className="min-w-0">
      <TooltipTrigger
        className="min-w-0"
        render={
          <span className="flex min-w-0 text-(--color-text-muted)">
            <AnimatedTitle text={title} sessionId={sessionId} />
          </span>
        }
      />
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}
