/**
 * Wires ``buildSwitchCommands`` to live data and to the code paths the
 * sidebar's session switch and new-session buttons already use. The session
 * and workspace-tree queries share their keys with the sidebar, so listing
 * workspaces adds no requests on desktop; opening a workspace's page loads
 * that workspace's sessions.
 */
import { useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { getCodingWorkspaceTree, listSessions } from '@/api/client'
import { startNewSession } from '@/lib/new-session'
import { queryKeys } from '@/queries'
import { useSessionsQuery } from '@/queries/useSessionsQuery'
import { applySessionSelection } from '../Sidebar.sessions'
import type { Command } from '../CommandPalette'
import { buildSwitchCommands } from './paletteSwitchCommands'

const WORKSPACE_TREE_STALE_MS = 30_000
// Enough for a workspace's recent history; older sessions stay in the sidebar.
const WORKSPACE_SESSION_LIMIT = 50

export function usePaletteSwitchCommands({
  workspace,
  sessionId,
}: {
  workspace: string | null
  sessionId: string | null
}): Command[] {
  const navigate = useNavigate()
  const { data: sessionPages } = useSessionsQuery()
  const { data: tree = null } = useQuery({
    queryKey: queryKeys.coding.tree(),
    queryFn: getCodingWorkspaceTree,
    staleTime: WORKSPACE_TREE_STALE_MS,
  })

  // The workspace whose session page was opened last.
  const [openedWorkspace, setOpenedWorkspace] = useState<string | null>(null)
  // One page, kept in the infinite-list shape so the event stream's in-place
  // row patches (running, needs input, renames) reach it like the sidebar's.
  const { data: workspacePages } = useInfiniteQuery({
    queryKey: queryKeys.session.sessions.palette(openedWorkspace ?? ''),
    queryFn: ({ signal }) => listSessions(null, WORKSPACE_SESSION_LIMIT, { workspace: openedWorkspace, sort: 'activity' }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: () => undefined,
    enabled: openedWorkspace !== null,
    refetchOnWindowFocus: false,
  })

  return useMemo(() => buildSwitchCommands(
    {
      currentSessionId: sessionId,
      currentWorkspace: workspace,
      sessions: sessionPages?.pages.flatMap((page) => page.data) ?? [],
      tree,
      workspaceSessions: openedWorkspace && workspacePages
        ? { path: openedWorkspace, sessions: workspacePages.pages.flatMap((page) => page.data) }
        : null,
    },
    {
      openSession: (session) => applySessionSelection({ session, workspacePath: session.workspace ?? '', navigate }),
      newSession: (path) => {
        startNewSession({ navigate, workspace: path, current: { sessionId, workspace } })
      },
      loadWorkspace: setOpenedWorkspace,
    },
  ), [navigate, openedWorkspace, sessionId, sessionPages, tree, workspace, workspacePages])
}
