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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useIsMobile } from '@/hooks/use-mobile'
import { useDrawerMotion } from '@/hooks/use-drawer-motion'
import { usePlatform } from '@/hooks/use-platform'
import { cn } from '@/lib/utils'
import { isMenuKey, menuPointFor } from '@/lib/focus/item-keys'
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
  Activity,
  AppWindow,
  Check,
  ChevronRight,
  Command,
  Copy,
  Folder,
  FolderPlus,
  FolderSearch,
  GitBranch,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  SquarePen,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { isPrimaryModifierOS } from '@/lib/keyboard-shortcut'
import { sessionWorking } from '@/lib/active-sessions'
import {
  useDeleteSessionMutation,
  useSessionsQuery,
  useSetSessionPinnedMutation,
  useUpdateSessionTitleMutation,
} from '@/queries/useSessionsQuery'
import { isChatWorkspacePath, useChatWorkspace } from '@/queries/useChatWorkspace'
import { queryKeys } from '@/queries/keys'
import { getCodingWorkspaceTree, listSessions, listWorktrees, removeWorktree, setCodingWorkspaceVisibility } from '@/api/client'
import { WORKSPACES_KEY, renameSavedWorkspace, workspaceLabel } from '@/utils/workspace'
import { RelocateWorkspaceDialog } from '@/components/LazyRelocateWorkspaceDialog'
import type { WorkspaceRelocateResponse } from '@/api/types'
import { startNewSession } from '@/lib/new-session'
import { softHapticFeedback } from '@/lib/haptics'
import { useSidebarViewStore } from '@/stores/useSidebarViewStore'
import { useUIStore } from '@/stores/useUIStore'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'
import { ThemeToggle } from './ThemeToggle'
import { HealthDot } from './HealthDot'
import { Button } from '@/components/ui/button'
import { ActionSheet, ACTION_SHEET_ROW_CLASS } from '@/components/ui/action-sheet'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Chip } from '@/components/ui/chip'
import { Collapsible } from '@/components/ui/collapsible'
import {
  CONTEXT_MENU_ITEM_CLASS,
  CONTEXT_MENU_ITEM_DANGER_CLASS,
  ContextMenu,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ROW_ACTION, ROW_TEXT_ACTION, listRowClass, rowActionsReveal } from '@/components/ui/list-row'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { useToastStore } from '@/stores/useToastStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { openTelemetry } from '@/stores/useTelemetryStore'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CodingWorkspaceTreeRepository, SessionResponse, WorkspaceGroup, WorktreeInfo, WorktreeRemoveResponse } from '@/api/types'
import { LongPressButton } from '@/components/ui/long-press-button'
import { WorkspaceSessionList } from './Sidebar/WorkspaceSessionList'
import { NeedsYouSection, RunningSection } from './Sidebar/NeedsYouSection'
import { ScheduledSection } from './Sidebar/ScheduledSection'
import { SidebarConfirmDialogs } from './Sidebar/ConfirmDialogs'
import { SidebarSectionHeader } from './Sidebar/SidebarSectionHeader'
import { PinnedSection } from './Sidebar/PinnedSection'
import { FlatSessionGroups } from './Sidebar/FlatSessionGroups'
import { WorkspaceGroupDots, workspaceGroupsLabel } from './Sidebar/WorkspaceGroupDots'
import { SessionStatusMark } from './Sidebar/SessionStatusMark'
import { WorkspaceGroupToggles } from './Sidebar/WorkspaceGroupToggles'
import { groupColor } from './Sidebar/groupColor'
import {
  addExpandedPaths,
  buildWorktreeSourceByDirectory,
  groupSessionsByWorkspace,
  newSessionChoicePaths,
  orderWorkspacePaths,
  repositoryCheckouts,
  sessionActivityTime,
  sourceWorkspacePaths,
  toggleExpandedPath,
} from './Sidebar.helpers'
import {
  loadWorkspaceBrowser,
  shouldUseServerWorkspaceBrowser,
  validateTrustedWorkspace,
} from './Sidebar.browser'
import {
  loadWorktreesForSource,
  recoverCreatedWorktreeAfterTransientError,
  removeManagedWorktree,
  submitWorktreeSession,
} from './Sidebar.worktrees'
import {
  applySessionDelete,
  applySessionSelection,
} from './Sidebar.sessions'
import {
  confirmWorkspaceRemoval,
  openWorkspaceDraft,
} from './Sidebar.workspace'
import {
  consumeTrustedWorkspace,
  selectTrustedWorkspace,
} from './Sidebar.trust'
import {
  beginWorktreeTitleEdit,
  buildOpenWorktreeDialogState,
  submitWorktreeRename,
} from './Sidebar.worktree-dialog'
import {
  openSessionInNewWindow,
  sessionWindowErrorDescription,
  shouldOpenSessionInNewWindow,
} from './Sidebar.window'
import { SessionSearch } from './Sidebar/SessionSearch'
import { SessionsPageBar, SessionsPageHeader, SessionsPageToolbar } from './Sidebar/SessionsPage'
import { SidebarPageContext } from './Sidebar/SidebarPageContext'
import { SidebarScroller } from './Sidebar/SidebarScroller'
import { useLargeTitleCollapse } from './Sidebar/useLargeTitleCollapse'
import { CountChip } from './Sidebar/CountChip'
import { MenuShortcut } from './Sidebar/MenuShortcut'
import { ROW_KEYS, type RowKeyName } from './Sidebar/row-keys'
import { TREE_INDENT_PX } from './Sidebar/tree-indent'

const WORKSPACE_TREE_STALE_MS = 30_000
/** How long a deleted session can be brought back before the server forgets it. */
const SESSION_DELETE_UNDO_MS = 5000
const NO_REPOSITORIES: CodingWorkspaceTreeRepository[] = []
const NO_GROUPS: WorkspaceGroup[] = []
/** Rows that Up/Down/Home/End move between: sessions and workspace headers. */
const SIDEBAR_ROW = '[data-sidebar-session], [data-sidebar-workspace]'
/** A row of a phone's long-press sheet: a menu row at the touch height (``--phone-control``). */
const SHEET_ROW_CLASS = ACTION_SHEET_ROW_CLASS

/** One entry of a session's menu (⋯, right-click, the phone's sheet). */
interface SessionMenuAction {
  id: string
  label: string
  icon: LucideIcon
  danger?: boolean
  /** Starts a new group of entries. */
  separatorBefore?: boolean
  /** The row key that does the same thing (``ROW_KEYS``), shown beside the entry. */
  rowKey?: RowKeyName
  run: () => void
}

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

async function pickWorkspaceDirectory(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    directory: true,
    multiple: false,
    title: 'Open workspace',
  })
  return typeof selected === 'string' ? selected : null
}

/**
 * A workspace or checkout whose folder is gone from disk: a warning, not an
 * error. A small ⚠ in the warning tone beside the name, not a chip, so the
 * name keeps the whole row. It has no tooltip of its own: its row's says
 * "Folder not found at <path>".
 */
function MissingBadge() {
  return (
    <span
      data-sidebar-missing=""
      role="img"
      aria-label="Folder not found"
      className="flex shrink-0 items-center text-(--accent-orange-text)"
    >
      <TriangleAlert size={12} aria-hidden="true" />
    </span>
  )
}

