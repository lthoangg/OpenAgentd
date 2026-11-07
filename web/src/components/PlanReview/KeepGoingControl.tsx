/**
 * "Keep going until done" with its turns — the same control on the Plan tab
 * and the transcript card, so the approve label next to it is true on both.
 * A phone's review deck has no room for the words: it carries
 * ``KeepGoingToggle`` and shows the turns field above the box (``turnsOnly``).
 */
import { Repeat } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { MAX_GOAL_TURNS, type PlanDecision } from './usePlanDecision'

/** Phone deck: one toggle, the run-deck step, reading the turns while on. */
export function KeepGoingToggle({ decision }: { decision: PlanDecision }) {
  const { canKeepGoing, keepGoing, turnsText } = decision
  return (
    <button
      type="button"
      aria-label="Keep going until done"
      aria-pressed={keepGoing}
      title={decision.keepGoingHint}
      disabled={!canKeepGoing || decision.submitting}
      onClick={() => decision.setKeepGoing(!keepGoing)}
      className={cn(
        'touch-hit relative flex h-9 min-w-9 shrink-0 items-center justify-center gap-1 rounded-sm px-2 text-subhead tabular-nums transition-colors duration-(--motion-instant) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:opacity-50',
        keepGoing ? 'bg-(--color-fill-selected) text-(--color-text-on-selected)' : 'bg-(--bg-key) text-(--color-text-2)',
      )}
    >
      <Repeat size={14} aria-hidden="true" />
      {keepGoing && <span>{turnsText || '–'}</span>}
    </button>
  )
}

export function KeepGoingControl({
  decision,
  onTurnsFocusChange,
  turnsOnly = false,
  className,
}: {
  decision: PlanDecision
  /** The Plan tab keeps this row mounted while the turns field holds the phone keyboard. */
  onTurnsFocusChange?: (focused: boolean) => void
  /** Only the turns, for a phone whose deck carries the toggle. */
  turnsOnly?: boolean
  className?: string
}) {
  const { canKeepGoing, keepGoing, turnsProblem, turnsText } = decision
  return (
    <div className={cn('flex min-w-0 items-center gap-2 text-xs text-(--color-text)', className)} data-keep-going={keepGoing ? 'on' : 'off'}>
      {!turnsOnly && <Tooltip>
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
      </Tooltip>}
      {keepGoing && (
        <label className="flex items-center gap-1 text-meta text-(--color-text-muted)">
          {turnsOnly ? 'Keep going for' : 'for'}
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
