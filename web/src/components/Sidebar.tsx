// size-ceiling: 886 — one component: move the Sidebar.*.ts siblings into Sidebar/, then split the session list, the workspace rows and the menus
/**
 * Sidebar — flat workspace + session switcher for the app's one
 * screen:
 *
 *   • "New session" at the top, always visible (⌘N does the same).
 *   • The session list scrolls below it: Pinned, Needs you, then the
 *     "Workspaces" section (its header sticks to the top, so Search and View
 *     options stay reachable however long the list is). Scheduled sits
 *     pinned at the bottom and scrolls on its own past 224 px.
 *   • Repositories and their sessions as 28 px rows, one level deep.
 *     A repository's name opens its latest session; the chevron folds it.
 *     Worktrees are not rows: a repository lists the sessions of every
 *     checkout (its own and each worktree's) as one list, worktree sessions
 *     tagged with the worktree's name, and a checkout chip on the row
 *     narrows it to one checkout and holds the worktree actions. Sessions
 *     page in with an explicit "Show more" row.
 *   • Mobile drawer footer: Settings, Usage, command palette, server and theme
 *     icons. On desktop those live in the status bar (the palette is ⌘K).
 *   • Phone Sessions screen (``page``): the same list as the root of the
 *     phone's navigation stack instead of a drawer. A top bar (server, ✎ New
 *     session), a large title and search field that scroll with the list,
 *     pull to refresh, swipe actions on session rows and a bottom toolbar
 *     (Settings · Scheduled · Usage · Commands) in place of the drawer
 *     footer, the New session row and the Scheduled section.
 *
 * ``activeWorkspace`` is
 * the workspace driving
 * the current chat; ``expandedWorkspaces`` is local UI state for which rows are
 * currently showing their sessions. Multiple workspaces can stay open
 * at once. Switching the active workspace auto-expands it.
 */
import { failureToast } from '@/lib/failure-toast'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useIsMobile } from '@/hooks/use-mobile'
import { useDrawerMotion } from '@/hooks/use-drawer-motion'
import { usePlatform } from '@/hooks/use-platform'
import { isMobileApp } from '@/lib/mobile-app'
import { cn } from '@/lib/utils'
import { PANEL_SLIDE_MS, PanelResizeHandle, ResizableAside, type LiveWidth } from '@/components/ResizableAside'
import { useToggleTween } from '@/hooks/useToggleTween'
import { KeyLayerScope, useKeyLayer } from '@/lib/keyboard/hooks'
import { useViewportWidth } from '@/hooks/use-viewport-width'
import { useTouchFirst } from '@/hooks/use-touch-first'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useLayoutStore } from '@/stores/useLayoutStore'
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  sidebarMaxWidth,
} from '@/lib/workbench-layout'
import {
  SquarePen,
} from 'lucide-react'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { isPrimaryModifierOS } from '@/lib/keyboard-shortcut'
import { useSessionsQuery } from '@/queries/useSessionsQuery'
import { queryKeys } from '@/queries/keys'
import { listSessions } from '@/api/client'
import { renameSavedWorkspace, workspaceLabel } from '@/utils/workspace'
import { RelocateWorkspaceDialog } from '@/components/LazyRelocateWorkspaceDialog'
import type { WorkspaceRelocateResponse } from '@/api/types'
import { startNewSession } from '@/lib/new-session'
import { softHapticFeedback } from '@/lib/haptics'
import { useSidebarViewStore } from '@/stores/useSidebarViewStore'
import { useUIStore } from '@/stores/useUIStore'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'
import { listRowClass } from '@/components/ui/list-row'
import { useToastStore } from '@/stores/useToastStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { openTelemetry } from '@/stores/useTelemetryStore'
import type { SessionResponse } from '@/api/types'
import { NeedsYouSection, RunningSection } from './Sidebar/NeedsYouSection'
import { ScheduledSection } from './Sidebar/ScheduledSection'
import { SidebarConfirmDialogs } from './Sidebar/ConfirmDialogs'
import { SidebarSectionHeader } from './Sidebar/SidebarSectionHeader'
import { PinnedSection } from './Sidebar/PinnedSection'
import { FlatSessionGroups } from './Sidebar/FlatSessionGroups'
import {
  addExpandedPaths,
  groupSessionsByWorkspace,
  newSessionChoicePaths,
  orderWorkspacePaths,
  repositoryCheckouts,
  sessionActivityTime,
  sourceWorkspacePaths,
  toggleExpandedPath,
} from './Sidebar/helpers'
import { pickWorkspaceDirectory, shouldUseServerWorkspaceBrowser } from './Sidebar/browser'
import {
  confirmWorkspaceRemoval,
  openWorkspaceDraft,
  restoreHiddenWorkspace,
} from './Sidebar/workspace'
import { SessionSearch } from './Sidebar/SessionSearch'
import { SessionsPageBar, SessionsPageHeader, SessionsPageToolbar } from './Sidebar/SessionsPage'
import { SidebarPageContext } from './Sidebar/SidebarPageContext'
import { SidebarScroller } from './Sidebar/SidebarScroller'
import { useLargeTitleCollapse } from './Sidebar/useLargeTitleCollapse'
import { OpenWorkspaceDialog, useOpenWorkspaceDialog } from './Sidebar/OpenWorkspaceDialog'
import { useWorktreeActions } from './Sidebar/useWorktreeActions'
import { CreateWorktreeDialog, RenameWorktreeDialog } from './Sidebar/WorktreeDialogs'
import { useSessionActions } from './Sidebar/useSessionActions'
import { SessionActionsMenu } from './Sidebar/SessionActionsMenu'
import { WorkspaceActionsContextMenu, WorkspaceActionsSheet } from './Sidebar/WorkspaceActionsMenu'
import { CheckoutMenu, useCheckoutFilter } from './Sidebar/CheckoutMenu'
import { useWorkspaceTree } from './Sidebar/useWorkspaceTree'
import { WorkspaceTree } from './Sidebar/WorkspaceTree'
import { MobileDrawerFooter } from './Sidebar/MobileDrawerFooter'
import { walkSidebarRows } from './Sidebar/rowKeys'

