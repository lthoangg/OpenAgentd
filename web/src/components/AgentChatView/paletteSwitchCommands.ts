/**
 * The command palette's Switch Workspace/Session…: a list of workspaces, each
 * opening its sessions, with New Session on top.
 *
 * Pure so the list is testable from plain query data; ``usePaletteSwitchCommands``
 * gathers the inputs and wires the handlers to the same code paths the
 * sidebar uses.
 */
import type {
  CodingWorkspaceTreeResponse,
  SessionResponse,
} from '@/api/types'
import type { Command } from '../CommandPalette'
import { formatCompactRelative } from '@/utils/format'
import { sameWorkspacePath } from '@/utils/workspace'
import { sessionActivityTime } from '../Sidebar.helpers'

export interface SwitchCommandsInput {
  currentSessionId: string | null
  currentWorkspace: string | null
  /** Recent top-level sessions across workspaces, as the sidebar lists them. */
  sessions: SessionResponse[]
  /** ``null`` until the workspace tree has loaded. */
  tree: CodingWorkspaceTreeResponse | null
  /**
   * The full session list of the workspace whose page was opened. Until it
   * loads, that page shows the workspace's rows from ``sessions``.
   */
  workspaceSessions?: { path: string; sessions: SessionResponse[] } | null
  now?: Date
}

export interface SwitchCommandHandlers {
  openSession: (session: SessionResponse) => void
  /** A new-session draft in ``path``. */
  newSession: (path: string) => void
  /** The page of ``path`` opened: load its sessions. */
  loadWorkspace: (path: string) => void
}

function sessionStatus(session: SessionResponse, now: Date): string {
  // ``needs_input`` implies ``running``, so it is checked first.
  if (session.needs_input) return 'Needs you'
  if (session.running) return 'Running'
  return formatCompactRelative(sessionActivityTime(session), now)
}

function byRecency(a: SessionResponse, b: SessionResponse): number {
  return (sessionActivityTime(b) ?? '').localeCompare(sessionActivityTime(a) ?? '')
}

function sessionPage(
  path: string,
  label: string,
  input: SwitchCommandsInput,
  handlers: SwitchCommandHandlers,
  now: Date,
): Command[] {
  const loaded = input.workspaceSessions && sameWorkspacePath(input.workspaceSessions.path, path)
    ? input.workspaceSessions.sessions
    : input.sessions
  const sessions = loaded
    .filter((s) => s.id !== input.currentSessionId && !s.parent_session_id && sameWorkspacePath(s.workspace, path))
    .sort(byRecency)
    .map((s): Command => ({
      id: `session:${s.id}`,
      label: s.title?.trim() || 'Untitled session',
      description: sessionStatus(s, now),
      action: () => handlers.openSession(s),
    }))
  return [
    {
      id: `new-session:${path}`,
      label: 'New Session',
      description: `Start a fresh conversation in ${label}`,
      browseOnly: true,
      action: () => handlers.newSession(path),
    },
    ...sessions,
  ]
}

function workspaceCommands(input: SwitchCommandsInput, handlers: SwitchCommandHandlers, now: Date): Command[] {
  const tree = input.tree
  if (!tree) return []
  const rows: { path: string; label: string; description: string }[] = []
  if (tree.chat) rows.push({ path: tree.chat.path, label: tree.chat.name, description: 'Chat workspace' })
  for (const repo of tree.repositories) {
    rows.push({ path: repo.path, label: repo.name, description: repo.path })
    for (const wt of repo.worktrees) rows.push({ path: wt.path, label: wt.name, description: `Worktree of ${repo.name}` })
  }
  // The tree has no last-used time; the newest session in a workspace is the
  // best recency signal. Workspaces without sessions keep tree order.
  const lastActive = new Map<string, string>()
  for (const s of input.sessions) {
    const row = s.workspace ? rows.find((r) => sameWorkspacePath(r.path, s.workspace)) : undefined
    const at = sessionActivityTime(s) ?? ''
    if (row && at > (lastActive.get(row.path) ?? '')) lastActive.set(row.path, at)
  }
  const isCurrent = (path: string) => sameWorkspacePath(path, input.currentWorkspace)
  return rows
    .sort((a, b) =>
      Number(isCurrent(b.path)) - Number(isCurrent(a.path))
      || (lastActive.get(b.path) ?? '').localeCompare(lastActive.get(a.path) ?? ''))
    .map((r) => ({
      id: `workspace:${r.path}`,
      label: r.label,
      description: isCurrent(r.path) ? `Current workspace · ${r.description}` : r.description,
      page: { placeholder: `Search sessions in ${r.label}…`, commands: sessionPage(r.path, r.label, input, handlers, now) },
      onOpenPage: () => handlers.loadWorkspace(r.path),
      action: () => {},
    }))
}

export function buildSwitchCommands(input: SwitchCommandsInput, handlers: SwitchCommandHandlers): Command[] {
  const workspaces = workspaceCommands(input, handlers, input.now ?? new Date())
  if (workspaces.length === 0) return []
  return [{
    id: 'switch-workspace-session',
    group: 'Session',
    label: 'Switch Workspace/Session…',
    description: 'Pick a workspace, then one of its sessions or a new one',
    keywords: 'session workspace repository worktree chat',
    page: { placeholder: 'Search workspaces…', commands: workspaces },
    action: () => {},
  }]
}
