import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { InlineCodeText } from '@/components/InlineCodeText'
import { Collapsible } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { goalTurnReason, type GoalTurnInfo } from '@/lib/goal'
import { cn } from '@/lib/utils'

/**
 * Where a goal started a turn on its own. Stands in for the user bubble: the
 * agent read a hidden reminder there, which the user never wrote. Drawn like
 * the compaction divider (hairline, centred label, numbers in mono), since
 * both mark something the session did rather than something anyone said.
 *
 * The label says why the goal went on in a few words
 * ("Goal · turn 2/50 · not yet"). Hovering it (desktop) shows the full reason, and pressing it
 * (any device, since touch has no hover) opens it under the divider: the
 * check's own words when it rejected a claim. The goal's last allowed turn
 * says so.
 */
export function GoalTurnDivider({ info }: { info: GoalTurnInfo }) {
  const { turn, maxTurns } = info
  const last = turn >= maxTurns
  const reason = goalTurnReason(info)
  const [open, setOpen] = useState(false)
  const bodyId = useId()

  const toggle = (
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      aria-controls={bodyId}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-xs px-1 text-center text-xs text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:min-h-9"
    >
      <span data-goal-turn-label>
        {'Goal · turn '}
        <span className="font-mono tabular-nums">{`${turn}/${maxTurns}`}</span>
        {reason.short && ` · ${reason.short}`}
        {last && <span className="text-(--accent-orange-text)">{' · last'}</span>}
      </span>
      <ChevronRight
        size={12}
        aria-hidden="true"
        className={cn('shrink-0 text-(--color-text-subtle) transition-transform duration-(--motion-fast) ease-(--ease-out)', open && 'rotate-90')}
      />
    </button>
  )

  return (
    <div
      role="group"
      aria-label={`Goal continues: turn ${turn} of ${maxTurns}${last ? ', the last one' : ''}`}
      className="my-4 space-y-2"
      data-goal-turn={turn}
      data-goal-turn-why={info.why ?? 'unknown'}
    >
      <div className="flex items-center gap-3 select-none">
        <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-(--color-border)" />
        <Tooltip className="shrink">
          <TooltipTrigger render={toggle} />
          {/* Open, the same words sit under the divider. */}
          {!open && (
            <TooltipContent className="max-w-sm leading-relaxed">
              {/* Plain text on the dark hint: code spans lose their backticks. */}
              {reason.text.replaceAll('`', '')}
            </TooltipContent>
          )}
        </Tooltip>
        <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-(--color-border)" />
      </div>
      <Collapsible open={open}>
        <p
          id={bodyId}
          data-goal-turn-reason
          className="mx-auto max-w-xl break-words rounded-sm border border-(--color-border-subtle) bg-(--bg-card) px-3 py-2 text-xs leading-relaxed text-(--color-text-2) selectable-text"
        >
          <InlineCodeText text={reason.text} />
        </p>
      </Collapsible>
    </div>
  )
}
