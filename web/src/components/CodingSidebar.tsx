/**
 * CodingSidebar — flat workspace + session switcher for the ``/coding``
 * route. Mirrors the wireframe sidebar ``Q4zeZN`` in
 * ``.diagrams/OpenAgentd-ui.pen``:
 *
 *   • Search input at the top — opens the command palette (⌘P / Ctrl+P).
 *   • Flat list of repositories, worktrees, and their coding sessions.
 *     Worktree/session grouping is shown with icons, counts, and spacing
 *     rather than file-tree indentation.
 *   • ``+ Open folder…`` row at the bottom of the workspace list
 *     surfaces the trusted-workspace dialog.
 *   • Footer trio: ⚙ Settings · ❔ Help (palette) · 🌙 ThemeToggle.
 *
 * The 64 px icon rail from the previous design is gone — workspace
 * navigation now lives inline so the sidebar matches the cockpit's
 * single-column shape. ``activeWorkspace`` is the workspace driving
 * the current chat; ``expandedWorkspaces`` is local UI state for which rows are
 * currently showing their sessions. Multiple workspaces can stay open
 * at once. Switching the active workspace auto-expands it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { formatShortcut } from '@/lib/keyboard-shortcut'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import {
  ChevronRight,
  Copy,
  Folder,
  GitBranch,
  HelpCircle,
  Home,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { useDeleteTeamSessionMutation, useTeamSessionsQuery, useUpdateTeamSessionTitleMutation } from '@/queries/useSessionsQuery'
import { queryKeys } from '@/queries/keys'
import { getCodingWorkspaceTree, listWorktrees } from '@/api/client'
import { workspaceLabel } from '@/utils/workspace'
import { ThemeToggle } from './ThemeToggle'
import { HealthDot } from './HealthDot'
import { Button } from '@/components/ui/button'
import { useToastStore } from '@/stores/useToastStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
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
import { WorkspaceSessionList } from './CodingSidebar/WorkspaceSessionList'
import { CodingSidebarConfirmDialogs } from './CodingSidebar/ConfirmDialogs'
import {
  addExpandedPaths,
  buildWorktreeSourceByDirectory,
  sourceWorkspacePaths,
  toggleExpandedPath,
  visibleNestedWorktrees,
} from './CodingSidebar.helpers'
import {
  loadWorkspaceBrowser,
  shouldUseServerWorkspaceBrowser,
  validateTrustedWorkspace,
} from './CodingSidebar.browser'
import {
  loadWorktreesForSource,
  recoverCreatedWorktreeAfterTransientError,
  removeManagedWorktree,
  submitWorktreeSession,
} from './CodingSidebar.worktrees'
import {
  applySessionDelete,
  applySessionSelection,
  prepareSessionTitleUpdate,
} from './CodingSidebar.sessions'
import {
  confirmWorkspaceRemoval,
  selectCodingWorkspace,
} from './CodingSidebar.workspace'
import {
  consumeTrustedWorkspace,
  selectTrustedWorkspace,
} from './CodingSidebar.trust'
import {
  beginWorktreeTitleEdit,
  buildOpenWorktreeDialogState,
  submitWorktreeRename,
} from './CodingSidebar.worktree-dialog'
import {
  openSessionInNewWindow,
  sessionWindowErrorDescription,
  shouldOpenSessionInNewWindow,
} from './CodingSidebar.window'

interface CodingSidebarProps {
  currentSessionId?: string
  workspace?: string | null
  onCollapse?: () => void
  /** Bump this counter to programmatically open the workspace dialog
   *  (e.g. from a "no workspace attached" CTA). */
  openWorkspaceDialogKey?: number
  /** Open the command palette (search input + footer help). */
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

