/**
 * JumpToLatestChip — "↓ N new" on the floating composer while the reader is
 * scrolled away from the live end of the transcript.
 */
import { ArrowDown } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'

export function JumpToLatestChip({ below = false }: { below?: boolean }) {
  const unseen = useTranscriptFollowStore((s) => s.unseen)
  if (unseen === null) return null
  return (
    <button
      type="button"
      data-side={below ? 'below' : 'above'}
      onClick={() => useTranscriptFollowStore.getState().jumpToLatest?.()}
      aria-label={unseen > 0 ? `Jump to latest, ${unseen} new` : 'Jump to latest'}
      // Centred by margin against ``inset-x-0`` (DESIGN.md: no transform
      // layout). The gap clears the composer's drag grip.
      className={cn(
        'pointer-events-auto absolute inset-x-0 z-10 mx-auto flex h-7 w-fit items-center gap-1 rounded-full border border-(--color-border) bg-(--bg-card) px-2 text-xs text-(--color-text-2) shadow-(--shadow-depth) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) active:scale-95 motion-reduce:active:scale-100',
        below ? 'top-full mt-3' : 'bottom-full mb-3',
      )}
    >
      <ArrowDown size={13} aria-hidden="true" />
      {unseen > 0 && <span className="pr-0.5 font-medium tabular-nums">{unseen} new</span>}
    </button>
  )
}
