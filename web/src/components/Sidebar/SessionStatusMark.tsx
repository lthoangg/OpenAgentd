import { Loader2 } from 'lucide-react'
import type { SessionResponse } from '@/api/types'
import { sessionWorking } from '@/lib/active-sessions'

export type SessionStatus = 'needs_input' | 'running' | 'unread' | 'idle'

/**
 * Waiting on you outranks running, which outranks unread. A lead whose
 * subagents still work is running: its own turn ended, its work did not.
 */
export function sessionStatus(session: SessionResponse, unread: boolean): SessionStatus {
  if (session.needs_input === true) return 'needs_input'
  if (sessionWorking(session)) return 'running'
  return unread ? 'unread' : 'idle'
}

const DEFAULT_LABELS: Record<Exclude<SessionStatus, 'idle'>, string> = {
  needs_input: 'Session needs your input',
  running: 'Session running',
  unread: 'Unread session',
}

/** One fixed slot per row, so titles stay aligned whatever the state. */
export function SessionStatusMark({ status, label }: { status: SessionStatus; label?: string }) {
  if (status === 'idle') return <span className="size-3 shrink-0" aria-hidden="true" />
  const name = label ?? DEFAULT_LABELS[status]
  return (
    <span role="img" aria-label={name} className="flex size-3 shrink-0 items-center justify-center">
      {status === 'needs_input' && (
        <span className="text-[11px] font-bold leading-none text-(--color-warning)" aria-hidden="true">!</span>
      )}
      {status === 'running' && <Loader2 size={11} className="animate-spin text-(--color-accent)" aria-hidden="true" />}
      {status === 'unread' && <span className="size-1.5 rounded-full bg-(--color-accent)" aria-hidden="true" />}
    </span>
  )
}
