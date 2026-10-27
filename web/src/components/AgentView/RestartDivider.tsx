import { RotateCcw } from 'lucide-react'
import { restartNoteLabel, type RestartNoteInfo } from '@/lib/restart-note'

/**
 * Where a server restart cut the session's turn off. Stands in for the user
 * bubble the note would otherwise be (the agent reads its text; the user
 * never wrote it). Drawn like the goal and compaction dividers: a hairline
 * with a centred mono label, since it marks something the session did.
 */
export function RestartDivider({ info }: { info: RestartNoteInfo }) {
  const label = restartNoteLabel(info)
  return (
    <div role="note" aria-label={label} className="my-4 flex items-center gap-3 select-none" data-restart-note={info.continued ? 'continued' : 'stopped'}>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-(--color-border)" />
      <span className="inline-flex min-w-0 items-center gap-1.5 px-1 text-center font-mono text-xs text-(--color-text-2)">
        <RotateCcw size={12} aria-hidden="true" className="shrink-0 text-(--color-text-subtle)" />
        <span>{label}</span>
      </span>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-(--color-border)" />
    </div>
  )
}
