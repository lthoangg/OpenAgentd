/**
 * useOverlayState — mobile/desktop panel & drawer state for AgentChatView.
 *
 * Owns every "big surface" toggle in the chat layout: the session
 * sidebar, the workspace panel + detached file viewer, the
 * workspace files panel, todos popover, mobile chat-actions
 * menu, and the mobile edge-swipe drawer controller that ties sidebar /
 * actions / workspace-panel together as a single-open-at-a-time group.
 *
 * ── Mobile single-overlay rule ──────────────────────────────────────────
 *
 * On mobile every large surface — the session sidebar, chat-actions menu,
 * workspace panel, session settings (agent capabilities), the
 * scheduler, todos, the files panel and the command palette
 * — is a full-screen or near-full-screen overlay. Having two open at once
 * is always a layering bug, so opening any one closes all the others.
 *
 * ``useUIStore`` already enforces this *among* scheduler / capabilities /
 * palette, and ``useEdgeSwipe`` enforces it among the drawers — but the
 * two islands plus todos / files panel never coordinated across each
 * other. ``closeOtherMobileOverlays`` is the cross-island bridge.
 *
 * Mobile-only: sidebar / chat-actions / workspace-panel are full-screen
 * overlays that shouldn't stack — guarded behind ``isMobile``.
 * Todos / files / capabilities / scheduler / palette are shared surfaces
 * that must not stack on *either* platform, so those run unconditionally.
 *
 * ── Desktop dock views ──────────────────────────────────────────────────
 *
 * On desktop with a workspace, the agent task list and the scheduler open
 * as review-dock tabs instead of the popover / overlay. The request mirrors
 * the terminal pattern: a keyed request plus a parent-owned "handled" ref, so
 * a dock that mounts in response still honours it, and a later ⌘D does not
 * replay it. The dock reports its active view back so a second press of the
 * same shortcut hides the dock (VS Code's panel toggle).
 *
 * Phones with a workspace open the scheduler in the dock sheet as well: it
 * is full-screen either way, and the sheet adds swipe-to-close and the
 * Changes / Files / Terminal tabs. Tasks stay in the popover there, the one
 * surface that leaves the chat visible while the agent works.
 *
 * `/btw` side questions follow Tasks: a dock tab on desktop with a
 * workspace, otherwise the panel above the composer.
 *
 * The session plan opens as a Plan tab on every platform with a workspace
 * (the dock sheet on phones). Desktop brings it forward by itself once per
 * plan review, so the plan the agent submitted is on screen to review.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { listCodingWorkspaceFiles } from '@/api/client'
import { queryKeys } from '@/queries'
import { useAgentStore } from '@/stores/useAgentStore'
import { useBtwStore } from '@/stores/useBtwStore'
import { useUIStore } from '@/stores/useUIStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useFileRevealStore } from '@/stores/useFileRevealStore'
import { useToastStore } from '@/stores/useToastStore'
import { parseMentionRef, resolveWorkspaceRef, workspaceRelativePath, type FileRef } from '@/utils/file-refs'
import { resolveSidebarCollapsed, SIDEBAR_AUTO_EXPAND_MIN_VIEWPORT } from '@/lib/workbench-layout'
import { useViewportAtLeast } from '@/hooks/use-viewport-width'
import { useEdgeSwipe, type EdgeSwipeHandlers } from '@/hooks/use-edge-swipe'
import { APP_EVENTS } from '@/lib/app-events'
import type { WorkspaceFileInfo } from '@/api/types'
import type { AttachmentTabRequest, DiffTabRequest, DockView, DockViewRequest, PreviewTabRequest } from '../WorkspacePanel/dock-tabs'
import type { FileLightboxItem } from '../FileLightbox'
import type { PreviewTarget } from '@/api/preview'
import type { ChangedFileStatus } from '../WorkspacePanel/diff-helpers'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { sessionTouchedPaths } from './helpers'
import { overlaysToClose, type MobileOverlay } from './mobileOverlays'

export type { AttachmentTabRequest, DiffTabRequest, DockView, DockViewRequest, PreviewTabRequest }

export interface UseOverlayStateArgs {
  isMobile: boolean
  workspace: string | null
  toggleScheduler: () => void
  toggleAgentCapabilities: () => void
  togglePalette: () => void
  toggleQuickOpen: () => void
}

export interface UseOverlayStateResult {
  mobileSidebarOpen: boolean
  setMobileSidebarOpen: Dispatch<SetStateAction<boolean>>
  workspacePanel: null | 'changed' | 'files'
  setWorkspacePanel: Dispatch<SetStateAction<null | 'changed' | 'files'>>
  fileViewer: WorkspaceFileInfo | null
  setFileViewer: Dispatch<SetStateAction<WorkspaceFileInfo | null>>
  fileOpenKey: number
  setFileOpenKey: Dispatch<SetStateAction<number>>
  terminalOpenKey: number
  handledTerminalOpenKeyRef: React.RefObject<number>
  dockViewRequest: DockViewRequest | null
  handledDockViewKeyRef: React.RefObject<number>
  dockDiffRequest: DiffTabRequest | null
  handledDockDiffRequestKeyRef: React.RefObject<number>
  dockPreviewRequest: PreviewTabRequest | null
  handledDockPreviewRequestKeyRef: React.RefObject<number>
  dockAttachmentRequest: AttachmentTabRequest | null
  handledDockAttachmentRequestKeyRef: React.RefObject<number>
  /** Dock view tab currently focused in the mounted dock, else ``null``. */
  dockActiveView: DockView | null
  setDockActiveView: Dispatch<SetStateAction<DockView | null>>
  /** True when tasks / scheduler open as dock tabs (desktop + workspace). */
  dockViewsEnabled: boolean
  /** True when the scheduler opens as a dock tab (any platform + workspace). */
  schedulerInDock: boolean
  sidebarCollapsed: boolean
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>
  openWorkspaceDialogKey: number
  showTodos: boolean
  showMobileActions: boolean

  closeOtherMobileOverlays: (keep: MobileOverlay) => void
  handleWorkspaceFiles: () => void
  /** Opens the dock on its Git tab, or shows the open one (workspace only). */
  handleOpenGit: () => void
  handleSidebarToggle: () => void
  handleOpenWorkspaceDialog: () => void
  handleFileSelect: (file: WorkspaceFileInfo | null) => void
  handleMentionFileOpen: (path: string) => Promise<void>
  /**
   * Open a clicked ``path:line`` from the transcript, at its line. A name or
   * partial path finds its file; several matches open Quick Open to choose.
   */
  handleFileRefOpen: (ref: FileRef) => Promise<void>
  /** Open a clicked file change from reader mode as a full-height diff tab in the dock. */
  handleDiffOpen: (ref: FileRef & { status?: ChangedFileStatus }) => void
  /** Open a web preview tab in the dock (workspace only). */
  /** ``focusOnly`` shows an open tab for ``target`` without navigating it. */
  handleOpenPreview: (target: PreviewTarget, options?: { focusOnly?: boolean }) => void
  /** Open a sent message's attachment as a dock tab (workspace only). */
  handleOpenAttachment: (item: FileLightboxItem) => void
  closeMobileActionsMenu: () => void
  handleSetShowMobileActions: Dispatch<SetStateAction<boolean>>
  handleToggleAgentCapabilities: () => void
  handleToggleScheduler: () => void
  handleTogglePalette: () => void
  /** Open Session Settings to pick another model. */
  handleSwitchModel: () => void
  handleToggleQuickOpen: () => void
  handleSetShowTodos: Dispatch<SetStateAction<boolean>>
  /** ⌘T, the header Tasks button, and the palette's Task List command. */
  handleToggleTasks: () => void
  /**
   * Show the session plan: the dock's Plan tab with a workspace, else the
   * Tasks popover, whose plan row opens it as a document.
   */
  handleOpenPlan: () => void
  /**
   * Show the session's `/btw` side questions: the dock's BTW tab on desktop
   * with a workspace, else the panel above the composer. Never hides them.
   */
  handleOpenSideQuestions: (sessionId: string) => void
  handleToggleFilesPanel: () => void
  handleOpenTerminal: () => void
  closeAllDrawers: () => void
  openLeftDrawer: () => void
  openRightDrawer: () => void

  edgeSwipeHandlers: EdgeSwipeHandlers
  sidebarDragOffset: number | null
  actionsDragOffset: number | null
  workspacePanelDragOffset: number | null
}

