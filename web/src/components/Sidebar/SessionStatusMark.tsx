import { Loader2, X } from 'lucide-react'
import type { SessionResponse } from '@/api/types'
import { IconSwap } from '@/components/ui/swap'
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
 * The state in words (DESIGN.md → One name per thing), for surfaces without
 * the mark (the ⌘L switcher) and for a row's tooltip. Sidebar rows show the
 * mark alone; its label carries the state for assistive tech.
 */
const STATE_WORDS: Record<Exclude<SessionStatus, 'idle'>, string> = {
  needs_input: 'Needs you',
  running: 'Running',
  unread: 'Done',
  failed: 'Failed',
}

/** The word for a state; ``null`` for an idle session, which shows its age instead. */
export function sessionStateWord(status: SessionStatus): string | null {
  return status === 'idle' ? null : STATE_WORDS[status]
}

/**
 * One fixed slot per row, so titles stay aligned whatever the state. A new
 * state replaces the old mark the SF Symbols way (``IconSwap``): the spinner
 * shrinks away as the dot or ✗ springs up.
 */
export function SessionStatusMark({ status, label }: { status: SessionStatus; label?: string }) {
  const idle = status === 'idle'
  return (
    <span
      role={idle ? undefined : 'img'}
      aria-label={idle ? undefined : label ?? DEFAULT_LABELS[status]}
      aria-hidden={idle || undefined}
      className="flex size-3 shrink-0 items-center justify-center"
    >
      <IconSwap swapKey={status}>
        {status === 'needs_input' && (
          <span className="text-meta font-bold leading-none text-(--accent-orange-text)" aria-hidden="true">!</span>
        )}
        {status === 'running' && <Loader2 size={12} className="animate-spin text-(--color-text-2)" aria-hidden="true" />}
        {status === 'unread' && <span className="size-1.5 rounded-full bg-(--color-accent)" aria-hidden="true" />}
        {status === 'failed' && <X size={12} strokeWidth={2.5} className="text-(--color-error)" aria-hidden="true" />}
      </IconSwap>
    </span>
  )
}
