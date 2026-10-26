/**
 * useAgentCommands — assembles the Command Palette command list for
 * the agent chat view.
 *
 * The palette commands are pure data, but they close over a lot of
 * parent-owned state and callbacks (the various toggle/cycle handlers).
 * Wrapping the assembly in a hook keeps
 * the parent's render body focused on layout while still threading the
 * closures naturally.
 *
 * Group conventions used by ``CommandPalette``:
 *   - ``Session``    — session lifecycle (new chat, …)
 *   - ``View``       — view-mode + panel toggles
 *   - ``Navigation`` — app-level surfaces (Settings, Telemetry)
 */
import { useMemo } from 'react'
import type { Command } from '../CommandPalette'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { openTelemetry } from '@/stores/useTelemetryStore'
import { useUIStore } from '@/stores/useUIStore'
import { usePlatform } from '@/hooks/use-platform'
import { useThemePreference } from '@/hooks/useThemePreference'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { APP_SHORTCUTS as KEYS, shortcutLabel } from '@/lib/app-shortcuts'
import { THEME_OPTIONS } from '@/components/ThemeToggle'

/** The session's goal as the palette needs it: given only while it has one. */
export interface UseAgentCommandsGoal {
  /** Opens the dock's Goal tab. */
  onShow: () => void
}

interface UseAgentCommandsArgs {
  toggleAgentCapabilities: () => void
  /** Opens the task list (dock Tasks tab on desktop, popover otherwise). */
  toggleTasks: () => void
  /** Opens scheduled tasks (dock Schedule tab with a workspace, overlay otherwise). */
  toggleScheduler: () => void
  handleWorkspaceFiles: () => void
  /** Project workspaces only: opens or shows the dock's Git tab. */
  handleOpenGit?: () => void
  handleSidebarToggle: () => void

  // Session
  handleNewSession: () => void

  /** Attached workspace only — opens the terminal tab. */
  handleOpenTerminal: () => void
  /** Opens the review dock if needed and toggles it over the chat column. */
  handleToggleDockMaximized?: () => void
  /** Only while the session has a plan: opens it (dock Plan tab, or the task popover without a workspace). */
  handleOpenPlan?: () => void
  /** The plan is waiting for the user's review. */
  planAwaitingReview?: boolean
  /** Opens a web preview tab in the review dock (workspace + local backend). */
  handleOpenPreview?: () => void
  /** Once the session exists: reopens its ``/btw`` side questions. */
  handleOpenSideQuestions?: () => void
  /** The session's goal, with a workspace to show its tab in. */
  goal?: UseAgentCommandsGoal
}

/** The palette's one goal entry: it opens the Goal tab, where the goal's actions are. */
function goalCommands(goal: UseAgentCommandsArgs['goal']): Command[] {
  if (!goal) return []
  return [{
    id: 'goal-open',
    group: 'View',
    label: 'Goal',
    description: 'Progress, limits, and the last completion check',
    keywords: 'goal objective loop continue autonomous pause resume clear',
    action: goal.onShow,
  }]
}

