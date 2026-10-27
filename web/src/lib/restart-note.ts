/**
 * The note a server restart leaves in a transcript (``extra.restart_resume``,
 * written by ``appv3_agent::restart_resume``): the turn that was running is
 * continued once, or, cut off again, left stopped. The agent reads the
 * note's text; the user sees a divider, never a prompt bubble.
 */
import type { ContentBlock } from '@/api/types'

/** Matches ``appv3_agent::restart_resume::NOTE_KEY``. */
export const RESTART_NOTE_KEY = 'restart_resume'

export interface RestartNoteInfo {
  /** The turn runs again (false: a second restart cut it off and it stays stopped). */
  continued: boolean
}

/** Whether a row's or block's ``extra`` is a restart note. */
export function isRestartNoteExtra(extra: Record<string, unknown> | null | undefined): boolean {
  const note = extra?.[RESTART_NOTE_KEY]
  return note != null && typeof note === 'object'
}

export function restartNoteInfo(block: ContentBlock): RestartNoteInfo | null {
  if (block.type !== 'user' || !isRestartNoteExtra(block.extra)) return null
  const note = block.extra?.[RESTART_NOTE_KEY] as { continued?: unknown }
  return { continued: note.continued !== false }
}

/** The divider's words. */
export function restartNoteLabel(info: RestartNoteInfo): string {
  return info.continued ? 'Continued after a server restart' : 'Stopped by a server restart · not continued again'
}