/** One pick-one row of a repository's checkout menu. */
function CheckoutMenuItem({ checked, title, onSelect, children }: { checked: boolean; title?: string; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      title={title}
      className={`${CONTEXT_MENU_ITEM_CLASS} ${checked ? 'text-(--color-text)' : ''}`}
      onClick={onSelect}
    >
      <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
        {checked && <Check size={12} />}
      </span>
      {children}
    </button>
  )
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
  page = false,
  onOpenScheduler,
  onOpenServers,
}: SidebarProps) {
  const isPage = page
  // The page is a phone layout whatever the window says: sheets for row
  // actions, no desktop resize. Only the drawer's own motion (scrim, slide,
  // inert) is left out of it, below.
  const isMobile = useIsMobile() || isPage
  const { isTauri, os } = usePlatform()
  const [nativeFolderPickerEnabled, setNativeFolderPickerEnabled] = useState(isTauri)
  const isTauriMobile = isTauri && (os === 'ios' || os === 'android')
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
  const deleteSession = useDeleteSessionMutation()
  const updateSessionTitle = useUpdateSessionTitleMutation()
  const setSessionPinned = useSetSessionPinnedMutation()
  const groupBy = useSidebarViewStore((s) => s.groupBy)
  // The phone has no "Show details" switch: its rows always carry them.
  const storedShowDetails = useSidebarViewStore((s) => s.showDetails)
  const showDetails = isMobile || storedShowDetails
  const groupFilter = useSidebarViewStore((s) => s.groupFilter)
  const setGroupFilter = useSidebarViewStore((s) => s.setGroupFilter)

  const workspaceSessions = useMemo(
    () => (sessions.data?.pages.flatMap((page) => page.data) ?? []).filter((session) => session.workspace),
    [sessions.data],
  )
  // Indexed once per `workspaceSessions` change instead of re-filtering the full
  // session list for every workspace/worktree row on every render.
  const sessionsByWorkspace = useMemo(() => groupSessionsByWorkspace(workspaceSessions), [workspaceSessions])

  // Read straight from the shared query, so a refresh made anywhere (the
  // command palette's workspace switch, another window) shows here too.
  const {
    data: workspaceTreeData,
    isPending: workspaceTreePending,
    isError: workspaceTreeFailed,
    refetch: refetchWorkspaceTree,
    isRefetching: workspaceTreeRetrying,
  } = useQuery({
    queryKey: queryKeys.coding.tree(),
    queryFn: getCodingWorkspaceTree,
    staleTime: WORKSPACE_TREE_STALE_MS,
  })
  const workspaceTree = workspaceTreeData?.repositories ?? NO_REPOSITORIES
  const workspaceByPath = useMemo(
    () => new Map(workspaceTree.map((repo) => [repo.path, repo])),
    [workspaceTree],
  )
  // Workspace groups: tags on repositories that set who may message whom.
  const workspaceGroups = workspaceTreeData?.groups ?? NO_GROUPS
  const groupsOf = (path: string) => {
    const ids = workspaceByPath.get(path)?.group_ids ?? []
    return workspaceGroups.filter((g) => ids.includes(g.id))
  }
  // A filter for a group that no longer exists shows everything.
  const activeGroupFilter = workspaceGroups.find((g) => g.id === groupFilter) ?? null
  // The chat workspace is a pinned, non-repository row: the backend never
  // stores it in ``coding_workspaces``, so it is prepended here.
  const chatWorkspace = useChatWorkspace()
  const isChatPath = (path: string | null | undefined) =>
    isChatWorkspacePath(path, chatWorkspace)
  const visibleWorkspaces = [
    ...(chatWorkspace ? [chatWorkspace.path] : []),
    ...workspaceTree.map((repo) => repo.path).filter((path) => !isChatPath(path)),
  ]
  const activeWorkspace = workspace ?? null
  const worktreeSourceByDirectory = buildWorktreeSourceByDirectory(workspaceTree)

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


  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null)
  const [browserPath, setBrowserPath] = useState<string | null>(null)
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [dirs, setDirs] = useState<Array<{ name: string; path: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [pendingWorkspace, setPendingWorkspace] = useState<string | null>(null)
  const [trustWorkspace, setTrustWorkspace] = useState<string | null>(null)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchFocusKey, setSearchFocusKey] = useState(0)
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const [worktreeEditTarget, setWorktreeEditTarget] = useState<WorktreeInfo | null>(null)
  const [worktreeEditTitle, setWorktreeEditTitle] = useState('')
  const [worktreeEditLoading, setWorktreeEditLoading] = useState(false)
  const worktreeEditInputRef = useRef<HTMLInputElement>(null)
  const [deleteTarget, setDeleteTarget] = useState<SessionResponse | null>(null)
  const [mobileSessionActions, setMobileSessionActions] = useState<{ session: SessionResponse; workspacePath: string } | null>(null)
  const [desktopSessionActions, setDesktopSessionActions] = useState<{ session: SessionResponse; workspacePath: string; x: number; y: number } | null>(null)
  // Workspace action menus act on the repository (``path``); "New session"
  // starts in the checkout its list shows (``sessionPath``).
  const [desktopWorkspaceActions, setDesktopWorkspaceActions] = useState<{ path: string; sessionPath: string; x: number; y: number } | null>(null)
  const [mobileWorkspaceActions, setMobileWorkspaceActions] = useState<{ path: string; sessionPath: string; kind: 'main' | 'chat' } | null>(null)
  // "Locate folder…" for a workspace whose folder is gone. ``native`` picks
  // with the OS dialog (the desktop app on its own server).
  const [relocateTarget, setRelocateTarget] = useState<{ path: string; native: boolean } | null>(null)
  // Repository path → the one checkout its list shows (its own path or a
  // worktree's). Absent means every checkout.
  const [checkoutFilter, setCheckoutFilter] = useState<Record<string, string>>({})
  const [checkoutMenu, setCheckoutMenu] = useState<{ repo: string; x: number; y: number } | null>(null)
  const [worktreeTarget, setWorktreeTarget] = useState<string | null>(null)
  const [worktreeName, setWorktreeName] = useState('')
  const [worktreeBranch, setWorktreeBranch] = useState('')
  const [worktreeLoading, setWorktreeLoading] = useState(false)
  const [worktreeOptions, setWorktreeOptions] = useState<WorktreeInfo[]>([])
  const [worktreeRemoving, setWorktreeRemoving] = useState<string | null>(null)
  const [worktreesBySource, setWorktreesBySource] = useState<Record<string, WorktreeInfo[]>>({})
  const [removedWorktreePaths, setRemovedWorktreePaths] = useState<Set<string>>(() => new Set())
  // Managed-worktree pending removal — null when no confirmation is open.
  // Removing a managed worktree deletes it from disk (git worktree remove),
  // which can drop uncommitted work, so it must be confirmed (error
  // prevention) like session-delete and workspace-removal already are.
  const [removeWorktreeTarget, setRemoveWorktreeTargetState] = useState<WorktreeInfo | null>(null)
  // What the removal does to the worktree's branch (a dry run), for the dialog.
  const [removeWorktreePreview, setRemoveWorktreePreview] = useState<WorktreeRemoveResponse | null>(null)
  const removeWorktreeAsked = useRef<string | null>(null)
  const setRemoveWorktreeTarget = (item: WorktreeInfo | null) => {
    setRemoveWorktreeTargetState(item)
    setRemoveWorktreePreview(null)
    removeWorktreeAsked.current = item?.directory ?? null
    const source = item?.managed ? worktreeSourceByDirectory.get(item.directory) ?? worktreeTarget : null
    if (!item || !source) return
    // The dialog stands without the answer; it only loses the branch line.
    removeWorktree(source, item.directory, { dryRun: true })
      .then((preview) => { if (removeWorktreeAsked.current === item.directory) setRemoveWorktreePreview(preview) })
      .catch(() => {})
  }

  const loadBrowser = useCallback(async (path?: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const result = await loadWorkspaceBrowser(path)
      setBrowserPath(result.path)
      setParentPath(result.parent)
      setDirs(result.directories)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to read directory')
    } finally {
      setLoading(false)
    }
  }, [])

  const openWebWorkspaceDialog = useCallback(() => {
    setSelectedWorkspace(null)
    setTrustWorkspace(null)
    setDialogOpen(true)
    if (!browserPath) void loadBrowser(null)
    // `useState` setters are stable, so listing them is runtime-neutral — but
    // the React Compiler infers them as dependencies and skips optimizing the
    // whole component when the source list omits them.
  }, [browserPath, loadBrowser, setSelectedWorkspace, setTrustWorkspace, setDialogOpen])

  const openWorkspaceDialog = useCallback(async () => {
    setError(null)
    setSelectedWorkspace(null)
    setTrustWorkspace(null)

    if (await shouldUseServerWorkspaceBrowser(isTauri, isTauriMobile)) {
      setNativeFolderPickerEnabled(false)
      openWebWorkspaceDialog()
      return
    }
    setNativeFolderPickerEnabled(true)

    setDialogOpen(true)
    setLoading(true)
    try {
      const selected = await pickWorkspaceDirectory()
      if (!selected) return
      setSelectedWorkspace(selected)
      setTrustWorkspace(await validateTrustedWorkspace(selected))
      setDialogOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to open workspace')
    } finally {
      setLoading(false)
    }
    // Stable `useState` setters — see openWebWorkspaceDialog above.
  }, [
    isTauri,
    isTauriMobile,
    openWebWorkspaceDialog,
    setError,
    setSelectedWorkspace,
    setTrustWorkspace,
    setNativeFolderPickerEnabled,
    setDialogOpen,
    setLoading,
  ])

  // Every caller has just changed the tree on the server, so a cached copy
  // is never good enough. Invalidating also restarts a fetch already in
  // flight, which may have left before the change landed.
  const refreshWorkspaceTree = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.coding.tree() }),
    [queryClient],
  )
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
  const openRelocate = useCallback(async (path: string) => {
    let native = false
    try {
      native = !(await shouldUseServerWorkspaceBrowser(isTauri, isTauriMobile))
    } catch {
      native = false
    }
    setRelocateTarget({ path, native })
  }, [isTauri, isTauriMobile])
  const handleRelocated = useCallback((result: WorkspaceRelocateResponse) => {
    setRelocateTarget(null)
    renameSavedWorkspace(result.from, result.workspace)
    for (const moved of result.moved_worktrees) renameSavedWorkspace(moved.from, moved.to)
    void refreshSessionList()
    pushToast(result.warnings.length > 0
      ? { tone: 'error', title: `Moved to ${workspaceLabel(result.workspace)}, but git needs a hand`, description: result.warnings.join('\n') }
      : { tone: 'info', title: `Moved to ${workspaceLabel(result.workspace)}` })
  }, [pushToast, refreshSessionList])
  // Scheduled on the page toolbar: the caller's way, else the way the
  // drawer's Scheduled section opens it.
  const openScheduler = onOpenScheduler ?? (() => {
    useUIStore.getState().focusScheduledTask(null)
    dispatchAppEvent(APP_EVENTS.openScheduler)
  })

  useEffect(() => {
    const handler = () => { void refreshWorkspaceTree() }
    // Other windows also write storage for unrelated state (unread marks on
    // every finished turn, theme…); only the saved workspace list moves the tree.
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === WORKSPACES_KEY) handler()
    }
    window.addEventListener('workspaces-changed', handler)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('workspaces-changed', handler)
      window.removeEventListener('storage', onStorage)
    }
  }, [refreshWorkspaceTree])

  useEffect(() => {
    if (openWorkspaceDialogKey > 0) void openWorkspaceDialog()
  }, [openWorkspaceDialogKey, openWorkspaceDialog])

  useEffect(() => {
    if (pendingWorkspace && workspace === pendingWorkspace) setPendingWorkspace(null)
  }, [pendingWorkspace, workspace])

  useEffect(() => {
    if (worktreeEditTarget) worktreeEditInputRef.current?.focus()
  }, [worktreeEditTarget])

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
      void openWorkspaceDialog()
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
      setError(err instanceof Error ? err.message : 'Unable to open workspace')
    } finally {
      setPendingWorkspace(null)
    }
  }

  const toggleSessionPinned = (session: SessionResponse) => {
    const pinned = !session.pinned_at
    setSessionPinned.mutate(
      { id: session.id, pinned },
      { onError: () => pushToast({ tone: 'error', title: pinned ? 'Could not pin session' : 'Could not unpin session' }) },
    )
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
    void confirmWorkspaceRemoval({
      path,
      worktreePaths,
      activeWorkspace,
      expandedWorkspaces,
      queryClient,
      refreshWorkspaceTree,
      navigate: ({ to, replace }) => navigate({ to, replace }),
    }).catch((err: unknown) => {
      pushToast({
        tone: 'error',
        title: `Could not remove ${workspaceLabel(path)} from the sidebar`,
        description: err instanceof Error ? err.message : undefined,
      })
      void refreshWorkspaceTree()
    })
  }

  const loadWorktreesForTarget = useCallback(async (path: string) => {
    const items = await loadWorktreesForSource(path, listWorktrees)
    setWorktreesBySource((current) => ({ ...current, [path]: items }))
    if (worktreeTarget === path) setWorktreeOptions(items)
    return items
  }, [worktreeTarget])

  const openWorktreeDialog = async (path: string) => {
    const nextState = buildOpenWorktreeDialogState(path, worktreesBySource[path])
    setWorktreeTarget(nextState.target)
    setWorktreeName(nextState.name)
    setWorktreeBranch(nextState.branch)
    setWorktreeOptions(nextState.options)
    setWorktreeRemoving(nextState.removing)
    setError(nextState.error)
    const items = await loadWorktreesForTarget(path)
    setWorktreeOptions(items)
  }

  const handleRemoveWorktree = async (item: WorktreeInfo) => {
    if (!item.managed) return
    const directory = item.directory
    setWorktreeRemoving(directory)
    setError(null)
    try {
      const result = await removeManagedWorktree(item, {
        worktreeTarget,
        worktreeSourceByDirectory,
        loadWorktreesForSource: loadWorktreesForTarget,
        refreshWorkspaceTree,
      })
      if (!result) return
      setRemovedWorktreePaths((current) => new Set(current).add(result.removedDirectory))
      setExpandedWorkspaces((current) => {
        if (!current.has(result.removedDirectory)) return current
        const next = new Set(current)
        next.delete(result.removedDirectory)
        return next
      })
      setWorktreesBySource((current) => {
        const next = { ...current }
        delete next[result.removedDirectory]
        if (result.source) {
          next[result.source] = result.refreshedItems
        }
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to remove worktree')
    } finally {
      setWorktreeRemoving(null)
    }
  }

  // Commit the removal from the confirmation dialog.
  const confirmRemoveWorktree = () => {
    const target = removeWorktreeTarget
    setRemoveWorktreeTarget(null)
    if (target) void handleRemoveWorktree(target)
  }

  const submitWorktree = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!worktreeTarget) return
    setWorktreeLoading(true)
    setError(null)
    try {
      await submitWorktreeSession({
        worktreeTarget,
        worktreeName,
        worktreeBranch,
        queryClient,
        refreshWorkspaceTree,
        navigate,
        onMobileClose,
        loadWorktreesForSource: loadWorktreesForTarget,
      })
      setWorktreeTarget(null)
    } catch (err) {
      const recovered = await recoverCreatedWorktreeAfterTransientError({
        error: err,
        worktreeTarget,
        worktreeName,
        loadWorktreesForSource: loadWorktreesForTarget,
        refreshWorkspaceTree,
        navigate: ({ to }) => navigate({ to }),
        onMobileClose,
      })
      if (recovered) {
        setWorktreeTarget(null)
        setError(null)
        return
      }
      setError(err instanceof Error ? err.message : 'Unable to create worktree')
    } finally {
      setWorktreeLoading(false)
    }
  }

  const deletedWorktreeSet = removedWorktreePaths
  // Chat, then repositories in a workspace group, then the rest; each part
  // most recently active first.
  const sourceWorkspaces = [
    ...(chatWorkspace ? [chatWorkspace.path] : []),
    ...orderWorkspacePaths(
      sourceWorkspacePaths(workspaceTree, deletedWorktreeSet)
        .filter((path) => !isChatPath(path))
        .filter((path) => !activeGroupFilter || (workspaceByPath.get(path)?.group_ids ?? []).includes(activeGroupFilter.id)),
      workspaceByPath,
      workspaceGroups.map((group) => group.id),
      sessionsByWorkspace,
    ),
  ]
  const activeWorktreeSource = activeWorkspace ? worktreeSourceByDirectory.get(activeWorkspace) : null
  // ✎'s hold menu on the Sessions screen: where a tap would start, Chat, and
  // the most recently active repositories.
  const newSessionChoices = isPage
    ? newSessionChoicePaths(
        workspace ?? chatWorkspace?.path ?? null,
        chatWorkspace?.path ?? null,
        orderWorkspacePaths(
          sourceWorkspacePaths(workspaceTree, deletedWorktreeSet).filter((path) => !isChatPath(path)),
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

  // Opening a session its repository's checkout filter hides (from Needs
  // you, search, another window) shows every checkout again. Picking a
  // filter never moves the current session, so that choice sticks.
  useEffect(() => {
    if (!activeWorkspace) return
    const repository = activeWorktreeSource ?? activeWorkspace
    setCheckoutFilter((current) => {
      const selected = current[repository]
      if (selected === undefined || selected === activeWorkspace) return current
      const next = { ...current }
      delete next[repository]
      return next
    })
  }, [currentSessionId, activeWorkspace, activeWorktreeSource])

  const selectCheckout = (repository: string, checkout: string | null) => {
    setCheckoutFilter((current) => {
      const next = { ...current }
      if (checkout === null) delete next[repository]
      else next[repository] = checkout
      return next
    })
  }
  const checkoutMenuRepository = checkoutMenu
    ? repositoryCheckouts(checkoutMenu.repo, workspaceByPath.get(checkoutMenu.repo), deletedWorktreeSet, checkoutFilter[checkoutMenu.repo])
    : null
  const checkoutMenuSelection = checkoutMenuRepository?.selectedWorktree
  const checkoutMenuWorktree: WorktreeInfo | null = checkoutMenuSelection
    ? { name: checkoutMenuSelection.name, directory: checkoutMenuSelection.path, managed: checkoutMenuSelection.managed }
    : null

  // A checkout that is not OpenAgentd's to delete (a subfolder, an outside
  // worktree, or one whose folder is gone) leaves the sidebar only.
  const hideCheckout = (path: string) => {
    void setCodingWorkspaceVisibility(path, true)
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
        await refreshWorkspaceTree()
      })
      .catch((err: unknown) => {
        pushToast({ tone: 'error', title: 'Could not remove it from the sidebar', description: err instanceof Error ? err.message : undefined })
      })
  }

  const openSelectedFolder = async () => {
    try {
      const trustedWorkspace = await selectTrustedWorkspace(browserPath, validateTrustedWorkspace)
      if (!trustedWorkspace) return
      setTrustWorkspace(trustedWorkspace)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Workspace is invalid')
    }
  }

  const confirmTrustedWorkspace = () => {
    const nextState = consumeTrustedWorkspace(trustWorkspace)
    if (!nextState.workspaceToOpen) return
    setTrustWorkspace(nextState.nextTrustWorkspace)
    setDialogOpen(nextState.nextDialogOpen)
    void openFolderDraft(nextState.workspaceToOpen)
  }

  const openInNewWindow = (session: SessionResponse) => {
    openSessionInNewWindow({ session }).catch((err) => {
      console.error('Failed to open session in new window:', err)
      pushToast({
        tone: 'error',
        title: 'Could not open session in new window',
        description: sessionWindowErrorDescription(err, 'Desktop window creation failed.'),
      })
    })
  }

  const handleSessionSelect = (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => {
    if (event && shouldOpenSessionInNewWindow(event, isTauri, os)) {
      event.preventDefault()
      event.stopPropagation()
      openInNewWindow(session)
      return
    }

    applySessionSelection({
      session,
      workspacePath,
      navigate,
      onMobileClose,
    })
  }

  // From a row's key (an event) or its swipe action (none): either way it
  // only opens the confirmation.
  const handleSessionDelete = (e: React.SyntheticEvent | null, session: SessionResponse) => {
    e?.stopPropagation()
    setDeleteTarget(session)
  }

  const handleSessionEdit = (session: SessionResponse) => {
    setEditingSessionId(session.id)
  }

  const handleSessionRename = (session: SessionResponse, title: string) => {
    setEditingSessionId(null)
    updateSessionTitle.mutate(
      { id: session.id, title },
      { onError: () => pushToast({ tone: 'error', title: 'Could not rename session' }) },
    )
  }

  const handleWorktreeEdit = (item: WorktreeInfo) => {
    const nextState = beginWorktreeTitleEdit(item)
    setWorktreeEditTarget(nextState.target)
    setWorktreeEditTitle(nextState.title)
  }

  const submitWorktreeTitle = async (e: React.FormEvent) => {
    e.preventDefault()
    setWorktreeEditLoading(true)
    setError(null)
    try {
      const renamed = await submitWorktreeRename({
        target: worktreeEditTarget,
        title: worktreeEditTitle,
        refreshWorkspaceTree,
      })
      if (!renamed) return
      setWorktreeEditTarget(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to rename worktree')
    } finally {
      setWorktreeEditLoading(false)
    }
  }

  const workspaceDisplayName = (path: string) => (isChatPath(path) ? (chatWorkspace?.name ?? path) : workspaceLabel(path))

  // Row callbacks shared by every session list (tree, flat views, Pinned).
  const sessionRowHandlers = {
    onSessionSelect: handleSessionSelect,
    onSessionDelete: handleSessionDelete,
    onSessionEdit: handleSessionEdit,
    onSessionRename: handleSessionRename,
    onSessionRenameCancel: () => setEditingSessionId(null),
    onSessionLongPress: (session: SessionResponse) => openMobileSessionActions(session, session.workspace ?? ''),
    onSessionContextActions: (session: SessionResponse, event: { clientX: number; clientY: number }) => {
      // Phones (browser too): the titled sheet, since a truncated title has
      // no tooltip on touch.
      if (isMobile) {
        openMobileSessionActions(session, session.workspace ?? '')
        return
      }
      setDesktopSessionActions({ session, workspacePath: session.workspace ?? '', x: event.clientX, y: event.clientY })
    },
    onSessionPinToggle: toggleSessionPinned,
  }

  // One list for a session's ⋯ menu, right-click and the phone's sheet.
  const sessionMenuActions = (session: SessionResponse): SessionMenuAction[] => {
    // Subagents are their parent's: no pin, and their title is their task.
    const topLevel = !session.parent_session_id
    const actions: SessionMenuAction[] = []
    if (isTauri && !isTauriMobile) {
      actions.push({ id: 'window', label: 'Open in new window', icon: AppWindow, run: () => openInNewWindow(session) })
    }
    if (topLevel) {
      actions.push({ id: 'rename', label: 'Rename', icon: Pencil, rowKey: 'rename', run: () => handleSessionEdit(session) })
      actions.push({
        id: 'pin',
        label: session.pinned_at ? 'Unpin' : 'Pin',
        icon: session.pinned_at ? PinOff : Pin,
        run: () => toggleSessionPinned(session),
      })
    }
    actions.push({ id: 'delete', label: 'Delete session…', icon: Trash2, danger: true, separatorBefore: actions.length > 0, rowKey: 'delete', run: () => setDeleteTarget(session) })
    return actions
  }

  // The titled sheet on a phone, the iOS app included.
  const openMobileSessionActions = (session: SessionResponse, workspacePath: string) => {
    setMobileSessionActions({ session, workspacePath })
  }

  const confirmSessionDelete = () => {
    if (!deleteTarget) return
    const target = deleteTarget
    // On the Sessions page, ``currentSessionId`` is the chat kept under the
    // list, not one on screen: deleting it neither leaves for another session
    // (that would push a chat over Sessions) nor, on Undo, goes back to it.
    const stay = isPage && mobileOpen
    const wasOpen = !stay && target.id === currentSessionId
    // The row leaves at once; the server delete waits out the Undo window.
    // Undo (or a refusal) brings the row back.
    const undo = new AbortController()
    const toastId = pushToast({
      tone: 'info',
      title: 'Session deleted',
      description: target.title || 'Untitled',
      action: {
        label: 'Undo',
        onAction: () => {
          undo.abort()
          if (wasOpen) navigate({ to: '/$sessionId', params: { sessionId: target.id }, replace: true })
        },
      },
    }, SESSION_DELETE_UNDO_MS)
    applySessionDelete({
      deleteTarget: target,
      currentSessionId,
      workspaceSessions,
      stay,
      mutateDelete: (mutationTarget) => deleteSession.mutate(
        typeof mutationTarget === 'string'
          ? { id: mutationTarget, holdMs: SESSION_DELETE_UNDO_MS, undo: undo.signal }
          : { ...mutationTarget, holdMs: SESSION_DELETE_UNDO_MS, undo: undo.signal },
        {
          // Past the window the Undo button can't help any more.
          onSettled: () => dismissToast(toastId),
          onError: () => {
            if (undo.signal.aborted) return
            pushToast({ tone: 'error', title: 'Could not delete session' })
          },
        },
      ),
      navigate,
    })
    setDeleteTarget(null)
  }

  const mobileWorkspaceActionsTitle = mobileWorkspaceActions?.kind === 'chat'
    ? (chatWorkspace?.name ?? 'Chat')
    : mobileWorkspaceActions
      ? workspaceLabel(mobileWorkspaceActions.path)
      : 'Workspace actions'
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
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          const target = event.target as HTMLElement
          // Up/Down/Home/End walk the visible rows like a native source list;
          // Tab still stops on every row and action (DESIGN.md → Keyboard
          // focus model). Only from a row, so fields and menus keep their keys.
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && target.matches(SIDEBAR_ROW)) {
            const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(SIDEBAR_ROW))
              .filter((el) => !el.closest('[inert], [hidden]'))
            const index = rows.indexOf(target)
            const next = event.key === 'Home' ? rows[0]
              : event.key === 'End' ? rows[rows.length - 1]
              : rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
            event.preventDefault()
            next?.focus()
            return
          }
          // Left on a session row climbs to its workspace, like a tree.
          if (event.key !== 'ArrowLeft') return
          if (!target.closest('[data-sidebar-session]')) return
          const header = target.closest('[data-sidebar-workspace-group]')?.querySelector<HTMLElement>('[data-sidebar-workspace]')
          if (!header) return
          event.preventDefault()
          header.focus()
        }}
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
          onOpenFolder={() => { void openWorkspaceDialog() }}
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
        onOpenFolder={() => { void openWorkspaceDialog() }}
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
      <div className="flex flex-1 flex-col pb-2">
        {workspaceTreeFailed && workspaceTree.length === 0 && (
          <div role="alert" data-sidebar-tree-error="">
            <EmptyState
              compact
              tone="error"
              icon={TriangleAlert}
              title="Couldn't load workspaces."
              className="px-3 py-1.5"
              action={(
                <button
                  type="button"
                  className={`${ROW_TEXT_ACTION} -ml-2`}
                  disabled={workspaceTreeRetrying}
                  onClick={() => { void refetchWorkspaceTree() }}
                >
                  {workspaceTreeRetrying && <Loader2 size={12} className="mr-1 animate-spin" aria-hidden="true" />}
                  {workspaceTreeRetrying ? 'Retrying…' : 'Retry'}
                </button>
              )}
            />
          </div>
        )}

        {!workspaceTreePending && !workspaceTreeFailed && visibleWorkspaces.length === 0 && (
          <EmptyState
            compact
            icon={FolderPlus}
            title="No workspaces yet"
            className="px-3 py-3"
            action={(
              <Button type="button" size="sm" onClick={() => { void openWorkspaceDialog() }}>
                <FolderPlus size={13} aria-hidden="true" />
                Open workspace…
              </Button>
            )}
          />
        )}

        {activeGroupFilter && (
          // The group filter, named above the list, with a one-step way back.
          <div className="mx-1.5 flex h-6 items-center gap-1.5 px-1.5 text-meta text-(--color-text-subtle) pointer-coarse:h-9" data-sidebar-group-filter="">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: groupColor(activeGroupFilter) }} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              Group: <span className="font-mono text-(--color-text-2)">{activeGroupFilter.name}</span>
            </span>
            <button
              type="button"
              onClick={() => setGroupFilter(null)}
              className={ROW_TEXT_ACTION}
              aria-label="Show all workspaces"
            >
              Show all
            </button>
          </div>
        )}

        {sourceWorkspaces.map((path) => {
          // Chat is pinned and not a repository: no worktrees, no rename, no
          // removal — only the expand toggle and "New session" apply.
          const sourceIsChat = isChatPath(path)
          const sourceLabel = sourceIsChat ? (chatWorkspace?.name ?? path) : workspaceLabel(path)
          const sourceGroups = sourceIsChat ? NO_GROUPS : groupsOf(path)
          const checkouts = repositoryCheckouts(path, workspaceByPath.get(path), deletedWorktreeSet, checkoutFilter[path])
          const { worktrees, selectedWorktree } = checkouts
          const allCheckoutPaths = [path, ...worktrees.map((item) => item.path)]
          // "New session" starts where the list points: the selected checkout.
          const sessionTarget = checkouts.selected ?? path
          const sourceIsActive = path === activeWorkspace || path === activeWorktreeSource
          const sourceIsExpanded = expandedWorkspaces.has(path)
          const sourceIsPending = pendingWorkspace !== null && allCheckoutPaths.includes(pendingWorkspace)
          const worktreeIsRemoving = worktreeRemoving !== null && allCheckoutPaths.includes(worktreeRemoving)
          const sourceRunningSessions = checkouts.listPaths
            .flatMap((checkout) => sessionsByWorkspace.get(checkout) ?? [])
            .filter(sessionWorking)
            .sort((a, b) => (sessionActivityTime(b) ?? '').localeCompare(sessionActivityTime(a) ?? ''))
          const sourceHasRunningSession = sourceRunningSessions.length > 0
          // Touch: the row says when a session inside waits or runs, so a
          // folded workspace still shows it (mockup J2).
          const sourceWaitingCount = checkouts.listPaths
            .flatMap((checkout) => sessionsByWorkspace.get(checkout) ?? [])
            .filter((session) => session.needs_input === true).length
          const sourceMissing = Boolean(workspaceByPath.get(path)?.missing)
          const worktreeChipHint = checkouts.selected
            ? `Showing ${selectedWorktree?.name ?? 'the workspace'} only · change worktree`
            : `Showing the workspace and ${worktrees.length} worktree${worktrees.length === 1 ? '' : 's'}`

          return (
            <div key={path} className="relative" data-sidebar-workspace-group="">
              <div className="group mx-1.5 flex h-(--spacing-list-row) items-center rounded-sm hover:bg-(--bg-key)/40">
                {/* The chevron folds; the name opens. Keyboard users fold with
                    ←/→ on the name, so the chevron is not a Tab stop. Its
                    padding keeps it over the session guide below. */}
                <button
                  type="button"
                  tabIndex={-1}
                  data-sidebar-workspace-toggle=""
                  onClick={() => toggleWorkspaceExpanded(path)}
                  className="flex h-full shrink-0 items-center rounded-sm pl-1.5 pr-1 text-(--color-text-muted) hover:text-(--color-text) pointer-coarse:pr-[19px]"
                  aria-expanded={sourceIsExpanded}
                  aria-label={`${sourceIsExpanded ? 'Collapse' : 'Expand'} workspace ${sourceLabel}`}
                >
                  <ChevronRight size={12} className={`shrink-0 transition-transform duration-(--motion-fast) ${sourceIsExpanded ? 'rotate-90' : ''}`} aria-hidden="true" />
                </button>
                <Tooltip className="h-full min-w-0 flex-1">
                  <TooltipTrigger
                    className="h-full min-w-0 flex-1"
                    render={
                      <LongPressButton
                        enabled={mobileLongPressActions}
                        // Chat gets the sheet too, just a narrower one: on
                        // touch the inline "+" is hidden, so this is the only
                        // way left to start a new chat session.
                        onLongPress={() => setMobileWorkspaceActions({ path, sessionPath: sessionTarget, kind: sourceIsChat ? 'chat' : 'main' })}
                        type="button"
                        data-sidebar-workspace=""
                        onClick={() => { void openWorkspaceLatest(path, checkouts.listPaths, sessionTarget) }}
                        onKeyDown={(event) => {
                          const expandKey = event.key === 'ArrowRight' && !sourceIsExpanded
                          const collapseKey = event.key === 'ArrowLeft' && sourceIsExpanded
                          if (expandKey || collapseKey) {
                            event.preventDefault()
                            toggleWorkspaceExpanded(path)
                          } else if (isMenuKey(event) && !mobileLongPressActions && !sourceIsChat) {
                            event.preventDefault()
                            const at = menuPointFor(event.currentTarget)
                            setDesktopWorkspaceActions({ path, sessionPath: sessionTarget, x: at.clientX, y: at.clientY })
                          }
                        }}
                        onContextMenu={(event) => {
                          if (mobileLongPressActions || sourceIsChat) return
                          event.preventDefault()
                          setDesktopWorkspaceActions({ path, sessionPath: sessionTarget, x: event.clientX, y: event.clientY })
                        }}
                        className="flex h-full min-w-0 flex-1 items-center gap-1.5 truncate rounded-sm pr-1.5 text-left text-xs"
                        aria-label={`Open workspace ${sourceLabel}`}
                        aria-description={sourceIsExpanded ? 'Expanded' : 'Collapsed'}
                      >
                        {sourceIsChat ? (
                          <MessageCircle size={12} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
                        ) : (
                          <Folder size={12} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
                        )}
                        {/* A folder that is gone reads muted, with a ⚠ after it
                            (its tooltip says where it was). */}
                        <span
                          className={cn(
                            'truncate',
                            sourceIsActive && 'font-medium',
                            sourceMissing
                              ? 'text-(--color-text-muted)'
                              : sourceIsActive ? 'text-(--color-text)' : 'text-(--color-text-2) group-hover:text-(--color-text)',
                          )}
                        >
                          {sourceLabel}
                        </span>
                        {sourceMissing && <MissingBadge />}
                        <WorkspaceGroupDots groups={sourceGroups} />
                        {mobileLongPressActions && (sourceWaitingCount > 0 || sourceHasRunningSession) && (
                          <span data-workspace-status="" className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-meta tabular-nums text-(--color-text-muted)">
                            <SessionStatusMark
                              status={sourceWaitingCount > 0 ? 'needs_input' : 'running'}
                              label={sourceWaitingCount > 0 ? `${sourceWaitingCount} waiting for you` : `${sourceRunningSessions.length} running`}
                            />
                            <span aria-hidden="true">{sourceWaitingCount > 0 ? sourceWaitingCount : sourceRunningSessions.length}</span>
                          </span>
                        )}
                        {sourceIsPending && (
                          <span>
                            <Loader2 size={12} className="shrink-0 animate-spin text-(--color-text-muted)" aria-hidden="true" />
                          </span>
                        )}
                      </LongPressButton>
                    }
                  />
                  <TooltipContent>
                    {sourceIsChat ? 'Chat workspace' : sourceMissing ? `Folder not found at ${path}` : path}
                    {sourceGroups.length > 0 && <span className="block">{workspaceGroupsLabel(sourceGroups)}</span>}
                  </TooltipContent>
                </Tooltip>
                {worktrees.length > 0 && (
                  // Always visible and always compact (branch icon + worktree
                  // count, the pill every row count uses), so the repository
                  // name keeps the row; a filter shows as the chip's fill and
                  // as a row atop the list.
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <CountChip
                          icon={GitBranch}
                          count={worktrees.length}
                          active={Boolean(checkouts.selected)}
                          mark={worktreeIsRemoving ? <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden="true" /> : undefined}
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect()
                            setCheckoutMenu({ repo: path, x: rect.left, y: rect.bottom + 4 })
                          }}
                          aria-haspopup="menu"
                          aria-expanded={checkoutMenu?.repo === path}
                          aria-label={`${worktrees.length} ${worktrees.length === 1 ? 'worktree' : 'worktrees'}`}
                          aria-description={`${sourceLabel}: ${worktreeChipHint}`}
                        />
                      }
                    />
                    <TooltipContent>{worktreeChipHint}</TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => newSessionIn(sessionTarget)}
                        // Like session rows, the actions take no room at rest,
                        // so the folder name keeps the whole row.
                        className={`ml-1 ${ROW_ACTION} ${mobileLongPressActions ? 'hidden' : rowActionsReveal('')}`}
                        aria-label={selectedWorktree ? `New session in worktree ${selectedWorktree.name}` : `New session in ${sourceLabel}`}
                      >
                        <Plus size={12} aria-hidden="true" />
                      </button>
                    }
                  />
                  <TooltipContent>{selectedWorktree ? `New session in ${selectedWorktree.name}` : 'New session'}</TooltipContent>
                </Tooltip>
                {sourceIsChat ? (
                  // Chat has no actions menu; hold its slot so the + lines up
                  // with every other workspace row.
                  !mobileLongPressActions && <span aria-hidden="true" className={`mr-1 w-6 shrink-0 pointer-coarse:w-9 ${rowActionsReveal('')}`} />
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          onClick={(event) => {
                            if (isMobile) {
                              setMobileWorkspaceActions({ path, sessionPath: sessionTarget, kind: 'main' })
                              return
                            }
                            const rect = event.currentTarget.getBoundingClientRect()
                            setDesktopWorkspaceActions({ path, sessionPath: sessionTarget, x: rect.left, y: rect.bottom + 4 })
                          }}
                          className={`mr-1 ${ROW_ACTION} ${mobileLongPressActions ? 'hidden' : rowActionsReveal('')}`}
                          aria-haspopup="menu"
                          aria-label={`Actions for ${sourceLabel}`}
                        >
                          <MoreHorizontal size={12} aria-hidden="true" />
                        </button>
                      }
                    />
                    <TooltipContent>Workspace actions</TooltipContent>
                  </Tooltip>
                )}
              </div>

              <Collapsible open={sourceIsExpanded || sourceHasRunningSession}>
                {/* One level: every checkout's sessions hang off a single
                    guide under the chevron (the tree's one indent, which a
                    session's subagent rows use too), status marks under the
                    folder. Expanding and collapsing fold the rows (height motion). */}
                <div className="mr-1.5 border-l border-(--color-border-subtle) pb-1 pl-1" style={{ marginLeft: TREE_INDENT_PX }}>
                  {checkouts.selected && sourceIsExpanded && (
                    // The active filter, named where its sessions are, with
                    // a one-step way back to every checkout.
                    <div className="flex h-6 items-center gap-1.5 px-1.5 text-meta text-(--color-text-subtle) pointer-coarse:h-9">
                      <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
                        {selectedWorktree
                          ? <GitBranch size={12} className="text-(--accent-orange-text)" />
                          : <Folder size={12} className="text-(--color-accent)" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-(--color-text-2)">
                        {selectedWorktree?.name ?? 'Workspace'}
                      </span>
                      <button
                        type="button"
                        onClick={() => selectCheckout(path, null)}
                        className={ROW_TEXT_ACTION}
                        aria-label={`Show all worktrees in ${sourceLabel}`}
                      >
                        Show all
                      </button>
                    </div>
                  )}
                  <WorkspaceSessionList
                    path={checkouts.listPaths[0]}
                    paths={checkouts.listPaths}
                    // Tags only help while several checkouts share the list.
                    checkoutNames={checkouts.selected ? undefined : checkouts.worktreeNames}
                    currentSessionId={currentSessionId}
                    runningSessions={sourceRunningSessions}
                    collapsed={!sourceIsExpanded}
                    showDetails={showDetails}
                    draftActive={draftWorkspace !== null && checkouts.listPaths.includes(draftWorkspace)}
                    mobileLongPressActions={mobileLongPressActions}
                    editingSessionId={editingSessionId}
                    {...sessionRowHandlers}
                    onSessionLongPress={(session) => openMobileSessionActions(session, session.workspace || path)}
                    onSessionContextActions={(session, event) => {
                      if (isMobile) {
                        openMobileSessionActions(session, session.workspace || path)
                        return
                      }
                      setDesktopSessionActions({ session, workspacePath: session.workspace || path, x: event.clientX, y: event.clientY })
                    }}
                  />
                </div>
              </Collapsible>
            </div>
          )
        })}

        {workspaceTreePending && (
          // First load: placeholder rows, not "No workspaces yet".
          <div role="status" aria-label="Loading workspaces" className="space-y-2 px-3 py-2" data-sidebar-tree-loading="">
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        )}
      </div>
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
      <>
      {/* Mobile drawer footer — on desktop this lives in AppFooter status bar */}
      {/* Settings, Usage and theme are icons; the server takes the free width
          and names itself, so the connection is readable at a glance. */}
      <div className="flex md:hidden items-center gap-1 border-t border-(--color-border) px-2 py-1 pb-safe">
        <button
          type="button"
          onClick={() => { openSettings(); onMobileClose?.() }}
          aria-label="Settings"
          className="flex size-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
        >
          <Settings size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => { openTelemetry(); onMobileClose?.() }}
          aria-label="Usage"
          className="flex size-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
        >
          <Activity size={16} aria-hidden="true" />
        </button>
        {onOpenPalette && (
          <button
            type="button"
            onClick={() => { onMobileClose?.(); onOpenPalette() }}
            aria-label="Command palette"
            className="flex size-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
          >
            <Command size={16} aria-hidden="true" />
          </button>
        )}
        <HealthDot labeled className="h-9 min-w-0 flex-1 justify-start px-2 text-xs" />
        <ThemeToggle collapsed className="h-9 w-9" />
      </div>
      </>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setTrustWorkspace(null)
        }}
      >
        <DialogContent showCloseButton={false} className="min-w-0">
          {trustWorkspace ? (
            <>
              <DialogHeader>
                <DialogTitle>Trust this workspace?</DialogTitle>
                <DialogDescription>
                  Agents get filesystem and shell access inside this exact directory.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2">
                <p className="break-all font-mono text-xs text-(--color-text-muted)">{trustWorkspace}</p>
              </div>
              <DialogFooter>
                <Button type="button" variant="default" onClick={() => setTrustWorkspace(null)}>Back</Button>
                <Button variant="primary" type="button" onClick={confirmTrustedWorkspace}>Trust and open</Button>
              </DialogFooter>
            </>
          ) : nativeFolderPickerEnabled && !isTauriMobile ? (
            <>
              <DialogHeader>
                <DialogTitle>Open workspace</DialogTitle>
                <DialogDescription>
                  Use the desktop folder picker to choose a workspace.
                </DialogDescription>
              </DialogHeader>
              <div className="min-w-0 space-y-2">
                {selectedWorkspace && (
                  <div className="min-w-0 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2">
                    <p className="min-w-0 font-mono text-xs text-(--color-text-muted) [overflow-wrap:anywhere]" title={selectedWorkspace}>
                      {selectedWorkspace}
                    </p>
                  </div>
                )}
                {error && <p className="text-xs text-(--color-error)">{error}</p>}
              </div>
              <DialogFooter>
                <Button type="button" variant="default" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button variant="primary" type="button" disabled={loading} onClick={() => { void openWorkspaceDialog() }}>
                  {loading ? 'Opening…' : 'Choose folder…'}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Open workspace</DialogTitle>
                <DialogDescription>Choose a workspace folder on the server.</DialogDescription>
              </DialogHeader>
              <div className="min-w-0 space-y-2">
                <div className="min-w-0 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2">
                  <p className="min-w-0 font-mono text-xs text-(--color-text-muted) [overflow-wrap:anywhere]" title={browserPath ?? undefined}>
                    {browserPath ?? 'Loading folders…'}
                  </p>
                </div>
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-sm border border-(--color-border) bg-(--bg-card) p-1">
                  {parentPath && (
                    <button
                      type="button"
                      className="w-full rounded-xs px-2 py-1.5 text-left text-sm hover:bg-(--bg-key)"
                      onClick={() => void loadBrowser(parentPath)}
                    >
                      ..
                    </button>
                  )}
                  {loading && dirs.length === 0 && (
                    <div role="status" aria-label="Loading folders" className="space-y-2 px-2 py-3">
                      <Skeleton className="h-3 w-2/3" />
                      <Skeleton className="h-3 w-1/2" />
                      <Skeleton className="h-3 w-3/5" />
                    </div>
                  )}
                  {!loading && dirs.length === 0 && (
                    <EmptyState compact icon={Folder} title="No folders here" className="px-2 py-3" />
                  )}
                  {dirs.map((dir) => (
                    <button
                      type="button"
                      key={dir.path}
                      className="flex w-full min-w-0 items-center gap-2 rounded-xs px-2 py-1.5 text-left text-sm hover:bg-(--bg-key)"
                      onClick={() => void loadBrowser(dir.path)}
                    >
                      <Folder size={14} className="shrink-0" />
                      <span className="min-w-0 truncate">{dir.name}</span>
                    </button>
                  ))}
                </div>
                {error && <p className="text-xs text-(--color-error)">{error}</p>}
              </div>
              <DialogFooter>
                <Button type="button" variant="default" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button variant="primary" type="button" disabled={!browserPath || loading} onClick={openSelectedFolder}>Open this folder</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* A workspace's long-press menu on a phone: a sheet from the bottom
          edge, like the session one below. */}
      <BottomSheet
        open={mobileWorkspaceActions !== null}
        onClose={() => setMobileWorkspaceActions(null)}
        label={mobileWorkspaceActionsTitle}
      >
        <div className="px-4 pb-1">
          <p className="text-sm font-medium text-(--color-text) [overflow-wrap:anywhere]">{mobileWorkspaceActionsTitle}</p>
          <p className="text-xs text-(--color-text-muted)">
            {mobileWorkspaceActions?.kind === 'chat'
              ? 'Choose a chat action.'
              : 'Choose a main workspace action.'}
          </p>
        </div>
        <div className="flex flex-col px-2 pb-3">
            <button
              type="button"
              className={SHEET_ROW_CLASS}
              onClick={() => {
                const action = mobileWorkspaceActions
                setMobileWorkspaceActions(null)
                if (action) newSessionIn(action.sessionPath)
              }}
            >
              <Plus size={16} aria-hidden="true" />
              New session
            </button>
            {/* Chat's root is the home directory — the path is noise there,
                and there is no repository to act on. */}
            {mobileWorkspaceActions?.kind !== 'chat' && (
              <button
                type="button"
                className={SHEET_ROW_CLASS}
                onClick={() => {
                  const action = mobileWorkspaceActions
                  setMobileWorkspaceActions(null)
                  if (action) void navigator.clipboard.writeText(action.path)
                }}
              >
                <Copy size={16} aria-hidden="true" />
                Copy path
              </button>
            )}
            {mobileWorkspaceActions?.kind === 'main' && (
              <>
                {workspaceByPath.get(mobileWorkspaceActions.path)?.missing && (
                  <button
                    type="button"
                    data-sidebar-locate=""
                    className={SHEET_ROW_CLASS}
                    onClick={() => {
                      const action = mobileWorkspaceActions
                      setMobileWorkspaceActions(null)
                      if (action) void openRelocate(action.path)
                    }}
                  >
                    <FolderSearch size={16} aria-hidden="true" />
                    Locate folder…
                  </button>
                )}
                <button
                  type="button"
                  className={SHEET_ROW_CLASS}
                  onClick={() => {
                    const action = mobileWorkspaceActions
                    setMobileWorkspaceActions(null)
                    if (action) void openWorktreeDialog(action.path)
                  }}
                >
                  <GitBranch size={16} aria-hidden="true" />
                  Create worktree…
                </button>
                <WorkspaceGroupToggles
                  workspace={mobileWorkspaceActions.path}
                  variant="sheet"
                  onManage={() => {
                    setMobileWorkspaceActions(null)
                    openSettings('workspaces')
                  }}
                />
                <button
                  type="button"
                  className={SHEET_ROW_CLASS}
                  onClick={() => {
                    const action = mobileWorkspaceActions
                    setMobileWorkspaceActions(null)
                    if (action) hideWorkspaceFromSidebar(action.path)
                  }}
                >
                  <span className="size-4 shrink-0" aria-hidden="true" />
                  Hide from sidebar
                </button>
              </>
            )}
        </div>
      </BottomSheet>

      <Dialog
        open={worktreeTarget !== null}
        onOpenChange={(open) => { if (!open) setWorktreeTarget(null) }}
      >
        <DialogContent size="lg">
          <form onSubmit={submitWorktree} className="space-y-3">
            <DialogHeader>
              <DialogTitle>Create worktree</DialogTitle>
              <DialogDescription>
                Isolated copy of {worktreeTarget ? workspaceLabel(worktreeTarget) : 'this workspace'}.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2.5">
              <div className="rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-1.5">
                <div className="mb-0.5 flex items-center gap-1.5 label-caps text-(--color-text-subtle)">
                  <Folder size={12} aria-hidden="true" />
                  Source workspace
                </div>
                {worktreeTarget ? (
                  <Tooltip className="min-w-0">
                    <TooltipTrigger
                      className="min-w-0"
                      render={<p className="truncate font-mono text-meta text-(--color-text-muted)">{worktreeTarget}</p>}
                    />
                    <TooltipContent>{worktreeTarget}</TooltipContent>
                  </Tooltip>
                ) : (
                  <p className="truncate font-mono text-meta text-(--color-text-muted)" />
                )}
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <label className="block space-y-1 text-xs font-medium text-(--color-text-2)">
                  <span>Worktree name</span>
                  <input
                    value={worktreeName}
                    onChange={(e) => setWorktreeName(e.target.value)}
                    placeholder="feature-login"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="min-h-9 w-full min-w-0 rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-1 font-mono text-xs text-(--color-text) outline-none transition-colors placeholder:text-(--color-text-muted) focus:outline-none focus:border-(--color-text-subtle) md:min-h-8 max-md:pointer-coarse:text-base"
                    maxLength={80}
                    autoFocus
                  />
                  <p className="text-xs md:text-meta font-normal text-(--color-text-muted)">Blank uses &quot;session&quot;.</p>
                </label>
                <label className="block space-y-1 text-xs font-medium text-(--color-text-2)">
                  <span>Branch</span>
                  <input
                    value={worktreeBranch}
                    onChange={(e) => setWorktreeBranch(e.target.value)}
                    placeholder="openagentd/feature-login"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="min-h-9 w-full min-w-0 rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-1 font-mono text-xs text-(--color-text) outline-none transition-colors placeholder:text-(--color-text-muted) focus:outline-none focus:border-(--color-text-subtle) md:min-h-8 max-md:pointer-coarse:text-base"
                    maxLength={255}
                  />
                  <p className="text-xs md:text-meta font-normal text-(--color-text-muted)">Blank defaults to openagentd/name.</p>
                </label>
              </div>
              <div className="rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-2 text-xs text-(--color-text-muted)">
                <div className="mb-1 flex items-center justify-between gap-2">
                    <p className="font-medium text-(--color-text-2)">Existing worktrees</p>
                    <Chip mono>{worktreeOptions.length}</Chip>
                </div>
                {worktreeOptions.length === 0 ? (
                    <EmptyState compact icon={GitBranch} title="No worktrees yet" className="py-1" />
                ) : (
                  <ul className="max-h-32 space-y-0.5 overflow-y-auto pr-1">
                      {worktreeOptions.map((item) => (
                        <li key={item.directory} className="group flex min-w-0 items-center gap-2 rounded-xs px-2 py-1 hover:bg-(--bg-key)">
                          <GitBranch size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
                          <Tooltip className="min-w-0 flex-1">
                            <TooltipTrigger
                              className="min-w-0 flex-1"
                              render={
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-(--color-text-2)">{item.name}</p>
                                  {item.branch && <p className="truncate text-meta text-(--color-text-subtle)">{item.branch}</p>}
                                </div>
                              }
                            />
                            <TooltipContent>{item.directory}</TooltipContent>
                          </Tooltip>
                          {item.managed ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => setRemoveWorktreeTarget(item)}
                                    disabled={worktreeRemoving === item.directory}
                                    aria-label={`Delete worktree ${item.name}…`}
                                  >
                                    {worktreeRemoving === item.directory ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Trash2 className="size-3" aria-hidden="true" />}
                                  </Button>
                                }
                              />
                              <TooltipContent>Delete worktree…</TooltipContent>
                            </Tooltip>
                          ) : (
                            <Chip>external</Chip>
                          )}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
              {error && <p className="mt-2 text-xs text-(--color-error)">{error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="default" onClick={() => setWorktreeTarget(null)}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={worktreeLoading}>
                {worktreeLoading ? 'Creating…' : 'Create and open'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <RelocateWorkspaceDialog
        from={relocateTarget?.path ?? null}
        name={relocateTarget ? workspaceByPath.get(relocateTarget.path)?.name : undefined}
        pickFolder={relocateTarget?.native ? pickWorkspaceDirectory : null}
        onClose={() => setRelocateTarget(null)}
        onRelocated={handleRelocated}
      />

      {desktopWorkspaceActions && (
        <ContextMenu
          at={desktopWorkspaceActions}
          label={`Actions for ${workspaceLabel(desktopWorkspaceActions.path)}`}
          onDismiss={() => setDesktopWorkspaceActions(null)}
          className="min-w-48"
        >
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM_CLASS}
              // ⌘N starts a session in the workspace on screen: the key and the
              // entry agree only for that one, so only its menu shows the key.
              aria-keyshortcuts={desktopWorkspaceActions.sessionPath === activeWorkspace ? newSessionKeys : undefined}
              onClick={() => {
                const action = desktopWorkspaceActions
                setDesktopWorkspaceActions(null)
                newSessionIn(action.sessionPath)
              }}
            >
              <Plus size={12} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">New session</span>
              {desktopWorkspaceActions.sessionPath === activeWorkspace && (
                <MenuShortcut>{shortcutLabel(APP_SHORTCUTS.newSession, os)}</MenuShortcut>
              )}
            </button>
            <ContextMenuSeparator />
            {workspaceByPath.get(desktopWorkspaceActions.path)?.missing && (
              <button
                type="button"
                role="menuitem"
                data-sidebar-locate=""
                className={CONTEXT_MENU_ITEM_CLASS}
                onClick={() => {
                  const action = desktopWorkspaceActions
                  setDesktopWorkspaceActions(null)
                  void openRelocate(action.path)
                }}
              >
                <FolderSearch size={12} aria-hidden="true" />
                Locate folder…
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM_CLASS}
              onClick={() => {
                const action = desktopWorkspaceActions
                setDesktopWorkspaceActions(null)
                void navigator.clipboard.writeText(action.path)
              }}
            >
              <Copy size={12} aria-hidden="true" />
              Copy path
            </button>
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM_CLASS}
              onClick={() => {
                const action = desktopWorkspaceActions
                setDesktopWorkspaceActions(null)
                void openWorktreeDialog(action.path)
              }}
            >
              <GitBranch size={12} aria-hidden="true" />
              Create worktree…
            </button>
            <WorkspaceGroupToggles
              workspace={desktopWorkspaceActions.path}
              variant="menu"
              onManage={() => {
                setDesktopWorkspaceActions(null)
                openSettings('workspaces')
              }}
            />
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM_CLASS}
              onClick={() => {
                const action = desktopWorkspaceActions
                setDesktopWorkspaceActions(null)
                hideWorkspaceFromSidebar(action.path)
              }}
            >
              <span className="size-3 shrink-0" aria-hidden="true" />
              Hide from sidebar
            </button>
        </ContextMenu>
      )}

      {checkoutMenu && checkoutMenuRepository && mobileLongPressActions && (
        // Touch: a sheet (mockup J8 8.4), names in sans, each row with its
        // session count and what runs there.
        <BottomSheet open onClose={() => setCheckoutMenu(null)} label={`Worktrees for ${workspaceLabel(checkoutMenu.repo)}`}>
          <div data-worktree-sheet="" className="flex flex-col px-2 pb-3">
            {[
              { path: null as string | null, name: 'Workspace and worktrees', counted: [...checkoutMenuRepository.worktrees.map((w) => w.path), checkoutMenu.repo] },
              { path: checkoutMenu.repo as string | null, name: 'Main workspace', counted: [checkoutMenu.repo] },
              ...checkoutMenuRepository.worktrees.map((w) => ({ path: w.path as string | null, name: w.name, counted: [w.path] })),
            ].map((row) => {
              const rowSessions = row.counted.flatMap((p) => sessionsByWorkspace.get(p) ?? [])
              const running = rowSessions.filter(sessionWorking).length
              const checked = checkoutMenuRepository.selected === row.path
              return (
                <button
                  key={row.path ?? 'all'}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => { selectCheckout(checkoutMenu.repo, row.path); setCheckoutMenu(null) }}
                  className={cn(ACTION_SHEET_ROW_CLASS, 'min-h-14 items-center')}
                >
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm text-(--color-text)">{row.name}</span>
                    <span className="block truncate text-meta text-(--color-text-muted)">
                      {`${rowSessions.length} ${rowSessions.length === 1 ? 'session' : 'sessions'}${running > 0 ? ` · ${running} running` : ''}`}
                    </span>
                  </span>
                  {checked && <Check size={16} aria-hidden="true" />}
                </button>
              )
            })}
            <div className="my-1 border-t border-(--color-border)" />
            <button
              type="button"
              className={ACTION_SHEET_ROW_CLASS}
              onClick={() => { const repo = checkoutMenu.repo; setCheckoutMenu(null); void openWorktreeDialog(repo) }}
            >
              <Plus size={16} aria-hidden="true" />
              Create worktree…
            </button>
            {checkoutMenuWorktree && (
              <button type="button" className={ACTION_SHEET_ROW_CLASS} onClick={() => { setCheckoutMenu(null); handleWorktreeEdit(checkoutMenuWorktree) }}>
                <Pencil size={16} aria-hidden="true" />
                {`Rename ${checkoutMenuWorktree.name}…`}
              </button>
            )}
            {checkoutMenuWorktree?.managed && (
              <button
                type="button"
                className={cn(ACTION_SHEET_ROW_CLASS, 'text-(--color-error)')}
                disabled={worktreeRemoving === checkoutMenuWorktree.directory}
                onClick={() => { setCheckoutMenu(null); setRemoveWorktreeTarget(checkoutMenuWorktree) }}
              >
                <Trash2 size={16} aria-hidden="true" />
                {`Delete worktree ${checkoutMenuWorktree.name}…`}
              </button>
            )}
          </div>
        </BottomSheet>
      )}
      {checkoutMenu && checkoutMenuRepository && !mobileLongPressActions && (
        <ContextMenu
          at={checkoutMenu}
          label={`Worktrees for ${workspaceLabel(checkoutMenu.repo)}`}
          onDismiss={() => setCheckoutMenu(null)}
          className="min-w-48 max-w-64"
        >
          <CheckoutMenuItem
            checked={checkoutMenuRepository.selected === null}
            onSelect={() => { selectCheckout(checkoutMenu.repo, null); setCheckoutMenu(null) }}
          >
            Workspace and worktrees
          </CheckoutMenuItem>
          <CheckoutMenuItem
            checked={checkoutMenuRepository.selected === checkoutMenu.repo}
            onSelect={() => { selectCheckout(checkoutMenu.repo, checkoutMenu.repo); setCheckoutMenu(null) }}
          >
            <Folder size={12} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
            Workspace
          </CheckoutMenuItem>
          {checkoutMenuRepository.worktrees.map((item) => (
            <CheckoutMenuItem
              key={item.path}
              checked={checkoutMenuRepository.selected === item.path}
              title={item.missing ? `Folder not found at ${item.path}` : undefined}
              onSelect={() => { selectCheckout(checkoutMenu.repo, item.path); setCheckoutMenu(null) }}
            >
              {item.kind === 'folder'
                ? <Folder size={12} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
                : <GitBranch size={12} className="shrink-0 text-(--accent-orange-text)" aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
              {item.missing
                ? <MissingBadge />
                : item.kind === 'folder'
                  ? <Chip>folder</Chip>
                  : !item.managed && <Chip>external</Chip>}
            </CheckoutMenuItem>
          ))}
          <ContextMenuSeparator />
          <button
            type="button"
            role="menuitem"
            className={CONTEXT_MENU_ITEM_CLASS}
            onClick={() => {
              const repo = checkoutMenu.repo
              setCheckoutMenu(null)
              void openWorktreeDialog(repo)
            }}
          >
            <Plus size={12} aria-hidden="true" />
            Create worktree…
          </button>
          {/* Worktree actions act on the selected worktree, which the chip
              names, so the menu never needs a second level. */}
          {checkoutMenuWorktree && (
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM_CLASS}
              onClick={() => {
                setCheckoutMenu(null)
                handleWorktreeEdit(checkoutMenuWorktree)
              }}
            >
              <Pencil size={12} aria-hidden="true" />
              {`Rename ${checkoutMenuWorktree.name}…`}
            </button>
          )}
          {checkoutMenuWorktree?.managed && (
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM_DANGER_CLASS}
              disabled={worktreeRemoving === checkoutMenuWorktree.directory}
              onClick={() => {
                setCheckoutMenu(null)
                setRemoveWorktreeTarget(checkoutMenuWorktree)
              }}
            >
              <Trash2 size={12} aria-hidden="true" />
              {`Delete worktree ${checkoutMenuWorktree.name}…`}
            </button>
          )}
          {checkoutMenuWorktree && !checkoutMenuWorktree.managed && (
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM_CLASS}
              onClick={() => {
                const target = checkoutMenuWorktree.directory
                selectCheckout(checkoutMenu.repo, null)
                setCheckoutMenu(null)
                hideCheckout(target)
              }}
            >
              <X size={12} aria-hidden="true" />
              {`Hide ${checkoutMenuWorktree.name} from sidebar`}
            </button>
          )}
        </ContextMenu>
      )}

      {desktopSessionActions && (
        <ContextMenu
          at={desktopSessionActions}
          label={`Actions for ${desktopSessionActions.session.title || 'Untitled'}`}
          onDismiss={() => setDesktopSessionActions(null)}
          className="min-w-44"
        >
          {sessionMenuActions(desktopSessionActions.session).map(({ id, label, icon: Icon, danger, separatorBefore, rowKey, run }) => (
            <Fragment key={id}>
              {separatorBefore && <ContextMenuSeparator />}
              <button
                type="button"
                role="menuitem"
                className={danger ? CONTEXT_MENU_ITEM_DANGER_CLASS : CONTEXT_MENU_ITEM_CLASS}
                aria-keyshortcuts={rowKey ? ROW_KEYS[rowKey].aria(os) : undefined}
                onClick={() => {
                  setDesktopSessionActions(null)
                  run()
                }}
              >
                <Icon size={12} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {rowKey && <MenuShortcut>{ROW_KEYS[rowKey].label(os)}</MenuShortcut>}
              </button>
            </Fragment>
          ))}
        </ContextMenu>
      )}

      {/* A phone's long-press menu is a sheet from the bottom edge (Android,
          and phone browsers); the iOS app shows the system action sheet
          instead (openMobileSessionActions). */}
      <ActionSheet
        open={mobileSessionActions !== null}
        onClose={() => setMobileSessionActions(null)}
        title={mobileSessionActions?.session.title || 'Untitled'}
        description="Choose a session action."
        items={mobileSessionActions ? sessionMenuActions(mobileSessionActions.session) : []}
      />

      <Dialog
        open={worktreeEditTarget !== null}
        onOpenChange={(open) => { if (!open) setWorktreeEditTarget(null) }}
      >
        <DialogContent size="xs" padding="compact">
          <form onSubmit={submitWorktreeTitle} className="space-y-3">
            <DialogHeader>
              <DialogTitle>Rename worktree</DialogTitle>
              {worktreeEditTarget?.directory ? (
                <Tooltip className="min-w-0">
                  <TooltipTrigger
                    className="min-w-0"
                    render={<DialogDescription className="max-w-full truncate text-xs leading-4">{workspaceLabel(worktreeEditTarget.directory)}</DialogDescription>}
                  />
                  <TooltipContent>{worktreeEditTarget.directory}</TooltipContent>
                </Tooltip>
              ) : (
                <DialogDescription className="max-w-full truncate text-xs leading-4">Rename this sidebar item.</DialogDescription>
              )}
            </DialogHeader>
            <div>
              <input
                ref={worktreeEditInputRef}
                value={worktreeEditTitle}
                onChange={(e) => setWorktreeEditTitle(e.target.value)}
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="min-h-9 w-full min-w-0 rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-1 text-xs text-(--color-text) outline-none transition-colors focus:outline-none focus:border-(--color-text-subtle) md:min-h-8 max-md:pointer-coarse:text-base"
                aria-label="Worktree title"
                maxLength={255}
              />
              {error && <p className="mt-2 text-xs text-(--color-error)">{error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="default" onClick={() => setWorktreeEditTarget(null)}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={!worktreeEditTitle.trim() || worktreeEditLoading}>
                {worktreeEditLoading ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <SidebarConfirmDialogs
        deleteTarget={deleteTarget}
        setDeleteTarget={setDeleteTarget}
        onConfirmSessionDelete={confirmSessionDelete}
        removeWorktreeTarget={removeWorktreeTarget}
        removeWorktreePreview={removeWorktreePreview}
        setRemoveWorktreeTarget={setRemoveWorktreeTarget}
        onConfirmRemoveWorktree={confirmRemoveWorktree}
      />
    </ResizableAside>
    </SidebarPageContext.Provider>
    </KeyLayerScope>
  )
}
