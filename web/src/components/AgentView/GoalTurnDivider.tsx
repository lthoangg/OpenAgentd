import { useId, useState } from 'react'
import { InlineCodeText } from '@/components/InlineCodeText'
import { Collapsible } from '@/components/ui/collapsible'
import { TRANSCRIPT_CARD } from '@/components/ui/panel-tokens'
import { goalTurnReason, type GoalTurnInfo } from '@/lib/goal'
import { cn } from '@/lib/utils'
import { TranscriptDivider } from './TranscriptDivider'

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

  const label = (
    <span data-goal-turn-label>
      {'Goal · turn '}
      <span className="font-mono tabular-nums">{`${turn}/${maxTurns}`}</span>
      {reason.short && ` · ${reason.short}`}
      {last && <span className="text-(--accent-orange-text)">{' · last'}</span>}
    </span>
  )

  return (
    <div
      role="group"
      aria-label={`Goal continues: turn ${turn} of ${maxTurns}${last ? ', the last one' : ''}`}
      className="my-4 space-y-2"
      data-goal-turn={turn}
      data-goal-turn-why={info.why ?? 'unknown'}
    >
      <TranscriptDivider
        label={label}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        controls={bodyId}
        // Open, the same words sit under the divider. Plain text on the dark
        // hint: code spans lose their backticks.
        hint={open ? null : reason.text.replaceAll('`', '')}
      />
      <Collapsible open={open}>
        <p
          id={bodyId}
          data-goal-turn-reason
          className={cn('mx-auto max-w-xl break-words px-3 py-2 text-xs leading-relaxed text-(--color-text-2) selectable-text', TRANSCRIPT_CARD)}
        >
          <InlineCodeText text={reason.text} />
        </p>
      </Collapsible>
    </div>
  )
}