export function CodingSidebar({
  currentSessionId,
  workspace,
  onCollapse,
  openWorkspaceDialogKey = 0,
  onCommandPalette,
  desktopCollapsed = false,
  mobileOpen = false,
  mobileDragOffset = null,
  onMobileClose,
}: CodingSidebarProps) {
  const isMobile = useIsMobile()
  const { isTauri, os } = usePlatform()
  const [nativeFolderPickerEnabled, setNativeFolderPickerEnabled] = useState(isTauri)
  const isTauriMobile = isTauri && (os === 'ios' || os === 'android')
  const mobileLongPressActions = isMobile && isTauriMobile && mobileOpen
  const prefersReducedMotion = useReducedMotion()
  // ``onCollapse`` is wired by TeamChatView's left-chrome hamburger.
  // We don't render an inline collapse toggle anymore — the topbar
   // hamburger and ⌘B/Ctrl+B own that surface.
  void onCollapse
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const pushToast = useToastStore((s) => s.push)
  const openSettings = useSettingsStore((s) => s.openSettings)
  const sessions = useTeamSessionsQuery('coding')
  const deleteSession = useDeleteTeamSessionMutation()
  const updateSessionTitle = useUpdateTeamSessionTitleMutation()

  const codingSessions = (sessions.data?.pages.flatMap((page) => page.data) ?? []).filter(
    (session) => session.workspace,
  )

  const [workspaceTree, setWorkspaceTree] = useState<CodingWorkspaceTreeRepository[]>(
    () => queryClient.getQueryData<{ repositories: CodingWorkspaceTreeRepository[] }>(queryKeys.coding.tree())?.repositories ?? [],
  )
  const visibleWorkspaces = workspaceTree.map((repo) => repo.path)
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
  const [editTarget, setEditTarget] = useState<SessionResponse | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const editTitleInputRef = useRef<HTMLInputElement>(null)
  const [worktreeEditTarget, setWorktreeEditTarget] = useState<WorktreeInfo | null>(null)
  const [worktreeEditTitle, setWorktreeEditTitle] = useState('')
  const [worktreeEditLoading, setWorktreeEditLoading] = useState(false)
  const worktreeEditInputRef = useRef<HTMLInputElement>(null)
  const [deleteTarget, setDeleteTarget] = useState<SessionResponse | null>(null)
  const [mobileSessionActions, setMobileSessionActions] = useState<{ session: SessionResponse; workspacePath: string } | null>(null)
  const [desktopSessionActions, setDesktopSessionActions] = useState<{ session: SessionResponse; workspacePath: string; x: number; y: number } | null>(null)
  const [desktopWorkspaceActions, setDesktopWorkspaceActions] = useState<{ path: string; kind: 'main' | 'worktree'; source?: string; worktree?: WorktreeInfo; x: number; y: number } | null>(null)
  const [mobileWorkspaceActions, setMobileWorkspaceActions] = useState<{ path: string; kind: 'main' | 'worktree'; source?: string; worktree?: WorktreeInfo } | null>(null)
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
  }, [browserPath, loadBrowser])

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
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Open workspace',
      })
      if (typeof selected !== 'string') return
      setSelectedWorkspace(selected)
      setTrustWorkspace(await validateTrustedWorkspace(selected))
      setDialogOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to open workspace')
    } finally {
      setLoading(false)
    }
  }, [isTauri, isTauriMobile, openWebWorkspaceDialog])

  const refreshWorkspaceTree = useCallback(async (force = false) => {
    if (force) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.coding.tree(), refetchType: 'none' })
    }
    const tree = await queryClient.fetchQuery({
      queryKey: queryKeys.coding.tree(),
      queryFn: getCodingWorkspaceTree,
      staleTime: 30_000,
    })
    setWorkspaceTree(tree.repositories)
  }, [queryClient])

  useEffect(() => {
    void refreshWorkspaceTree()
    const handler = () => { void refreshWorkspaceTree(true) }
    window.addEventListener('coding-workspaces-changed', handler)
    window.addEventListener('storage', handler)
    return () => {
      window.removeEventListener('coding-workspaces-changed', handler)
      window.removeEventListener('storage', handler)
    }
  }, [refreshWorkspaceTree])

  useEffect(() => {
    if (openWorkspaceDialogKey > 0) void openWorkspaceDialog()
  }, [openWorkspaceDialogKey, openWorkspaceDialog])

  useEffect(() => {
    if (pendingWorkspace && workspace === pendingWorkspace) setPendingWorkspace(null)
  }, [pendingWorkspace, workspace])

  useEffect(() => {
    if (editTarget) editTitleInputRef.current?.focus()
  }, [editTarget])

  useEffect(() => {
    if (worktreeEditTarget) worktreeEditInputRef.current?.focus()
  }, [worktreeEditTarget])

  const selectWorkspace = async (path: string, opts: { create?: boolean } = {}) => {
    const requestedCreate = opts.create === true
    setPendingWorkspace(path)
    try {
      const result = await selectCodingWorkspace({
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

  // Remove a workspace from the sidebar. Sessions stay in the backend —
  // reopening the same folder later resurfaces them. If the removed
  // workspace was the active one, navigate back to the empty /coding
  // route so the URL doesn't reference a workspace that no longer
  // appears in the sidebar. Called from the confirmation dialog below.
  const confirmRemoveWorkspace = () => {
    const path = removeWorkspaceTarget
    if (!path) return
    setExpandedWorkspaces((current) => {
      const next = new Set(current)
      next.delete(path)
      return next
    })
    if (path === activeWorkspace) {
      navigate({ to: '/coding', replace: true })
    }
    void confirmWorkspaceRemoval({
      path,
      activeWorkspace,
      expandedWorkspaces,
      queryClient,
      refreshWorkspaceTree,
      navigate: ({ to, replace }) => navigate({ to, replace }),
    }).catch(() => undefined)
    setRemoveWorkspaceTarget(null)
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
  const sourceWorkspaces = sourceWorkspacePaths(workspaceTree, deletedWorktreeSet)
  const activeWorktreeSource = activeWorkspace ? worktreeSourceByDirectory.get(activeWorkspace) : null

  const rightPanelWidth = typeof document !== 'undefined'
    ? (document.querySelector('aside.border-l')?.getBoundingClientRect().width ?? 0)
    : 0

  const resizable = useResizableWidth({
    storageKey: 'oa.codingSidebar.width',
    defaultWidth: 256,
    minWidth: 220,
    maxWidth: Math.min(
      420,
      Math.max(
        220,
        Math.floor((typeof window === 'undefined' ? 420 : window.innerWidth) - rightPanelWidth - 380)
      )
    ),
    edge: 'right',
    disabled: isMobile || desktopCollapsed,
  })

  useEffect(() => {
    if (!activeWorkspace || !activeWorktreeSource) return
    setExpandedWorkspaces((current) =>
      addExpandedPaths(current, [activeWorktreeSource, activeWorkspace]),
    )
  }, [activeWorkspace, activeWorktreeSource])

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

  const handleSessionDelete = (e: React.MouseEvent, session: SessionResponse) => {
    e.stopPropagation()
    setDeleteTarget(session)
  }

  const handleSessionEdit = (session: SessionResponse) => {
    setEditTarget(session)
    setEditTitle(session.title || '')
  }

  const handleWorktreeEdit = (item: WorktreeInfo) => {
    const nextState = beginWorktreeTitleEdit(item)
    setWorktreeEditTarget(nextState.target)
    setWorktreeEditTitle(nextState.title)
  }

  const submitSessionTitle = (e: React.FormEvent) => {
    e.preventDefault()
    const update = prepareSessionTitleUpdate(editTarget, editTitle)
    if (!update) return
    updateSessionTitle.mutate(
      update,
      { onSuccess: () => setEditTarget(null) },
    )
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
      codingSessions,
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
            key="coding-sidebar-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: mobileDragOffset !== null ? Math.max(0, Math.min(1, 1 + mobileDragOffset / 280)) : 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: mobileDragOffset !== null ? 0 : (prefersReducedMotion ? 0.01 : 0.2) }}
            className="mobile-safe-top fixed inset-x-0 bottom-0 z-30 bg-black/60 md:hidden"
            aria-hidden="true"
            onClick={onMobileClose}
          />
        )}
      </AnimatePresence>

    <motion.aside
      initial={false}
      animate={
        isMobile
          ? { x: mobileDragOffset ?? (mobileOpen ? 0 : -280), width: 'min(272px, calc(100vw - 2rem))' }
          : { width: desktopCollapsed ? 0 : resizable.width }
      }
      transition={
        mobileDragOffset !== null
          ? { duration: 0 }
          : { duration: resizable.isResizing || prefersReducedMotion ? 0.01 : 0.22, ease: [0.4, 0, 0.2, 1] }
      }
      className={
        isMobile
          ? 'mobile-safe-top fixed bottom-0 left-0 z-40 flex w-[min(272px,calc(100vw-2rem))] shrink-0 flex-col overflow-hidden border-r border-(--color-border) bg-(--bg-page) shadow-xl'
          : 'relative flex shrink-0 flex-col overflow-hidden border-r border-(--color-border) bg-(--bg-page)'
      }
    >
      {!isMobile && !desktopCollapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize coding sidebar"
          title="Drag to resize · double-click to reset"
          className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-(--color-accent)/40"
          onPointerDown={resizable.startResize}
          onDoubleClick={resizable.resetWidth}
        />
      )}

      {isMobile && (
        <nav aria-label="Primary" className="px-2 pt-3">
          <button
            type="button"
            onClick={() => { navigate({ to: '/' }); onMobileClose?.() }}
            className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-(--color-text-2) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
          >
            <Home size={15} aria-hidden="true" />
            <span>Home</span>
          </button>
        </nav>
      )}

      {/* Search trigger — opens the command palette (⌘P / Ctrl+P). */}
      {onCommandPalette && (
        <div className={isMobile ? 'px-3 pt-3' : 'px-3 py-3'}>
          <button
            type="button"
            onClick={onCommandPalette}
            className="flex h-8 w-full items-center gap-2 rounded-md border border-(--color-border) bg-(--bg-page) px-2.5 text-left text-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
            aria-label="Open command palette"
            title={`Open command palette (${formatShortcut('P', os)})`}
          >
            <Search size={13} aria-hidden="true" />
            <span className="flex-1">Search…</span>
            <kbd className="font-mono text-[10px] text-(--color-text-subtle)">^P</kbd>
          </button>
        </div>
      )}

      {/* Workspace + sessions tree */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-2">
        {visibleWorkspaces.length === 0 && (
          <p className="px-3 py-4 text-xs text-(--color-text-subtle)">
            No workspaces yet. Use “Open folder…” below to add one.
          </p>
        )}

        {sourceWorkspaces.map((path) => {
          const sourceIsActive = path === activeWorkspace
          const sourceIsExpanded = expandedWorkspaces.has(path)
          const sourceIsPending = pendingWorkspace === path
          const sourceSessions = codingSessions.filter((s) => s.workspace === path)
          const sourceRunningSessions = sourceSessions.filter((s) => s.running === true)
          const sourceHasRunningSession = sourceRunningSessions.length > 0
          const repository = workspaceTree.find((repo) => repo.path === path)
          const nestedWorktrees = visibleNestedWorktrees(repository, deletedWorktreeSet)

          return (
            <div key={path} className="relative">
              <div className="group mx-2 flex h-7 items-center rounded-md border border-transparent">
                <LongPressButton
                  enabled={mobileLongPressActions}
                  onLongPress={() => setMobileWorkspaceActions({ path, kind: 'main' })}
                  type="button"
                  onClick={() => toggleWorkspaceExpanded(path)}
                  onContextMenu={(event) => {
                    if (mobileLongPressActions) return
                    event.preventDefault()
                    setDesktopWorkspaceActions({ path, kind: 'main', x: event.clientX, y: event.clientY })
                  }}
                  className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded px-1.5 py-1 text-left text-xs"
                  aria-expanded={sourceIsExpanded}
                  aria-label={`${sourceIsExpanded ? 'Collapse' : 'Expand'} repository ${workspaceLabel(path)}`}
                  title={path}
                >
                  <Folder size={11} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
                  <span className={`truncate font-mono ${sourceIsActive ? 'font-semibold text-(--color-text)' : 'text-(--color-text-2) group-hover:text-(--color-text)'}`}>
                    {workspaceLabel(path)}
                  </span>
                  {sourceIsPending && (
                    <span>
                      <Loader2 size={11} className="shrink-0 animate-spin text-(--color-text-muted)" aria-hidden="true" />
                    </span>
                  )}
                </LongPressButton>
                <button
                  type="button"
                  onClick={() => { void selectWorkspace(path, { create: true }) }}
                  className={`ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-(--color-border) text-(--color-text-muted) transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) ${mobileLongPressActions ? 'hidden' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100'}`}
                  aria-label={`New session in ${workspaceLabel(path)}`}
                  title="New session"
                >
                  <Plus size={11} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={(event) => setDesktopWorkspaceActions({ path, kind: 'main', x: event.clientX, y: event.clientY })}
                  className={`mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-(--color-text-subtle) transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) ${mobileLongPressActions ? 'hidden' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100'}`}
                  aria-label={`Actions for ${workspaceLabel(path)}`}
                  title="Workspace actions"
                >
                  <MoreHorizontal size={12} aria-hidden="true" />
                </button>
              </div>

              {(sourceIsExpanded || sourceHasRunningSession) && (
                <div className="pb-1">
                  <WorkspaceSessionList
                    path={path}
                    currentSessionId={currentSessionId}
                    runningSessions={sourceRunningSessions}
                    collapsed={!sourceIsExpanded}
                    mobileLongPressActions={mobileLongPressActions}
                    onSessionSelect={handleSessionSelect}
                    onSessionDelete={handleSessionDelete}
                    onSessionEdit={handleSessionEdit}
                    onSessionLongPress={(session) => setMobileSessionActions({ session, workspacePath: path })}
                    onSessionContextActions={(session, event) => {
                      setDesktopSessionActions({ session, workspacePath: path, x: event.clientX, y: event.clientY })
                    }}
                  />
                  {nestedWorktrees.map((item) => {
                    const directory = item.path
                    const worktreeInfo: WorktreeInfo = { name: item.name, directory, managed: item.managed }
                    const isActive = directory === activeWorkspace
                    const isExpanded = expandedWorkspaces.has(directory)
                    const isPending = pendingWorkspace === directory
                    const itemSessions = codingSessions.filter((s) => s.workspace === directory)
                    const runningSessions = itemSessions.filter((s) => s.running === true)
                    const hasRunningSession = runningSessions.length > 0
                    return (
                      <div key={directory} className="mt-1">
                        <div className="group mx-2 flex h-7 items-center rounded-md">
                          <LongPressButton
                            enabled={mobileLongPressActions}
                            onLongPress={() => setMobileWorkspaceActions({ path: directory, kind: 'worktree', source: path, worktree: worktreeInfo })}
                            type="button"
                            onClick={() => toggleWorkspaceExpanded(directory)}
                            onContextMenu={(event) => {
                              if (mobileLongPressActions) return
                              event.preventDefault()
                              setDesktopWorkspaceActions({ path: directory, kind: 'worktree', source: path, worktree: worktreeInfo, x: event.clientX, y: event.clientY })
                            }}
                            className={`flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs transition-colors ${isActive ? 'text-(--color-accent)' : 'text-(--color-text-2)'}`}
                            aria-expanded={isExpanded}
                            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} worktree ${item.name}`}
                            title={directory}
                          >
                            <ChevronRight size={11} className={`shrink-0 text-(--color-text-subtle) transition-transform ${isExpanded ? 'rotate-90' : ''}`} aria-hidden="true" />
                            <GitBranch size={12} className="shrink-0 text-(--accent-orange-text)" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
                            {!item.managed && <span className="shrink-0 rounded-full bg-(--bg-key) px-1.5 py-0.5 text-[9px] text-(--color-text-subtle)">external</span>}
                            {isPending && (
                              <span>
                                <Loader2 size={11} className="shrink-0 animate-spin text-(--color-text-muted)" aria-hidden="true" />
                              </span>
                            )}
                          </LongPressButton>
                          <button
                            type="button"
                            onClick={() => { void selectWorkspace(directory, { create: true }) }}
                            className={`ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-(--color-border) text-(--color-text-muted) transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) ${mobileLongPressActions ? 'hidden' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100'}`}
                            aria-label={`New session in worktree ${item.name}`}
                            title={`New session in worktree ${item.name}`}
                          >
                            <Plus size={11} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleWorktreeEdit(worktreeInfo)}
                            className={`ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-(--color-text-subtle) transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) ${mobileLongPressActions ? 'hidden' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100'}`}
                            aria-label={`Edit worktree title ${item.name}`}
                            title="Edit worktree title"
                          >
                            <Pencil size={11} aria-hidden="true" />
                          </button>
                          {item.managed ? (
                            <button
                              type="button"
                              onClick={() => setRemoveWorktreeTarget(worktreeInfo)}
                              disabled={worktreeRemoving === directory}
                              className={`ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-(--color-text-subtle) transition-all hover:bg-(--color-error-subtle) hover:text-(--color-error) disabled:opacity-50 ${mobileLongPressActions ? 'hidden' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100'}`}
                              aria-label={`Remove worktree ${item.name}`}
                              title="Remove managed worktree"
                            >
                              {worktreeRemoving === directory ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <Trash2 size={11} aria-hidden="true" />}
                            </button>
                          ) : null}
                        </div>
                        {(isExpanded || hasRunningSession) && (
                          <WorkspaceSessionList
                            path={directory}
                            currentSessionId={currentSessionId}
                            runningSessions={runningSessions}
                            collapsed={!isExpanded}
                            className="max-h-[7.75rem] space-y-0.5 overflow-y-auto py-0.5 pl-5 pr-2"
                            mobileLongPressActions={mobileLongPressActions}
                            onSessionSelect={handleSessionSelect}
                            onSessionDelete={handleSessionDelete}
                            onSessionEdit={handleSessionEdit}
                            onSessionLongPress={(session) => setMobileSessionActions({ session, workspacePath: directory })}
                            onSessionContextActions={(session, event) => {
                              setDesktopSessionActions({ session, workspacePath: directory, x: event.clientX, y: event.clientY })
                            }}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* + Open folder… */}
        <button
          type="button"
          onClick={() => { void openWorkspaceDialog() }}
          className="mx-2 flex h-8 items-center gap-2 rounded-md px-2.5 text-left text-xs font-medium text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
          aria-label="Open folder"
          title="Open a new workspace folder"
        >
          <Plus size={13} aria-hidden="true" />
          <span>Open folder…</span>
        </button>
      </div>

      {/* Footer trio — Settings · Help · HealthDot + ThemeToggle. Mirrors
          the cockpit sidebar so both feel like the same shell. */}
      <div className="flex items-center justify-between gap-2 border-t border-(--color-border) px-3 py-2 pb-safe">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { openSettings(); onMobileClose?.() }}
            className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
            aria-label="Settings"
            title={`Settings (${formatShortcut(',', os)})`}
          >
            <Settings size={14} aria-hidden="true" />
          </button>
          {onCommandPalette && (
            <button
              type="button"
              onClick={onCommandPalette}
              className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
              aria-label="Help and shortcuts"
              title={`Help and shortcuts (${formatShortcut('P', os)})`}
            >
              <HelpCircle size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <HealthDot />
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
                  Coding mode grants agents filesystem and shell access inside this exact directory.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2">
                <p className="break-all font-mono text-xs text-(--color-text-muted)">{trustWorkspace}</p>
              </div>
              <DialogFooter>
                <Button type="button" variant="default" onClick={() => setTrustWorkspace(null)}>Back</Button>
                <Button type="button" onClick={confirmTrustedWorkspace}>Trust and open</Button>
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
                <Button type="button" disabled={loading} onClick={() => { void openWorkspaceDialog() }}>
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
                      className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-(--bg-key)"
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
                      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-(--bg-key)"
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
                <Button type="button" disabled={!browserPath || loading} onClick={openSelectedFolder}>Open this folder</Button>
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
            <DialogTitle>{mobileWorkspaceActions ? workspaceLabel(mobileWorkspaceActions.path) : 'Workspace actions'}</DialogTitle>
            <DialogDescription>{mobileWorkspaceActions?.kind === 'worktree' ? 'Choose a worktree action.' : 'Choose a main workspace action.'}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                const action = mobileWorkspaceActions
                setMobileWorkspaceActions(null)
                if (action) void selectWorkspace(action.path, { create: true })
              }}
            >
              <Plus size={14} aria-hidden="true" />
              New session
            </Button>
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
            {mobileWorkspaceActions?.kind === 'main' ? (
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
            ) : mobileWorkspaceActions?.worktree ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  className="justify-start"
                  onClick={() => {
                    const item = mobileWorkspaceActions.worktree
                    setMobileWorkspaceActions(null)
                    if (item) handleWorktreeEdit(item)
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                  Edit title
                </Button>
                {mobileWorkspaceActions.worktree.managed ? (
                  <Button
                    type="button"
                    variant="danger-subtle"
                    className="justify-start"
                    onClick={() => {
                      const item = mobileWorkspaceActions.worktree
                      setMobileWorkspaceActions(null)
                      if (item) setRemoveWorktreeTarget(item)
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Remove worktree
                  </Button>
                ) : null}
              </>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={worktreeTarget !== null}
        onOpenChange={(open) => { if (!open) setWorktreeTarget(null) }}
      >
        <DialogContent showCloseButton={false} className="flex max-h-[min(86dvh,520px)] w-[calc(100vw-1.5rem)] max-w-md flex-col overflow-hidden p-0 sm:w-[min(560px,calc(100vw-2rem))] sm:max-w-none">
          <form onSubmit={submitWorktree} className="flex h-full min-h-0 flex-col">
            <DialogHeader className="shrink-0 gap-0 border-b border-(--color-border) bg-(--bg-page) px-3 py-2.5 sm:px-4">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <DialogTitle className="text-sm font-semibold leading-5 text-(--color-text)">Create worktree</DialogTitle>
                  <DialogDescription className="mt-0.5 text-xs leading-4 text-(--color-text-muted)">
                    Isolated checkout from {worktreeTarget ? workspaceLabel(worktreeTarget) : 'this workspace'}.
                  </DialogDescription>
                </div>
                <button
                  type="button"
                  onClick={() => setWorktreeTarget(null)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                  aria-label="Close create worktree dialog"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            </DialogHeader>
            <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3 sm:px-4">
              <div className="rounded-md border border-(--color-border) bg-(--bg-page) px-2.5 py-1.5">
                <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-(--color-text-subtle)">
                  <Folder size={12} aria-hidden="true" />
                  Source workspace
                </div>
                <p className="truncate font-mono text-[11px] text-(--color-text-muted)" title={worktreeTarget ?? undefined}>
                  {worktreeTarget}
                </p>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <label className="block space-y-1 text-xs font-medium text-(--color-text-2)">
                  <span>Worktree name</span>
                  <input
                    value={worktreeName}
                    onChange={(e) => setWorktreeName(e.target.value)}
                    placeholder="feature-login"
                    className="min-h-11 w-full min-w-0 rounded-md border border-(--color-border) bg-(--bg-page) px-2.5 py-1 font-mono text-sm text-(--color-text) outline-none transition-colors placeholder:text-(--color-text-subtle) focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/25 md:min-h-8"
                    maxLength={80}
                    autoFocus
                  />
                  <p className="text-[10px] font-normal text-(--color-text-subtle)">Blank uses “session”.</p>
                </label>
                <label className="block space-y-1 text-xs font-medium text-(--color-text-2)">
                  <span>Branch</span>
                  <input
                    value={worktreeBranch}
                    onChange={(e) => setWorktreeBranch(e.target.value)}
                    placeholder="openagentd/feature-login"
                    className="min-h-11 w-full min-w-0 rounded-md border border-(--color-border) bg-(--bg-page) px-2.5 py-1 font-mono text-sm text-(--color-text) outline-none transition-colors placeholder:text-(--color-text-subtle) focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/25 md:min-h-8"
                    maxLength={255}
                  />
                  <p className="text-[10px] font-normal text-(--color-text-subtle)">Blank defaults to openagentd/name.</p>
                </label>
              </div>
              <div className="rounded-md border border-(--color-border) bg-(--bg-page) px-2.5 py-2 text-xs text-(--color-text-muted)">
                <div className="mb-1 flex items-center justify-between gap-2">
                    <p className="font-medium text-(--color-text-2)">Existing worktrees</p>
                    <span className="rounded-full bg-(--bg-key) px-2 py-0.5 text-[10px] text-(--color-text-subtle)">{worktreeOptions.length}</span>
                </div>
                {worktreeOptions.length === 0 ? (
                    <p className="py-1 text-(--color-text-subtle)">No worktrees yet.</p>
                ) : (
                  <ul className="max-h-32 space-y-0.5 overflow-y-auto pr-1">
                      {worktreeOptions.map((item) => (
                        <li key={item.directory} className="group flex min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-(--bg-key)" title={item.directory}>
                          <GitBranch size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-(--color-text-2)">{item.name}</p>
                            {item.branch && <p className="truncate text-[11px] text-(--color-text-subtle)">{item.branch}</p>}
                          </div>
                          {item.managed ? (
                            <button
                              type="button"
                              onClick={() => setRemoveWorktreeTarget(item)}
                              disabled={worktreeRemoving === item.directory}
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-(--color-text-subtle) opacity-100 transition-colors hover:bg-(--color-error-subtle) hover:text-(--color-error) disabled:opacity-50 md:opacity-0 md:group-hover:opacity-100"
                              aria-label={`Remove worktree ${item.name}`}
                              title="Remove managed worktree"
                            >
                              {worktreeRemoving === item.directory ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Trash2 size={12} aria-hidden="true" />}
                            </button>
                          ) : (
                            <span className="rounded-full bg-(--bg-key) px-2 py-0.5 text-[10px] text-(--color-text-subtle)">external</span>
                          )}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
              {error && <p className="rounded-md border border-(--color-error)/30 bg-(--color-error-subtle) px-3 py-2 text-xs text-(--color-error)">{error}</p>}
            </div>
            <DialogFooter className="mx-0 mb-0 shrink-0 flex-row justify-end gap-2 rounded-none border-t border-(--color-border) bg-(--bg-page) px-3 py-2.5 sm:px-4">
              <Button type="button" size="sm" variant="default" onClick={() => setWorktreeTarget(null)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={worktreeLoading}>
                {worktreeLoading ? 'Creating…' : 'Create and open'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {desktopWorkspaceActions && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setDesktopWorkspaceActions(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setDesktopWorkspaceActions(null)
          }}
        >
          <div
            role="menu"
            aria-label={`Actions for ${workspaceLabel(desktopWorkspaceActions.path)}`}
            className="fixed min-w-48 rounded-sm border border-(--color-border) bg-(--bg-card) p-1 text-xs text-(--color-text) shadow-md"
            style={{ left: desktopWorkspaceActions.x, top: desktopWorkspaceActions.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
              onClick={() => {
                const action = desktopWorkspaceActions
                setDesktopWorkspaceActions(null)
                void selectWorkspace(action.path, { create: true })
              }}
            >
              <Plus size={14} aria-hidden="true" />
              New session
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
              onClick={() => {
                const action = desktopWorkspaceActions
                setDesktopWorkspaceActions(null)
                void navigator.clipboard.writeText(action.path)
              }}
            >
              <Copy size={14} aria-hidden="true" />
              Copy repo absolute path
            </button>
            {desktopWorkspaceActions.kind === 'main' ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
                  onClick={() => {
                    const action = desktopWorkspaceActions
                    setDesktopWorkspaceActions(null)
                    void openWorktreeDialog(action.path)
                  }}
                >
                  <GitBranch size={14} aria-hidden="true" />
                  Create worktree
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-(--color-error) hover:bg-(--color-error-subtle) focus-visible:bg-(--color-error-subtle) focus-visible:outline-none"
                  onClick={() => {
                    const action = desktopWorkspaceActions
                    setDesktopWorkspaceActions(null)
                    setRemoveWorkspaceTarget(action.path)
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  Remove from sidebar
                </button>
              </>
            ) : desktopWorkspaceActions.worktree ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
                  onClick={() => {
                    const item = desktopWorkspaceActions.worktree
                    setDesktopWorkspaceActions(null)
                    if (item) handleWorktreeEdit(item)
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                  Edit title
                </button>
                {desktopWorkspaceActions.worktree.managed ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-(--color-error) hover:bg-(--color-error-subtle) focus-visible:bg-(--color-error-subtle) focus-visible:outline-none"
                    onClick={() => {
                      const item = desktopWorkspaceActions.worktree
                      setDesktopWorkspaceActions(null)
                      if (item) setRemoveWorktreeTarget(item)
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Remove worktree
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      )}

      {desktopSessionActions && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setDesktopSessionActions(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setDesktopSessionActions(null)
          }}
        >
          <div
            role="menu"
            aria-label={`Actions for ${desktopSessionActions.session.title || 'Untitled'}`}
            className="fixed min-w-44 rounded-sm border border-(--color-border) bg-(--bg-card) p-1 text-xs text-(--color-text) shadow-md"
            style={{ left: desktopSessionActions.x, top: desktopSessionActions.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
              onClick={() => {
                const { session } = desktopSessionActions
                setDesktopSessionActions(null)
                handleSessionEdit(session)
              }}
            >
              <Pencil size={14} aria-hidden="true" />
              Edit title
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-(--color-error) hover:bg-(--color-error-subtle) focus-visible:bg-(--color-error-subtle) focus-visible:outline-none"
              onClick={() => {
                const { session } = desktopSessionActions
                setDesktopSessionActions(null)
                setDeleteTarget(session)
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
              Delete session
            </button>
          </div>
        </div>
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
        open={editTarget !== null}
        onOpenChange={(open) => { if (!open) setEditTarget(null) }}
      >
        <DialogContent className="max-w-xs gap-3 p-3">
          <form onSubmit={submitSessionTitle} className="space-y-3">
            <DialogHeader className="gap-1 pr-8">
              <DialogTitle className="text-sm leading-5">Edit session title</DialogTitle>
              <DialogDescription className="text-xs leading-4">
                Rename this sidebar item.
              </DialogDescription>
            </DialogHeader>
            <div>
              <input
                ref={editTitleInputRef}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="min-h-11 w-full min-w-0 rounded-md border border-(--color-border) bg-(--bg-page) px-2.5 py-1 text-sm text-(--color-text) outline-none focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/25 md:min-h-8"
                aria-label="Session title"
                maxLength={255}
              />
              {updateSessionTitle.isError && (
                <p className="mt-2 text-xs text-(--color-error)">Failed to update title.</p>
              )}
            </div>
            <DialogFooter className="-mx-3 -mb-3 p-3">
              <Button type="button" size="sm" variant="default" onClick={() => setEditTarget(null)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={!editTitle.trim() || updateSessionTitle.isPending}>
                {updateSessionTitle.isPending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={worktreeEditTarget !== null}
        onOpenChange={(open) => { if (!open) setWorktreeEditTarget(null) }}
      >
        <DialogContent className="max-w-xs gap-3 p-3">
          <form onSubmit={submitWorktreeTitle} className="space-y-3">
            <DialogHeader className="gap-1 pr-8">
              <DialogTitle className="text-sm leading-5">Edit worktree title</DialogTitle>
              <DialogDescription className="max-w-full truncate text-xs leading-4" title={worktreeEditTarget?.directory}>
                {worktreeEditTarget?.directory ? workspaceLabel(worktreeEditTarget.directory) : 'Rename this sidebar item.'}
              </DialogDescription>
            </DialogHeader>
            <div>
              <input
                ref={worktreeEditInputRef}
                value={worktreeEditTitle}
                onChange={(e) => setWorktreeEditTitle(e.target.value)}
                className="min-h-11 w-full min-w-0 rounded-md border border-(--color-border) bg-(--bg-page) px-2.5 py-1 text-sm text-(--color-text) outline-none focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/25 md:min-h-8"
                aria-label="Worktree title"
                maxLength={255}
              />
              {error && <p className="mt-2 text-xs text-(--color-error)">{error}</p>}
            </div>
            <DialogFooter className="-mx-3 -mb-3 p-3">
              <Button type="button" size="sm" variant="default" onClick={() => setWorktreeEditTarget(null)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={!worktreeEditTitle.trim() || worktreeEditLoading}>
                {worktreeEditLoading ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <CodingSidebarConfirmDialogs
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
    </motion.aside>
    </>
  )
}
