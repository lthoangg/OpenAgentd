/**
 * GoalRing — the small ring that stands for a session goal: filled and
 * pulsing while it works, hollow while it is paused or waits, in the colour
 * of its status (blue working, orange waiting on the user, neutral paused,
 * red blocked). Used on the header's Task list button.
 */
import { cn } from '@/lib/utils'
import type { GoalTone } from '@/lib/goal'

const TONE_CLASS: Record<GoalTone, string> = {
  active: 'text-(--accent-blue-text)',
  achieved: 'text-(--accent-blue-text)',
  wait: 'text-(--accent-orange-text)',
  paused: 'text-(--color-text-2)',
  blocked: 'text-(--color-error)',
}

export function GoalRing({ tone, className }: { tone: GoalTone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-goal-ring={tone}
      className={cn(
        'relative size-2.5 shrink-0 rounded-full border-2 border-current',
        TONE_CLASS[tone],
        tone === 'active' && 'animate-pulse motion-reduce:animate-none',
        className,
      )}
    >
      {(tone === 'active' || tone === 'blocked') && <span className="absolute inset-px rounded-full bg-current" />}
    </span>
  )
}
