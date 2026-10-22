/**
 * JumpToLatestChip — "↓ N new" on the floating composer while the reader is
 * scrolled away from the live end of the transcript.
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

export function JumpToLatestChip({ below = false }: { below?: boolean }) {
  const unseen = useTranscriptFollowStore((s) => s.unseen)
  const [lastUnseen, setLastUnseen] = useState(unseen ?? 0)
  if (unseen !== null && unseen !== lastUnseen) setLastUnseen(unseen)
  const { mounted, closing } = useDeferredUnmount(unseen !== null, DURATIONS_S.fast * 1000)
  if (!mounted && unseen === null) return null
  const count = unseen ?? lastUnseen
  const leaving = closing || unseen === null
  return (
    <button
      type="button"
      data-side={below ? 'below' : 'above'}
      onClick={() => useTranscriptFollowStore.getState().jumpToLatest?.()}
      aria-label={count > 0 ? `Jump to latest, ${count} new` : 'Jump to latest'}
      aria-hidden={leaving || undefined}
      inert={leaving}
      // Centred by margin against ``inset-x-0`` (DESIGN.md: no transform
      // layout). The gap clears the composer's drag grip.
      className={cn(
        'absolute inset-x-0 z-10 mx-auto flex h-7 w-fit items-center gap-1 rounded-full border border-(--color-border) bg-(--bg-card) px-2 text-xs text-(--color-text-2) shadow-(--shadow-depth) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) active:scale-95 motion-reduce:active:scale-100',
        below ? 'top-full mt-3' : 'bottom-full mb-3',
        leaving
          ? 'pointer-events-none animate-out fade-out-0 zoom-out-95 fill-mode-forwards animation-duration-(--motion-fast) ease-(--ease-in-out)'
          : cn('pointer-events-auto animate-in fade-in-0 zoom-in-95 animation-duration-(--motion-base) ease-(--ease-out)', below ? 'slide-in-from-top-1' : 'slide-in-from-bottom-1'),
      )}
    >
      <ArrowDown size={13} aria-hidden="true" />
      {count > 0 && <span className="pr-0.5 font-medium tabular-nums">{count} new</span>}
    </button>
  )
}
