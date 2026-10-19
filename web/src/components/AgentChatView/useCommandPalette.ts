/**
 * useCommandPalette — Command Palette assembly, workspace file search,
 * view-mode cycling, and the window-level keyboard shortcut map.
 *
 * These are grouped together because most of the shortcut handlers (view
 * cycling, palette toggle, workspace files, sidebar/terminal toggles) are
 * *also* the actions the palette lists as commands — keeping them in one
 * hook avoids threading the same dozen callbacks through two separate
 * places in the shell.
 */
import { useCallback, useMemo } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  WORKSPACE_FILES_STALE_MS,
  workspaceFileListQueryOptions,
} from '@/queries/workspace-files'
import { useIsMobile } from '@/hooks/use-mobile'
import { appShortcut, useShortcuts } from '@/lib/keyboard/hooks'
import { useFileRevealStore } from '@/stores/useFileRevealStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import type { WorkspaceFileInfo } from '@/api/types'
import type { Command } from '../CommandPalette'
import { useAgentCommands } from './useAgentCommands'
import { usePaletteSwitchCommands } from './usePaletteSwitchCommands'

export interface UseCommandPaletteArgs {
  workspace: string | null
  quickOpenOpen: boolean
  sessionIdState: string | null
  /** True while the review dock is mounted (``workspacePanel !== null``). */
  workspacePanelOpen: boolean

  handleNewSession: () => void
  handleWorkspaceFiles: () => void
  /** Project workspaces only: opens or shows the dock's Git tab. */
  handleOpenGit?: () => void
  handleSidebarToggle: () => void
  handleToggleAgentCapabilities: () => void
  /** Desktop + workspace: the dock's Tasks tab; otherwise the popover. */
  handleToggleTasks: () => void
  handleTogglePalette: () => void
  handleToggleQuickOpen: () => void
  handleToggleScheduler: () => void
  handleOpenTerminal: () => void
  /** Only while the session has a plan; lists Open Plan. */
  handleOpenPlan?: () => void
  planAwaitingReview?: boolean
  /** Workspace with a local backend only: opens a web preview tab. */
  handleOpenPreview?: () => void
  /** Shows the session's ``/btw`` side questions (dock tab or composer panel). */
  handleOpenSideQuestions: (sessionId: string) => void

  setFileViewer: Dispatch<SetStateAction<WorkspaceFileInfo | null>>
  setFileOpenKey: Dispatch<SetStateAction<number>>
  setWorkspacePanel: Dispatch<SetStateAction<null | 'changed' | 'files'>>
}

export interface UseCommandPaletteResult {
  paletteCommands: Command[]
  quickOpenWorkspaceFiles: WorkspaceFileInfo[]
  /** The backend listing hit its file cap — surfaced in the Quick Open footer. */
  quickOpenFilesTruncated: boolean
  /** Opens the pick in the dock, at the lines the query named. */
  handleQuickOpenFileOpen: (file: WorkspaceFileInfo, line?: number, endLine?: number) => void
}

