/**
 * Palette Switch Workspace/Session… — workspaces, then a workspace's
 * sessions — built from query data.
 */
import { describe, expect, it, mock } from 'bun:test'
import type { CodingWorkspaceTreeResponse, SessionResponse } from '@/api/types'
import type { Command } from '@/components/CommandPalette'
import {
  buildSwitchCommands,
  switchPagePath,
  type SwitchCommandHandlers,
  type SwitchCommandsInput,
} from '@/components/AgentChatView/paletteSwitchCommands'

const NOW = new Date('2026-05-01T12:00:00Z')

function session(id: string, overrides: Partial<SessionResponse> = {}): SessionResponse {
  return { id, title: id, agent_name: null, created_at: null, updated_at: '2026-05-01T11:00:00Z', workspace: '/repo/app', ...overrides }
}

const tree: CodingWorkspaceTreeResponse = {
  chat: { path: '/home/me', name: 'Chat' },
  repositories: [
    { path: '/repo/app', name: 'app', worktrees: [{ path: '/repo/app-wt', name: 'app-wt', managed: true }] },
    { path: '/repo/docs', name: 'docs', worktrees: [] },
  ],
}

function build(overrides: Partial<SwitchCommandsInput> = {}) {
  const handlers: SwitchCommandHandlers = {
    openSession: mock(() => {}),
    newSession: mock(() => {}),
    loadWorkspace: mock(() => {}),
  }
  const input: SwitchCommandsInput = {
    currentSessionId: 'current',
    currentWorkspace: '/repo/app',
    sessions: [],
    tree,
    now: NOW,
    ...overrides,
  }
  return { handlers, commands: buildSwitchCommands(input, handlers) }
}

function byId(commands: Command[], id: string): Command {
  const cmd = commands.find((c) => c.id === id)
  if (!cmd) throw new Error(`missing ${id}: ${commands.map((c) => c.id).join(', ')}`)
  return cmd
}

const workspaces = (commands: Command[]) => byId(commands, 'switch-workspace-session').page!.commands

describe('Switch Workspace/Session…', () => {
  it('is found by session or workspace, beside the current workspace\'s sessions', () => {
    const { commands } = build()
    expect(commands.map((c) => c.id)).toEqual(['switch-workspace-session', 'workspace-sessions'])
    expect(commands[0].label).toBe('Switch Workspace/Session…')
    expect(commands[0].keywords).toContain('session')
    expect(commands[0].keywords).toContain('workspace')
  })

  it('shows the shortcut labels it is given', () => {
    const { commands } = build({ shortcuts: { switchWorkspace: '⌘L', workspaceSessions: '⌘⇧L' } })
    expect(commands.map((c) => c.shortcut)).toEqual(['⌘L', '⌘⇧L'])
  })

  it('lists the current workspace\'s sessions as their own command, which loads them', () => {
    const { commands, handlers } = build({ sessions: [session('a'), session('b', { workspace: '/repo/docs' })] })
    const here = byId(commands, 'workspace-sessions')
    expect(here.label).toBe('Sessions in This Workspace…')
    expect(here.page!.commands.map((c) => c.label)).toEqual(['New Session', 'a'])
    here.onOpenPage?.()
    expect(handlers.loadWorkspace).toHaveBeenCalledWith('/repo/app')
  })

  it('omits the current workspace\'s sessions without a current workspace', () => {
    expect(build({ currentWorkspace: null }).commands.map((c) => c.id)).toEqual(['switch-workspace-session'])
  })

  it('opens the shortcuts on the workspace list or inside the current workspace', () => {
    const { commands } = build()
    expect(switchPagePath(commands, 'workspaces')).toEqual(['switch-workspace-session'])
    expect(switchPagePath(commands, 'sessions')).toEqual(['switch-workspace-session', 'workspace:/repo/app'])
  })

  it('falls back to the workspace list without a current workspace or before the tree loads', () => {
    expect(switchPagePath(build({ currentWorkspace: null }).commands, 'sessions')).toEqual(['switch-workspace-session'])
    expect(switchPagePath(build({ tree: null }).commands, 'sessions')).toEqual(['switch-workspace-session'])
  })

  it('is omitted before the workspace tree has loaded', () => {
    expect(build({ tree: null }).commands).toEqual([])
  })

  it('lists every workspace, the current one first, then the most recently active', () => {
    const { commands } = build({
      sessions: [
        session('a', { workspace: '/repo/docs', updated_at: '2026-05-01T10:00:00Z' }),
        session('b', { workspace: '/home/me', updated_at: '2026-05-01T11:30:00Z' }),
      ],
    })

    expect(workspaces(commands).map((c) => [c.label, c.description])).toEqual([
      ['app', 'Current workspace · /repo/app'],
      ['Chat', 'Chat workspace'],
      ['docs', '/repo/docs'],
      ['app-wt', 'Worktree of app'],
    ])
  })

  it('opens each workspace as a page that loads its sessions', () => {
    const { commands, handlers } = build()
    const docs = byId(workspaces(commands), 'workspace:/repo/docs')

    expect(docs.page?.placeholder).toBe('Search sessions in docs…')
    docs.onOpenPage?.()
    expect(handlers.loadWorkspace).toHaveBeenCalledWith('/repo/docs')
  })
})

describe('a workspace session page', () => {
  it('starts with New Session, listed only while browsing', () => {
    const { commands, handlers } = build()
    const [first] = byId(workspaces(commands), 'workspace:/repo/docs').page!.commands

    expect([first.label, first.browseOnly]).toEqual(['New Session', true])
    first.action()
    expect(handlers.newSession).toHaveBeenCalledWith('/repo/docs')
  })

  it('lists the workspace’s other top-level sessions, newest first, with status', () => {
    const { commands, handlers } = build({
      sessions: [
        session('current'),
        session('idle', { title: null, updated_at: '2026-05-01T09:00:00Z' }),
        session('busy', { title: 'Fix login', running: true }),
        session('asking', { title: 'Plan release', running: true, needs_input: true, updated_at: '2026-05-01T10:00:00Z' }),
        session('child', { parent_session_id: 'busy' }),
        session('elsewhere', { workspace: '/repo/docs' }),
      ],
    })
    const page = byId(workspaces(commands), 'workspace:/repo/app').page!

    expect(page.commands.slice(1).map((c) => [c.label, c.description])).toEqual([
      ['Fix login', 'Running'],
      ['Plan release', 'Needs you'],
      ['Untitled session', '3h'],
    ])
    page.commands[1].action()
    expect(handlers.openSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'busy' }))
  })

  it('uses the sessions loaded for that workspace over the recent list', () => {
    const { commands } = build({
      sessions: [session('recent', { workspace: '/repo/docs' })],
      workspaceSessions: {
        path: '/repo/docs',
        sessions: [session('older', { workspace: '/repo/docs', updated_at: '2026-04-01T00:00:00Z' }), session('recent', { workspace: '/repo/docs' })],
      },
    })

    const docs = byId(workspaces(commands), 'workspace:/repo/docs').page!
    expect(docs.commands.slice(1).map((c) => c.id)).toEqual(['session:recent', 'session:older'])
    // Other workspaces keep the recent list.
    expect(byId(workspaces(commands), 'workspace:/home/me').page!.commands.map((c) => c.label)).toEqual(['New Session'])
  })
})
