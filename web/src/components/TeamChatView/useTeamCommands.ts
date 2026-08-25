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
 *   - ``Navigation`` — top-level routes
 */
import { useMemo } from 'react'
import type { useNavigate } from '@tanstack/react-router'
import type { Command } from '../CommandPalette'
import type { ViewMode } from './types'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { usePlatform } from '@/hooks/use-platform'
import { dispatchShortcutKey, formatShortcut } from '@/lib/keyboard-shortcut'

interface UseTeamCommandsArgs {
  // View / layout
  viewMode: ViewMode
  toggleAgentCapabilities: () => void
  setShowTodos: (fn: (v: boolean) => boolean) => void
  handleWorkspaceFiles: () => void
  handleCodingSidebarToggle: () => void

  // Session
  handleNewSession: () => void

  /** Coding mode with an attached workspace only — opens the terminal tab. */
  handleOpenTerminal: () => void

  // Navigation
  navigate: ReturnType<typeof useNavigate>
}

export function useTeamCommands({
  viewMode,
  toggleAgentCapabilities,
  setShowTodos,
  handleWorkspaceFiles,
  handleCodingSidebarToggle,
  handleNewSession,
  handleOpenTerminal,
  navigate,
}: UseTeamCommandsArgs): Command[] {
  const openSettings = useSettingsStore((s) => s.openSettings)
  const { os } = usePlatform()
  return useMemo<Command[]>(() => [
    { id: 'new-chat', group: 'Team', label: 'New Team Chat', description: 'Start a fresh team conversation', shortcut: formatShortcut('N', os), action: handleNewSession },
    {
      id: 'toggle-view', group: 'View',
      label: viewMode === 'agent' ? 'Switch to Split View' : 'Switch to Agent View',
      description: 'Cycle: Agent → Split', shortcut: formatShortcut('V', os, { shift: true }), action: () => dispatchShortcutKey('v', os, { shift: true }),
    },
    // Bare ⌘A is "Select All" on macOS, so Session Settings requires Shift.
    { id: 'agent-info',       group: 'View',       label: 'Session Settings', description: 'Show session model settings and lead context', shortcut: formatShortcut('A', os, { shift: true }), action: toggleAgentCapabilities },
    { id: 'todos',            group: 'View',       label: 'Task List',          description: 'View agent todos and progress', shortcut: formatShortcut('T', os), action: () => setShowTodos((v) => !v) },
    { id: 'workspace-files',  group: 'View',       label: 'Open Changed & Files', description: 'Browse changed files and workspace files', shortcut: formatShortcut('F', os), action: handleWorkspaceFiles },
    { id: 'collapse-sidebar', group: 'View', label: 'Toggle Coding Sidebar', description: 'Collapse or expand workspaces and sessions', shortcut: formatShortcut('B', os), action: handleCodingSidebarToggle },
    { id: 'scheduled-tasks',  group: 'View',       label: 'Scheduled Tasks',   description: 'Manage cron and scheduled agent tasks', shortcut: formatShortcut('S', os), action: () => dispatchShortcutKey('s', os) },
    { id: 'open-terminal', group: 'View' as const, label: 'Open Terminal', description: 'Interactive shell in the workspace (runs on the connected server)', shortcut: formatShortcut('`', os, { shift: true }), action: handleOpenTerminal },
    { id: 'go-home',     group: 'Navigation', label: 'Go to Home',     description: '', action: () => navigate({ to: '/' }) },
    { id: 'go-settings', group: 'Navigation', label: 'Open Settings',  description: 'Manage agents, skills, providers & more', shortcut: formatShortcut(',', os), action: () => openSettings('agents') },
    { id: 'go-telemetry', group: 'Navigation', label: 'Open Telemetry', description: 'View spans, latency, and model metrics', action: () => navigate({ to: '/telemetry' }) },
  ], [os, viewMode, toggleAgentCapabilities, setShowTodos, handleWorkspaceFiles, handleCodingSidebarToggle, handleNewSession, handleOpenTerminal, navigate, openSettings])
}
