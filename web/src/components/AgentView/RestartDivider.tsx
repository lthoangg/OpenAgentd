import { restartNoteLabel, type RestartNoteInfo } from '@/lib/restart-note'
import { TranscriptDivider } from './TranscriptDivider'

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
    <TranscriptDivider role="note" aria-label={label} className="my-4" data-restart-note={info.continued ? 'continued' : 'stopped'} label={label} />
  )
}
