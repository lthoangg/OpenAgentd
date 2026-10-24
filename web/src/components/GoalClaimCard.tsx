/**
 * The ``update_goal`` call as a goal-check card, in the transcript's card
 * family (plan reviews, questions): a caps header strip, then what the check
 * made of the claim, then the evidence the agent claimed.
 *
 * Colour carries the outcome only. The achieved and blocked cards tint their
 * header strip (success, error); a claim being checked or not yet accepted
 * stays neutral, with an orange "Not yet" as its one accent. The evidence
 * starts open on an achieved goal, since it is what the user judges, and
 * closed while the agent keeps working.
 */
import { memo, useId, useMemo, useState } from 'react'
import { ChevronRight, CircleAlert, CircleCheck, Target } from 'lucide-react'
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
        className="inline-flex items-center gap-1 rounded-xs py-0.5 text-[11px] text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40 pointer-coarse:min-h-9"
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

const FRAME: Record<CardKind, { title: string; icon: typeof Target; border: string; header: string }> = {
  checking: { title: 'Goal check', icon: Target, border: 'border-(--color-border)', header: 'border-(--color-border) text-(--color-text-muted)' },
  rejected: { title: 'Goal check', icon: Target, border: 'border-(--color-border)', header: 'border-(--color-border) text-(--color-text-muted)' },
  unchecked: { title: 'Goal check', icon: Target, border: 'border-(--color-border)', header: 'border-(--color-border) text-(--color-text-muted)' },
  achieved: {
    title: 'Goal achieved',
    icon: CircleCheck,
    border: 'border-(--color-success)/30',
    header: 'border-(--color-success)/30 bg-(--color-success-subtle) text-(--accent-green-text)',
  },
  blocked: {
    title: 'Goal blocked',
    icon: CircleAlert,
    border: 'border-(--color-error)/25',
    header: 'border-(--color-error)/25 bg-(--color-error-subtle) text-(--color-error)',
  },
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
        <span className="font-semibold text-(--color-text)">Update Goal</span>: {claim.text.split('\n')[0]}
      </p>
    )
  }

  const frame = FRAME[claim.kind]
  const Icon = frame.icon

  return (
    <section
      aria-label={frame.title}
      data-goal-claim={claim.kind}
      className={cn('my-2 overflow-hidden rounded-md border bg-(--bg-card)', frame.border, animatesIn && 'tool-row-enter')}
    >
      <div className={cn('flex items-center gap-1.5 border-b px-3 py-1.5 label-caps', frame.header)}>
        <Icon size={12} aria-hidden className={cn(claim.kind === 'checking' && 'animate-pulse motion-reduce:animate-none')} />
        {frame.title}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 px-3 py-2">
        {claim.kind === 'checking' && (
          <span role="status" className="text-[11px] leading-relaxed font-medium text-(--color-text-muted)">
            <span className="animate-pulse motion-reduce:animate-none">Checking the claim…</span>
          </span>
        )}
        {claim.kind === 'rejected' && (
          <span className="text-[11px] leading-relaxed">
            <span className="font-medium text-(--accent-orange-text)">{claim.paused ? 'Not met' : 'Not yet'}</span>
            <span className="text-(--color-text-muted)">{claim.paused ? ' · goal paused until you resume it' : ' · the agent keeps working'}</span>
          </span>
        )}
        {claim.kind === 'unchecked' && (
          <span className="text-[11px] leading-relaxed">
            <span className="font-medium text-(--color-text-2)">Check failed</span>
            <span className="text-(--color-text-muted)">{claim.paused ? ' · goal paused until you resume it' : ' · the agent can claim again'}</span>
          </span>
        )}
        {claim.kind !== 'checking' && claim.reason && (
          <p className="text-xs leading-relaxed break-words text-(--color-text) selectable-text"><InlineCodeText text={claim.reason} /></p>
        )}
        {claim.kind === 'blocked' && (
          <span className="text-[11px] leading-relaxed text-(--color-text-muted)">Paused until you resume it</span>
        )}
        {claim.kind !== 'blocked' && claim.evidence.length > 0 && (
          <Evidence items={claim.evidence} label={claim.kind === 'achieved' ? 'Evidence' : 'Claimed evidence'} defaultOpen={claim.kind === 'achieved'} />
        )}
      </div>
    </section>
  )
})
