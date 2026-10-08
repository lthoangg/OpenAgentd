import type React from 'react'
import type { SessionResponse } from '@/api/types'
import { SessionStatusMark, type SessionStatus } from './SessionStatusMark'
import { LIST_ROW_GEOMETRY, listRowSurface, listRowText } from '@/components/ui/list-row'

/** A session outside the tree (Needs you, search results): status, title, workspace. */
export function CompactSessionRow({
  session,
  status,
  isCurrent,
  workspaceName,
  onSelect,
}: {
  session: SessionResponse
  status: SessionStatus
  isCurrent: boolean
  workspaceName: string
  onSelect: (event: React.MouseEvent) => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isCurrent ? 'page' : undefined}
      className={`${LIST_ROW_GEOMETRY} transition-colors ${listRowSurface(isCurrent)} ${listRowText(isCurrent || status !== 'idle')}`}
    >
      <SessionStatusMark status={status} />
      <span className={`min-w-0 flex-1 truncate ${isCurrent ? 'font-semibold' : 'font-medium'}`}>
        {session.title || 'Untitled'}
      </span>
      <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-(--color-text-subtle)">
        {workspaceName}
      </span>
    </button>
  )
}
