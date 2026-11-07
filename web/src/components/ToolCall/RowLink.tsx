/**
 * RowLink — a tool row's own "open it" control (a team call's subagent, a
 * workspace message's session), drawn inside the row line instead of on a
 * row of its own under it (user request: the old controls were bulky).
 *
 * The tool row is itself a button, so the control cannot be one inside it.
 * It comes in two parts: ``RowLinkChip`` is the drawn chip, in the row,
 * which a tap or click opens (and stops, so the row does not also unfold);
 * ``RowLinkButton`` is the real button, beside the row and visually hidden,
 * for keyboard and screen readers. Focusing it rings the chip (index.css).
 */
import type { ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'

import { Chip } from '@/components/ui/chip'
import { cn } from '@/lib/utils'
import { subagentStatusView } from './subagentStatus'
import { openSubagentSession } from './SubagentRow'
import { useSubagentRoster } from './useSubagentRoster'

export function RowLinkChip({ onOpen, title, className, children }: {
  /** Absent: the chip only informs (a subagent whose session is not known yet). */
  onOpen?: () => void
  title?: string
  className?: string
  children: ReactNode
}) {
  return (
    <span
      aria-hidden="true"
      data-row-link=""
      title={title}
      onClick={onOpen ? (event) => { event.stopPropagation(); onOpen() } : undefined}
      className={cn(
        'relative inline-flex h-5 shrink-0 items-center gap-1 self-center rounded-xs px-1 text-meta text-(--color-text-2)',
        onOpen && 'touch-hit cursor-pointer transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) active:bg-(--bg-key)',
        className,
      )}
    >
      {children}
      {onOpen && <ArrowUpRight size={12} aria-hidden="true" className="shrink-0 text-(--color-text-muted)" />}
    </span>
  )
}

export function RowLinkButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button type="button" data-row-link-button="" aria-label={label} onClick={onOpen} className="sr-only">
      {label}
    </button>
  )
}

/** Where a team call's subagent is now, from the live roster. */
function useTeamMember(handle: string) {
  const live = useSubagentRoster(true)?.get(handle)
  const view = subagentStatusView(live?.status ?? null, live?.has_pending_question === true)
  const sessionId = live?.session_id || null
  return { view, sessionId }
}

/**
 * The subagent's state in words, in the team call's row; it opens the
 * session. No timer: the row keeps its room for the target, and the
 * subagent's own session shows how long it has run.
 */
export function TeamMemberChip({ handle }: { handle: string }) {
  const { view, sessionId } = useTeamMember(handle)
  if (!view && !sessionId) return null
  return (
    <RowLinkChip onOpen={sessionId ? () => openSubagentSession(sessionId) : undefined} title={sessionId ? `Open ${handle}'s session` : undefined}>
      {view && (
        <Chip tone={view.tone} spinner={view.spinner} dot={view.waiting} data-subagent-status={view.label}>
          {view.label}
        </Chip>
      )}
    </RowLinkChip>
  )
}

export function TeamMemberButton({ handle }: { handle: string }) {
  const { view, sessionId } = useTeamMember(handle)
  if (!sessionId) return null
  return <RowLinkButton label={`Open ${handle} session${view ? `, ${view.label}` : ''}`} onOpen={() => openSubagentSession(sessionId)} />
}
