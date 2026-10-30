/**
 * The ``update_goal`` call as a goal-check card, in the transcript's card
 * family (plan reviews, questions): a caps "Goal check" strip with the
 * outcome chip, then what the check made of the claim, then the evidence
 * the agent claimed.
 *
 * Colour carries the outcome only, on the chip: blue while checking or once
 * achieved, orange for "not yet", red for blocked. The evidence starts open
 * on an achieved goal, since it is what the user judges, and closed while
 * the agent keeps working.
 */
import { memo, useId, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Chip, type ChipTone } from '@/components/ui/chip'
import { InlineCodeText } from '@/components/InlineCodeText'
import { Collapsible } from '@/components/ui/collapsible'
import { parseGoalClaim, type GoalClaim } from '@/lib/goal'
import { cn } from '@/lib/utils'

function Evidence({ items, label, defaultOpen }: { items: string[]; label: string; defaultOpen: boolean }) {
  // Follows the outcome (opens when a live claim is accepted) until the user
  // toggles it; from then on it stays the way they left it.
  const [toggled, setToggled] = useState<boolean | null>(null)
  const open = toggled ?? defaultOpen
  const listId = useId()
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setToggled(!open)}
        aria-expanded={open}
        aria-controls={listId}
        className="inline-flex items-center gap-1 rounded-xs py-0.5 text-[11px] text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring) pointer-coarse:min-h-11"
      >
        <ChevronRight
          size={12}
          aria-hidden
          className={cn('shrink-0 transition-transform duration-(--motion-fast) ease-(--ease-out)', open && 'rotate-90')}
        />
        {`${label} · ${items.length}`}
      </button>
      <Collapsible open={open}>
        <ul id={listId} className="mt-1 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-(--color-text-2) marker:text-(--color-text-subtle) selectable-text">
          {items.map((item, i) => <li key={i} className="break-words"><InlineCodeText text={item} /></li>)}
        </ul>
      </Collapsible>
    </div>
  )
}

type CardKind = Exclude<GoalClaim['kind'], 'other'>

/**
 * One card frame for every outcome (DESIGN.md → Transcript cards): a caps
 * "Goal check" strip with the outcome as a chip on its right. Colour sits
 * on the chip only; the frame stays neutral.
 */
const OUTCOME: Record<CardKind, { label: string; tone: ChipTone; dot?: boolean }> = {
  checking: { label: 'checking…', tone: 'info', dot: true },
  rejected: { label: 'not yet', tone: 'warning' },
  unchecked: { label: 'check failed', tone: 'neutral' },
  achieved: { label: 'achieved', tone: 'info' },
  blocked: { label: 'blocked', tone: 'error' },
}

export const GoalClaimCard = memo(function GoalClaimCard({ args, result, done, animatesIn = false }: {
  args?: string
  result?: string
  done?: boolean
  /** Mounted while the claim was live: slide in like a new tool row. */
  animatesIn?: boolean
}) {
  const claim = useMemo(() => parseGoalClaim(args, result, Boolean(done)), [args, result, done])

  // A reply the card cannot read (no goal, bad arguments) stays a plain tool row.
  if (claim.kind === 'other') {
    return (
      <p className="my-2 py-1 font-mono text-xs text-(--color-text-muted)">
        <span className="font-medium text-(--color-text)">update_goal</span> {claim.text.split('\n')[0]}
      </p>
    )
  }

  const outcome = OUTCOME[claim.kind]
  const outcomeLabel = claim.kind === 'rejected' && claim.paused ? 'not met' : outcome.label

  return (
    <section
      aria-label={`Goal check: ${outcomeLabel}`}
      data-goal-claim={claim.kind}
      className={cn('my-2 overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card)', animatesIn && 'tool-row-enter')}
    >
      <div className="flex items-center justify-between gap-2 border-b border-(--color-border) px-3 py-1.5">
        <span className="label-caps text-(--color-text-muted)">Goal check</span>
        <Chip tone={outcome.tone} dot={outcome.dot} role={claim.kind === 'checking' ? 'status' : undefined}>{outcomeLabel}</Chip>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 px-3 py-2">
        {claim.kind === 'checking' && (
          <span className="text-[11px] leading-relaxed text-(--color-text-muted)">A separate check is reviewing the claim.</span>
        )}
        {claim.kind === 'rejected' && (
          <span className="text-[11px] leading-relaxed text-(--color-text-muted)">
            {claim.paused ? 'Goal paused until you resume it.' : 'The agent keeps working.'}
          </span>
        )}
        {claim.kind === 'unchecked' && (
          <span className="text-[11px] leading-relaxed text-(--color-text-muted)">
            {claim.paused ? 'The check could not run. Goal paused until you resume it.' : 'The check could not run. The agent can claim again.'}
          </span>
        )}
        {claim.kind !== 'checking' && claim.reason && (
          <p className="text-xs leading-relaxed break-words text-(--color-text) selectable-text"><InlineCodeText text={claim.reason} /></p>
        )}
        {claim.kind === 'blocked' && (
          <span className="text-[11px] leading-relaxed text-(--color-text-muted)">Goal paused until you resume it.</span>
        )}
        {claim.kind !== 'blocked' && claim.evidence.length > 0 && (
          <Evidence items={claim.evidence} label="Evidence" defaultOpen={claim.kind === 'achieved'} />
        )}
      </div>
    </section>
  )
})