// Hiding undoes from the toast for as long as a delete does.
const WORKSPACE_HIDE_UNDO_MS = 10_000

interface SidebarProps {
  currentSessionId?: string
  workspace?: string | null
  /**
   * The workspace of the new-session draft on screen (nothing saved yet),
   * shown as a "New session" row atop its list.
   */
  draftWorkspace?: string | null
  /**
   * Start a new session the way ⌘N does (the chat's own handler, which also
   * clears the composer). Without it the sidebar opens a draft itself.
   */
  onNewSession?: () => void
  onCollapse?: () => void
  /** Bump this counter to programmatically open the workspace dialog
   *  (e.g. from a "no workspace attached" CTA). */
  openWorkspaceDialogKey?: number
  /** Bump to open the session search, focused (⌘⇧F). */
  searchSessionsKey?: number
  /** Desktop only: when true, the inline panel collapses to width=0. */
  desktopCollapsed?: boolean
  /**
   * A window too narrow to push the chat (``sidebarIsDrawer``): the sidebar
   * is a drawer over the content (``desktopCollapsed`` false while open). A
   * click outside it or Escape calls ``onCollapse``.
   */
  drawer?: boolean
  /** Desktop: the Review panel is open, so the column leaves room for it too. */
  dockOpen?: boolean
  /** Mobile only: whether the overlay drawer is open. */
  mobileOpen?: boolean
  /** Mobile only: called when the drawer should close (backdrop tap, navigation). */
  onMobileClose?: () => void
  /** Mobile drawer footer: opens the command palette; the icon hides without it. */
  onOpenPalette?: () => void
  /**
   * Phone: draw the full-screen Sessions page (the navigation stack's root
   * layer, which this fills) instead of the drawer. There is no scrim, no
   * drawer motion and no resize edge. ``mobileOpen`` then means Sessions is
   * the screen on top: long-press and swipe actions work only while it is.
   */
  page?: boolean
  /** The page toolbar's Scheduled button; without it the scheduler opens as the sidebar's own entries do. */
  onOpenScheduler?: () => void
  /**
   * Page only: down to the Servers screen (‹ Servers in the top bar, and the
   * server line under the large title). Without it the bar shows the server
   * chip, which opens the Server dialog.
   */
  onOpenServers?: () => void
}

