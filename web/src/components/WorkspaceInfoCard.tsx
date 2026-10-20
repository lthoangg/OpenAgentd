/**
 * WorkspaceInfoCard — workspace empty-state placeholder.
 *
 * Rendered inside ``AgentView`` (via the ``emptyState`` slot) when the user
 * has a workspace open and hasn't sent a message yet: the workspace name and
 * path, then its most recently active sessions so picking up earlier work is
 * one click. The branch and change counts live in the header.
 *
 * The chat workspace renders a chat variant instead: its root is the user's
 * home directory, so the path would just echo the account name. Pass
 * ``chatWorkspace`` to get that variant — it skips the session list too.
 */

import { Folder, MessageCircle } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useWorkspaceSessionsQuery } from '@/queries/useSessionsQuery'
import { useUnreadStore } from '@/stores/useUnreadStore'
import { formatCompactRelative } from '@/utils/format'
import { workspaceLabel } from '@/utils/workspace'
import { applySessionSelection } from './Sidebar.sessions'
import { sessionActivityTime } from './Sidebar.helpers'
import { SessionStatusMark, sessionStatus } from './Sidebar/SessionStatusMark'
import { listRowClass } from '@/components/ui/list-row'
import type { SessionResponse } from '@/api/types'

interface Props {
  workspace: string
  /** True when ``workspace`` is the chat root (see ``useChatWorkspace``). */
  chatWorkspace?: boolean
  /** The empty session on screen; left out of the recent list. */
  currentSessionId?: string | null
}

export function WorkspaceInfoCard({ workspace, chatWorkspace = false, currentSessionId = null }: Props) {
  // Same key as the sidebar's workspace list, so this adds no request there.
  const { data } = useWorkspaceSessionsQuery(workspace, !chatWorkspace)

  if (chatWorkspace) {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <MessageCircle size={16} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
          <h2 className="truncate text-sm font-medium text-(--color-text)">Chat</h2>
        </div>
        <p className="mt-2 text-xs text-(--color-text-muted)">
          OpenAgentd runs here, in your home directory. Ask about your own files by
          name, type <span className="font-medium text-(--color-text-2)">@</span> to
          reference one, or drop a file into the composer.
        </p>
      </div>
    )
  }

  const name = workspaceLabel(workspace)
  const recent = (data?.pages.flatMap((page) => page.data) ?? [])
    .filter((session) => session.id !== currentSessionId && !session.parent_session_id)
    .sort((a, b) => (sessionActivityTime(b) ?? '').localeCompare(sessionActivityTime(a) ?? ''))

  return (
    <div className="mx-auto w-full max-w-md px-4 py-4">
      <div className="flex min-w-0 items-center gap-2">
        <Folder size={16} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
        <Tooltip className="min-w-0">
          <TooltipTrigger
            className="min-w-0"
            render={<h2 className="truncate text-sm font-medium text-(--color-text)">{name}</h2>}
          />
          <TooltipContent>{name}</TooltipContent>
        </Tooltip>
      </div>

      <Tooltip className="mt-1 w-full">
        <TooltipTrigger
          className="w-full"
          render={<p className="mt-1 truncate font-mono text-xs text-(--color-text-muted)">{workspace}</p>}
        />
        <TooltipContent>{workspace}</TooltipContent>
      </Tooltip>

      {recent.length > 0 && (
        <RecentSessionsList className="mt-4" sessions={recent} workspace={workspace} label="Recent sessions" />
      )}
    </div>
  )
}

/**
 * A workspace's recent sessions as list rows (status, title, age): the empty
 * session card and the new-session screen. Picking one opens it.
 */
export function RecentSessionsList({
  sessions,
  workspace,
  label,
  className = '',
  headingLevel = 3,
}: {
  sessions: readonly SessionResponse[]
  workspace: string
  label: string
  className?: string
  /** ``2`` where the list is a top-level section (the new-session screen). */
  headingLevel?: 2 | 3
}) {
  const navigate = useNavigate()
  const unreadIds = useUnreadStore((state) => state.ids)
  const now = new Date()
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  return (
    <section aria-label={label} className={className}>
      <Heading className="mb-1 px-1.5 label-caps text-(--color-text-subtle)">{label}</Heading>
      <ul className="space-y-px">
        {sessions.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              onClick={() => applySessionSelection({ session, workspacePath: session.workspace ?? workspace, navigate })}
              className={listRowClass()}
            >
              <SessionStatusMark status={sessionStatus(session, unreadIds.includes(session.id))} />
              <span className="min-w-0 flex-1 truncate font-medium">{session.title || 'Untitled'}</span>
              <span className="shrink-0 font-mono text-[11px] text-(--color-text-subtle)">
                {formatCompactRelative(sessionActivityTime(session), now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
