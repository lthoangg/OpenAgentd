/**
 * "Keep going until done" with its turns — the same control on the Plan tab
 * and the transcript card, so the approve label next to it is true on both.
 */
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { MAX_GOAL_TURNS, type PlanDecision } from './usePlanDecision'

export function KeepGoingControl({
  decision,
  onTurnsFocusChange,
  className,
}: {
  decision: PlanDecision
  /** The Plan tab keeps this row mounted while the turns field holds the phone keyboard. */
  onTurnsFocusChange?: (focused: boolean) => void
  className?: string
}) {
  const { canKeepGoing, keepGoing, turnsProblem, turnsText } = decision
  return (
    <div className={cn('flex min-w-0 items-center gap-2 text-xs text-(--color-text)', className)} data-keep-going={keepGoing ? 'on' : 'off'}>
      <Tooltip>
        <TooltipTrigger
          render={
            <label className={cn('flex items-center gap-1.5 pointer-coarse:min-h-9', !canKeepGoing && 'text-(--color-text-muted)')}>
              <Checkbox
                aria-label="Keep going until done"
                checked={keepGoing}
                disabled={!canKeepGoing || decision.submitting}
                onCheckedChange={decision.setKeepGoing}
              />
              Keep going until done
            </label>
          }
        />
        <TooltipContent>{decision.keepGoingHint}</TooltipContent>
      </Tooltip>
      {keepGoing && (
        <label className="flex items-center gap-1 text-meta text-(--color-text-muted)">
          for
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_GOAL_TURNS}
            aria-label="Turns for this goal"
            aria-invalid={turnsProblem ? true : undefined}
            value={turnsText}
            onChange={(event) => decision.setTurnsText(event.target.value)}
            onFocus={() => onTurnsFocusChange?.(true)}
            onBlur={() => onTurnsFocusChange?.(false)}
            className="h-6 w-14 rounded-sm border border-(--color-border) bg-(--bg-page) px-1.5 text-right font-mono text-meta text-(--color-text) outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) aria-invalid:border-(--color-error) pointer-coarse:h-9"
          />
          turns
        </label>
      )}
    </div>
  )
}
