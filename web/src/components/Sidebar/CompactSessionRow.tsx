import type React from 'react'
import type { ReactNode } from 'react'
import type { SessionResponse } from '@/api/types'
import { SessionStatusMark, type SessionStatus } from './SessionStatusMark'
import { LIST_ROW_GEOMETRY, listRowSurface, listRowText } from '@/components/ui/list-row'

/**
 * A session outside the tree (Needs you, search results): status, title,
 * workspace. ``title`` and ``meta`` replace the plain title and the
 * workspace name (search marks the match, and names the workspace above a
 * group, so its rows show their age instead).
 */
export function CompactSessionRow({
  session,
  status,
  isCurrent,
  workspaceName,
  onSelect,
  title,
  meta,
  walkable = false,
}: {
  session: SessionResponse
  status: SessionStatus
  isCurrent: boolean
  workspaceName: string
  onSelect: (event: React.MouseEvent) => void
  title?: ReactNode
  meta?: ReactNode
  /** One of the rows the sidebar's ↑/↓ walk (``SIDEBAR_ROW``). */
  walkable?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isCurrent ? 'page' : undefined}
      data-sidebar-session={walkable ? '' : undefined}
      className={`${LIST_ROW_GEOMETRY} transition-colors ${listRowSurface(isCurrent)} ${listRowText(isCurrent || status !== 'idle')}`}
    >
      <SessionStatusMark status={status} />
      <span className={`min-w-0 flex-1 truncate ${isCurrent ? 'font-medium' : ''}`}>
        {title ?? (session.title || 'Untitled')}
      </span>
      {meta ?? (
        <span className="max-w-[40%] shrink-0 truncate font-mono text-meta text-(--color-text-muted)">
          {workspaceName}
        </span>
      )}
    </button>
  )
}