export function Sidebar({
  currentSessionId,
  workspace,
  draftWorkspace = null,
  onNewSession,
  onCollapse,
  openWorkspaceDialogKey = 0,
  searchSessionsKey = 0,
  desktopCollapsed = false,
  drawer = false,
  dockOpen = false,
  mobileOpen = false,
  onMobileClose,
  onOpenPalette,
  page: isPage = false,
  onOpenScheduler,
  onOpenServers,
}: SidebarProps) {
  // The page is a phone layout whatever the window says: sheets for row
  // actions, no desktop resize. Only the drawer's own motion (scrim, slide,
  // inert) is left out of it, below.
  const isMobile = useIsMobile() || isPage
  const { isTauri, os } = usePlatform()
  const isTauriMobile = isMobileApp({ isTauri, os })
  // Held rows open the session sheet in the iOS and Android apps while the
  // drawer is open, and on the Sessions page in any phone browser (the page
  // has no inline ⋯ to fall back on). The page keeps it while a chat covers
  // it: rows that changed shape under the sliding chat would be seen doing it.
  const mobileLongPressActions = isPage || (isMobile && isTauriMobile && mobileOpen)
  const prefersReducedMotion = useReducedMotion()
  // The header's sidebar button and ⌘B open and close the column; a drawer
  // also closes on a click outside it or Escape.
  const drawerOpen = drawer && !isMobile && !desktopCollapsed
  // A layer like a menu: opening a dialog over it closes it, unless the
  // dialog (or a row's menu) opened from inside it (``KeyLayerScope``).
  const drawerLayer = useKeyLayer(drawerOpen, { kind: 'transient', onClose: () => onCollapse?.() })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const pushToast = useToastStore((s) => s.push)
  const dismissToast = useToastStore((s) => s.dismiss)
  const openSettings = useSettingsStore((s) => s.openSettings)
  const sessions = useSessionsQuery()
  const groupBy = useSidebarViewStore((s) => s.groupBy)
  // The phone has no "Show details" switch: its rows always carry them.
  const storedShowDetails = useSidebarViewStore((s) => s.showDetails)
  const showDetails = isMobile || storedShowDetails

  const workspaceSessions = useMemo(
    () => (sessions.data?.pages.flatMap((page) => page.data) ?? []).filter((session) => session.workspace),
    [sessions.data],
  )
  // Indexed once per `workspaceSessions` change instead of re-filtering the full
  // session list for every workspace/worktree row on every render.
  const sessionsByWorkspace = useMemo(() => groupSessionsByWorkspace(workspaceSessions), [workspaceSessions])
  const sessionActions = useSessionActions({ currentSessionId, workspaceSessions, isMobile, isPage, mobileOpen, onMobileClose })
  const { editingSessionId, sessionRowHandlers, handleSessionSelect } = sessionActions

  const workspaceTreeState = useWorkspaceTree()
  const {
    workspaceTree,
    workspaceByPath,
    workspaceGroups,
    chatWorkspace,
    isChatPath,
    worktreeSourceByDirectory,
    refreshWorkspaceTree,
  } = workspaceTreeState
  const activeWorkspace = workspace ?? null

  // ``expandedWorkspaces`` is local UI state — it auto-tracks the active
  // workspace but the user can also expand/collapse any other workspace
  // independently.
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(
    () => new Set(activeWorkspace ? [activeWorkspace] : []),
  )
  useEffect(() => {
    if (!activeWorkspace) return
    setExpandedWorkspaces((current) => addExpandedPaths(current, [activeWorkspace]))
  }, [activeWorkspace])

  const toggleWorkspaceExpanded = (path: string) => {
    setExpandedWorkspaces((current) => toggleExpandedPath(current, path))
  }


  const [error, setError] = useState<string | null>(null)
  const [pendingWorkspace, setPendingWorkspace] = useState<string | null>(null)
  const openWorkspace = useOpenWorkspaceDialog({
    isTauri,
    isTauriMobile,
    openKey: openWorkspaceDialogKey,
    setError,
    onOpen: (path) => { void openFolderDraft(path) },
  })
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchFocusKey, setSearchFocusKey] = useState(0)
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  // Workspace action menus act on the repository (``path``); "New session"
  // starts in the checkout its list shows (``sessionPath``).
  const [desktopWorkspaceActions, setDesktopWorkspaceActions] = useState<{ path: string; sessionPath: string; x: number; y: number } | null>(null)
  const [mobileWorkspaceActions, setMobileWorkspaceActions] = useState<{ path: string; sessionPath: string; kind: 'main' | 'chat' } | null>(null)
  // "Locate folder…" for a workspace whose folder is gone. ``native`` picks
  // with the OS dialog (the desktop app on its own server).
  const [relocateTarget, setRelocateTarget] = useState<{ path: string; native: boolean } | null>(null)
  const [checkoutMenu, setCheckoutMenu] = useState<{ repo: string; x: number; y: number } | null>(null)

  // Pull to refresh on the Sessions page: every session list (the tree's,
  // Pinned, Needs you, the flat views) and the workspace tree. The promise
  // settles when the refetches do, which is when the spinner may stop.
  const refreshSessionList = useCallback(
    () => Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() }),
      refreshWorkspaceTree(),
    ]),
    [queryClient, refreshWorkspaceTree],
  )
  const worktreeActions = useWorktreeActions({
    worktreeSourceByDirectory,
    refreshWorkspaceTree,
    onMobileClose,
    setError,
    onRemoved: (directory) => setExpandedWorkspaces((current) => {
      if (!current.has(directory)) return current
      const next = new Set(current)
      next.delete(directory)
      return next
    }),
  })
  const openRelocate = useCallback(async (path: string) => {
    let native = false
    try {
      native = !(await shouldUseServerWorkspaceBrowser(isTauri, isTauriMobile))
    } catch {
      native = false
    }
    setRelocateTarget({ path, native })
    // Stable `useState` setters are listed for the React Compiler, which
    // otherwise skips optimizing the whole component.
  }, [isTauri, isTauriMobile, setRelocateTarget])
  const handleRelocated = useCallback((result: WorkspaceRelocateResponse) => {
    setRelocateTarget(null)
    renameSavedWorkspace(result.from, result.workspace)
    for (const moved of result.moved_worktrees) renameSavedWorkspace(moved.from, moved.to)
    void refreshSessionList()
    pushToast(result.warnings.length > 0
      ? { tone: 'error', title: `Moved to ${workspaceLabel(result.workspace)}, but git needs a hand`, description: result.warnings.join('\n') }
      : { tone: 'info', title: `Moved to ${workspaceLabel(result.workspace)}` })
  }, [pushToast, refreshSessionList, setRelocateTarget])
  // Scheduled on the page toolbar: the caller's way, else the way the
  // drawer's Scheduled section opens it.
  const openScheduler = onOpenScheduler ?? (() => {
    useUIStore.getState().focusScheduledTask(null)
    dispatchAppEvent(APP_EVENTS.openScheduler)
  })

  useEffect(() => {
    if (pendingWorkspace && workspace === pendingWorkspace) setPendingWorkspace(null)
  }, [pendingWorkspace, workspace])

  const openSessionSearch = () => {
    setSearchOpen(true)
    setSearchFocusKey((key) => key + 1)
  }
  useEffect(() => {
    if (searchSessionsKey === 0) return
    setSearchOpen(true)
    setSearchFocusKey((key) => key + 1)
  }, [searchSessionsKey])
  // The header with the Search button moves from above the results back
  // into the scroller, so focus returns to it once it has re-rendered.
  const refocusSearchButton = useRef(false)
  const closeSessionSearch = () => {
    refocusSearchButton.current = true
    setSearchOpen(false)
  }
  useEffect(() => {
    if (searchOpen || !refocusSearchButton.current) return
    refocusSearchButton.current = false
    searchButtonRef.current?.focus()
  }, [searchOpen])
  // The large title hands over to the top bar's small one as it scrolls away.
  const { barRef, titleRef, onScroll: onListScroll } = useLargeTitleCollapse(isPage && searchOpen)
  // Session rows read this to swipe; only while Sessions is the screen on top.
  const pageState = useMemo(() => (isPage ? { active: mobileOpen } : null), [isPage, mobileOpen])

  // A new session is a draft until its first message: nothing is created
  // here, the draft screen opens for ``path``.
  const newSessionIn = (path: string) => {
    startNewSession({
      navigate,
      workspace: path,
      current: { sessionId: currentSessionId, workspace },
    })
    onMobileClose?.()
  }

  // The Sessions screen covers the chat it was popped from, so the chat's
  // own handler (which leaves an empty draft or session as it is) would
  // change nothing on screen: always push a fresh draft. The draft is built
  // before the push, so the slide shows it at once.
  const pushPageDraft = (path: string) => {
    softHapticFeedback()
    startNewSession({ navigate, workspace: path })
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('focus-chat-input')))
  }

  // "New session" atop the sidebar does what ⌘N does: the chat's handler
  // when there is one, else a draft in the current workspace (or Chat).
  // An empty draft already on screen stays; its composer takes focus.
  const startSessionFromSidebar = () => {
    const target = workspace ?? chatWorkspace?.path ?? null
    if (!target) {
      void openWorkspace.open()
      return
    }
    if (isPage) {
      pushPageDraft(target)
      return
    }
    if (onNewSession && workspace) {
      onNewSession()
      onMobileClose?.()
    } else {
      newSessionIn(target)
    }
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('focus-chat-input')))
  }

  // A workspace's name opens its most recently active session (a draft when
  // it has none) and unfolds it; the chevron beside it only folds. The
  // workspace already on screen just unfolds: there is nothing to open.
  const openWorkspaceLatest = async (path: string, listPaths: readonly string[], sessionTarget: string) => {
    setExpandedWorkspaces((current) => addExpandedPaths(current, [path]))
    if (path === activeWorkspace || worktreeSourceByDirectory.get(activeWorkspace ?? '') === path) return
    const inList = (session: SessionResponse) =>
      !session.parent_session_id && listPaths.includes(session.workspace ?? '')
    // The all-workspaces list is newest first, so a workspace's newest
    // session is in it whenever any of its sessions is.
    let latest: SessionResponse | undefined = listPaths
      .flatMap((checkout) => sessionsByWorkspace.get(checkout) ?? [])
      .filter(inList)
      .sort((a, b) => (sessionActivityTime(b) ?? '').localeCompare(sessionActivityTime(a) ?? ''))[0]
    if (!latest) {
      try {
        const page = await listSessions(
          null,
          5,
          listPaths.length === 1 ? { workspace: listPaths[0], sort: 'activity' } : { workspaces: listPaths, sort: 'activity' },
        )
        // An older server ignores ``workspaces``: keep only this repository's rows.
        latest = page.data.find(inList)
      } catch {
        latest = undefined
      }
    }
    if (latest) handleSessionSelect(latest, latest.workspace ?? path)
    else newSessionIn(sessionTarget)
  }

  // A folder from Open workspace…: register it (so it has a row) and open a
  // draft there. A desktop says so once the folder is new to the sidebar.
  const openFolderDraft = async (path: string) => {
    setPendingWorkspace(path)
    try {
      const added = await openWorkspaceDraft({
        path,
        listed: isChatPath(path) || workspaceByPath.has(path),
        currentSessionId,
        currentWorkspace: workspace,
        refreshWorkspaceTree,
        navigate,
      })
      if (added && !isMobile) pushToast({ tone: 'info', title: `Added ${workspaceLabel(path)}` })
      onMobileClose?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open workspace")
    } finally {
      setPendingWorkspace(null)
    }
  }

  // Remove a workspace (and its worktrees) from the sidebar. Sessions stay in
  // the backend — reopening the same folder later resurfaces them. Leaving a
  // removed active workspace for the empty / route happens inside
  // ``confirmWorkspaceRemoval``. Hiding is reversible, so it asks nothing.
  const hideWorkspaceFromSidebar = (path: string) => {
    const worktreePaths = (workspaceByPath.get(path)?.worktrees ?? []).map((item) => item.path)
    setExpandedWorkspaces((current) => {
      const next = new Set(current)
      for (const hidden of [path, ...worktreePaths]) next.delete(hidden)
      return next
    })
    const removal = confirmWorkspaceRemoval({
      path,
      worktreePaths,
      activeWorkspace,
      expandedWorkspaces,
      queryClient,
      refreshWorkspaceTree,
      navigate: ({ to, replace }) => navigate({ to, replace }),
    })
    // The row leaves at once, so the toast is what says it happened and how
    // to get it back. Undo shows the folder (and its worktrees) again, after
    // the hide has landed; it does not reopen it.
    const toastId = pushToast({
      tone: 'info',
      title: `Hid ${workspaceLabel(path)} from the sidebar`,
      description: 'Its sessions are kept. Open workspace… brings it back.',
      action: {
        label: 'Undo',
        onAction: () => {
          void removal
            .then(() => restoreHiddenWorkspace({ paths: [path, ...worktreePaths], queryClient, refreshWorkspaceTree }))
            .catch(() => pushToast({ tone: 'error', title: `Couldn't show ${workspaceLabel(path)} again` }))
        },
      },
    }, WORKSPACE_HIDE_UNDO_MS)
    removal.catch((err: unknown) => {
      dismissToast(toastId)
      pushToast(failureToast(`Couldn't remove ${workspaceLabel(path)} from the sidebar`, err))
      void refreshWorkspaceTree()
    })
  }

  const activeWorktreeSource = activeWorkspace ? worktreeSourceByDirectory.get(activeWorkspace) : null
  // ✎'s hold menu on the Sessions screen: where a tap would start, Chat, and
  // the most recently active repositories.
  const newSessionChoices = isPage
    ? newSessionChoicePaths(
        workspace ?? chatWorkspace?.path ?? null,
        chatWorkspace?.path ?? null,
        orderWorkspacePaths(
          sourceWorkspacePaths(workspaceTree, worktreeActions.removedWorktreePaths).filter((path) => !isChatPath(path)),
          workspaceByPath,
          [],
          sessionsByWorkspace,
        ),
      ).map((path) => ({
        path,
        label: workspaceLabel(path, chatWorkspace),
        current: path === (workspace ?? chatWorkspace?.path),
      }))
    : []

  // Width is persisted in the layout store and clamped against the window so
  // the chat and a side-by-side dock always keep their minimums. A drawer
  // covers the chat, so it only has to leave the chat visible beside it.
  const viewportWidth = useViewportWidth()
  const touch = useTouchFirst()
  const widthContext = { dockOpen: dockOpen && !drawer, touch }
  const storedSidebarWidth = useLayoutStore((s) => s.sidebarWidth)
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth)
  const commitSidebarWidth = useCallback((width: number) => setSidebarWidth(width), [setSidebarWidth])
  const resetSidebarWidth = useCallback(() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH), [setSidebarWidth])
  const sidebarResize = {
    width: clampSidebarWidth(storedSidebarWidth, viewportWidth, widthContext),
    min: SIDEBAR_MIN_WIDTH,
    max: sidebarMaxWidth(viewportWidth, widthContext),
    edge: 'right' as const,
    onCommit: commitSidebarWidth,
    onReset: resetSidebarWidth,
    detent: SIDEBAR_DEFAULT_WIDTH,
    disabled: isMobile || desktopCollapsed,
    label: 'Resize sidebar',
  }
  // Desktop: showing or hiding slides the width (a CSS transition, only for
  // the toggle); the rows keep the open width and ride the moving edge, so
  // they slide rather than rewrap every frame.
  const sliding = useToggleTween(desktopCollapsed, PANEL_SLIDE_MS) && !isMobile
  const pinRows = !isMobile && (desktopCollapsed || sliding)
  // The phone drawer slides by ``translate`` (and its scrim fades) through
  // ``lib/drawer-motion``: an edge swipe writes it per frame without
  // re-rendering, and a release springs on with the finger's speed. Closed
  // sits 280px out so its shadow clears the edge.
  useDrawerMotion('sidebar', { open: mobileOpen, enabled: isMobile && !isPage, hidden: -280, reduced: prefersReducedMotion ?? false })
  const sidebarMotion = ({ width }: LiveWidth) => ({
    // The page fills its layer: no width of its own to animate.
    animate: isPage
      ? {}
      : isMobile
        ? { width: 'min(272px, calc(100vw - 2rem))' }
        : { width: desktopCollapsed ? 0 : width },
    // Desktop sets the width as a style (no frame loop), sliding it only
    // while a toggle runs.
    transition: { duration: 0 },
    instantWidth: !isMobile,
    tweenWidth: sliding,
  })

  const collapseAllWorkspaces = () => {
    // Keep the active repository open so the current session stays visible.
    const activeRepository = activeWorktreeSource ?? activeWorkspace
    setExpandedWorkspaces(new Set(activeRepository ? [activeRepository] : []))
  }

  useEffect(() => {
    if (!activeWorktreeSource) return
    setExpandedWorkspaces((current) => addExpandedPaths(current, [activeWorktreeSource]))
  }, [activeWorktreeSource])

  const { checkoutFilter, selectCheckout } = useCheckoutFilter({ currentSessionId, activeWorkspace, activeWorktreeSource })

  const checkoutMenuRepository = checkoutMenu
    ? repositoryCheckouts(checkoutMenu.repo, workspaceByPath.get(checkoutMenu.repo), worktreeActions.removedWorktreePaths, checkoutFilter[checkoutMenu.repo])
    : null


  const workspaceDisplayName = (path: string) => (isChatPath(path) ? (chatWorkspace?.name ?? path) : workspaceLabel(path))

  // What a workspace's menus (desktop and phone) can do.
  const workspaceMenuActions = {
    workspaceByPath,
    newSessionIn,
    openRelocate,
    openWorktreeDialog: worktreeActions.openWorktreeDialog,
    hideWorkspaceFromSidebar,
  }
  // ``aria-keyshortcuts`` for ⌘N, on the New session button and its menu entry.
  const newSessionKeys = isPrimaryModifierOS(os) ? 'Meta+N' : 'Control+N'
  // Status grouping lists the waiting sessions itself. The sidebar puts this
  // section after Pinned; the Sessions page puts it first, above everything.
  const needsYouSection = groupBy !== 'status' && (
    <NeedsYouSection
      currentSessionId={currentSessionId}
      workspaceName={workspaceDisplayName}
      onSessionSelect={handleSessionSelect}
    />
  )

  return (
    <KeyLayerScope layer={drawerLayer}>
      {/* Mobile backdrop — closes the drawer on tap. Its opacity is the
          drawer's progress (see useDrawerMotion), so it fades with a drag
          and with the release spring; shut, it takes no touches. The Sessions
          page is no drawer: nothing to dim. */}
      {isMobile && !isPage && (
        <div
          data-edge-drawer-scrim="sidebar"
          // No `md:hidden`: a landscape phone is wider than md but still
          // mobile (useIsMobile's height rule); `isMobile` already gates it.
          className={cn('mobile-safe-top fixed inset-x-0 bottom-0 z-30 bg-(--color-overlay)', !mobileOpen && 'pointer-events-none')}
          aria-hidden="true"
          onClick={onMobileClose}
        />
      )}
      {/* A desktop drawer dims what it covers, as drawer scrims do (DESIGN.md),
          and closes on a click anywhere outside it. z-25: over the Review
          panel, even one covering the chat (z-20), and under the drawer (z-30). */}
      {drawerOpen && (
        <div
          aria-hidden="true"
          data-sidebar-drawer-backdrop=""
          className="absolute inset-0 z-25 bg-(--color-overlay)"
          onPointerDown={() => onCollapse?.()}
        />
      )}

    <SidebarPageContext.Provider value={pageState}>
    <ResizableAside
      initial={false}
      resize={sidebarResize}
      getMotion={sidebarMotion}
      // A desktop drawer floats over the chat and the Review panel: it takes
      // no room, so the panel must not size itself around it.
      inFlow={!isPage && (isMobile || !drawer)}
      // Collapsed (desktop) or closed (mobile), the sidebar is off screen
      // but still in the DOM: keep Tab and screen readers out of it.
      // The page is never inert here: the navigation stack inerts its own
      // covered layer.
      inert={isPage ? false : isMobile ? !mobileOpen : desktopCollapsed}
      data-edge-drawer={isMobile && !isPage ? 'sidebar' : undefined}
      data-sidebar-page={isPage ? '' : undefined}
      // The drawer is fixed to the left edge, outside the shell's safe-area
      // padding: `pl-safe` keeps its rows clear of a landscape cutout while
      // its width (and so the closed -280px offset) stays the same.
      // The page is not fixed: it fills the stack's layer, inside the chat
      // view's ``mobile-safe-shell`` (which pads left and right), so only its
      // top bar pads the top and its toolbar the bottom.
      className={
        isPage
          ? 'relative flex h-full w-full min-w-0 flex-col bg-(--bg-page)'
          : isMobile
          ? 'mobile-safe-top pl-safe fixed bottom-0 left-0 z-40 flex w-[min(272px,calc(100vw-2rem))] shrink-0 flex-col overflow-hidden border-r border-(--color-border) bg-(--bg-page) shadow-(--shadow-depth) dark:bg-(--bg-sidebar)'
          : drawer
            // Closed, the drawer is 0 wide: hide it so its edge and shadow do not show.
            ? cn('absolute inset-y-0 left-0 z-30 flex shrink-0 flex-col overflow-hidden border-r border-(--color-border) bg-(--bg-page) shadow-(--shadow-depth) dark:bg-(--bg-sidebar)', desktopCollapsed && !sliding && 'invisible')
            // Collapsed to 0 wide, the border alone would still draw a 1px
            // edge down the window side (once the slide is over).
            : cn('relative flex shrink-0 flex-col overflow-hidden border-r border-(--color-border) bg-(--bg-page) dark:bg-(--bg-sidebar)', desktopCollapsed && !sliding && 'border-r-0')
      }
      data-sidebar-drawer={drawer && !isMobile ? '' : undefined}
    >
      {!isMobile && !desktopCollapsed && <PanelResizeHandle edge="right" />}

      {isPage && <SessionsPageBar barRef={barRef} onOpenServers={onOpenServers} />}

      <div
        data-focus-region="sidebar"
        className={cn('flex min-h-0 flex-1 flex-col', pinRows && 'shrink-0 self-end')}
        style={pinRows ? { width: sidebarResize.width } : undefined}
        onKeyDown={walkSidebarRows}
      >
      {/* Always visible, above the scroller: the one-step way to start. The
          Sessions page starts one from ✎ in its top bar instead. */}
      {!isPage && (
      <div className="shrink-0 px-1.5 pb-1 pt-1.5">
        <button
          type="button"
          data-sidebar-new-session=""
          onClick={startSessionFromSidebar}
          aria-keyshortcuts={newSessionKeys}
          className={`${listRowClass()} font-medium`}
        >
          <SquarePen size={13} aria-hidden="true" className="shrink-0 text-(--color-text-muted)" />
          <span className="min-w-0 flex-1 truncate">New session</span>
          <kbd aria-hidden="true" className="shrink-0 font-sans text-meta font-normal text-(--color-text-muted) pointer-coarse:hidden">
            {shortcutLabel(APP_SHORTCUTS.newSession, os)}
          </kbd>
        </button>
      </div>
      )}

      {/* Section header — actions stay reachable however long the list is. */}
      {searchOpen && !isPage && (
        <SidebarSectionHeader
          groupBy={groupBy}
          workspaceGroups={workspaceGroups}
          searchOpen={searchOpen}
          searchButtonRef={searchButtonRef}
          onToggleSearch={closeSessionSearch}
          onCollapseAll={collapseAllWorkspaces}
          onOpenFolder={() => { void openWorkspace.open() }}
        />
      )}

      {searchOpen ? (
        <SessionSearch
          currentSessionId={currentSessionId}
          focusKey={searchFocusKey}
          workspaceName={workspaceDisplayName}
          onSessionSelect={(session, workspacePath, event) => {
            setSearchOpen(false)
            handleSessionSelect(session, workspacePath, event)
          }}
          onClose={closeSessionSearch}
          cancel={isPage}
        />
      ) : (
      <>
      {/* The sessions scroller: Pinned, Needs you and the sessions (under a
          header that sticks) scroll together. Scheduled is pinned below it. */}
      <SidebarScroller page={isPage} onRefresh={refreshSessionList} onScroll={onListScroll}>
      {isPage && <SessionsPageHeader titleRef={titleRef} searchRef={searchButtonRef} onSearch={openSessionSearch} onOpenServers={onOpenServers} />}
      {isPage && needsYouSection}
      {isPage && groupBy !== 'status' && (
        <RunningSection
          currentSessionId={currentSessionId}
          workspaceName={workspaceDisplayName}
          onSessionSelect={handleSessionSelect}
        />
      )}
      <PinnedSection
        currentSessionId={currentSessionId}
        workspaceName={workspaceDisplayName}
        editingSessionId={editingSessionId}
        showDetails={showDetails}
        mobileLongPressActions={mobileLongPressActions}
        {...sessionRowHandlers}
      />

      {!isPage && needsYouSection}

      <SidebarSectionHeader
        groupBy={groupBy}
        workspaceGroups={workspaceGroups}
        searchOpen={searchOpen}
        searchButtonRef={searchButtonRef}
        onToggleSearch={openSessionSearch}
        onCollapseAll={collapseAllWorkspaces}
        onOpenFolder={() => { void openWorkspace.open() }}
        page={isPage}
      />

      {groupBy !== 'project' ? (
      /* Every session in one list, grouped by status or date (or not). */
      <div className="flex flex-1 flex-col pb-2">
        <FlatSessionGroups
          groupBy={groupBy}
          currentSessionId={currentSessionId}
          workspaceName={workspaceDisplayName}
          draftWorkspace={draftWorkspace}
          editingSessionId={editingSessionId}
          showDetails={showDetails}
          mobileLongPressActions={mobileLongPressActions}
          {...sessionRowHandlers}
        />
      </div>
      ) : (
      /* Workspace + sessions tree */
      <WorkspaceTree
        tree={workspaceTreeState}
        onOpenWorkspace={() => { void openWorkspace.open() }}
        sessionsByWorkspace={sessionsByWorkspace}
        removedWorktreePaths={worktreeActions.removedWorktreePaths}
        worktreeRemoving={worktreeActions.worktreeRemoving}
        checkoutFilter={checkoutFilter}
        selectCheckout={selectCheckout}
        checkoutMenuRepo={checkoutMenu?.repo}
        setCheckoutMenu={setCheckoutMenu}
        activeWorkspace={activeWorkspace}
        activeWorktreeSource={activeWorktreeSource}
        expandedWorkspaces={expandedWorkspaces}
        toggleWorkspaceExpanded={toggleWorkspaceExpanded}
        pendingWorkspace={pendingWorkspace}
        openWorkspaceLatest={openWorkspaceLatest}
        newSessionIn={newSessionIn}
        setMobileWorkspaceActions={setMobileWorkspaceActions}
        setDesktopWorkspaceActions={setDesktopWorkspaceActions}
        isMobile={isMobile}
        mobileLongPressActions={mobileLongPressActions}
        currentSessionId={currentSessionId}
        showDetails={showDetails}
        draftWorkspace={draftWorkspace}
        editingSessionId={editingSessionId}
        sessionRowHandlers={sessionRowHandlers}
      />
      )}
      {/* Room under the last row for the floating toolbar. */}
      {isPage && !searchOpen && <div aria-hidden="true" className="h-24 shrink-0" />}
      </SidebarScroller>

      {/* Pinned at the bottom, own scroll past 224px; hidden during search.
          The Sessions page has no Scheduled section: its toolbar opens it. */}
      {!isPage && (
      <div data-sidebar-scheduled-scroller="" className="max-h-56 shrink-0 overflow-y-auto overflow-x-hidden">
        <ScheduledSection onMobileClose={onMobileClose} />
      </div>
      )}
      </>
      )}
      </div>

      {isPage ? (
        // Hidden while searching, as an iOS toolbar is: the soft keyboard
        // shrinks the shell, and the toolbar would ride up on top of it.
        !searchOpen && (
          <SessionsPageToolbar
            onNewSession={startSessionFromSidebar}
            onNewSessionIn={pushPageDraft}
            newSessionChoices={newSessionChoices}
            onOpenSettings={() => openSettings()}
            onOpenScheduler={openScheduler}
            onOpenUsage={() => openTelemetry()}
          />
        )
      ) : (
        <MobileDrawerFooter onMobileClose={onMobileClose} onOpenPalette={onOpenPalette} />
      )}

      <OpenWorkspaceDialog state={openWorkspace} error={error} isTauriMobile={isTauriMobile} />

      {/* A workspace's long-press menu on a phone: a sheet from the bottom
          edge, like the session one. */}
      <WorkspaceActionsSheet
        mobileWorkspaceActions={mobileWorkspaceActions}
        setMobileWorkspaceActions={setMobileWorkspaceActions}
        chatName={chatWorkspace?.name}
        {...workspaceMenuActions}
      />

      <CreateWorktreeDialog worktrees={worktreeActions} error={error} />

      <RelocateWorkspaceDialog
        from={relocateTarget?.path ?? null}
        name={relocateTarget ? workspaceByPath.get(relocateTarget.path)?.name : undefined}
        pickFolder={relocateTarget?.native ? pickWorkspaceDirectory : null}
        onClose={() => setRelocateTarget(null)}
        onRelocated={handleRelocated}
      />

      <WorkspaceActionsContextMenu
        desktopWorkspaceActions={desktopWorkspaceActions}
        setDesktopWorkspaceActions={setDesktopWorkspaceActions}
        activeWorkspace={activeWorkspace}
        newSessionKeys={newSessionKeys}
        {...workspaceMenuActions}
      />

      <CheckoutMenu
        checkoutMenu={checkoutMenu}
        setCheckoutMenu={setCheckoutMenu}
        checkoutMenuRepository={checkoutMenuRepository}
        mobileLongPressActions={mobileLongPressActions}
        sessionsByWorkspace={sessionsByWorkspace}
        selectCheckout={selectCheckout}
        worktreeActions={worktreeActions}
        refreshWorkspaceTree={refreshWorkspaceTree}
      />

      <SessionActionsMenu actions={sessionActions} />

      <RenameWorktreeDialog worktrees={worktreeActions} error={error} />

      <SidebarConfirmDialogs
        deleteTarget={sessionActions.deleteTarget}
        setDeleteTarget={sessionActions.setDeleteTarget}
        onConfirmSessionDelete={sessionActions.confirmSessionDelete}
        removeWorktreeTarget={worktreeActions.removeWorktreeTarget}
        removeWorktreePreview={worktreeActions.removeWorktreePreview}
        setRemoveWorktreeTarget={worktreeActions.setRemoveWorktreeTarget}
        onConfirmRemoveWorktree={worktreeActions.confirmRemoveWorktree}
      />
    </ResizableAside>
    </SidebarPageContext.Provider>
    </KeyLayerScope>
  )
}
