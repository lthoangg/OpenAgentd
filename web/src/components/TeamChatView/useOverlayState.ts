/**
 * useOverlayState — mobile/desktop panel & drawer state for TeamChatView.
 *
 * Owns every "big surface" toggle in the chat layout: the session
 * sidebar, the coding workspace panel + detached file viewer, the
 * (normal-mode) workspace files panel, todos popover, mobile chat-actions
 * menu, and the mobile edge-swipe drawer controller that ties sidebar /
 * actions / coding-panel together as a single-open-at-a-time group.
 *
 * ── Mobile single-overlay rule ──────────────────────────────────────────
 *
 * On mobile every large surface — the session sidebar, chat-actions menu,
 * coding workspace panel, session settings (agent capabilities), the
 * scheduler, todos, the (normal-mode) files panel and the command palette
 * — is a full-screen or near-full-screen overlay. Having two open at once
 * is always a layering bug, so opening any one closes all the others.
 *
 * ``useUIStore`` already enforces this *among* scheduler / capabilities /
 * palette, and ``useEdgeSwipe`` enforces it among the drawers — but the
 * two islands plus todos / files panel never coordinated across each
 * other. ``closeOtherMobileOverlays`` is the cross-island bridge.
 *
 * Mobile-only: sidebar / chat-actions / coding-panel are full-screen
 * overlays that shouldn't stack — guarded behind ``isMobile``.
 * Todos / files / capabilities / scheduler / palette are shared surfaces
 * that must not stack on *either* platform, so those run unconditionally.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { listCodingWorkspaceFiles } from '@/api/client'
import { queryKeys } from '@/queries'
import { useUIStore } from '@/stores/useUIStore'
import { useEdgeSwipe, type EdgeSwipeHandlers } from '@/hooks/use-edge-swipe'
import type { WorkspaceFileInfo } from '@/api/types'
import { overlaysToClose, type MobileOverlay } from './mobileOverlays'

export interface UseOverlayStateArgs {
  isMobile: boolean
  mode: 'normal' | 'coding'
  workspace: string | null
  sessionIdState: string | null
  toggleScheduler: () => void
  toggleAgentCapabilities: () => void
  togglePalette: () => void
}

export interface UseOverlayStateResult {
  mobileSidebarOpen: boolean
  setMobileSidebarOpen: Dispatch<SetStateAction<boolean>>
  showFilesPanel: boolean
  setShowFilesPanel: Dispatch<SetStateAction<boolean>>
  codingPanel: null | 'changed' | 'files'
  setCodingPanel: Dispatch<SetStateAction<null | 'changed' | 'files'>>
  codingFileViewer: WorkspaceFileInfo | null
  setCodingFileViewer: Dispatch<SetStateAction<WorkspaceFileInfo | null>>
  codingFileViewerDetached: boolean
  setCodingFileViewerDetached: Dispatch<SetStateAction<boolean>>
  codingFileOpenKey: number
  setCodingFileOpenKey: Dispatch<SetStateAction<number>>
  terminalOpenKey: number
  handledTerminalOpenKeyRef: React.RefObject<number>
  codingSidebarCollapsed: boolean
  setCodingSidebarCollapsed: Dispatch<SetStateAction<boolean>>
  openWorkspaceDialogKey: number
  showTodos: boolean
  showMobileActions: boolean

  closeOtherMobileOverlays: (keep: MobileOverlay) => void
  handleWorkspaceFiles: () => void
  handleCodingSidebarToggle: () => void
  handleOpenWorkspaceDialog: () => void
  handleCodingFileSelect: (file: WorkspaceFileInfo | null) => void
  handleMentionFileOpen: (path: string) => Promise<void>
  closeMobileActionsMenu: () => void
  handleSetShowMobileActions: Dispatch<SetStateAction<boolean>>
  handleToggleAgentCapabilities: () => void
  handleToggleScheduler: () => void
  handleTogglePalette: () => void
  handleSetShowTodos: Dispatch<SetStateAction<boolean>>
  handleToggleFilesPanel: () => void
  handleOpenTerminal: () => void
  closeAllDrawers: () => void
  openLeftDrawer: () => void
  openRightDrawer: () => void

  edgeSwipeHandlers: EdgeSwipeHandlers
  sidebarDragOffset: number | null
  actionsDragOffset: number | null
  codingPanelDragOffset: number | null
}

export function useOverlayState({
  isMobile,
  mode,
  workspace,
  sessionIdState,
  toggleScheduler,
  toggleAgentCapabilities,
  togglePalette,
}: UseOverlayStateArgs): UseOverlayStateResult {
  const queryClient = useQueryClient()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [showFilesPanel, setShowFilesPanel] = useState(false)
  const [codingPanel, setCodingPanel] = useState<null | 'changed' | 'files'>(null)
  const [codingFileViewer, setCodingFileViewer] = useState<WorkspaceFileInfo | null>(null)
  const [codingFileViewerDetached, setCodingFileViewerDetached] = useState(false)
  const [codingFileOpenKey, setCodingFileOpenKey] = useState(0)
  // Terminal is coding-mode only for now — cockpit mode has no terminal UI.
  const [terminalOpenKey, setTerminalOpenKey] = useState(0)
  const handledTerminalOpenKeyRef = useRef(0)
  const [codingSidebarCollapsed, setCodingSidebarCollapsed] = useState(true)
  const [openWorkspaceDialogKey, setOpenWorkspaceDialogKey] = useState(0)
  const [showTodos, setShowTodos] = useState(false)
  const [showMobileActions, setShowMobileActions] = useState(false)

  useEffect(() => {
    setCodingFileViewer(null)
    setCodingFileViewerDetached(false)
  }, [workspace])

  useEffect(() => {
    if (isMobile) {
      useUIStore.getState().closeAgentCapabilities()
      setShowFilesPanel(false)
    }
  }, [isMobile])

  const closeOtherMobileOverlays = useCallback((keep: MobileOverlay) => {
    const toClose = new Set(overlaysToClose(keep))
    if (isMobile && (toClose.has('sidebar') || toClose.has('actions') || toClose.has('coding-panel'))) {
      setMobileSidebarOpen(false)
      setShowMobileActions(false)
      setCodingPanel(null)
      setCodingFileViewer(null)
      setCodingFileViewerDetached(false)
    }
    if (toClose.has('todos')) setShowTodos(false)
    if (toClose.has('files')) setShowFilesPanel(false)
    const ui = useUIStore.getState()
    if (toClose.has('scheduler')) ui.closeScheduler()
    if (toClose.has('capabilities')) ui.closeAgentCapabilities()
    if (toClose.has('palette')) ui.closePalette()
  }, [isMobile])

  const handleWorkspaceFiles = useCallback(() => {
    if (mode === 'coding') {
      if (workspace) {
        if (isMobile) { setMobileSidebarOpen(false); closeOtherMobileOverlays('coding-panel') }
        setCodingPanel((value) => {
          const next = value === null ? 'changed' : null
          if (next === null) setCodingFileViewerDetached(false)
          return next
        })
      } else {
        setCodingSidebarCollapsed(false)
        setOpenWorkspaceDialogKey((value) => value + 1)
      }
      return
    }
    if (sessionIdState) {
      setShowFilesPanel((value) => {
        const next = !value
        if (next) closeOtherMobileOverlays('files')
        return next
      })
    }
  }, [closeOtherMobileOverlays, isMobile, mode, workspace, sessionIdState])

  const handleCodingSidebarToggle = useCallback(() => {
    if (isMobile) {
      setCodingPanel(null)
      setCodingFileViewer(null)
      setMobileSidebarOpen((value) => {
        const next = !value
        if (next) closeOtherMobileOverlays('sidebar')
        return next
      })
      return
    }
    setCodingSidebarCollapsed((value) => !value)
  }, [closeOtherMobileOverlays, isMobile])

  const handleOpenWorkspaceDialog = useCallback(() => {
    setCodingSidebarCollapsed(false)
    setOpenWorkspaceDialogKey((value) => value + 1)
  }, [])

  const handleCodingFileSelect = useCallback((file: WorkspaceFileInfo | null) => {
    setCodingFileViewer(file)
    setCodingFileViewerDetached(false)
  }, [])

  const handleMentionFileOpen = useCallback(async (path: string) => {
    if (mode !== 'coding' || !workspace) return
    const cleanPath = path.split('#', 1)[0]
    if (!cleanPath) return
    const current = codingFileViewer?.path === cleanPath ? codingFileViewer : null
    if (current) {
      setCodingFileViewer(current)
      setCodingFileViewerDetached(false)
      setCodingFileOpenKey((value) => value + 1)
      setCodingPanel((value) => value ?? 'files')
      return
    }
    try {
      const result = await queryClient.fetchQuery({
        queryKey: queryKeys.coding.files(workspace),
        queryFn: () => listCodingWorkspaceFiles(workspace),
        staleTime: 5_000,
      })
      const file = result.files.find((item) => item.path === cleanPath)
      if (file) {
        setCodingFileViewer(file)
        setCodingFileViewerDetached(false)
        setCodingFileOpenKey((value) => value + 1)
        setCodingPanel((value) => value ?? 'files')
      }
    } catch {
      // Keep the current panel state; the panel query will surface listing errors.
    }
  }, [codingFileViewer, mode, queryClient, workspace])

  const closeMobileActionsMenu = useCallback(() => setShowMobileActions(false), [])

  const handleSetShowMobileActions = useCallback<typeof setShowMobileActions>((value) => {
    setShowMobileActions((prev) => {
      const next = typeof value === 'function' ? value(prev) : value
      if (next && !prev) {
        closeOtherMobileOverlays('actions')
        setMobileSidebarOpen(false)
      }
      return next
    })
  }, [closeOtherMobileOverlays])

  // Cross-platform overlay toggles: when opening one overlay, close the rest.
  // closeOtherMobileOverlays now coordinates todos/files/capabilities on both
  // desktop and mobile; sidebar/actions guards stay mobile-only.
  const handleToggleAgentCapabilities = useCallback(() => {
    if (!useUIStore.getState().agentCapabilitiesOpen) closeOtherMobileOverlays('capabilities')
    toggleAgentCapabilities()
  }, [closeOtherMobileOverlays, toggleAgentCapabilities])

  const handleToggleScheduler = useCallback(() => {
    if (!useUIStore.getState().schedulerOpen) closeOtherMobileOverlays('scheduler')
    toggleScheduler()
  }, [closeOtherMobileOverlays, toggleScheduler])

  const handleTogglePalette = useCallback(() => {
    if (!useUIStore.getState().paletteOpen) closeOtherMobileOverlays('palette')
    togglePalette()
  }, [closeOtherMobileOverlays, togglePalette])

  const handleSetShowTodos = useCallback<typeof setShowTodos>((value) => {
    setShowTodos((prev) => {
      const next = typeof value === 'function' ? value(prev) : value
      if (next && !prev) closeOtherMobileOverlays('todos')
      return next
    })
  }, [closeOtherMobileOverlays])

  const handleToggleFilesPanel = useCallback(() => {
    if (!sessionIdState) return
    setShowFilesPanel((prev) => {
      const next = !prev
      if (next) closeOtherMobileOverlays('files')
      return next
    })
  }, [closeOtherMobileOverlays, sessionIdState])

  // Open (or focus) a terminal — coding mode only for now. Ensures the
  // workspace panel is visible, then bumps the key so CodingWorkspacePanel
  // focuses/opens its terminal tab (cwd = project). Cockpit mode has no
  // terminal UI (kept simple; may return later behind its own entry point).
  const handleOpenTerminal = useCallback(() => {
    if (mode !== 'coding' || !workspace) return
    setCodingPanel((prev) => prev ?? 'files')
    setTerminalOpenKey((k) => k + 1)
  }, [mode, workspace])

  // ── Mobile edge-swipe drawers ──────────────────────────────────────────────
  //
  // One controller owns every mobile drawer so only ONE can be open at a
  // time. The previous implementation tracked each drawer's open state in
  // isolation, which let a left-edge swipe open the sidebar while the
  // right-side actions/coding panel was already open (and vice-versa).
  //
  // Right-edge target depends on context: in a coding workspace it opens
  // the workspace panel (changed files / tree); otherwise the chat-actions
  // menu. Left-edge always opens the session sidebar.
  const codingPanelOpenForSwipe = mode === 'coding' && Boolean(workspace)

  // Single source of truth for "what is open right now". Closing routes to
  // whichever drawer the id names, so swipe-to-close hits the right one.
  const activeDrawer: string | null = mobileSidebarOpen
    ? 'sidebar'
    : showMobileActions
      ? 'actions'
      : codingPanel !== null
        ? 'coding-panel'
        : null

  const closeAllDrawers = useCallback(() => {
    setMobileSidebarOpen(false)
    setShowMobileActions(false)
    setCodingPanel(null)
    setCodingFileViewer(null)
    setCodingFileViewerDetached(false)
  }, [])

  const openLeftDrawer = useCallback(() => {
    // Opening the sidebar must vacate every other overlay first.
    closeOtherMobileOverlays('sidebar')
    setShowMobileActions(false)
    if (mode === 'coding') {
      setCodingPanel(null)
      setCodingFileViewer(null)
    }
    setMobileSidebarOpen(true)
  }, [closeOtherMobileOverlays, mode])

  const openRightDrawer = useCallback(() => {
    // Opening a right drawer must vacate the sidebar + other overlays first.
    setMobileSidebarOpen(false)
    if (codingPanelOpenForSwipe) {
      closeOtherMobileOverlays('coding-panel')
      setShowMobileActions(false)
      setCodingPanel((value) => value ?? 'changed')
    } else {
      closeOtherMobileOverlays('actions')
      setShowMobileActions(true)
    }
  }, [closeOtherMobileOverlays, codingPanelOpenForSwipe])

  const { handlers: edgeSwipeHandlers, drag: edgeSwipeDrag } = useEdgeSwipe({
    activeDrawer,
    left: { id: 'sidebar', open: openLeftDrawer },
    right: { id: codingPanelOpenForSwipe ? 'coding-panel' : 'actions', open: openRightDrawer },
    close: closeAllDrawers,
  })

  // Live drag offset (px) per drawer, fed to each drawer so it tracks the
  // finger. Each drawer reads only its own id; null when not being dragged.
  const sidebarDragOffset = edgeSwipeDrag?.drawerId === 'sidebar' ? edgeSwipeDrag.offset : null
  const actionsDragOffset = edgeSwipeDrag?.drawerId === 'actions' ? edgeSwipeDrag.offset : null
  const codingPanelDragOffset = edgeSwipeDrag?.drawerId === 'coding-panel' ? edgeSwipeDrag.offset : null

  return {
    mobileSidebarOpen,
    setMobileSidebarOpen,
    showFilesPanel,
    setShowFilesPanel,
    codingPanel,
    setCodingPanel,
    codingFileViewer,
    setCodingFileViewer,
    codingFileViewerDetached,
    setCodingFileViewerDetached,
    codingFileOpenKey,
    setCodingFileOpenKey,
    terminalOpenKey,
    handledTerminalOpenKeyRef,
    codingSidebarCollapsed,
    setCodingSidebarCollapsed,
    openWorkspaceDialogKey,
    showTodos,
    showMobileActions,

    closeOtherMobileOverlays,
    handleWorkspaceFiles,
    handleCodingSidebarToggle,
    handleOpenWorkspaceDialog,
    handleCodingFileSelect,
    handleMentionFileOpen,
    closeMobileActionsMenu,
    handleSetShowMobileActions,
    handleToggleAgentCapabilities,
    handleToggleScheduler,
    handleTogglePalette,
    handleSetShowTodos,
    handleToggleFilesPanel,
    handleOpenTerminal,
    closeAllDrawers,
    openLeftDrawer,
    openRightDrawer,

    edgeSwipeHandlers,
    sidebarDragOffset,
    actionsDragOffset,
    codingPanelDragOffset,
  }
}
