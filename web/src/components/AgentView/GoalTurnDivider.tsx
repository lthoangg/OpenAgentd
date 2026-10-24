import { Target } from 'lucide-react'

/**
 * Where a goal started a turn on its own. Stands in for the user bubble: the
 * agent read a hidden reminder there, which the user never wrote. Drawn like
 * the compaction divider (hairline, centred mono label), since both mark
 * something the session did rather than something anyone said. The goal's
 * last allowed turn says so.
 */
export function GoalTurnDivider({ turn, maxTurns }: { turn: number; maxTurns: number }) {
  const last = turn >= maxTurns
  return (
    <div
      role="separator"
      aria-label={`Goal continues: turn ${turn} of ${maxTurns}${last ? ', the last one' : ''}`}
      className="my-4 flex items-center gap-3 select-none"
      data-goal-turn={turn}
    >
      <span aria-hidden="true" className="h-px flex-1 bg-(--color-border)" />
      <span className="inline-flex items-center gap-1.5 font-mono text-xs text-(--color-text-2)">
        <Target size={12} aria-hidden="true" className="shrink-0 text-(--color-text-subtle)" />
        <span>
          {`Goal · turn ${turn} of ${maxTurns}`}
          {last && <span className="text-(--accent-orange-text)">{' · last'}</span>}
        </span>
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-(--color-border)" />
    </div>
  )
}
