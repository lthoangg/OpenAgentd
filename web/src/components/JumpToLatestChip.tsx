/**
 * JumpToLatestChip — "↓ N new" while the reader is scrolled away from the
 * live end of the transcript, or "↓ Jump to latest" when nothing new has
 * arrived. The one jump control: on the floating composer, or in the
 * transcript itself when there is no composer (a subagent's session).
 *
 * It rises in at ``base`` and fades out at ``fast`` (DESIGN.md → Motion);
 * while it fades it is out of reach and keeps its last count.
 */
import { useState } from 'react'
import { ArrowDown } from 'lucide-react'

import { cn } from '@/lib/utils'
import { DURATIONS_S } from '@/lib/motion'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import { useDeferredUnmount } from './ui/_use-deferred-unmount'
import { RollingNumber } from './ui/swap'
import { useIsPhone } from '@/hooks/use-is-phone'

/** Where the chip floats: above or below the composer, or inside the transcript's own corner. */
type ChipSide = 'above' | 'below' | 'inside'

const SIDE_CLASS: Record<ChipSide, string> = {
  above: 'bottom-full mb-3',
  below: 'top-full mt-3',
  inside: 'bottom-4',
}

/**
 * The chip itself. ``unseen`` is ``null`` while the transcript follows its
 * live end (the chip is out of reach), else the blocks that arrived since the
 * reader scrolled away.
 */
export function JumpToLatest({ unseen, onJump, side = 'above', fadeOut = true }: {
  unseen: number | null
  onJump: () => void
  side?: ChipSide
  /** Fade out when the reader is back at the live end, rather than vanish. */
  fadeOut?: boolean
}) {
  const [lastUnseen, setLastUnseen] = useState(unseen ?? 0)
  if (unseen !== null && unseen !== lastUnseen) setLastUnseen(unseen)
  const { mounted, closing } = useDeferredUnmount(unseen !== null, DURATIONS_S.fast * 1000)
  // A phone: a round ↓ at the right corner with a count badge (mockup J4).
  const isPhone = useIsPhone()
  if (unseen === null && (!fadeOut || !mounted)) return null
  const count = unseen ?? lastUnseen
  const leaving = closing || unseen === null
  return (
    <button
      type="button"
      data-side={side}
      onClick={onJump}
      aria-label={count > 0 ? `Jump to latest, ${count} new` : 'Jump to latest'}
      aria-hidden={leaving || undefined}
      inert={leaving}
      // Centred by margin against ``inset-x-0`` (DESIGN.md: no transform
      // layout). The gap clears the composer's drag grip. On touch it is
      // sized like the run deck: 36px tall, its words 13px on a phone, where
      // ``text-xs`` is 17px; ``touch-hit`` grows the touch area to 44px.
      data-jump-round={isPhone || undefined}
      className={cn(
        isPhone
          ? 'absolute right-3 z-10 flex size-11 items-center justify-center rounded-full bg-(--bg-card) text-(--color-text-2) shadow-(--shadow-depth) active:scale-95 motion-reduce:active:scale-100'
          : 'touch-hit absolute inset-x-0 z-10 mx-auto flex h-7 w-fit items-center gap-1 rounded-full bg-(--bg-card) px-2.5 text-xs text-(--color-text-2) shadow-(--shadow-depth) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) active:scale-95 motion-reduce:active:scale-100 pointer-coarse:h-9 pointer-coarse:px-3 phone:text-meta',
        SIDE_CLASS[side],
        leaving
          ? 'pointer-events-none animate-out fade-out-0 zoom-out-95 fill-mode-forwards animation-duration-(--motion-fast) ease-(--ease-in-out)'
          : cn('pointer-events-auto animate-in fade-in-0 zoom-in-95 animation-duration-(--motion-base) ease-(--ease-out)', side === 'below' ? 'slide-in-from-top-1' : 'slide-in-from-bottom-1'),
      )}
    >
      {isPhone ? (
        <>
          <ArrowDown size={20} aria-hidden="true" />
          {count > 0 && (
            <span aria-hidden="true" className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-(--color-text) px-1 text-meta font-semibold tabular-nums text-(--bg-page)">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </>
      ) : (
        <>
          <ArrowDown size={13} aria-hidden="true" />
          <span className="pr-0.5 font-medium tabular-nums">
            {count > 0 ? <RollingNumber text={String(count)} value={count} suffix=" new" /> : 'Jump to latest'}
          </span>
        </>
      )}
    </button>
  )
}

/** The chip on the floating composer, fed by the transcript's follow state. */
export function JumpToLatestChip({ below = false }: { below?: boolean }) {
  const unseen = useTranscriptFollowStore((s) => s.unseen)
  return (
    <JumpToLatest
      unseen={unseen}
      side={below ? 'below' : 'above'}
      onJump={() => useTranscriptFollowStore.getState().jumpToLatest?.()}
    />
  )
}
