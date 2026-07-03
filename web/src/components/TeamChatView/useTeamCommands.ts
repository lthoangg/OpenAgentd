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
  cycleViewMode: () => void
  toggleAgentCapabilities: () => void
  setShowTodos: (fn: (v: boolean) => boolean) => void
  handleWorkspaceFiles: () => void
  handleCodingSidebarToggle: () => void
  mode?: 'normal' | 'coding'

  // Session
  handleNewSession: () => void

  // Navigation
  navigate: ReturnType<typeof useNavigate>
}

export function useTeamCommands({
  viewMode,
  cycleViewMode,
  toggleAgentCapabilities,
  setShowTodos,
  handleWorkspaceFiles,
  handleCodingSidebarToggle,
  mode = 'normal',
  handleNewSession,
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
    { id: 'workspace-files',  group: 'View',       label: mode === 'coding' ? 'Open Changed & Files' : 'Toggle Workspace Files', description: mode === 'coding' ? 'Browse changed files and workspace files' : 'Browse files the agent has produced', shortcut: formatShortcut('F', os), action: handleWorkspaceFiles },
    mode === 'coding'
      ? { id: 'collapse-sidebar', group: 'View', label: 'Toggle Coding Sidebar', description: 'Collapse or expand workspaces and sessions', shortcut: formatShortcut('B', os), action: handleCodingSidebarToggle }
      : { id: 'collapse-sidebar', group: 'View', label: 'Toggle Sidebar', description: '', shortcut: formatShortcut('B', os), action: () => dispatchShortcutKey('b', os) },
    { id: 'scheduled-tasks',  group: 'View',       label: 'Scheduled Tasks',   description: 'Manage cron and scheduled agent tasks', shortcut: formatShortcut('S', os), action: () => dispatchShortcutKey('s', os) },
    { id: 'go-home',     group: 'Navigation', label: 'Go to Home',     description: '', action: () => navigate({ to: '/' }) },
    ...(mode === 'normal' ? [{ id: 'go-coding', group: 'Navigation', label: 'Go to Coding Mode', description: 'Open the coding workbench', action: () => navigate({ to: '/coding' }) }] : []),
    { id: 'go-settings', group: 'Navigation', label: 'Open Settings',  description: 'Manage agents, skills, providers & more', shortcut: formatShortcut(',', os), action: () => openSettings('agents') },
  ], [os, viewMode, cycleViewMode, toggleAgentCapabilities, setShowTodos, handleWorkspaceFiles, handleCodingSidebarToggle, mode, handleNewSession, navigate, openSettings])
}