export function useAgentCommands({
  toggleAgentCapabilities,
  toggleTasks,
  toggleScheduler,
  handleWorkspaceFiles,
  handleOpenGit,
  handleSidebarToggle,
  handleNewSession,
  handleOpenTerminal,
  handleToggleDockMaximized,
  handleOpenPlan,
  planAwaitingReview = false,
  handleOpenPreview,
  handleOpenSideQuestions,
  goal,
}: UseAgentCommandsArgs): Command[] {
  const openSettings = useSettingsStore((s) => s.openSettings)
  const { preference: theme, setPreference: setTheme } = useThemePreference()
  const readerMode = useDisplayPrefsStore((s) => s.transcriptStyle === 'reader')
  const toggleReaderMode = useDisplayPrefsStore((s) => s.toggleTranscriptStyle)
  const { os, isTauri } = usePlatform()
  return useMemo<Command[]>(() => [
    { id: 'new-chat', group: 'Session', label: 'New Session', description: 'Start a fresh conversation', shortcut: shortcutLabel(KEYS.newSession, os), action: handleNewSession },
    ...goalCommands(goal),
    { id: 'agent-info',       group: 'View',       label: 'Session Settings', description: 'Show session model settings and lead context', shortcut: shortcutLabel(KEYS.sessionSettings, os), action: toggleAgentCapabilities },
    { id: 'todos',            group: 'View',       label: 'Task List',          description: 'View agent todos and progress', shortcut: shortcutLabel(KEYS.tasks, os), action: toggleTasks },
    ...(handleOpenPlan
      ? [{
          id: 'open-plan',
          group: 'View' as const,
          label: 'Open Plan',
          description: planAwaitingReview ? 'Waiting for your review · approve or request changes' : "View or edit this session's plan",
          keywords: 'plan review approve request changes comment',
          action: handleOpenPlan,
        }]
      : []),
    { id: 'workspace-files',  group: 'View',       label: 'Toggle Review Dock', description: 'Show or hide the dock with its open tabs', keywords: 'changed files dock panel', shortcut: shortcutLabel(KEYS.workspaceFiles, os), action: handleWorkspaceFiles },
    ...(handleOpenSideQuestions
      ? [{
          id: 'side-questions',
          group: 'View' as const,
          label: 'Side Questions',
          description: 'Reopen this session\'s /btw questions and answers',
          keywords: 'btw by the way aside side question answer',
          action: handleOpenSideQuestions,
        }]
      : []),
    ...(handleOpenGit
      ? [{ id: 'open-git', group: 'View' as const, label: 'Open Git', description: 'Changed files and commit history in the review dock', keywords: 'changes diff history commits review', shortcut: shortcutLabel(KEYS.openGit, os), action: handleOpenGit }]
      : []),
    ...(handleToggleDockMaximized
      ? [{ id: 'maximize-dock', group: 'View' as const, label: 'Maximize Review Dock', description: 'Give the review dock the full width for diffs, files, and terminals', shortcut: shortcutLabel(KEYS.maximizeDock, os), action: handleToggleDockMaximized }]
      : []),
    { id: 'collapse-sidebar', group: 'View', label: 'Toggle Sidebar', description: 'Collapse or expand workspaces and sessions', shortcut: shortcutLabel(KEYS.sidebar, os), action: handleSidebarToggle },
    { id: 'scheduled-tasks',  group: 'View',       label: 'Scheduled Tasks',   description: 'Manage cron and scheduled agent tasks', action: toggleScheduler },
    ...(handleOpenPreview
      ? [{
          id: 'open-preview',
          group: 'View' as const,
          label: 'Open Preview',
          description: 'Show a local dev server or HTML file in the review dock, with design comments',
          keywords: 'browser web view localhost dev server design inspect',
          action: handleOpenPreview,
        }]
      : []),
    { id: 'open-terminal', group: 'View' as const, label: 'Open Terminal', description: 'Interactive shell in the workspace (runs on the connected server)', shortcut: shortcutLabel(KEYS.terminal, os), action: handleOpenTerminal },
    { id: 'go-settings', group: 'Navigation', label: 'Open Settings',  description: 'Manage agents, skills, providers & more', shortcut: shortcutLabel(KEYS.settings, os), action: () => openSettings('agents') },
    { id: 'go-telemetry', group: 'Navigation', label: 'Open Telemetry', description: 'Spend, turns, and traces by workspace and model', action: () => openTelemetry() },
    { id: 'keyboard-shortcuts', group: 'Navigation', label: 'Keyboard Shortcuts', description: 'Every shortcut, by where it works', keywords: 'keys hotkeys keybindings', shortcut: shortcutLabel(KEYS.shortcutsHelp, os), action: () => useUIStore.getState().toggleShortcutsHelp() },
    {
      id: 'theme',
      group: 'View',
      label: 'Theme…',
      description: `${THEME_OPTIONS.find((o) => o.value === theme)?.label ?? 'System'} now · switch between System, Light, and Dark`,
      keywords: 'appearance color mode system light dark',
      page: {
        placeholder: 'Search themes…',
        commands: THEME_OPTIONS.map(({ value, label }) => ({
          id: `theme-${value}`,
          label,
          description: `${value === 'system' ? 'Follow the system appearance' : `Use the ${value} theme`}${value === theme ? ' · Current' : ''}`,
          action: () => setTheme(value),
        })),
      },
      action: () => {},
    },
    {
      id: 'toggle-reader-mode',
      group: 'View',
      label: 'Toggle Reader Mode',
      description: readerMode
        ? 'Reader mode is on · show every thinking trace and tool call again'
        : "Fold each turn's work into one row and list the files it changed",
      keywords: 'transcript compact detailed summary view',
      action: toggleReaderMode,
    },
    // Desktop only: the native ⌘R accelerator was dropped so a stray key
    // press cannot wipe a live turn's UI state; browsers keep their own reload.
    ...(isTauri
      ? [{ id: 'reload-window', group: 'View', label: 'Reload Window', description: 'Reload the app UI (the server and running turns are unaffected)', action: () => window.location.reload() }]
      : []),
  ], [os, isTauri, toggleAgentCapabilities, toggleTasks, toggleScheduler, handleWorkspaceFiles, handleOpenGit, handleToggleDockMaximized, handleOpenPlan, planAwaitingReview, handleOpenPreview, handleOpenSideQuestions, goal, handleSidebarToggle, handleNewSession, handleOpenTerminal, openSettings, theme, setTheme, readerMode, toggleReaderMode])
}
