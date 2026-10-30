import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GoalRing } from '@/components/ui/goal-ring'
import type { GoalTone } from '@/lib/goal'

export function MobileHeaderAction({
  Icon,
  label,
  onClick,
  active = false,
  disabled = false,
  badge = 0,
  goalTone,
  tooltip,
}: {
  Icon: LucideIcon
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  badge?: number
  /** A goal's ring, in the colour of its status. */
  goalTone?: GoalTone
  /** Tooltip text when it should say more than the label. */
  tooltip?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            disabled={disabled || !onClick}
            className={`relative flex h-8 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:opacity-45 pointer-coarse:size-11 ${
              active
                ? 'bg-(--bg-key) text-(--color-text)'
                : 'text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)'
            }`}
            aria-label={label}
          >
            <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
            {badge > 0 && (
              <span className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-(--color-accent) px-1 text-center font-mono text-[11px] leading-3.5 text-(--bg-page)">
                {badge > 9 ? '9+' : badge}
              </span>
            )}
            {goalTone && <GoalRing tone={goalTone} className="absolute bottom-1 right-1" />}
          </button>
        }
      />
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  )
}