export function useOverlayState({
  isMobile,
  workspace,
  toggleScheduler,
  toggleAgentCapabilities,
  togglePalette,
  toggleQuickOpen,
}: UseOverlayStateArgs): UseOverlayStateResult {
  const queryClient = useQueryClient()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [workspacePanel, setWorkspacePanel] = useState<null | 'changed' | 'files'>(null)
  const [fileViewer, setFileViewer] = useState<WorkspaceFileInfo | null>(null)
  const [fileOpenKey, setFileOpenKey] = useState(0)
  // Terminal is available once a workspace is attached.
  const [terminalOpenKey, setTerminalOpenKey] = useState(0)
  const handledTerminalOpenKeyRef = useRef(0)
  const [dockViewRequest, setDockViewRequest] = useState<DockViewRequest | null>(null)
  const handledDockViewKeyRef = useRef(0)
  const [dockDiffRequest, setDockDiffRequest] = useState<DiffTabRequest | null>(null)
  const handledDockDiffRequestKeyRef = useRef(0)
  const [dockPreviewRequest, setDockPreviewRequest] = useState<PreviewTabRequest | null>(null)
  const handledDockPreviewRequestKeyRef = useRef(0)
  const [dockAttachmentRequest, setDockAttachmentRequest] = useState<AttachmentTabRequest | null>(null)
  const handledDockAttachmentRequestKeyRef = useRef(0)
  const [dockActiveView, setDockActiveView] = useState<DockView | null>(null)
  const dockViewsEnabled = !isMobile && Boolean(workspace)
  const schedulerInDock = Boolean(workspace)
  // Desktop sidebar collapse is persisted in the layout store. Until the user
  // toggles it once, wide windows open with the sidebar expanded.
  const storedSidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed)
  const wideViewport = useViewportAtLeast(SIDEBAR_AUTO_EXPAND_MIN_VIEWPORT)
  const sidebarCollapsed = resolveSidebarCollapsed(storedSidebarCollapsed, wideViewport)
  const setSidebarCollapsed = useCallback<Dispatch<SetStateAction<boolean>>>((value) => {
    useLayoutStore.getState().setSidebarCollapsed(
      value,
      resolveSidebarCollapsed(useLayoutStore.getState().sidebarCollapsed, wideViewport),
    )
  }, [wideViewport])
  const [openWorkspaceDialogKey, setOpenWorkspaceDialogKey] = useState(0)
  const [showTodos, setShowTodos] = useState(false)
  const [showMobileActions, setShowMobileActions] = useState(false)

  useEffect(() => {
    setFileViewer(null)
  }, [workspace])

  // Maximize is a per-opening affordance: closing the dock always restores
  // the chat so the next ⌘D opens side by side.
  useEffect(() => {
    if (workspacePanel === null) useLayoutStore.getState().setDockMaximized(false)
  }, [workspacePanel])

  useEffect(() => {
    if (isMobile) {
      useUIStore.getState().closeAgentCapabilities()
    }
  }, [isMobile])

  const closeOtherMobileOverlays = useCallback((keep: MobileOverlay) => {
    const toClose = new Set(overlaysToClose(keep))
    if (isMobile && (toClose.has('sidebar') || toClose.has('actions') || toClose.has('workspace-panel'))) {
      setMobileSidebarOpen(false)
      setShowMobileActions(false)
      setWorkspacePanel(null)
      setFileViewer(null)
    }
    if (toClose.has('todos')) setShowTodos(false)
    const ui = useUIStore.getState()
    if (toClose.has('scheduler')) ui.closeScheduler()
    if (toClose.has('capabilities')) ui.closeAgentCapabilities()
    if (toClose.has('palette')) {
      ui.closePalette()
      ui.closeQuickOpen()
    }
  }, [isMobile])

  const handleWorkspaceFiles = useCallback(() => {
    if (workspace) {
        if (isMobile) { setMobileSidebarOpen(false); closeOtherMobileOverlays('workspace-panel') }
        setWorkspacePanel((value) => (value === null ? 'changed' : null))
      } else {
        setSidebarCollapsed(false)
        setOpenWorkspaceDialogKey((value) => value + 1)
      }
  }, [closeOtherMobileOverlays, isMobile, setSidebarCollapsed, workspace])

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setWorkspacePanel(null)
      setFileViewer(null)
      setMobileSidebarOpen((value) => {
        const next = !value
        if (next) closeOtherMobileOverlays('sidebar')
        return next
      })
      return
    }
    setSidebarCollapsed((value) => !value)
  }, [closeOtherMobileOverlays, isMobile, setSidebarCollapsed])

  const handleOpenGit = useCallback(() => {
    if (!workspace) return
    if (isMobile) setMobileSidebarOpen(false)
    closeOtherMobileOverlays('workspace-panel')
    setWorkspacePanel((value) => value ?? 'changed')
    setDockViewRequest((prev) => ({ view: 'review', key: (prev?.key ?? 0) + 1 }))
  }, [closeOtherMobileOverlays, isMobile, workspace])

  const handleOpenWorkspaceDialog = useCallback(() => {
    setSidebarCollapsed(false)
    setOpenWorkspaceDialogKey((value) => value + 1)
  }, [setSidebarCollapsed])

  const handleFileSelect = useCallback((file: WorkspaceFileInfo | null) => {
    setFileViewer(file)
  }, [])

  const showFile = useCallback((file: WorkspaceFileInfo) => {
    setFileViewer(file)
    setFileOpenKey((value) => value + 1)
    setWorkspacePanel((value) => value ?? 'files')
  }, [])

  /** The workspace listing, or ``null`` when it cannot be fetched. */
  const listWorkspaceFiles = useCallback(async (): Promise<WorkspaceFileInfo[] | null> => {
    if (!workspace) return null
    try {
      const result = await queryClient.fetchQuery({
        queryKey: queryKeys.coding.files(workspace),
        queryFn: () => listCodingWorkspaceFiles(workspace),
        staleTime: 5_000,
      })
      return result.files
    } catch {
      // Keep the current panel state; the panel query will surface listing errors.
      return null
    }
  }, [queryClient, workspace])

  /** Show a workspace-relative file in the dock; false when it is not listed. */
  const openWorkspaceFile = useCallback(async (cleanPath: string): Promise<boolean> => {
    if (!workspace) return false
    if (fileViewer?.path === cleanPath) {
      showFile(fileViewer)
      return true
    }
    const file = (await listWorkspaceFiles())?.find((item) => item.path === cleanPath)
    if (file) showFile(file)
    return Boolean(file)
  }, [fileViewer, listWorkspaceFiles, showFile, workspace])

  const showDiff = useCallback((path: string, status?: ChangedFileStatus) => {
    if (!workspace) return
    if (isMobile) {
      setMobileSidebarOpen(false)
    }
    closeOtherMobileOverlays('workspace-panel')
    setWorkspacePanel((value) => value ?? 'changed')
    const state = useGitPanelStore.getState()
    state.setSubTab(workspace, 'changes')
    const expanded = state.workspaces[workspace]?.expandedDiffs ?? []
    if (!expanded.includes(path)) {
      state.setExpandedDiffs(workspace, [...expanded, path])
    }
    setDockDiffRequest((prev) => ({ path, status, key: (prev?.key ?? 0) + 1 }))
  }, [closeOtherMobileOverlays, isMobile, workspace])

  const handleDiffOpen = useCallback((ref: FileRef & { status?: ChangedFileStatus }) => {
    const cited = workspace ? workspaceRelativePath(ref.path, workspace) : null
    if (!workspace || !cited) return
    showDiff(cited, ref.status)
  }, [showDiff, workspace])

  const handleOpenPreview = useCallback((target: PreviewTarget, options?: { focusOnly?: boolean }) => {
    if (!workspace) return
    if (isMobile) setMobileSidebarOpen(false)
    closeOtherMobileOverlays('workspace-panel')
    setWorkspacePanel((value) => value ?? 'changed')
    setDockPreviewRequest((prev) => ({ target, key: (prev?.key ?? 0) + 1, ...(options?.focusOnly ? { focusOnly: true } : {}) }))
  }, [closeOtherMobileOverlays, isMobile, workspace])

  const handleOpenAttachment = useCallback((item: FileLightboxItem) => {
    if (!workspace) return
    if (isMobile) setMobileSidebarOpen(false)
    closeOtherMobileOverlays('workspace-panel')
    setWorkspacePanel((value) => value ?? 'changed')
    setDockAttachmentRequest((prev) => ({ item, key: (prev?.key ?? 0) + 1 }))
  }, [closeOtherMobileOverlays, isMobile, workspace])

  const handleMentionFileOpen = useCallback(async (path: string) => {
    // ``src/App.tsx#L42-L71`` (a mention or a design feedback source) opens
    // the file on that range, like a ``src/App.tsx:42-71`` reference in text.
    const ref = parseMentionRef(path)
    if (!ref.path || !(await openWorkspaceFile(ref.path))) return
    if (ref.line) useFileRevealStore.getState().reveal(ref.path, ref.line, ref.endLine)
  }, [openWorkspaceFile])

  const handleFileRefOpen = useCallback(async (ref: FileRef) => {
    const cited = workspace ? workspaceRelativePath(ref.path, workspace) : null
    if (!workspace || !cited) return
    const files = (await listWorkspaceFiles()) ?? []
    const { leadName, agentStreams } = useAgentStore.getState()
    const match = resolveWorkspaceRef(cited, files.map((file) => file.path), sessionTouchedPaths(agentStreams, leadName, workspace))
    if (match.kind === 'ambiguous') {
      closeOtherMobileOverlays('palette')
      const lines = ref.line ? `:${ref.line}${ref.endLine ? `-${ref.endLine}` : ''}` : ''
      useUIStore.getState().openQuickOpen(`${cited}${lines}`)
      return
    }
    const file = match.kind === 'file' ? files.find((item) => item.path === match.path) : undefined
    if (!file) {
      useToastStore.getState().push({ tone: 'info', title: 'File not found', description: `No file in this workspace matches ${cited}.` })
      return
    }
    showFile(file)
    if (ref.line) useFileRevealStore.getState().reveal(file.path, ref.line, ref.endLine)
  }, [closeOtherMobileOverlays, listWorkspaceFiles, showFile, workspace])

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

  // Second press of the same view's shortcut hides the dock; otherwise the
  // dock opens (if needed) and focuses that view's tab.
  const toggleDockView = useCallback((view: DockView) => {
    if (workspacePanel !== null && dockActiveView === view) {
      setWorkspacePanel(null)
      return
    }
    closeOtherMobileOverlays('workspace-panel')
    setWorkspacePanel((value) => value ?? 'changed')
    setDockViewRequest((prev) => ({ view, key: (prev?.key ?? 0) + 1 }))
  }, [closeOtherMobileOverlays, workspacePanel, dockActiveView])

  const handleToggleScheduler = useCallback(() => {
    if (schedulerInDock) {
      toggleDockView('schedule')
      return
    }
    if (!useUIStore.getState().schedulerOpen) closeOtherMobileOverlays('scheduler')
    toggleScheduler()
  }, [closeOtherMobileOverlays, schedulerInDock, toggleDockView, toggleScheduler])

  const handleOpenScheduler = useCallback(() => {
    if (schedulerInDock) {
      closeOtherMobileOverlays('workspace-panel')
      setWorkspacePanel((value) => value ?? 'changed')
      setDockViewRequest((prev) => ({ view: 'schedule', key: (prev?.key ?? 0) + 1 }))
      return
    }
    if (useUIStore.getState().schedulerOpen) return
    closeOtherMobileOverlays('scheduler')
    toggleScheduler()
  }, [closeOtherMobileOverlays, schedulerInDock, toggleScheduler])

  // A deep link (the home-screen scheduled-tasks widget) asked for the
  // scheduler, possibly before this view mounted. Taken once, so a remount
  // does not reopen it.
  const schedulerOpenPending = useUIStore((s) => s.schedulerOpenPending)
  useEffect(() => {
    if (schedulerOpenPending && useUIStore.getState().takeSchedulerOpenRequest()) handleOpenScheduler()
  }, [handleOpenScheduler, schedulerOpenPending])

  const handleTogglePalette = useCallback(() => {
    if (!useUIStore.getState().paletteOpen) closeOtherMobileOverlays('palette')
    togglePalette()
  }, [closeOtherMobileOverlays, togglePalette])

  // Session Settings holds the model picker, focused when it opens.
  const handleSwitchModel = useCallback(() => {
    if (!useUIStore.getState().agentCapabilitiesOpen) handleToggleAgentCapabilities()
  }, [handleToggleAgentCapabilities])

  const handleToggleQuickOpen = useCallback(() => {
    if (!useUIStore.getState().quickOpenOpen) closeOtherMobileOverlays('palette')
    toggleQuickOpen()
  }, [closeOtherMobileOverlays, toggleQuickOpen])

  const handleSetShowTodos = useCallback<typeof setShowTodos>((value) => {
    setShowTodos((prev) => {
      const next = typeof value === 'function' ? value(prev) : value
      if (next && !prev) closeOtherMobileOverlays('todos')
      return next
    })
  }, [closeOtherMobileOverlays])

  const handleToggleTasks = useCallback(() => {
    if (dockViewsEnabled) toggleDockView('tasks')
    else handleSetShowTodos((value) => !value)
  }, [dockViewsEnabled, handleSetShowTodos, toggleDockView])

  // The fallback popover must not linger when the dock takes over (e.g. a
  // workspace attaches while it is open on desktop).
  useEffect(() => {
    if (dockViewsEnabled) setShowTodos(false)
  }, [dockViewsEnabled])

  const handleOpenPlan = useCallback(() => {
    if (!workspace) {
      handleSetShowTodos(true)
      return
    }
    if (isMobile) setMobileSidebarOpen(false)
    closeOtherMobileOverlays('workspace-panel')
    setWorkspacePanel((value) => value ?? 'changed')
    setDockViewRequest((prev) => ({ view: 'plan', key: (prev?.key ?? 0) + 1 }))
  }, [closeOtherMobileOverlays, handleSetShowTodos, isMobile, workspace])

  const handleOpenSideQuestions = useCallback((sessionId: string) => {
    if (!dockViewsEnabled) {
      useBtwStore.getState().reopen(sessionId)
      return
    }
    setWorkspacePanel((value) => value ?? 'changed')
    setDockViewRequest((prev) => ({ view: 'btw', key: (prev?.key ?? 0) + 1 }))
  }, [dockViewsEnabled])

  // A new plan review brings the plan forward on desktop, once per review.
  // Phones leave the chat on screen; the transcript card opens the plan.
  const planReviewId = useAgentStore((s) => (s.pendingQuestion?.kind === 'plan_review' ? s.pendingQuestion.id : null))
  const autoOpenedReviewRef = useRef<string | null>(null)
  useEffect(() => {
    if (!dockViewsEnabled || !planReviewId || autoOpenedReviewRef.current === planReviewId) return
    autoOpenedReviewRef.current = planReviewId
    handleOpenPlan()
  }, [dockViewsEnabled, handleOpenPlan, planReviewId])

  const handleToggleFilesPanel = handleWorkspaceFiles

  // Open (or focus) a terminal — needs an attached workspace. Ensures the
  // workspace panel is visible, then bumps the key so WorkspacePanel
  // focuses/opens its terminal tab (cwd = project).
  // terminal UI (kept simple; may return later behind its own entry point).
  const handleOpenTerminal = useCallback(() => {
    if (!workspace) return
    setWorkspacePanel((prev) => prev ?? 'files')
    setTerminalOpenKey((k) => k + 1)
  }, [workspace])

  // Native menu items for actions without a keyboard shortcut.
  useEffect(() => {
    const routes: [string, () => void][] = [
      [APP_EVENTS.toggleScheduler, handleToggleScheduler],
      [APP_EVENTS.openScheduler, handleOpenScheduler],
      [APP_EVENTS.openWorkspace, handleOpenWorkspaceDialog],
      [APP_EVENTS.openTerminal, handleOpenTerminal],
      [APP_EVENTS.openPlan, handleOpenPlan],
    ]
    for (const [event, handler] of routes) window.addEventListener(event, handler)
    return () => {
      for (const [event, handler] of routes) window.removeEventListener(event, handler)
    }
  }, [handleOpenPlan, handleOpenScheduler, handleOpenTerminal, handleOpenWorkspaceDialog, handleToggleScheduler])

  // ── Mobile edge-swipe drawers ──────────────────────────────────────────────
  //
  // One controller owns every mobile drawer so only ONE can be open at a
  // time. The previous implementation tracked each drawer's open state in
  // isolation, which let a left-edge swipe open the sidebar while the
  // right-side actions/workspace panel was already open (and vice-versa).
  //
  // Right-edge target depends on context: with a workspace attached it opens
  // the workspace panel (changed files / tree); otherwise the chat-actions
  // menu. Left-edge always opens the session sidebar.
  const workspacePanelOpenForSwipe = Boolean(workspace)

  // Single source of truth for "what is open right now". Closing routes to
  // whichever drawer the id names, so swipe-to-close hits the right one.
  const activeDrawer: string | null = mobileSidebarOpen
    ? 'sidebar'
    : showMobileActions
      ? 'actions'
      : workspacePanel !== null
        ? 'workspace-panel'
        : null

  const closeAllDrawers = useCallback(() => {
    setMobileSidebarOpen(false)
    setShowMobileActions(false)
    setWorkspacePanel(null)
    setFileViewer(null)
  }, [])

  const openLeftDrawer = useCallback(() => {
    // Opening the sidebar must vacate every other overlay first.
    closeOtherMobileOverlays('sidebar')
    setShowMobileActions(false)
    setWorkspacePanel(null)
    setFileViewer(null)
    setMobileSidebarOpen(true)
  }, [closeOtherMobileOverlays])

  const openRightDrawer = useCallback(() => {
    // Opening a right drawer must vacate the sidebar + other overlays first.
    setMobileSidebarOpen(false)
    if (workspacePanelOpenForSwipe) {
      closeOtherMobileOverlays('workspace-panel')
      setShowMobileActions(false)
      setWorkspacePanel((value) => value ?? 'changed')
    } else {
      closeOtherMobileOverlays('actions')
      setShowMobileActions(true)
    }
  }, [closeOtherMobileOverlays, workspacePanelOpenForSwipe])

  const { handlers: edgeSwipeHandlers, drag: edgeSwipeDrag } = useEdgeSwipe({
    activeDrawer,
    left: { id: 'sidebar', open: openLeftDrawer },
    right: { id: workspacePanelOpenForSwipe ? 'workspace-panel' : 'actions', open: openRightDrawer },
    close: closeAllDrawers,
  })

  // Live drag offset (px) per drawer, fed to each drawer so it tracks the
  // finger. Each drawer reads only its own id; null when not being dragged.
  const sidebarDragOffset = edgeSwipeDrag?.drawerId === 'sidebar' ? edgeSwipeDrag.offset : null
  const actionsDragOffset = edgeSwipeDrag?.drawerId === 'actions' ? edgeSwipeDrag.offset : null
  const workspacePanelDragOffset = edgeSwipeDrag?.drawerId === 'workspace-panel' ? edgeSwipeDrag.offset : null

  return {
    mobileSidebarOpen,
    setMobileSidebarOpen,
    workspacePanel,
    setWorkspacePanel,
    fileViewer,
    setFileViewer,
    fileOpenKey,
    setFileOpenKey,
    terminalOpenKey,
    handledTerminalOpenKeyRef,
    dockViewRequest,
    handledDockViewKeyRef,
    dockDiffRequest,
    handledDockDiffRequestKeyRef,
    dockPreviewRequest,
    handledDockPreviewRequestKeyRef,
    dockAttachmentRequest,
    handledDockAttachmentRequestKeyRef,
    dockActiveView,
    setDockActiveView,
    dockViewsEnabled,
    schedulerInDock,
    sidebarCollapsed,
    setSidebarCollapsed,
    openWorkspaceDialogKey,
    showTodos,
    showMobileActions,

    closeOtherMobileOverlays,
    handleWorkspaceFiles,
    handleOpenGit,
    handleSidebarToggle,
    handleOpenWorkspaceDialog,
    handleFileSelect,
    handleMentionFileOpen,
    handleFileRefOpen,
    handleDiffOpen,
    handleOpenPreview,
    handleOpenAttachment,
    closeMobileActionsMenu,
    handleSetShowMobileActions,
    handleToggleAgentCapabilities,
    handleToggleScheduler,
    handleTogglePalette,
    handleSwitchModel,
    handleToggleQuickOpen,
    handleSetShowTodos,
    handleToggleTasks,
    handleOpenPlan,
    handleOpenSideQuestions,
    handleToggleFilesPanel,
    handleOpenTerminal,
    closeAllDrawers,
    openLeftDrawer,
    openRightDrawer,

    edgeSwipeHandlers,
    sidebarDragOffset,
    actionsDragOffset,
    workspacePanelDragOffset,
  }
}
