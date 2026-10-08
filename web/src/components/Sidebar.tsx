/**
 * Sidebar — flat workspace + session switcher for the app's one
 * screen. Mirrors the wireframe sidebar ``Q4zeZN`` in
 * ``.diagrams/OpenAgentd-ui.pen``:
 *
 *   • A "Workspaces" section header (VS Code view header) whose actions —
 *     Open folder…, Collapse all — stay reachable however long the list is.
 *   • Repositories and their sessions as 28 px rows, one level deep.
 *     Worktrees are not rows: a repository lists the sessions of every
 *     checkout (its own and each worktree's) as one list, worktree sessions
 *     tagged with the worktree's name, and a checkout chip on the row
 *     narrows it to one checkout and holds the worktree actions. Sessions
 *     page in with an explicit "Show more" row, so the sidebar has exactly
 *     one scroller.
 *   • Mobile drawer footer: ⚙ Settings · ❔ Help (command palette) · 🌙
 *     ThemeToggle. On desktop those live in the status bar.
 *
 * The 64 px icon rail from the previous design is gone — workspace
 * navigation now lives inline in a single column. ``activeWorkspace`` is
 * the workspace driving
 * the current chat; ``expandedWorkspaces`` is local UI state for which rows are
 * currently showing their sessions. Multiple workspaces can stay open
 * at once. Switching the active workspace auto-expands it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { isMenuKey, menuPointFor } from '@/lib/focus/item-keys'
import { PanelResizeHandle, ResizableAside, type LiveWidth } from '@/components/ResizableAside'
import { useViewportWidth } from '@/hooks/use-viewport-width'
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
  Check,
  ChevronRight,
  ChevronsDownUp,
  Copy,
  Folder,
  FolderPlus,
  GitBranch,
  HelpCircle,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { APP_EVENTS } from '@/lib/app-events'
import { SIDEBAR_FIND_SCOPE } from '@/lib/find-shortcut'
import { useDeleteSessionMutation, useSessionsQuery, useUpdateSessionTitleMutation } from '@/queries/useSessionsQuery'
import { isChatWorkspacePath, useChatWorkspace } from '@/queries/useChatWorkspace'
import { queryKeys } from '@/queries/keys'
import { getCodingWorkspaceTree, listWorktrees } from '@/api/client'
import { WORKSPACES_KEY, workspaceLabel } from '@/utils/workspace'
import { ThemeToggle } from './ThemeToggle'
import { HealthDot } from './HealthDot'
import { Button } from '@/components/ui/button'
import {
  CONTEXT_MENU_ITEM_CLASS,
  CONTEXT_MENU_ITEM_DANGER_CLASS,
  ContextMenu,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import type { CodingWorkspaceTreeRepository, SessionResponse, WorktreeInfo } from '@/api/types'
import { LongPressButton } from '@/components/ui/long-press-button'
import { WorkspaceSessionList } from './Sidebar/WorkspaceSessionList'
import { NeedsYouSection } from './Sidebar/NeedsYouSection'
import { ScheduledSection } from './Sidebar/ScheduledSection'
import { SidebarConfirmDialogs } from './Sidebar/ConfirmDialogs'
import {
  addExpandedPaths,
  buildWorktreeSourceByDirectory,
  groupSessionsByWorkspace,
  repositoryCheckouts,
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
  openWorkspaceSession,
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
import { EASINGS } from '@/lib/motion'

const WORKSPACE_TREE_STALE_MS = 30_000
const NO_REPOSITORIES: CodingWorkspaceTreeRepository[] = []

interface SidebarProps {
  currentSessionId?: string
  workspace?: string | null
  onCollapse?: () => void
  /** Bump this counter to programmatically open the workspace dialog
   *  (e.g. from a "no workspace attached" CTA). */
  openWorkspaceDialogKey?: number
  /** Open the command palette (footer help (?) button). */
  onCommandPalette?: () => void
  /** Desktop only: when true, the inline panel collapses to width=0. */
  desktopCollapsed?: boolean
  /** Mobile only: whether the overlay drawer is open. */
  mobileOpen?: boolean
  /** Mobile only: live edge-swipe drag offset (px) for finger-tracking. */
  mobileDragOffset?: number | null
  /** Mobile only: called when the drawer should close (backdrop tap, navigation). */
  onMobileClose?: () => void
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

