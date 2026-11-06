import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GoalRing } from '@/components/ui/goal-ring'
import { useBadgeBump } from '@/components/ui/swap'
import type { GoalTone } from '@/lib/goal'
import { cn } from '@/lib/utils'

/**
 * An action in the narrow layout's header (Tasks, Review panel). On a phone
 * it is a bar button: a 20px glyph in the accent tint, drawn at the phone's
 * control step and 44px to touch (``touch-hit``; DESIGN.md → Rulebook 4, 5);
 * a narrow mouse window keeps the 14px glyph.
 */
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
  const badgeRef = useBadgeBump<HTMLSpanElement>(badge)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            disabled={disabled || !onClick}
            aria-pressed={active}
            className={cn('relative touch-hit', active ? 'bg-(--bg-key) text-(--color-text)' : 'phone:text-(--color-accent)')}
            aria-label={label}
          >
            <Icon size={14} strokeWidth={1.8} aria-hidden="true" className="size-3.5 phone:size-5" />
            {badge > 0 && (
              <span ref={badgeRef} className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-(--color-accent) px-1 text-center font-mono text-meta leading-3.5 text-(--bg-page)">
                {badge > 9 ? '9+' : badge}
              </span>
            )}
            {goalTone && <GoalRing tone={goalTone} className="absolute bottom-1 right-1" />}
          </Button>
        }
      />
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  )
}