export function useCommandPalette({
  workspace,
  quickOpenOpen,
  sessionIdState,
  workspacePanelOpen,
  handleNewSession,
  handleWorkspaceFiles,
  handleOpenGit,
  handleSidebarToggle,
  handleToggleAgentCapabilities,
  handleToggleTasks,
  handleTogglePalette,
  handleToggleQuickOpen,
  handleToggleScheduler,
  handleOpenTerminal,
  handleOpenPlan,
  planAwaitingReview,
  handleOpenPreview,
  handleOpenSideQuestions: openSideQuestions,
  setFileViewer,
  setFileOpenKey,
  setWorkspacePanel,
}: UseCommandPaletteArgs): UseCommandPaletteResult {
  const isMobile = useIsMobile()

  // ⌘⇧D — maximize the review dock over the chat (Zed's panel zoom). Opens
  // the dock first when it is closed. Mobile docks are already full-screen.
  const handleToggleDockMaximized = useCallback(() => {
    if (!workspace || isMobile) return
    const layout = useLayoutStore.getState()
    if (!workspacePanelOpen) {
      setWorkspacePanel('changed')
      layout.setDockMaximized(true)
      return
    }
    layout.toggleDockMaximized()
  }, [workspacePanelOpen, isMobile, setWorkspacePanel, workspace])

  const handleOpenSideQuestions = useMemo(
    () => (sessionIdState ? () => openSideQuestions(sessionIdState) : undefined),
    [sessionIdState, openSideQuestions],
  )

  const agentCommands = useAgentCommands({
    toggleAgentCapabilities: handleToggleAgentCapabilities,
    toggleTasks: handleToggleTasks,
    toggleScheduler: handleToggleScheduler,
    handleWorkspaceFiles,
    handleOpenGit,
    handleSidebarToggle,
    handleNewSession,
    handleOpenTerminal,
    handleToggleDockMaximized: workspace && !isMobile ? handleToggleDockMaximized : undefined,
    handleOpenPlan,
    planAwaitingReview,
    handleOpenPreview,
    handleOpenSideQuestions,
  })
  const switchCommands = usePaletteSwitchCommands({ workspace, sessionId: sessionIdState })
  const paletteCommands = useMemo(() => [...agentCommands, ...switchCommands], [agentCommands, switchCommands])

  // ── Quick Open workspace file search ───────────────────────────────────────
  //
  // Fetch the active workspace file listing when Quick Open is open. We reuse
  // the same query key as the @-mention picker so the two
  // share a cache entry — no extra network request when both are warm.
  const hasQuickOpenWorkspace = Boolean(workspace)
  const quickOpenQueryOptions = workspaceFileListQueryOptions(workspace ?? '')
  const { data: paletteFilesData } = useQuery<
    { files: WorkspaceFileInfo[]; truncated?: boolean },
    Error,
    { files: WorkspaceFileInfo[]; truncated?: boolean },
    readonly unknown[]
  >({
    // Must cache the *full* response, not a narrowed { files } object — the
    // workspace file tree reads the same entry. See ``workspace-files.ts``.
    ...quickOpenQueryOptions,
    enabled: quickOpenOpen && hasQuickOpenWorkspace,
    staleTime: WORKSPACE_FILES_STALE_MS,
  })

  const quickOpenWorkspaceFiles = quickOpenOpen ? (paletteFilesData?.files ?? []) : []
  const quickOpenFilesTruncated = quickOpenOpen && Boolean(paletteFilesData?.truncated)

  const handleQuickOpenFileOpen = useCallback((file: WorkspaceFileInfo, line?: number, endLine?: number) => {
    setFileViewer(file)
    setFileOpenKey((k) => k + 1)
    setWorkspacePanel((prev) => prev ?? 'files')
    if (line) useFileRevealStore.getState().reveal(file.path, line, endLine)
  }, [setFileViewer, setFileOpenKey, setWorkspacePanel])

  // The shell's shortcut map. Behind a dialog or overlay the dispatcher blocks
  // these (switchers aside), so none of them act on the app underneath.
  useShortcuts([
    appShortcut('newSession', () => { handleNewSession() }),
    appShortcut('sessionSettings', () => { handleToggleAgentCapabilities() }),
    appShortcut('workspaceFiles', () => { handleWorkspaceFiles() }),
    appShortcut('maximizeDock', () => { handleToggleDockMaximized() }, { enabled: !isMobile && Boolean(workspace) }),
    appShortcut('tasks', () => { handleToggleTasks() }, { enabled: Boolean(sessionIdState) }),
    appShortcut('quickOpen', () => { handleToggleQuickOpen() }, { enabled: !isMobile && hasQuickOpenWorkspace }),
    appShortcut('commandPalette', () => { handleTogglePalette() }, { enabled: !isMobile }),
    appShortcut('sidebar', () => { handleSidebarToggle() }),
    appShortcut('focusChat', () => {
      // The composer is inert under a maximized dock; restore it first.
      useLayoutStore.getState().setDockMaximized(false)
      window.dispatchEvent(new CustomEvent('focus-chat-input'))
    }),
    appShortcut('terminal', () => { handleOpenTerminal() }),
    appShortcut('openGit', () => { handleOpenGit?.() }, { enabled: handleOpenGit !== undefined }),
  ])

  return {
    paletteCommands,
    quickOpenWorkspaceFiles,
    quickOpenFilesTruncated,
    handleQuickOpenFileOpen,
  }
}
