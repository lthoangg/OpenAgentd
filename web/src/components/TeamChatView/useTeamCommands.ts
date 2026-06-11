/**
 * useTeamCommands — assembles the Command Palette command list for
 * the team chat view.
 *
 * The palette commands are pure data, but they close over a lot of
 * parent-owned state and callbacks (current view mode, navigate, the
 * various toggle/cycle handlers). Wrapping the assembly in a hook keeps
 * the parent's render body focused on layout while still threading the
 * closures naturally.
 *
 * Group conventions used by ``CommandPalette``:
 *   - ``Team``       — session lifecycle (new chat, …)
 *   - ``View``       — view-mode + panel toggles
 *   - ``Agents``     — per-agent navigation + cycling
 *   - ``Navigation`` — top-level routes
 *   - ``Settings``   — agent / skill management routes
 */
import type { useNavigate } from '@tanstack/react-router'
import type { Command } from '../CommandPalette'
import type { ViewMode } from './types'

/**
 * Dispatch a synthetic Ctrl+key event so the window-level shortcut
 * handlers fire when a palette item is activated. We use Ctrl (not
 * Cmd) on every platform — see hooks/useKeyboardShortcuts.ts for the
 * rationale.
 */
function dispatchCtrlKey(key: string): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      ctrlKey: true,
      metaKey: false,
      bubbles: true,
    }),
  )
}

interface UseTeamCommandsArgs {
  // View / layout
  viewMode: ViewMode
  cycleViewMode: () => void
  setViewMode: (m: ViewMode) => void
  toggleAgentCapabilities: () => void
  setShowTodos: (fn: (v: boolean) => boolean) => void
  handleWorkspaceFiles: () => void
  handleCodingSidebarToggle: () => void
  mode?: 'normal' | 'coding'

  // Session
  handleNewSession: () => void

  // Dream
  handleDreamRun: () => void

  // Agents
  agentNames: string[]
  leadName: string | null
  cycleActiveAgent: (dir: 'next' | 'prev') => void
  setActiveAgent: (name: string) => void

  // Navigation
  navigate: ReturnType<typeof useNavigate>
}

export function useTeamCommands({
  viewMode,
  cycleViewMode,
  setViewMode,
  toggleAgentCapabilities,
  setShowTodos,
  handleWorkspaceFiles,
  handleCodingSidebarToggle,
  mode = 'normal',
  handleNewSession,
  handleDreamRun,
  agentNames,
  leadName,
  cycleActiveAgent,
  setActiveAgent,
  navigate,
}: UseTeamCommandsArgs): Command[] {
  const switchableAgentNames = agentNames.filter((name) => name !== leadName)
  const commands: Command[] = [
    { id: 'new-chat', group: 'Team', label: 'New Team Chat', description: 'Start a fresh team conversation', shortcut: 'Ctrl+N', action: handleNewSession },
    { id: 'dream-run', group: 'Team', label: 'Run Dream', description: 'Synthesise unprocessed sessions into wiki topics', action: handleDreamRun },
    {
      id: 'toggle-view', group: 'View',
      label: viewMode === 'agent' ? 'Switch to Split View' : 'Switch to Agent View',
      description: 'Cycle: Agent → Split', shortcut: 'Ctrl+V', action: cycleViewMode,
    },
    { id: 'agent-info',       group: 'View',       label: 'Session Settings', description: 'Show session model settings and lead context', shortcut: 'Ctrl+A', action: toggleAgentCapabilities },
    { id: 'todos',            group: 'View',       label: 'Task List',          description: 'View agent todos and progress', shortcut: 'Ctrl+T', action: () => setShowTodos((v) => !v) },
    { id: 'workspace-files',  group: 'View',       label: mode === 'coding' ? 'Open Changed & Files' : 'Toggle Workspace Files', description: mode === 'coding' ? 'Browse changed files and workspace files' : 'Browse files the agent has produced', shortcut: 'Ctrl+F', action: handleWorkspaceFiles },
    mode === 'coding'
      ? { id: 'collapse-sidebar', group: 'View', label: 'Toggle Coding Sidebar', description: 'Collapse or expand workspaces and sessions', shortcut: 'Ctrl+B', action: handleCodingSidebarToggle }
      : { id: 'collapse-sidebar', group: 'View', label: 'Toggle Sidebar', description: '', shortcut: 'Ctrl+B', action: () => dispatchCtrlKey('b') },
    { id: 'wiki',             group: 'View',       label: 'Wiki',              description: 'Browse and edit the agent wiki', shortcut: 'Ctrl+M', action: () => dispatchCtrlKey('m') },
    { id: 'scheduled-tasks',  group: 'View',       label: 'Scheduled Tasks',   description: 'Manage cron and scheduled agent tasks', shortcut: 'Ctrl+S', action: () => dispatchCtrlKey('s') },
    ...switchableAgentNames.map((name) => ({
      id: `switch-${name}`, group: 'Agents',
      label: `View ${name}`,
      description: 'Worker agent',
      action: () => {
        setViewMode('agent'); setActiveAgent(name)
      },
    })),
    { id: 'next-agent', group: 'Agents', label: 'Next Agent',     description: 'Tab',       action: () => cycleActiveAgent('next') },
    { id: 'prev-agent', group: 'Agents', label: 'Previous Agent', description: 'Shift+Tab', action: () => cycleActiveAgent('prev') },
    { id: 'go-home',     group: 'Navigation', label: 'Go to Home',     description: '', action: () => navigate({ to: '/' }) },
    ...(mode === 'normal' ? [{ id: 'go-coding', group: 'Navigation', label: 'Go to Coding Mode', description: 'Open the coding workbench', action: () => navigate({ to: '/coding' }) }] : []),
    { id: 'go-settings', group: 'Navigation', label: 'Open Settings',  description: 'Manage agents & skills', action: () => navigate({ to: '/settings/agents' }) },
    { id: 'settings-agents', group: 'Settings', label: 'Manage Agents', description: 'Edit agent .md files',  action: () => navigate({ to: '/settings/agents' }) },
    { id: 'settings-new-agent', group: 'Settings', label: 'New Agent',  description: 'Create a new agent',    action: () => navigate({ to: '/settings/agents/new' }) },
    { id: 'settings-skills', group: 'Settings', label: 'Manage Skills', description: 'Edit skill .md files',  action: () => navigate({ to: '/settings/skills' }) },
    { id: 'settings-new-skill', group: 'Settings', label: 'New Skill',  description: 'Create a new skill',    action: () => navigate({ to: '/settings/skills/new' }) },
    { id: 'settings-dream', group: 'Settings', label: 'Dream Settings',  description: 'Edit the dream model and schedule', action: () => navigate({ to: '/settings/dream' }) },
    ...agentNames.map((name) => ({
      id: `edit-${name}`, group: 'Settings',
      label: `Edit ${name}…`,
      description: 'Jump to agent editor',
      action: () => navigate({ to: '/settings/agents/$name', params: { name } }),
    })),
  ]
  return commands
}
