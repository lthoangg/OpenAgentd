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
import { useRouter } from '@tanstack/react-router'
import type { Command } from '../CommandPalette'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { openTelemetry } from '@/stores/useTelemetryStore'
import { useUIStore } from '@/stores/useUIStore'
import { usePlatform } from '@/hooks/use-platform'
import { useThemePreference } from '@/hooks/useThemePreference'
import { TEXT_SIZES, useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { APP_SHORTCUTS as KEYS, shortcutLabel } from '@/lib/app-shortcuts'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'
import { openNextNeedsYou } from '@/lib/desktop-commands'
import { THEME_OPTIONS } from '@/components/ThemeToggle'

/** The session's goal as the palette needs it: given only while it has one. */
export interface UseAgentCommandsGoal {
  /** Opens the dock's Goal tab. */
  onShow: () => void
}

interface UseAgentCommandsArgs {
  toggleRunPicker: () => void
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

  /** Attached workspace only — shows the last terminal tab, or starts a shell. */
  handleOpenTerminal: () => void
  /** Opens the review dock if needed and toggles it over the chat column. */
  handleToggleDockMaximized?: () => void
  /** Desktop with a workspace: split the Review panel's focused pane right (⌘\) or down (⌘⇧\). */
  handleSplitDock?: () => void
  handleSplitDockDown?: () => void
  /** Desktop: find in this session's transcript (⌘F). */
  handleFindInSession?: () => void
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
  toggleRunPicker,
  toggleTasks,
  toggleScheduler,
  handleWorkspaceFiles,
  handleOpenGit,
  handleSidebarToggle,
  handleNewSession,
  handleOpenTerminal,
  handleToggleDockMaximized,
  handleSplitDock,
  handleSplitDockDown,
  handleFindInSession,
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
  const textSize = useDisplayPrefsStore((s) => s.textSize)
  const setTextSize = useDisplayPrefsStore((s) => s.setTextSize)
  const { os, isTauri } = usePlatform()
  const router = useRouter()
  return useMemo<Command[]>(() => [
    { id: 'new-chat', group: 'Session', label: 'New Session', description: 'Start a fresh conversation', shortcut: shortcutLabel(KEYS.newSession, os), action: handleNewSession },
    ...goalCommands(goal),
    { id: 'agent-info',       group: 'Session',    label: 'Model and Thinking…', description: 'Model, thinking level and account for the next message', keywords: 'model thinking account key reasoning provider switch', shortcut: shortcutLabel(KEYS.sessionSettings, os), action: toggleRunPicker },
    { id: 'todos',            group: 'View',       label: 'Tasks',          description: "The agent's task list and progress", keywords: 'todos task list progress', shortcut: shortcutLabel(KEYS.tasks, os), action: toggleTasks },
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
    { id: 'workspace-files',  group: 'View',       label: 'Toggle Review Panel', description: 'Show or hide the Review panel and its open tabs', keywords: 'changed files dock panel review', shortcut: shortcutLabel(KEYS.workspaceFiles, os), action: handleWorkspaceFiles },
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
      ? [{ id: 'open-git', group: 'View' as const, label: 'Open Git', description: 'Changed files and commit history in the Review panel', keywords: 'changes diff history commits review', shortcut: shortcutLabel(KEYS.openGit, os), action: handleOpenGit }]
      : []),
    ...(handleToggleDockMaximized
      ? [{ id: 'maximize-dock', group: 'View' as const, label: 'Maximize Review Panel', description: 'Give the Review panel the full width for diffs, files and terminals', keywords: 'dock', shortcut: shortcutLabel(KEYS.maximizeDock, os), action: handleToggleDockMaximized }]
      : []),
    ...(handleSplitDock
      ? [{ id: 'split-dock', group: 'View' as const, label: 'Split Review Panel Right', description: 'A new pane beside the focused one; closing its last tab joins it back', keywords: 'dock split pane group side by side right vertical', shortcut: shortcutLabel(KEYS.splitDock, os), action: handleSplitDock }]
      : []),
    ...(handleSplitDockDown
      ? [{ id: 'split-dock-down', group: 'View' as const, label: 'Split Review Panel Down', description: 'A new pane under the focused one; closing its last tab joins it back', keywords: 'dock split pane group top bottom down horizontal', shortcut: shortcutLabel(KEYS.splitDockDown, os), action: handleSplitDockDown }]
      : []),
    ...(handleFindInSession
      ? [{ id: 'find-in-session', group: 'Session' as const, label: 'Find in Session', description: 'Search this conversation', keywords: 'search text transcript', shortcut: shortcutLabel(KEYS.findInSession, os), action: handleFindInSession }]
      : []),
    { id: 'collapse-sidebar', group: 'View', label: 'Toggle Sidebar', description: 'Collapse or expand workspaces and sessions', shortcut: shortcutLabel(KEYS.sidebar, os), action: handleSidebarToggle },
    { id: 'scheduled-tasks',  group: 'View',       label: 'Scheduled Tasks',   description: 'Create, pause and run scheduled agent tasks', keywords: 'scheduler schedule cron', action: toggleScheduler },
    ...(handleOpenPreview
      ? [{
          id: 'open-preview',
          group: 'View' as const,
          label: 'Open Preview',
          description: 'Show a local dev server or HTML file in the Review panel',
          keywords: 'browser web view localhost dev server design inspect',
          action: handleOpenPreview,
        }]
      : []),
    { id: 'open-terminal', group: 'View' as const, label: 'Open Terminal', description: 'The last terminal, or a new shell in the workspace (runs on the connected server)', keywords: 'shell console', action: handleOpenTerminal },
    { id: 'go-settings', group: 'Navigation', label: 'Open Settings',  description: 'Agents, skills, providers and more', shortcut: shortcutLabel(KEYS.settings, os), action: () => openSettings('agents') },
    { id: 'open-workspace', group: 'Navigation', label: 'Open Workspace…', description: 'Add a folder as a workspace', keywords: 'folder project repo add', shortcut: shortcutLabel(KEYS.openWorkspace, os), action: () => dispatchAppEvent(APP_EVENTS.openWorkspace) },
    { id: 'next-needs-you', group: 'Navigation', label: 'Next Session That Needs You', description: 'Jump to the next session waiting for an answer or a review', keywords: 'waiting attention ask question approve', action: () => openNextNeedsYou(router) },
    { id: 'go-telemetry', group: 'Navigation', label: 'Open Usage', description: 'Spend, turns and traces by workspace and model', keywords: 'telemetry usage spend cost traces', action: () => openTelemetry() },
    { id: 'keyboard-shortcuts', group: 'Navigation', label: 'Keyboard Shortcuts', description: 'Every shortcut, by where it works', keywords: 'keys hotkeys keybindings', shortcut: shortcutLabel(KEYS.shortcutsHelp, os), action: () => useUIStore.getState().toggleShortcutsHelp() },
    {
      id: 'theme',
      group: 'View',
      label: 'Theme…',
      description: `Switch between System, Light and Dark. Now: ${THEME_OPTIONS.find((o) => o.value === theme)?.label ?? 'System'}`,
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
      id: 'text-size',
      group: 'View',
      label: 'Text Size…',
      description: `Compact, Default or Large. Now: ${TEXT_SIZES.find((size) => size.value === textSize)?.label ?? 'Default'}`,
      keywords: 'font zoom bigger smaller density',
      page: {
        placeholder: 'Text size…',
        commands: TEXT_SIZES.map(({ value, label }) => ({
          id: `text-size-${value}`,
          label,
          description: value === textSize ? 'Current' : undefined,
          action: () => setTextSize(value),
        })),
      },
      action: () => {},
    },
    { id: 'reset-layout', group: 'View', label: 'Reset Layout', description: 'Sidebar and Review panel sizes back to their defaults', keywords: 'restore default width panels', action: () => useLayoutStore.getState().resetLayout() },
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
  ], [os, isTauri, router, toggleRunPicker, toggleTasks, toggleScheduler, handleWorkspaceFiles, handleOpenGit, handleToggleDockMaximized, handleSplitDock, handleSplitDockDown, handleFindInSession, handleOpenPlan, planAwaitingReview, handleOpenPreview, handleOpenSideQuestions, goal, handleSidebarToggle, handleNewSession, handleOpenTerminal, openSettings, theme, setTheme, readerMode, toggleReaderMode, textSize, setTextSize])
}