/** One pick-one row of a repository's checkout menu. */
function CheckoutMenuItem({ checked, onSelect, children }: { checked: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
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
  onCollapse,
  openWorkspaceDialogKey = 0,
  onCommandPalette,
  desktopCollapsed = false,
  mobileOpen = false,
  mobileDragOffset = null,
  onMobileClose,
}: SidebarProps) {
  const isMobile = useIsMobile()
  const { isTauri, os } = usePlatform()
  const [nativeFolderPickerEnabled, setNativeFolderPickerEnabled] = useState(isTauri)
  const isTauriMobile = isTauri && (os === 'ios' || os === 'android')
  const mobileLongPressActions = isMobile && isTauriMobile && mobileOpen
  const prefersReducedMotion = useReducedMotion()
  // ``onCollapse`` is wired by AgentChatView's left-chrome hamburger.
  // We don't render an inline collapse toggle anymore — the topbar
   // hamburger and ⌘B/Ctrl+B own that surface.
  void onCollapse
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const pushToast = useToastStore((s) => s.push)
  const openSettings = useSettingsStore((s) => s.openSettings)
  const sessions = useSessionsQuery()
  const deleteSession = useDeleteSessionMutation()
  const updateSessionTitle = useUpdateSessionTitleMutation()

  const workspaceSessions = useMemo(
    () => (sessions.data?.pages.flatMap((page) => page.data) ?? []).filter((session) => session.workspace),
    [sessions.data],
  )
  // Indexed once per `workspaceSessions` change instead of re-filtering the full
  // session list for every workspace/worktree row on every render.
  const sessionsByWorkspace = useMemo(() => groupSessionsByWorkspace(workspaceSessions), [workspaceSessions])

  // Read straight from the shared query, so a refresh made anywhere (the
  // command palette's workspace switch, another window) shows here too.
  const { data: workspaceTreeData } = useQuery({
    queryKey: queryKeys.coding.tree(),
    queryFn: getCodingWorkspaceTree,
    staleTime: WORKSPACE_TREE_STALE_MS,
  })
  const workspaceTree = workspaceTreeData?.repositories ?? NO_REPOSITORIES
  const workspaceByPath = useMemo(
    () => new Map(workspaceTree.map((repo) => [repo.path, repo])),
    [workspaceTree],
  )
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
  // Repository path → the one checkout its list shows (its own path or a
  // worktree's). Absent means every checkout.
  const [checkoutFilter, setCheckoutFilter] = useState<Record<string, string>>({})
  const [checkoutMenu, setCheckoutMenu] = useState<{ repo: string; x: number; y: number } | null>(null)
  // Workspace pending removal — null when no confirmation is open. The
  // confirmation dialog reads this; ``confirmRemoveWorkspace`` commits.
  const [removeWorkspaceTarget, setRemoveWorkspaceTarget] = useState<string | null>(null)
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
  const [removeWorktreeTarget, setRemoveWorktreeTarget] = useState<WorktreeInfo | null>(null)

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

  const openSessionSearch = useCallback(() => {
    setSearchOpen(true)
    setSearchFocusKey((key) => key + 1)
  }, [])
  const closeSessionSearch = () => {
    setSearchOpen(false)
    searchButtonRef.current?.focus()
  }
  useEffect(() => {
    window.addEventListener(APP_EVENTS.searchSessions, openSessionSearch)
    return () => window.removeEventListener(APP_EVENTS.searchSessions, openSessionSearch)
  }, [openSessionSearch])

  const selectWorkspace = async (path: string, opts: { create?: boolean } = {}) => {
    const requestedCreate = opts.create === true
    setPendingWorkspace(path)
    try {
      const result = await openWorkspaceSession({
        path,
        requestedCreate,
        currentSessionId,
        currentWorkspace: workspace,
        queryClient,
        refreshWorkspaceTree,
        navigate,
      })
      if (result.skipped) {
        setPendingWorkspace(null)
      }
    } catch (err) {
      setPendingWorkspace(null)
      setError(err instanceof Error ? err.message : 'Unable to create session')
    }
  }

  // Remove a workspace (and its worktrees) from the sidebar. Sessions stay in
  // the backend — reopening the same folder later resurfaces them. Leaving a
  // removed active workspace for the empty / route happens inside
  // ``confirmWorkspaceRemoval``. Called from the confirmation dialog below.
  const confirmRemoveWorkspace = () => {
    const path = removeWorkspaceTarget
    if (!path) return
    setRemoveWorkspaceTarget(null)
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
  const sourceWorkspaces = [
    ...(chatWorkspace ? [chatWorkspace.path] : []),
    ...sourceWorkspacePaths(workspaceTree, deletedWorktreeSet).filter((path) => !isChatPath(path)),
  ]
  const activeWorktreeSource = activeWorkspace ? worktreeSourceByDirectory.get(activeWorkspace) : null

  // Width is persisted in the layout store and clamped against the window so
  // the chat and a side-by-side dock always keep their minimums.
  const viewportWidth = useViewportWidth()
  const storedSidebarWidth = useLayoutStore((s) => s.sidebarWidth)
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth)
  const commitSidebarWidth = useCallback((width: number) => setSidebarWidth(width), [setSidebarWidth])
  const resetSidebarWidth = useCallback(() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH), [setSidebarWidth])
  const sidebarResize = {
    width: clampSidebarWidth(storedSidebarWidth, viewportWidth),
    min: SIDEBAR_MIN_WIDTH,
    max: sidebarMaxWidth(viewportWidth),
    edge: 'right' as const,
    onCommit: commitSidebarWidth,
    onReset: resetSidebarWidth,
    disabled: isMobile || desktopCollapsed,
    label: 'Resize sidebar',
  }
  const sidebarMotion = ({ width, isResizing }: LiveWidth) => ({
    animate: isMobile
      ? { x: mobileDragOffset ?? (mobileOpen ? 0 : -280), width: 'min(272px, calc(100vw - 2rem))' }
      : { width: desktopCollapsed ? 0 : width },
    transition: mobileDragOffset !== null
      ? { duration: 0 }
      : { duration: isResizing || prefersReducedMotion ? 0.01 : 0.22, ease: EASINGS.inOut },
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
    void selectWorkspace(nextState.workspaceToOpen)
  }

  const handleSessionSelect = (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => {
    if (event && shouldOpenSessionInNewWindow(event, isTauri, os)) {
      event.preventDefault()
      event.stopPropagation()
      openSessionInNewWindow({ session }).catch((err) => {
        console.error('Failed to open session in new window:', err)
        pushToast({
          tone: 'error',
          title: 'Could not open session in new window',
          description: sessionWindowErrorDescription(err, 'Desktop window creation failed.'),
        })
      })
      return
    }

    applySessionSelection({
      session,
      workspacePath,
      navigate,
      onMobileClose,
    })
  }

  const handleSessionDelete = (e: React.SyntheticEvent, session: SessionResponse) => {
    e.stopPropagation()
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

  const confirmSessionDelete = () => {
    if (!deleteTarget) return
    applySessionDelete({
      deleteTarget,
      currentSessionId,
      workspaceSessions,
      mutateDelete: deleteSession.mutate,
      navigate,
    })
    setDeleteTarget(null)
  }

  return (
    <>
      {/* Mobile backdrop — closes the drawer on tap. Fades with the drag. */}
      <AnimatePresence>
        {isMobile && (mobileOpen || mobileDragOffset !== null) && (
          <motion.div
            key="sidebar-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: mobileDragOffset !== null ? Math.max(0, Math.min(1, 1 + mobileDragOffset / 280)) : 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: mobileDragOffset !== null ? 0 : (prefersReducedMotion ? 0.01 : 0.2) }}
            className="mobile-safe-top fixed inset-x-0 bottom-0 z-30 bg-(--color-overlay) md:hidden"
            aria-hidden="true"
            onClick={onMobileClose}
          />
        )}
      </AnimatePresence>

    <ResizableAside
      {...SIDEBAR_FIND_SCOPE}
      initial={false}
      resize={sidebarResize}
      getMotion={sidebarMotion}
      // Collapsed (desktop) or closed (mobile), the sidebar is off screen
      // but still in the DOM: keep Tab and screen readers out of it.
      inert={isMobile ? !mobileOpen && mobileDragOffset === null : desktopCollapsed}
      className={
        isMobile
          ? 'mobile-safe-top fixed bottom-0 left-0 z-40 flex w-[min(272px,calc(100vw-2rem))] shrink-0 flex-col overflow-hidden border-r border-(--color-border) bg-(--bg-page) shadow-(--shadow-depth) dark:bg-(--bg-sidebar)'
          : 'relative flex shrink-0 flex-col overflow-hidden border-r border-(--color-border) bg-(--bg-page) dark:bg-(--bg-sidebar)'
      }
    >
      {!isMobile && !desktopCollapsed && <PanelResizeHandle edge="right" />}

      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={(event) => {
          // Left on a session row climbs to its workspace, like a tree.
          if (event.defaultPrevented || event.key !== 'ArrowLeft' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          const target = event.target as HTMLElement
          if (!target.closest('[data-sidebar-session]')) return
          const header = target.closest('[data-sidebar-workspace-group]')?.querySelector<HTMLElement>('[data-sidebar-workspace]')
          if (!header) return
          event.preventDefault()
          header.focus()
        }}
      >
      <NeedsYouSection
        currentSessionId={currentSessionId}
        workspaceName={(path) => (isChatPath(path) ? (chatWorkspace?.name ?? path) : workspaceLabel(path))}
        onSessionSelect={handleSessionSelect}
      />

      {/* Section header — actions stay reachable however long the list is. */}
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 pl-3 pr-1.5">
        <span className="truncate label-caps leading-none text-(--color-text-subtle)">
          Workspaces
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  ref={searchButtonRef}
                  type="button"
                  onClick={() => { if (searchOpen) closeSessionSearch(); else openSessionSearch() }}
                  className={`flex h-8 w-8 items-center justify-center rounded-xs transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-6 md:w-6 ${
                    searchOpen ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-muted)'
                  }`}
                  aria-label="Search sessions"
                  aria-pressed={searchOpen}
                >
                  <Search size={13} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent>{`Search sessions (${shortcutLabel(APP_SHORTCUTS.findInTranscript, os)} in the sidebar)`}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={collapseAllWorkspaces}
                  className="flex h-8 w-8 items-center justify-center rounded-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-6 md:w-6"
                  aria-label="Collapse all workspaces"
                >
                  <ChevronsDownUp size={13} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent>Collapse all</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => { void openWorkspaceDialog() }}
                  className="flex h-8 w-8 items-center justify-center rounded-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-6 md:w-6"
                  aria-label="Open folder"
                >
                  <FolderPlus size={13} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent>Open folder…</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {searchOpen ? (
        <SessionSearch
          currentSessionId={currentSessionId}
          focusKey={searchFocusKey}
          workspaceName={(path) => (isChatPath(path) ? (chatWorkspace?.name ?? path) : workspaceLabel(path))}
          onSessionSelect={(session, workspacePath, event) => {
            setSearchOpen(false)
            handleSessionSelect(session, workspacePath, event)
          }}
          onClose={closeSessionSearch}
        />
      ) : (
      /* Workspace + sessions tree */
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-2">
        {visibleWorkspaces.length === 0 && (
          <div className="flex flex-col items-start gap-2 px-3 py-3">
            <p className="text-xs text-(--color-text-subtle)">No workspaces yet.</p>
            <Button type="button" size="sm" onClick={() => { void openWorkspaceDialog() }}>
              <FolderPlus size={13} aria-hidden="true" />
              Open folder…
            </Button>
          </div>
        )}

        {sourceWorkspaces.map((path) => {
          // Chat is pinned and not a repository: no worktrees, no rename, no
          // removal — only the expand toggle and "New session" apply.
          const sourceIsChat = isChatPath(path)
          const sourceLabel = sourceIsChat ? (chatWorkspace?.name ?? path) : workspaceLabel(path)
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
            .filter((s) => s.running === true)
            .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
          const sourceHasRunningSession = sourceRunningSessions.length > 0
          const checkoutLabel = selectedWorktree?.name ?? (checkouts.selected ? 'main worktree' : 'all')

          return (
            <div key={path} className="relative" data-sidebar-workspace-group="">
              <div className="group mx-1.5 flex h-(--spacing-list-row) items-center rounded-sm hover:bg-(--bg-key)/40">
                <Tooltip className="min-w-0 flex-1">
                  <TooltipTrigger
                    className="min-w-0 flex-1"
                    render={
                      <LongPressButton
                        enabled={mobileLongPressActions}
                        // Chat gets the sheet too, just a narrower one: on
                        // touch the inline "+" is hidden, so this is the only
                        // way left to start a new chat session.
                        onLongPress={() => setMobileWorkspaceActions({ path, sessionPath: sessionTarget, kind: sourceIsChat ? 'chat' : 'main' })}
                        type="button"
                        data-sidebar-workspace=""
                        onClick={() => toggleWorkspaceExpanded(path)}
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
                        className="flex h-full min-w-0 flex-1 items-center gap-1.5 truncate rounded-sm px-1.5 text-left text-xs"
                        aria-expanded={sourceIsExpanded}
                        aria-label={`${sourceIsExpanded ? 'Collapse' : 'Expand'} ${sourceIsChat ? 'chat workspace' : 'repository'} ${sourceLabel}`}
                      >
                        <ChevronRight size={11} className={`shrink-0 text-(--color-text-subtle) transition-transform duration-(--motion-fast) ${sourceIsExpanded ? 'rotate-90' : ''}`} aria-hidden="true" />
                        {sourceIsChat ? (
                          <MessageCircle size={11} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
                        ) : (
                          <Folder size={11} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
                        )}
                        <span className={`truncate font-mono ${sourceIsActive ? 'font-semibold text-(--color-text)' : 'text-(--color-text-2) group-hover:text-(--color-text)'}`}>
                          {sourceLabel}
                        </span>
                        {sourceIsPending && (
                          <span>
                            <Loader2 size={11} className="shrink-0 animate-spin text-(--color-text-muted)" aria-hidden="true" />
                          </span>
                        )}
                      </LongPressButton>
                    }
                  />
                  <TooltipContent>{sourceIsChat ? 'Chat workspace' : path}</TooltipContent>
                </Tooltip>
                {worktrees.length > 0 && (
                  // Always visible and always compact (icon + worktree count),
                  // so the repository name keeps the row; a filter shows as
                  // the chip's fill and as a row atop the list.
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect()
                            setCheckoutMenu({ repo: path, x: rect.left, y: rect.bottom + 4 })
                          }}
                          className={`ml-1 inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 font-mono text-[11px] leading-4 transition-colors pointer-coarse:h-9 pointer-coarse:px-2.5 ${
                            checkouts.selected
                              ? 'bg-(--bg-key) text-(--color-text)'
                              : 'text-(--color-text-subtle) hover:bg-(--bg-key) hover:text-(--color-text-2)'
                          }`}
                          aria-haspopup="menu"
                          aria-expanded={checkoutMenu?.repo === path}
                          aria-label={`Checkouts in ${sourceLabel}: ${checkoutLabel}`}
                        >
                          {worktreeIsRemoving
                            ? <Loader2 size={11} className="shrink-0 animate-spin" aria-hidden="true" />
                            : <GitBranch size={11} className="shrink-0 text-(--accent-orange-text)" aria-hidden="true" />}
                          <span className="tabular-nums">{worktrees.length}</span>
                        </button>
                      }
                    />
                    <TooltipContent>
                      {checkouts.selected
                        ? `Showing ${selectedWorktree?.name ?? 'the main worktree'} only · change checkout`
                        : `All checkouts · ${worktrees.length} worktree${worktrees.length === 1 ? '' : 's'}`}
                    </TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => { void selectWorkspace(sessionTarget, { create: true }) }}
                        // On touch the actions are always shown, so the outline
                        // would box every row; the bare glyph matches the
                        // neighbouring row actions there.
                        className={`ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-xs border border-(--color-border) text-(--color-text-muted) transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) pointer-coarse:size-9 pointer-coarse:border-transparent ${mobileLongPressActions ? 'hidden' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100'}`}
                        aria-label={selectedWorktree ? `New session in worktree ${selectedWorktree.name}` : `New session in ${sourceLabel}`}
                      >
                        <Plus size={11} aria-hidden="true" />
                      </button>
                    }
                  />
                  <TooltipContent>{selectedWorktree ? `New session in ${selectedWorktree.name}` : 'New session'}</TooltipContent>
                </Tooltip>
                {sourceIsChat ? (
                  // Chat has no actions menu; hold its slot so the + lines up
                  // with every other workspace row.
                  !mobileLongPressActions && <span aria-hidden="true" className="mr-1 w-6 shrink-0 pointer-coarse:w-9" />
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          onClick={(event) => setDesktopWorkspaceActions({ path, sessionPath: sessionTarget, x: event.clientX, y: event.clientY })}
                          className={`mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-xs text-(--color-text-subtle) transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) pointer-coarse:size-9 ${mobileLongPressActions ? 'hidden' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100'}`}
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

              {(sourceIsExpanded || sourceHasRunningSession) && (
                // One level: every checkout's sessions hang off a single
                // guide under the chevron, status marks under the folder.
                <div className="ml-[17px] mr-1.5 border-l border-(--color-border-subtle) pb-1 pl-1">
                  {checkouts.selected && sourceIsExpanded && (
                    // The active filter, named where its sessions are, with
                    // a one-step way back to every checkout.
                    <div className="flex h-6 items-center gap-1.5 px-1.5 text-[11px] text-(--color-text-subtle) pointer-coarse:h-9">
                      <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
                        {selectedWorktree
                          ? <GitBranch size={11} className="text-(--accent-orange-text)" />
                          : <Folder size={11} className="text-(--color-accent)" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-(--color-text-2)">
                        {selectedWorktree?.name ?? 'main worktree'}
                      </span>
                      <button
                        type="button"
                        onClick={() => selectCheckout(path, null)}
                        className="shrink-0 rounded-xs px-1 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) pointer-coarse:h-9 pointer-coarse:px-2.5"
                        aria-label={`Show all checkouts in ${sourceLabel}`}
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
                    mobileLongPressActions={mobileLongPressActions}
                    onSessionSelect={handleSessionSelect}
                    onSessionDelete={handleSessionDelete}
                    onSessionEdit={handleSessionEdit}
                    editingSessionId={editingSessionId}
                    onSessionRename={handleSessionRename}
                    onSessionRenameCancel={() => setEditingSessionId(null)}
                    onSessionLongPress={(session) => setMobileSessionActions({ session, workspacePath: session.workspace || path })}
                    onSessionContextActions={(session, event) => {
                      setDesktopSessionActions({ session, workspacePath: session.workspace || path, x: event.clientX, y: event.clientY })
                    }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
      )}

      <ScheduledSection onMobileClose={onMobileClose} />
      </div>

      {/* Mobile drawer footer — on desktop this lives in AppFooter status bar */}
      <div className="flex md:hidden items-center justify-between gap-2 border-t border-(--color-border) px-3 py-2 pb-safe">
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => { openSettings(); onMobileClose?.() }}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                  aria-label="Settings"
                >
                  <Settings size={14} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent>{`Settings (${shortcutLabel(APP_SHORTCUTS.settings, os)})`}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => { openTelemetry(); onMobileClose?.() }}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                  aria-label="Telemetry"
                >
                  <Activity size={14} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent>Telemetry</TooltipContent>
          </Tooltip>
          {onCommandPalette && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => {
                      onCommandPalette()
                      onMobileClose?.()
                    }}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                    aria-label="Help and shortcuts"
                  >
                    <HelpCircle size={14} aria-hidden="true" />
                  </button>
                }
              />
              <TooltipContent>{`Help and shortcuts (${shortcutLabel(APP_SHORTCUTS.commandPalette, os)})`}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-2">
          <HealthDot labeled className="h-9 max-w-24" />
          <ThemeToggle collapsed />
        </div>
      </div>

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
                  Use the desktop folder picker to choose a local project folder.
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
                <DialogDescription>Choose a server-local project folder.</DialogDescription>
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
                    <p className="px-2 py-4 text-center text-xs text-(--color-text-subtle)">Loading folders…</p>
                  )}
                  {!loading && dirs.length === 0 && (
                    <p className="px-2 py-4 text-center text-xs text-(--color-text-subtle)">No folders here</p>
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

      <Dialog
        open={mobileWorkspaceActions !== null}
        onOpenChange={(open) => { if (!open) setMobileWorkspaceActions(null) }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mobileWorkspaceActions?.kind === 'chat'
                ? (chatWorkspace?.name ?? 'Chat')
                : mobileWorkspaceActions
                  ? workspaceLabel(mobileWorkspaceActions.path)
                  : 'Workspace actions'}
            </DialogTitle>
            <DialogDescription>
              {mobileWorkspaceActions?.kind === 'chat'
                ? 'Choose a chat action.'
                : 'Choose a main workspace action.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                const action = mobileWorkspaceActions
                setMobileWorkspaceActions(null)
                if (action) void selectWorkspace(action.sessionPath, { create: true })
              }}
            >
              <Plus size={14} aria-hidden="true" />
              New session
            </Button>
            {/* Chat's root is the home directory — the path is noise there,
                and there is no repository to act on. */}
            {mobileWorkspaceActions?.kind !== 'chat' && (
              <Button
                type="button"
                variant="ghost"
                className="justify-start"
                onClick={() => {
                  const action = mobileWorkspaceActions
                  setMobileWorkspaceActions(null)
                  if (action) void navigator.clipboard.writeText(action.path)
                }}
              >
                <Copy size={14} aria-hidden="true" />
                Copy repo absolute path
              </Button>
            )}
            {mobileWorkspaceActions?.kind === 'main' && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  className="justify-start"
                  onClick={() => {
                    const action = mobileWorkspaceActions
                    setMobileWorkspaceActions(null)
                    if (action) void openWorktreeDialog(action.path)
                  }}
                >
                  <GitBranch size={14} aria-hidden="true" />
                  Create worktree
                </Button>
                <Button
                  type="button"
                  variant="danger-subtle"
                  className="justify-start"
                  onClick={() => {
                    const action = mobileWorkspaceActions
                    setMobileWorkspaceActions(null)
                    if (action) setRemoveWorkspaceTarget(action.path)
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  Remove from sidebar
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={worktreeTarget !== null}
        onOpenChange={(open) => { if (!open) setWorktreeTarget(null) }}
      >
        <DialogContent showCloseButton={false} size="none" padding="none" className="flex max-h-[min(86dvh,520px)] w-[calc(100vw-1.5rem)] max-w-md flex-col overflow-hidden sm:w-[min(560px,calc(100vw-2rem))] sm:max-w-none">
          <form onSubmit={submitWorktree} className="flex h-full min-h-0 flex-col">
            <DialogHeader className="shrink-0 gap-0 border-b border-(--color-border) bg-(--bg-page) px-3 py-2.5 sm:px-4">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <DialogTitle>Create worktree</DialogTitle>
                  <DialogDescription className="mt-0.5 text-xs leading-4 text-(--color-text-muted)">
                    Isolated checkout from {worktreeTarget ? workspaceLabel(worktreeTarget) : 'this workspace'}.
                  </DialogDescription>
                </div>
                <button
                  type="button"
                  onClick={() => setWorktreeTarget(null)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7"
                  aria-label="Close create worktree dialog"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            </DialogHeader>
            <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3 sm:px-4">
              <div className="rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-1.5">
                <div className="mb-0.5 flex items-center gap-1.5 label-caps text-(--color-text-subtle)">
                  <Folder size={12} aria-hidden="true" />
                  Source workspace
                </div>
                {worktreeTarget ? (
                  <Tooltip className="min-w-0">
                    <TooltipTrigger
                      className="min-w-0"
                      render={<p className="truncate font-mono text-[11px] text-(--color-text-muted)">{worktreeTarget}</p>}
                    />
                    <TooltipContent>{worktreeTarget}</TooltipContent>
                  </Tooltip>
                ) : (
                  <p className="truncate font-mono text-[11px] text-(--color-text-muted)" />
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
                    className="min-h-9 w-full min-w-0 rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-1 font-mono text-sm text-(--color-text) outline-none transition-colors placeholder:text-(--color-text-subtle) focus:outline-none focus-visible:outline-none focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 md:min-h-8"
                    maxLength={80}
                    autoFocus
                  />
                  <p className="text-xs md:text-[11px] font-normal text-(--color-text-subtle)">Blank uses “session”.</p>
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
                    className="min-h-9 w-full min-w-0 rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-1 font-mono text-sm text-(--color-text) outline-none transition-colors placeholder:text-(--color-text-subtle) focus:outline-none focus-visible:outline-none focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 md:min-h-8"
                    maxLength={255}
                  />
                  <p className="text-xs md:text-[11px] font-normal text-(--color-text-subtle)">Blank defaults to openagentd/name.</p>
                </label>
              </div>
              <div className="rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-2 text-xs text-(--color-text-muted)">
                <div className="mb-1 flex items-center justify-between gap-2">
                    <p className="font-medium text-(--color-text-2)">Existing worktrees</p>
                    <span className="rounded-full bg-(--bg-key) px-2 py-0.5 text-xs md:text-[11px] text-(--color-text-subtle)">{worktreeOptions.length}</span>
                </div>
                {worktreeOptions.length === 0 ? (
                    <p className="py-1 text-(--color-text-subtle)">No worktrees yet.</p>
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
                                  {item.branch && <p className="truncate text-[11px] text-(--color-text-subtle)">{item.branch}</p>}
                                </div>
                              }
                            />
                            <TooltipContent>{item.directory}</TooltipContent>
                          </Tooltip>
                          {item.managed ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    onClick={() => setRemoveWorktreeTarget(item)}
                                    disabled={worktreeRemoving === item.directory}
                                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xs text-(--color-text-subtle) opacity-100 transition-colors hover:bg-(--color-error-subtle) hover:text-(--color-error) disabled:opacity-50 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                                    aria-label={`Remove worktree ${item.name}`}
                                  >
                                    {worktreeRemoving === item.directory ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Trash2 size={12} aria-hidden="true" />}
                                  </button>
                                }
                              />
                              <TooltipContent>Remove managed worktree</TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="rounded-full bg-(--bg-key) px-2 py-0.5 text-xs md:text-[11px] text-(--color-text-subtle)">external</span>
                          )}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
              {error && <p className="mt-2 text-xs text-(--color-error)">{error}</p>}
            </div>
            <DialogFooter className="mx-0 mb-0 shrink-0 flex-row justify-end gap-2 rounded-none border-t border-(--color-border) bg-(--bg-page) px-3 py-2.5 sm:px-4">
              <Button type="button" variant="default" onClick={() => setWorktreeTarget(null)}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={worktreeLoading}>
                {worktreeLoading ? 'Creating…' : 'Create and open'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
              onClick={() => {
                const action = desktopWorkspaceActions
                setDesktopWorkspaceActions(null)
                void selectWorkspace(action.sessionPath, { create: true })
              }}
            >
              <Plus size={12} aria-hidden="true" />
              New session
            </button>
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
              Copy repo absolute path
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
              Create worktree
            </button>
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM_DANGER_CLASS}
              onClick={() => {
                const action = desktopWorkspaceActions
                setDesktopWorkspaceActions(null)
                setRemoveWorkspaceTarget(action.path)
              }}
            >
              <Trash2 size={12} aria-hidden="true" />
              Remove from sidebar
            </button>
        </ContextMenu>
      )}

      {checkoutMenu && checkoutMenuRepository && (
        <ContextMenu
          at={checkoutMenu}
          label={`Checkouts in ${workspaceLabel(checkoutMenu.repo)}`}
          onDismiss={() => setCheckoutMenu(null)}
          className="min-w-48 max-w-64"
        >
          <CheckoutMenuItem
            checked={checkoutMenuRepository.selected === null}
            onSelect={() => { selectCheckout(checkoutMenu.repo, null); setCheckoutMenu(null) }}
          >
            All checkouts
          </CheckoutMenuItem>
          <CheckoutMenuItem
            checked={checkoutMenuRepository.selected === checkoutMenu.repo}
            onSelect={() => { selectCheckout(checkoutMenu.repo, checkoutMenu.repo); setCheckoutMenu(null) }}
          >
            <Folder size={12} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
            Main worktree
          </CheckoutMenuItem>
          {checkoutMenuRepository.worktrees.map((item) => (
            <CheckoutMenuItem
              key={item.path}
              checked={checkoutMenuRepository.selected === item.path}
              onSelect={() => { selectCheckout(checkoutMenu.repo, item.path); setCheckoutMenu(null) }}
            >
              <GitBranch size={12} className="shrink-0 text-(--accent-orange-text)" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
              {!item.managed && <span className="shrink-0 rounded-full bg-(--bg-key) px-1.5 text-[11px] leading-4 text-(--color-text-subtle)">external</span>}
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
            New worktree…
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
              {`Remove ${checkoutMenuWorktree.name}…`}
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
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM_CLASS}
              onClick={() => {
                const { session } = desktopSessionActions
                setDesktopSessionActions(null)
                handleSessionEdit(session)
              }}
            >
              <Pencil size={12} aria-hidden="true" />
              Edit title
            </button>
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM_DANGER_CLASS}
              onClick={() => {
                const { session } = desktopSessionActions
                setDesktopSessionActions(null)
                setDeleteTarget(session)
              }}
            >
              <Trash2 size={12} aria-hidden="true" />
              Delete session
            </button>
        </ContextMenu>
      )}

      <Dialog
        open={mobileSessionActions !== null}
        onOpenChange={(open) => { if (!open) setMobileSessionActions(null) }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mobileSessionActions?.session.title || 'Untitled'}</DialogTitle>
            <DialogDescription>Choose a session action.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                const action = mobileSessionActions
                setMobileSessionActions(null)
                if (action?.session) handleSessionEdit(action.session)
              }}
            >
              <Pencil size={14} aria-hidden="true" />
              Edit title
            </Button>
            <Button
              type="button"
              variant="danger-subtle"
              className="justify-start"
              onClick={() => {
                const action = mobileSessionActions
                setMobileSessionActions(null)
                if (action?.session) setDeleteTarget(action.session)
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
              Delete session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={worktreeEditTarget !== null}
        onOpenChange={(open) => { if (!open) setWorktreeEditTarget(null) }}
      >
        <DialogContent size="xs" padding="compact" className="gap-3">
          <form onSubmit={submitWorktreeTitle} className="space-y-3">
            <DialogHeader className="gap-1 pr-8">
              <DialogTitle>Edit worktree title</DialogTitle>
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
                className="min-h-9 w-full min-w-0 rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-1 text-sm text-(--color-text) outline-none focus:outline-none focus-visible:outline-none focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 md:min-h-8"
                aria-label="Worktree title"
                maxLength={255}
              />
              {error && <p className="mt-2 text-xs text-(--color-error)">{error}</p>}
            </div>
            <DialogFooter className="-mx-3 -mb-3 p-3">
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
        removeWorkspaceTarget={removeWorkspaceTarget}
        setRemoveWorkspaceTarget={setRemoveWorkspaceTarget}
        onConfirmRemoveWorkspace={confirmRemoveWorkspace}
        removeWorktreeTarget={removeWorktreeTarget}
        setRemoveWorktreeTarget={setRemoveWorktreeTarget}
        onConfirmRemoveWorktree={confirmRemoveWorktree}
      />
    </ResizableAside>
    </>
  )
}
