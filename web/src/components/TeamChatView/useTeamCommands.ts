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
  return useMemo<Command[]>(() => [
    { id: 'new-chat', group: 'Team', label: 'New Team Chat', description: 'Start a fresh team conversation', shortcut: 'Ctrl+N', action: handleNewSession },
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
    { id: 'scheduled-tasks',  group: 'View',       label: 'Scheduled Tasks',   description: 'Manage cron and scheduled agent tasks', shortcut: 'Ctrl+S', action: () => dispatchCtrlKey('s') },
    { id: 'go-home',     group: 'Navigation', label: 'Go to Home',     description: '', action: () => navigate({ to: '/' }) },
    ...(mode === 'normal' ? [{ id: 'go-coding', group: 'Navigation', label: 'Go to Coding Mode', description: 'Open the coding workbench', action: () => navigate({ to: '/coding' }) }] : []),
    { id: 'go-settings', group: 'Navigation', label: 'Open Settings',  description: 'Manage agents, skills, providers & more', shortcut: 'Ctrl+.', action: () => openSettings('agents') },
  ], [viewMode, cycleViewMode, toggleAgentCapabilities, setShowTodos, handleWorkspaceFiles, handleCodingSidebarToggle, mode, handleNewSession, navigate, openSettings])
}
