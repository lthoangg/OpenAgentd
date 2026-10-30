import { restartNoteLabel, type RestartNoteInfo } from '@/lib/restart-note'

/**
 * Where a server restart cut the session's turn off. Stands in for the user
 * bubble the note would otherwise be (the agent reads its text; the user
 * never wrote it). Drawn like the goal and compaction dividers: a hairline
 * with a centred label, since it marks something the session did. No icon:
 * a circular arrow read as a Retry button.
 */
export function RestartDivider({ info }: { info: RestartNoteInfo }) {
  const label = restartNoteLabel(info)
  return (
    <div role="note" aria-label={label} className="my-4 flex items-center gap-3 select-none" data-restart-note={info.continued ? 'continued' : 'stopped'}>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-(--color-border)" />
      <span className="min-w-0 px-1 text-center text-xs text-(--color-text-muted)">{label}</span>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-(--color-border)" />
    </div>
  )
}
