/**
 * useCommandPalette — Command Palette assembly, coding-mode palette file
 * search, view-mode cycling, and the window-level keyboard shortcut map.
 *
 * These are grouped together because most of the shortcut handlers (view
 * cycling, palette toggle, workspace files, sidebar/terminal toggles) are
 * *also* the actions the palette lists as commands — keeping them in one
 * hook avoids threading the same dozen callbacks through two separate
 * places in the shell.
 */
import { useCallback, useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useHotkeys } from '@tanstack/react-hotkeys'
import type { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  WORKSPACE_FILES_STALE_MS,
  codingWorkspaceFilesQueryOptions,
} from '@/queries/workspace-files'
import { useIsMobile } from '@/hooks/use-mobile'
import { getPlatform } from '@/hooks/use-platform'
import { isPrimaryShortcut } from '@/lib/keyboard-shortcut'
import type { WorkspaceFileInfo } from '@/api/types'
import type { Command } from '../CommandPalette'
import { useTeamCommands } from './useTeamCommands'
import { VIEW_MODES, type ViewMode } from './types'

export interface UseCommandPaletteArgs {
  mode: 'normal' | 'coding'
  workspace: string | null
  paletteOpen: boolean
  sessionIdState: string | null
  viewMode: ViewMode
  setViewMode: Dispatch<SetStateAction<ViewMode>>
  navigate: ReturnType<typeof useNavigate>

  handleNewSession: () => void
  handleWorkspaceFiles: () => void
  handleCodingSidebarToggle: () => void
  handleToggleAgentCapabilities: () => void
  handleSetShowTodos: Dispatch<SetStateAction<boolean>>
  handleTogglePalette: () => void
  handleToggleScheduler: () => void
  handleOpenTerminal: () => void

  setCodingFileViewer: Dispatch<SetStateAction<WorkspaceFileInfo | null>>
  setCodingFileViewerDetached: Dispatch<SetStateAction<boolean>>
  setCodingFileOpenKey: Dispatch<SetStateAction<number>>
  setCodingPanel: Dispatch<SetStateAction<null | 'changed' | 'files'>>
}

export interface UseCommandPaletteResult {
  cycleViewMode: () => void
  paletteCommands: Command[]
  paletteWorkspaceFiles: WorkspaceFileInfo[]
  /** The backend listing hit its file cap — surfaced in the palette footer. */
  paletteFilesTruncated: boolean
  handlePaletteFileOpen: (file: WorkspaceFileInfo) => void
}

export function useCommandPalette({
  mode,
  workspace,
  paletteOpen,
  sessionIdState,
  viewMode,
  setViewMode,
  navigate,
  handleNewSession,
  handleWorkspaceFiles,
  handleCodingSidebarToggle,
  handleToggleAgentCapabilities,
  handleSetShowTodos,
  handleTogglePalette,
  handleToggleScheduler,
  handleOpenTerminal,
  setCodingFileViewer,
  setCodingFileViewerDetached,
  setCodingFileOpenKey,
  setCodingPanel,
}: UseCommandPaletteArgs): UseCommandPaletteResult {
  const isMobile = useIsMobile()

  const cycleViewMode = useCallback(() => {
    setViewMode((v) => {
      const idx = VIEW_MODES.indexOf(v)
      return VIEW_MODES[(idx + 1) % VIEW_MODES.length]
    })
  }, [setViewMode])

  const paletteCommands = useTeamCommands({
    viewMode,
    toggleAgentCapabilities: handleToggleAgentCapabilities,
    setShowTodos: handleSetShowTodos,
    handleWorkspaceFiles,
    handleCodingSidebarToggle,
    mode,
    handleNewSession,
    handleOpenTerminal: mode === 'coding' && workspace ? handleOpenTerminal : undefined,
    navigate,
  })

  // ── Coding-mode file search in the palette ─────────────────────────────────
  //
  // Fetch the workspace file listing when the palette is open (coding mode
  // only). We reuse the same query key as the @-mention picker so the two
  // share a cache entry — no extra network request when both are warm.
  const isCodingPaletteOpen = mode === 'coding' && Boolean(workspace) && paletteOpen
  const { data: paletteFilesData } = useQuery({
    // Must cache the *full* response, not a narrowed { files } object — the
    // coding file tree reads the same entry. See ``workspace-files.ts``.
    ...codingWorkspaceFilesQueryOptions(workspace ?? ''),
    enabled: isCodingPaletteOpen,
    staleTime: WORKSPACE_FILES_STALE_MS,
  })

  const paletteWorkspaceFiles = isCodingPaletteOpen ? (paletteFilesData?.files ?? []) : []
  const paletteFilesTruncated = isCodingPaletteOpen && Boolean(paletteFilesData?.truncated)

  const handlePaletteFileOpen = useCallback((file: WorkspaceFileInfo) => {
    setCodingFileViewer(file)
    setCodingFileViewerDetached(false)
    setCodingFileOpenKey((k) => k + 1)
    setCodingPanel((prev) => prev ?? 'files')
  }, [setCodingFileViewer, setCodingFileViewerDetached, setCodingFileOpenKey, setCodingPanel])

  const { os } = getPlatform()
  useHotkeys(
    [
      { hotkey: 'Mod+N', callback: handleNewSession, options: { meta: { name: 'New session' } } },
      { hotkey: 'Mod+Shift+A', callback: handleToggleAgentCapabilities, options: { meta: { name: 'Agent capabilities' } } },
      { hotkey: 'Mod+F', callback: handleWorkspaceFiles, options: { meta: { name: 'Workspace files' } } },
      { hotkey: 'Mod+T', callback: () => handleSetShowTodos((v) => !v), options: { enabled: Boolean(sessionIdState), meta: { name: 'Todos' } } },
      { hotkey: 'Mod+P', callback: handleTogglePalette, options: { enabled: !isMobile, meta: { name: 'Command palette' } } },
      // Normal-mode Mod+B belongs to Sidebar. Only the coding sidebar owns this
      // registration when coding mode is active, preventing duplicate handlers.
      { hotkey: 'Mod+B', callback: handleCodingSidebarToggle, options: { enabled: mode === 'coding', meta: { name: 'Coding sidebar' } } },
      { hotkey: 'Mod+Shift+V', callback: cycleViewMode, options: { meta: { name: 'View mode' } } },
      { hotkey: 'Mod+S', callback: handleToggleScheduler, options: { meta: { name: 'Scheduler' } } },
      { hotkey: 'Mod+I', callback: () => window.dispatchEvent(new CustomEvent('focus-chat-input')), options: { meta: { name: 'Focus chat input' } } },
    ],
    {
      target: document,
      platform: os === 'macos' ? 'mac' : os === 'windows' ? 'windows' : 'linux',
      preventDefault: true,
      stopPropagation: false,
      ignoreInputs: false,
    },
  )

  // Keep this physical-key shortcut custom: layouts can report Shift+Backquote
  // as `~`, `` ` ``, or `Dead`, which a character hotkey cannot represent.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.code !== 'Backquote' || !isPrimaryShortcut(event, os, { shift: true })) return
      event.preventDefault()
      handleOpenTerminal()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleOpenTerminal, os])

  return {
    cycleViewMode,
    paletteCommands,
    paletteWorkspaceFiles,
    paletteFilesTruncated,
    handlePaletteFileOpen,
  }
}
