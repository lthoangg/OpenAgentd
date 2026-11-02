import { Loader2, X } from 'lucide-react'
import type { SessionResponse } from '@/api/types'
import { sessionWorking } from '@/lib/active-sessions'

export type SessionStatus = 'needs_input' | 'running' | 'unread' | 'failed' | 'idle'

/**
 * Waiting on you outranks running, which outranks unread. A lead whose
 * subagents still work is running: its own turn ended, its work did not.
 * ``failed`` is an unread session whose last turn ended in an error; the
 * caller says so, since the session payload does not.
 */
export function sessionStatus(session: SessionResponse, unread: boolean, failed = false): SessionStatus {
  if (session.needs_input === true) return 'needs_input'
  if (sessionWorking(session)) return 'running'
  if (!unread) return 'idle'
  return failed ? 'failed' : 'unread'
}

const DEFAULT_LABELS: Record<Exclude<SessionStatus, 'idle'>, string> = {
  needs_input: 'Session needs your input',
  running: 'Session running',
  unread: 'Unread session',
  failed: 'Session failed',
}

/**
 * The state in words (DESIGN.md → One name per thing). Every state has
 * words; the mark beside them is only the secondary cue.
 */
const STATE_WORDS: Record<Exclude<SessionStatus, 'idle'>, string> = {
  needs_input: 'Needs you',
  running: 'Running',
  unread: 'Done',
  failed: 'Failed',
}

const STATE_WORD_TONES: Record<Exclude<SessionStatus, 'idle'>, string> = {
  needs_input: 'text-(--accent-orange-text)',
  running: 'text-(--color-text-muted)',
  unread: 'text-(--color-text-muted)',
  failed: 'text-(--color-error)',
}

/** The word for a state; ``null`` for an idle session, which shows its age instead. */
export function sessionStateWord(status: SessionStatus): string | null {
  return status === 'idle' ? null : STATE_WORDS[status]
}

/**
 * A session's state as a word, for the row's meta slot in place of its age.
 * Decorative for assistive tech: the status mark carries the same state in
 * its label. ``className`` adds visibility rules for the row.
 */
export function SessionStateWord({ status, className = '' }: { status: SessionStatus; className?: string }) {
  if (status === 'idle') return null
  return (
    <span
      data-session-state={status}
      className={`shrink-0 whitespace-nowrap px-1 text-meta ${STATE_WORD_TONES[status]} ${className}`}
      aria-hidden="true"
    >
      {STATE_WORDS[status]}
    </span>
  )
}

/** One fixed slot per row, so titles stay aligned whatever the state. */
export function SessionStatusMark({ status, label }: { status: SessionStatus; label?: string }) {
  if (status === 'idle') return <span className="size-3 shrink-0" aria-hidden="true" />
  const name = label ?? DEFAULT_LABELS[status]
  return (
    <span role="img" aria-label={name} className="flex size-3 shrink-0 items-center justify-center">
      {status === 'needs_input' && (
        <span className="text-meta font-bold leading-none text-(--accent-orange-text)" aria-hidden="true">!</span>
      )}
      {status === 'running' && <Loader2 size={11} className="animate-spin text-(--color-accent)" aria-hidden="true" />}
      {status === 'unread' && <span className="size-1.5 rounded-full bg-(--color-accent)" aria-hidden="true" />}
      {status === 'failed' && <X size={11} strokeWidth={2.5} className="text-(--color-error)" aria-hidden="true" />}
    </span>
  )
}
