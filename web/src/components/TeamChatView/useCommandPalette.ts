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
import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { listCodingWorkspaceFiles } from '@/api/client'
import { queryKeys } from '@/queries/keys'
import { useIsMobile } from '@/hooks/use-mobile'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
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
    cycleViewMode,
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
  const { data: paletteFilesData } = useQuery<{ files: WorkspaceFileInfo[] }>({
    queryKey: queryKeys.fileRefs.coding(workspace ?? ''),
    queryFn: async () => {
      const res = await listCodingWorkspaceFiles(workspace as string)
      return { files: res.files }
    },
    enabled: isCodingPaletteOpen,
    staleTime: 30_000,
  })

  const paletteWorkspaceFiles = isCodingPaletteOpen ? (paletteFilesData?.files ?? []) : []

  const handlePaletteFileOpen = useCallback((file: WorkspaceFileInfo) => {
    setCodingFileViewer(file)
    setCodingFileViewerDetached(false)
    setCodingFileOpenKey((k) => k + 1)
    setCodingPanel((prev) => prev ?? 'files')
  }, [setCodingFileViewer, setCodingFileViewerDetached, setCodingFileOpenKey, setCodingPanel])

  useKeyboardShortcuts({
    n: handleNewSession,
    // ⌘⇧A / Ctrl+Shift+A — bare ⌘A is "Select All" on macOS, so Session
    // Settings requires Shift to avoid clobbering it.
    a: { handler: handleToggleAgentCapabilities, shift: true },
    f: handleWorkspaceFiles,
    t: () => { if (sessionIdState) handleSetShowTodos((v) => !v) },
    p: isMobile ? undefined : handleTogglePalette,
    b: mode === 'coding' ? handleCodingSidebarToggle : undefined,
    // ⌘⇧V / Ctrl+Shift+V — toggle between agent view and split view.
    v: { handler: cycleViewMode, shift: true },
    // ⌘S / Ctrl+S — open the scheduler drawer (state in useUIStore).
    s: handleToggleScheduler,
    // ⌘I / Ctrl+I — focus the chat input (dispatched via CustomEvent so
    // future callers don't need a ref to the input).
    'i': () => window.dispatchEvent(new CustomEvent('focus-chat-input')),
    // ⌘⇧` / Ctrl+Shift+` — open a terminal (any mode: coding workspace or
    // the cockpit session workspace). Matched on the physical key
    // (KeyboardEvent.code === 'Backquote') because e.key for
    // Shift+backquote is layout-dependent ('~', '`', or even 'Dead' on
    // layouts where backquote is a dead key).
    Backquote: { handler: handleOpenTerminal, shift: true },
  })

  return {
    cycleViewMode,
    paletteCommands,
    paletteWorkspaceFiles,
    handlePaletteFileOpen,
  }
}
