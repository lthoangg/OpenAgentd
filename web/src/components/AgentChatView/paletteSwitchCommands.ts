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
import { sessionStatus, sessionStateWord, type SessionStatus } from '../Sidebar/SessionStatusMark'

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
  /**
   * The workspace whose full session list is still loading, if any. Its page
   * ends in a "Loading…" row, as it shows only the recent sessions meanwhile.
   */
  loadingWorkspace?: string | null
  /** Shortcut labels shown on the two commands, e.g. ``⌘L`` and ``⌘⇧L``. */
  shortcuts?: { switchWorkspace?: string; workspaceSessions?: string }
  now?: Date
}

export const SWITCH_COMMAND_ID = 'switch-workspace-session'
export const WORKSPACE_SESSIONS_COMMAND_ID = 'workspace-sessions'

export interface SwitchCommandHandlers {
  openSession: (session: SessionResponse) => void
  /** A new-session draft in ``path``. */
  newSession: (path: string) => void
  /** The page of ``path`` opened: load its sessions. */
  loadWorkspace: (path: string) => void
}

/** Needs you, then running, then the rest: what the user should look at first. */
const URGENCY: Record<SessionStatus, number> = { needs_input: 0, running: 1, failed: 2, unread: 2, idle: 2 }

/**
 * A session's state as the sidebar reads it (no unread state here: the
 * palette is built from query data alone). A lead whose subagents still
 * work is running.
 */
function stateOf(session: SessionResponse): SessionStatus {
  return sessionStatus(session, false)
}

/** The state in words, or the age of an idle session. */
function sessionDescription(session: SessionResponse, now: Date): string {
  return sessionStateWord(stateOf(session)) ?? formatCompactRelative(sessionActivityTime(session), now)
}

function byRecency(a: SessionResponse, b: SessionResponse): number {
  return (sessionActivityTime(b) ?? '').localeCompare(sessionActivityTime(a) ?? '')
}

function byUrgency(a: SessionResponse, b: SessionResponse): number {
  return URGENCY[stateOf(a)] - URGENCY[stateOf(b)] || byRecency(a, b)
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
    .sort(byUrgency)
    .map((s): Command => ({
      id: `session:${s.id}`,
      label: s.title?.trim() || 'Untitled session',
      description: sessionDescription(s, now),
      status: stateOf(s),
      action: () => handlers.openSession(s),
    }))
  return [
    {
      id: `new-session:${path}`,
      label: 'New Session',
      description: `Start a fresh conversation in ${label}`,
      browseOnly: true,
      // Not a session: an empty mark slot, so its title lines up with theirs.
      status: 'idle',
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
  // The most urgent state among a workspace's other sessions (the one on
  // screen says its own): a workspace waiting on the user lists early.
  const urgent = new Map<string, SessionStatus>()
  for (const s of input.sessions) {
    const row = s.workspace ? rows.find((r) => sameWorkspacePath(r.path, s.workspace)) : undefined
    const at = sessionActivityTime(s) ?? ''
    if (row && at > (lastActive.get(row.path) ?? '')) lastActive.set(row.path, at)
    if (!row || s.parent_session_id || s.id === input.currentSessionId) continue
    const state = stateOf(s)
    if (state !== 'needs_input' && state !== 'running') continue
    const held = urgent.get(row.path)
    if (held === undefined || URGENCY[state] < URGENCY[held]) urgent.set(row.path, state)
  }
  const isCurrent = (path: string) => sameWorkspacePath(path, input.currentWorkspace)
  const urgency = (path: string) => URGENCY[urgent.get(path) ?? 'idle']
  return rows
    .sort((a, b) =>
      Number(isCurrent(b.path)) - Number(isCurrent(a.path))
      || urgency(a.path) - urgency(b.path)
      || (lastActive.get(b.path) ?? '').localeCompare(lastActive.get(a.path) ?? ''))
    .map((r): Command => {
      const state = urgent.get(r.path) ?? 'idle'
      const word = sessionStateWord(state)
      const where = word ? `${word} · ${r.description}` : r.description
      return {
        id: `workspace:${r.path}`,
        label: r.label,
        description: isCurrent(r.path) ? `Current workspace · ${where}` : where,
        status: state,
        page: {
          placeholder: `Search sessions in ${r.label}…`,
          commands: sessionPage(r.path, r.label, input, handlers, now),
          loading: sameWorkspacePath(input.loadingWorkspace, r.path),
        },
        onOpenPage: () => handlers.loadWorkspace(r.path),
        action: () => {},
      }
    })
}

export function buildSwitchCommands(input: SwitchCommandsInput, handlers: SwitchCommandHandlers): Command[] {
  const workspaces = workspaceCommands(input, handlers, input.now ?? new Date())
  if (workspaces.length === 0) return []
  const commands: Command[] = [{
    id: SWITCH_COMMAND_ID,
    group: 'Session',
    label: 'Switch Workspace/Session…',
    description: 'Pick a workspace, then one of its sessions or a new one',
    keywords: 'session workspace repository worktree chat',
    shortcut: input.shortcuts?.switchWorkspace,
    page: { placeholder: 'Search workspaces…', commands: workspaces },
    action: () => {},
  }]
  // The current workspace sorts first; it is absent from a fresh draft with
  // no workspace picked, or one the tree does not list.
  const current = workspaces[0]
  if (current.page && sameWorkspacePath(current.id.slice('workspace:'.length), input.currentWorkspace)) {
    commands.push({
      id: WORKSPACE_SESSIONS_COMMAND_ID,
      group: 'Session',
      label: 'Sessions in This Workspace…',
      description: `Open a session in ${current.label} or start a new one`,
      keywords: 'switch session recent current workspace',
      shortcut: input.shortcuts?.workspaceSessions,
      page: current.page,
      onOpenPage: current.onOpenPage,
      action: () => {},
    })
  }
  return commands
}

/**
 * The pages the palette opens on for a switch shortcut: the workspace list,
 * or the current workspace's sessions inside it so Esc steps back to the
 * list. Falls back to the workspace list without a current workspace.
 */
export function switchPagePath(commands: Command[], scope: 'workspaces' | 'sessions'): string[] {
  const root = commands.find((c) => c.id === SWITCH_COMMAND_ID)
  if (!root) return [SWITCH_COMMAND_ID]
  const hasCurrent = commands.some((c) => c.id === WORKSPACE_SESSIONS_COMMAND_ID)
  const current = root.page?.commands[0]
  return scope === 'sessions' && hasCurrent && current ? [SWITCH_COMMAND_ID, current.id] : [SWITCH_COMMAND_ID]
}
