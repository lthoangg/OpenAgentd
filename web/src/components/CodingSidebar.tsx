/**
 * CodingSidebar — flat workspace + session switcher for the ``/coding``
 * route. Mirrors the wireframe sidebar ``Q4zeZN`` in
 * ``.diagrams/OpenAgentd-ui.pen``:
 *
 *   • Search input at the top — opens the command palette (Ctrl+P).
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
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import {
  ChevronRight,
  Folder,
  GitBranch,
  HelpCircle,
  Home,
  CircleHelp,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { queryKeys } from '@/queries'
import { useCodingWorkspaceSessionsQuery, useDeleteTeamSessionMutation, useTeamSessionsQuery, useUpdateTeamSessionTitleMutation } from '@/queries/useSessionsQuery'
import { apiBaseUrl } from '@/api/base-url'
import { browseWorkspaces, getCodingWorkspaceTree, listWorktrees, removeWorktree, resolveTeamSession, setCodingWorkspaceVisibility, validateWorkspace } from '@/api/client'
import { getAppBackendStatus } from '@/lib/app-backend'
import { useTeamStore } from '@/stores/useTeamStore'
import { prependSession, prependWorkspaceSession } from '@/stores/cache-invalidation-bridge'
import { formatRelativeDate } from '@/utils/format'
import {
  saveLastCodingWorkspace,
  workspaceLabel,
} from '@/utils/workspace'
import { isTransientNetworkError } from '@/utils/errors'
import { ThemeToggle } from './ThemeToggle'
import { HealthDot } from './HealthDot'
import { Button } from '@/components/ui/button'
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

function worktreeNameSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '') || 'session'
}

function isLocalBackendUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

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
  /** Mobile only: called when the drawer should close (backdrop tap, navigation). */
  onMobileClose?: () => void
}

function WorkspaceSessionList({
  path,
  currentSessionId,
  runningSessions,
  collapsed = false,
  mobileLongPressActions = false,
  className = 'space-y-0.5 pb-1 pl-4 pr-2',
  onSessionSelect,
  onSessionDelete,
  onSessionEdit,
  onSessionLongPress,
  onSessionContextActions,
}: {
  path: string
  currentSessionId?: string
  runningSessions?: SessionResponse[]
  collapsed?: boolean
  mobileLongPressActions?: boolean
  className?: string
  onSessionSelect: (session: SessionResponse, workspacePath: string) => void
  onSessionDelete: (e: React.MouseEvent, session: SessionResponse) => void
  onSessionEdit: (session: SessionResponse) => void
  onSessionLongPress: (session: SessionResponse) => void
  onSessionContextActions: (session: SessionResponse, event: React.MouseEvent) => void
}) {
  const sessions = useCodingWorkspaceSessionsQuery(path, !collapsed)
  const workspaceSessions = collapsed
    ? (runningSessions ?? [])
    : (sessions.data?.pages.flatMap((page) => page.data) ?? [])

  return (
    <div className={className}>
      {workspaceSessions.length === 0 && !collapsed && !sessions.isLoading && (
        <p className="px-2 py-1 text-xs text-(--color-text-subtle)">No sessions yet.</p>
      )}
      {workspaceSessions.map((session) => {
        const isCurrent = session.id === currentSessionId
        const isRunning = session.running === true
        const sessionTitle = session.title || 'Untitled'
        const sessionDate = formatRelativeDate(session.created_at)
        return (
          <div key={session.id} className="group relative">
            <LongPressButton
              enabled={mobileLongPressActions}
              onLongPress={() => onSessionLongPress(session)}
              type="button"
              onClick={() => onSessionSelect(session, path)}
              onDoubleClick={(e) => {
                e.stopPropagation()
                onSessionEdit(session)
              }}
              onContextMenu={(e) => {
                if (mobileLongPressActions) return
                e.preventDefault()
                onSessionContextActions(session, e)
              }}
              title={`${sessionTitle} · ${sessionDate}`}
              className={`flex min-h-6 w-full items-center gap-1.5 rounded px-2 py-0.5 text-left text-xs transition-colors ${
                isCurrent
                  ? 'text-(--color-text)'
                  : 'text-(--color-text-2) hover:text-(--color-text)'
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isRunning ? 'bg-(--color-accent)' : 'border border-(--color-text-subtle)'}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-medium">{sessionTitle}</span>
              {isRunning && (
                <span
                  className="absolute right-7 top-1/2 -translate-y-1/2 text-(--color-accent)"
                  aria-label="Session running"
                >
                  <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                </span>
              )}
            </LongPressButton>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onSessionEdit(session)
              }}
              className="absolute right-6 top-1/2 flex -translate-y-1/2 items-center justify-center rounded p-1 text-(--color-text-subtle) opacity-0 transition-all hover:bg-(--bg-key) hover:text-(--color-text) group-hover:opacity-100 pointer-coarse:opacity-100"
              aria-label={`Edit session ${session.title || 'Untitled'}`}
            >
              <Pencil size={11} />
            </button>
            <button
              type="button"
              onClick={(e) => onSessionDelete(e, session)}
              className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-center rounded p-1 text-(--color-text-subtle) opacity-0 transition-all hover:bg-(--color-error-subtle) hover:text-(--color-error) group-hover:opacity-100 pointer-coarse:opacity-100"
              aria-label={`Delete session ${session.title || 'Untitled'}`}
            >
              <Trash2 size={11} />
            </button>
          </div>
        )
      })}
      {!collapsed && sessions.hasNextPage && (
        <button
          type="button"
          onClick={() => { void sessions.fetchNextPage() }}
          disabled={sessions.isFetchingNextPage}
          className="mt-1 flex w-full items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs text-(--color-accent) transition-colors hover:bg-(--bg-key) disabled:cursor-not-allowed disabled:opacity-60"
        >
          {sessions.isFetchingNextPage && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
          <span>{sessions.isFetchingNextPage ? 'Loading…' : 'Load more'}</span>
        </button>
      )}
    </div>
  )
}

export function CodingSidebar({
  currentSessionId,
  workspace,
  onCollapse,
  openWorkspaceDialogKey = 0,
  onCommandPalette,
  desktopCollapsed = false,
  mobileOpen = false,
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
  // hamburger and Ctrl+B own that surface.
  void onCollapse
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const sessions = useTeamSessionsQuery()
  const deleteSession = useDeleteTeamSessionMutation()
  const updateSessionTitle = useUpdateTeamSessionTitleMutation()

  const allSessions = sessions.data?.pages.flatMap((page) => page.data) ?? []
  const codingSessions = allSessions.filter(
    (session) => session.mode === 'coding' && session.workspace,
  )

  const [workspaceTree, setWorkspaceTree] = useState<CodingWorkspaceTreeRepository[]>([])
  const visibleWorkspaces = (workspaceTree ?? []).map((repo) => repo.path)
  const activeWorkspace = workspace ?? null
  const worktreeSourceByDirectory = new Map<string, string>()
  for (const repo of workspaceTree) {
    for (const item of repo.worktrees) worktreeSourceByDirectory.set(item.path, repo.path)
  }

  // ``expandedWorkspaces`` is local UI state — it auto-tracks the active
  // workspace but the user can also expand/collapse any other workspace
  // independently.
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(
    () => new Set(activeWorkspace ? [activeWorkspace] : []),
  )
  useEffect(() => {
    if (!activeWorkspace) return
    setExpandedWorkspaces((current) => {
      const next = new Set(current)
      next.add(activeWorkspace)
      return next
    })
  }, [activeWorkspace])

  const toggleWorkspaceExpanded = (path: string) => {
    setExpandedWorkspaces((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
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
  const [deleteTarget, setDeleteTarget] = useState<SessionResponse | null>(null)
  const [mobileSessionActions, setMobileSessionActions] = useState<SessionResponse | null>(null)
  const [desktopSessionActions, setDesktopSessionActions] = useState<{ session: SessionResponse; x: number; y: number } | null>(null)
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

  const loadBrowser = useCallback(async (path?: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const result = await browseWorkspaces(path)
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

    if (!isTauri || isTauriMobile) {
      openWebWorkspaceDialog()
      return
    }

    const backendBaseUrl = apiBaseUrl().replace(/\/api\/?$/, '')
    const backend = await getAppBackendStatus()
    const activeBackendBaseUrl = backend?.base_url ?? backendBaseUrl
    const isAbsoluteBackendUrl = /^https?:\/\//i.test(activeBackendBaseUrl)
    if ((backend?.external || (!backend && isAbsoluteBackendUrl)) && !isLocalBackendUrl(activeBackendBaseUrl)) {
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
      const result = await validateWorkspace(selected)
      setTrustWorkspace(result.workspace)
      setDialogOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to open workspace')
    } finally {
      setLoading(false)
    }
  }, [isTauri, isTauriMobile, openWebWorkspaceDialog])

  const refreshWorkspaceTree = useCallback(async () => {
    const tree = await getCodingWorkspaceTree()
    setWorkspaceTree(tree.repositories)
  }, [])

  useEffect(() => {
    void refreshWorkspaceTree()
    const handler = () => { void refreshWorkspaceTree() }
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

  const selectWorkspace = async (path: string, opts: { create?: boolean } = {}) => {
    const shouldCreate = opts.create === true
    const state = useTeamStore.getState()
    const create = shouldCreate && !(
      state.isEmptyIdleSession() &&
      state.sessionId === currentSessionId &&
      workspace === path
    )
    if (shouldCreate && !create) {
      setPendingWorkspace(null)
      return
    }
    saveLastCodingWorkspace(path)
    setPendingWorkspace(path)
    try {
      state.beginResolvedSession(null, {
        mode: 'coding',
        workspace: path,
        model: state.sessionModel,
        thinkingLevel: state.sessionThinkingLevel,
      })
      const session = await resolveTeamSession({
        mode: 'coding',
        workspace: path,
        model: state.sessionModel,
        thinkingLevel: state.sessionThinkingLevel,
        create,
      })
      state.beginResolvedSession(session.id, {
        mode: 'coding',
        workspace: session.workspace ?? path,
        model: session.model ?? state.sessionModel,
        thinkingLevel: session.thinking_level ?? state.sessionThinkingLevel,
        skipInitialRestore: create && session.created,
      })
      if (create && session.created) {
        prependSession(queryClient, session)
        prependWorkspaceSession(queryClient, path, session)
      }
      await refreshWorkspaceTree()
      navigate({ to: '/coding/$sessionId', params: { sessionId: session.id } })
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
    void setCodingWorkspaceVisibility(path, true).then(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.team.sessions.all() })
      void refreshWorkspaceTree()
    }).catch(() => undefined)
    setExpandedWorkspaces((current) => {
      if (!current.has(path)) return current
      const next = new Set(current)
      next.delete(path)
      return next
    })
    if (path === activeWorkspace) {
      navigate({ to: '/coding', replace: true })
    }
    setRemoveWorkspaceTarget(null)
  }

  const loadWorktreesForTarget = useCallback(async (path: string) => {
    try {
      const items = await listWorktrees(path)
      setWorktreesBySource((current) => ({ ...current, [path]: items }))
      if (worktreeTarget === path) setWorktreeOptions(items)
      return items
    } catch {
      setWorktreesBySource((current) => ({ ...current, [path]: [] }))
      if (worktreeTarget === path) setWorktreeOptions([])
      return []
    }
  }, [worktreeTarget])

  const openWorktreeDialog = async (path: string) => {
    setWorktreeTarget(path)
    setWorktreeName('')
    setWorktreeBranch('')
    setWorktreeOptions(worktreesBySource[path] ?? [])
    setWorktreeRemoving(null)
    setError(null)
    const items = await loadWorktreesForTarget(path)
    setWorktreeOptions(items)
  }

  const handleRemoveWorktree = async (item: WorktreeInfo) => {
    if (!item.managed) return
    const directory = item.directory
    setWorktreeRemoving(directory)
    setError(null)
    try {
      const source = worktreeSourceByDirectory.get(directory) ?? worktreeTarget
      if (!source) return
      await removeWorktree(source, directory)
      setRemovedWorktreePaths((current) => new Set(current).add(directory))
      setExpandedWorkspaces((current) => {
        if (!current.has(directory)) return current
        const next = new Set(current)
        next.delete(directory)
        return next
      })
      setWorktreesBySource((current) => {
        const next = { ...current }
        delete next[directory]
        next[source] = (next[source] ?? []).filter((worktree) => worktree.directory !== directory)
        return next
      })
      await loadWorktreesForTarget(source)
      await refreshWorkspaceTree()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to remove worktree')
    } finally {
      setWorktreeRemoving(null)
    }
  }

  const submitWorktree = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!worktreeTarget) return
    setWorktreeLoading(true)
    setError(null)
    try {
      const state = useTeamStore.getState()
      const session = await resolveTeamSession({
        mode: 'coding',
        worktreeFrom: worktreeTarget,
        worktreeName: worktreeName || 'session',
        worktreeBranch: worktreeBranch || null,
        model: state.sessionModel,
        thinkingLevel: state.sessionThinkingLevel,
      })
      const path = session.workspace
      if (!path) throw new Error('Worktree session did not return a workspace')
      setWorktreeTarget(null)
      saveLastCodingWorkspace(path)
      const nextState = useTeamStore.getState()
      nextState.beginResolvedSession(session.id, {
        mode: 'coding',
        workspace: path,
        model: session.model ?? nextState.sessionModel,
        thinkingLevel: session.thinking_level ?? nextState.sessionThinkingLevel,
        skipInitialRestore: session.created,
      })
      prependSession(queryClient, session)
      prependWorkspaceSession(queryClient, path, session)
      await refreshWorkspaceTree()
      navigate({ to: '/coding/$sessionId', params: { sessionId: session.id } })
      onMobileClose?.()
    } catch (err) {
      if (isTransientNetworkError(err) && worktreeTarget) {
        const source = worktreeTarget
        const expectedName = worktreeNameSlug(worktreeName || 'session')
        const items = await loadWorktreesForTarget(source)
        const created = items.find((item) => item.name === expectedName)
        if (created) {
          setWorktreeTarget(null)
          saveLastCodingWorkspace(created.directory)
          setError(null)
          await refreshWorkspaceTree()
          navigate({ to: '/coding' })
          onMobileClose?.()
          return
        }
      }
      setError(err instanceof Error ? err.message : 'Unable to create worktree')
    } finally {
      setWorktreeLoading(false)
    }
  }

  const deletedWorktreeSet = removedWorktreePaths
  const sourceWorkspaces = visibleWorkspaces.filter((path) => !deletedWorktreeSet.has(path))
  const activeWorktreeSource = activeWorkspace ? worktreeSourceByDirectory.get(activeWorkspace) : null

  const resizable = useResizableWidth({
    storageKey: 'oa.codingSidebar.width',
    defaultWidth: 256,
    minWidth: 220,
    maxWidth: 420,
    edge: 'right',
    disabled: isMobile || desktopCollapsed,
  })

  useEffect(() => {
    if (!activeWorkspace || !activeWorktreeSource) return
    setExpandedWorkspaces((current) => {
      const next = new Set(current)
      next.add(activeWorktreeSource)
      next.add(activeWorkspace)
      return next
    })
  }, [activeWorkspace, activeWorktreeSource])

  const openSelectedFolder = async () => {
    if (!browserPath) return
    try {
      const result = await validateWorkspace(browserPath)
      setTrustWorkspace(result.workspace)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Workspace is invalid')
    }
  }

  const confirmTrustedWorkspace = () => {
    if (!trustWorkspace) return
    const workspaceToOpen = trustWorkspace
    setTrustWorkspace(null)
    setDialogOpen(false)
    void selectWorkspace(workspaceToOpen)
  }

  const handleSessionSelect = (session: SessionResponse, workspacePath: string) => {
    if (session.workspace ?? workspacePath) saveLastCodingWorkspace(session.workspace ?? workspacePath)
    navigate({
      to: '/coding/$sessionId',
      params: { sessionId: session.id },
    })
    onMobileClose?.()
  }

  const handleSessionDelete = (e: React.MouseEvent, session: SessionResponse) => {
    e.stopPropagation()
    setDeleteTarget(session)
  }

  const handleSessionEdit = (session: SessionResponse) => {
    setEditTarget(session)
    setEditTitle(session.title || '')
  }

  const submitSessionTitle = (e: React.FormEvent) => {
    e.preventDefault()
    if (!editTarget) return
    const title = editTitle.trim()
    if (!title) return
    updateSessionTitle.mutate(
      { id: editTarget.id, title },
      { onSuccess: () => setEditTarget(null) },
    )
  }

  const confirmSessionDelete = () => {
    if (!deleteTarget) return
    const fallbackSession = deleteTarget.id === currentSessionId
      ? codingSessions.find((session) => session.id !== deleteTarget.id && session.workspace === deleteTarget.workspace)
        ?? codingSessions.find((session) => session.id !== deleteTarget.id)
      : null
    deleteSession.mutate(deleteTarget.id)
    if (deleteTarget.id === currentSessionId) {
      if (fallbackSession) {
        if (fallbackSession.workspace) saveLastCodingWorkspace(fallbackSession.workspace)
        navigate({
          to: '/coding/$sessionId',
          params: { sessionId: fallbackSession.id },
          replace: true,
        })
      } else {
        navigate({ to: '/coding', replace: true })
      }
    }
    setDeleteTarget(null)
  }

  return (
    <>
      {/* Mobile backdrop — closes the drawer on tap. */}
      <AnimatePresence>
        {isMobile && mobileOpen && (
          <motion.div
            key="coding-sidebar-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.01 : 0.2 }}
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
          ? { x: mobileOpen ? 0 : -280, width: 'min(272px, calc(100vw - 2rem))' }
          : { width: desktopCollapsed ? 0 : resizable.width }
      }
      transition={{ duration: prefersReducedMotion ? 0.01 : 0.22, ease: [0.4, 0, 0.2, 1] }}
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

      {/* Search trigger — opens the command palette (Ctrl+P). */}
      {onCommandPalette && (
        <div className={isMobile ? 'px-3 pt-3' : 'px-3 py-3'}>
          <button
            type="button"
            onClick={onCommandPalette}
            className="flex h-8 w-full items-center gap-2 rounded-md border border-(--color-border) bg-(--bg-page) px-2.5 text-left text-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
            aria-label="Open command palette"
            title="Open command palette (Ctrl+P)"
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
          const nestedWorktrees = (repository?.worktrees ?? []).filter((item) => !deletedWorktreeSet.has(item.path))

          return (
            <div key={path} className="relative">
              <div className="group mx-2 mb-0.5 flex h-8 items-center rounded-md border border-transparent">
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
                  {(sourceIsPending || sourceHasRunningSession) && (
                    <span aria-label={sourceHasRunningSession ? 'Repository has running session' : undefined}>
                      <Loader2 size={11} className="shrink-0 animate-spin text-(--color-text-muted)" aria-hidden="true" />
                    </span>
                  )}
                  {sourceHasRunningSession && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-(--color-accent)" aria-label="Repository has running session" />}
                </LongPressButton>
                <button
                  type="button"
                  onClick={() => { void openWorktreeDialog(path) }}
                  className={`ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-(--color-border) text-(--color-text-muted) transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                  aria-label={`Create worktree from ${workspaceLabel(path)}`}
                  title="Create worktree"
                >
                  <GitBranch size={11} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setRemoveWorkspaceTarget(path)}
                  className={`ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-(--color-text-subtle) transition-all hover:bg-(--color-error-subtle) hover:text-(--color-error) ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                  aria-label={`Hide repository ${workspaceLabel(path)} from sidebar`}
                  title="Hide repository from sidebar"
                >
                  <Trash2 size={11} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={(event) => setDesktopWorkspaceActions({ path, kind: 'main', x: event.clientX, y: event.clientY })}
                  className={`mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-(--color-text-subtle) transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                  aria-label={`Actions for ${workspaceLabel(path)}`}
                  title="Workspace actions"
                >
                  <MoreHorizontal size={12} aria-hidden="true" />
                </button>
              </div>

              {(sourceIsExpanded || sourceHasRunningSession) && (
                <div className="space-y-1 pb-1 pt-0.5">
                  <WorkspaceSessionList
                    path={path}
                    currentSessionId={currentSessionId}
                    runningSessions={sourceRunningSessions}
                    collapsed={!sourceIsExpanded}
                    mobileLongPressActions={mobileLongPressActions}
                    onSessionSelect={handleSessionSelect}
                    onSessionDelete={handleSessionDelete}
                    onSessionEdit={handleSessionEdit}
                    onSessionLongPress={setMobileSessionActions}
                    onSessionContextActions={(session, event) => {
                      setDesktopSessionActions({ session, x: event.clientX, y: event.clientY })
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
                        <div className="group mx-2 flex min-h-6 items-center rounded-md">
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
                            {itemSessions.length > 0 && <span className="shrink-0 rounded-full bg-(--bg-key) px-1.5 text-[10px] text-(--color-text-subtle)">{itemSessions.length}</span>}
                            {!item.managed && <span className="shrink-0 rounded-full bg-(--bg-key) px-1.5 py-0.5 text-[9px] text-(--color-text-subtle)">external</span>}
                            {(isPending || hasRunningSession) && (
                              <span aria-label={hasRunningSession ? 'Worktree has running session' : undefined}>
                                <Loader2 size={11} className="shrink-0 animate-spin text-(--color-text-muted)" aria-hidden="true" />
                              </span>
                            )}
                          </LongPressButton>
                          <button
                            type="button"
                            onClick={() => { void selectWorkspace(directory, { create: true }) }}
                            className={`ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-(--color-border) text-(--color-text-muted) transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                            aria-label={`New session in worktree ${item.name}`}
                            title={`New session in worktree ${item.name}`}
                          >
                            <Plus size={11} aria-hidden="true" />
                          </button>
                          {item.managed ? (
                            <button
                              type="button"
                              onClick={() => { void handleRemoveWorktree(worktreeInfo) }}
                              disabled={worktreeRemoving === directory}
                              className={`ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-(--color-text-subtle) transition-all hover:bg-(--color-error-subtle) hover:text-(--color-error) disabled:opacity-50 ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
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
                            className="space-y-0.5 py-1 pl-4 pr-2"
                            mobileLongPressActions={mobileLongPressActions}
                            onSessionSelect={handleSessionSelect}
                            onSessionDelete={handleSessionDelete}
                            onSessionEdit={handleSessionEdit}
                            onSessionLongPress={setMobileSessionActions}
                            onSessionContextActions={(session, event) => {
                              setDesktopSessionActions({ session, x: event.clientX, y: event.clientY })
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
          className="mt-1 flex h-8 items-center gap-2 px-3 text-left text-xs italic text-(--color-accent) transition-colors hover:bg-(--bg-key)"
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
            onClick={() => { navigate({ to: '/settings' }); onMobileClose?.() }}
            className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
            aria-label="Settings"
            title="Settings"
          >
            <Settings size={14} aria-hidden="true" />
          </button>
          {onCommandPalette && (
            <button
              type="button"
              onClick={onCommandPalette}
              className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
              aria-label="Help and shortcuts"
              title="Help and shortcuts (Ctrl+P)"
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
              <div className="rounded-lg border border-(--color-border) bg-(--bg-page) px-3 py-2">
                <p className="break-all font-mono text-xs text-(--color-text-muted)">{trustWorkspace}</p>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setTrustWorkspace(null)}>Back</Button>
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
                  <div className="min-w-0 rounded-lg border border-(--color-border) bg-(--bg-page) px-3 py-2">
                    <p className="min-w-0 font-mono text-xs text-(--color-text-muted) [overflow-wrap:anywhere]" title={selectedWorkspace}>
                      {selectedWorkspace}
                    </p>
                  </div>
                )}
                {error && <p className="text-xs text-(--color-error)">{error}</p>}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
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
                <div className="min-w-0 rounded-lg border border-(--color-border) bg-(--bg-page) px-3 py-2">
                  <p className="min-w-0 font-mono text-xs text-(--color-text-muted) [overflow-wrap:anywhere]" title={browserPath ?? undefined}>
                    {browserPath ?? 'Loading folders…'}
                  </p>
                </div>
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-(--color-border) p-1">
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
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
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
              variant="outline"
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
            {mobileWorkspaceActions?.kind === 'main' ? (
              <>
                <Button
                  type="button"
                  variant="outline"
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
                  variant="outline"
                  className="justify-start text-(--color-error)"
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
            ) : mobileWorkspaceActions?.worktree?.managed ? (
              <Button
                type="button"
                variant="outline"
                className="justify-start text-(--color-error)"
                onClick={() => {
                  const item = mobileWorkspaceActions.worktree
                  setMobileWorkspaceActions(null)
                  if (item) void handleRemoveWorktree(item)
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
                Remove worktree
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={worktreeTarget !== null}
        onOpenChange={(open) => { if (!open) setWorktreeTarget(null) }}
      >
        <DialogContent showCloseButton={false} className="flex max-h-[min(86dvh,600px)] w-[calc(100vw-1.5rem)] max-w-md flex-col overflow-hidden rounded-lg border border-(--color-border) bg-(--bg-card) p-0 shadow-xl sm:w-[min(680px,calc(100vw-2rem))] sm:max-w-none">
          <form onSubmit={submitWorktree} className="flex h-full min-h-0 flex-col">
            <DialogHeader className="shrink-0 border-b border-(--color-border) bg-(--bg-page) px-4 py-3 sm:px-5">
              <div className="flex items-start gap-2.5 sm:gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-(--color-border) bg-(--bg-key) text-(--color-accent)">
                  <GitBranch size={15} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <DialogTitle className="text-sm font-semibold leading-5 text-(--color-text)">Create worktree</DialogTitle>
                  <DialogDescription className="mt-0.5 text-xs leading-4 text-(--color-text-muted)">
                    Isolated checkout from {worktreeTarget ? workspaceLabel(worktreeTarget) : 'this workspace'}.
                  </DialogDescription>
                </div>
                <button
                  type="button"
                  onClick={() => setWorktreeTarget(null)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                  aria-label="Close create worktree dialog"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
            </DialogHeader>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 sm:px-5">
              <div className="rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-2">
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-(--color-text-subtle)">
                  <Folder size={12} aria-hidden="true" />
                  Source workspace
                </div>
                <p className="truncate font-mono text-[11px] text-(--color-text-muted)" title={worktreeTarget ?? undefined}>
                  {worktreeTarget}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-xs font-medium text-(--color-text-2)">
                  <span>Worktree name</span>
                  <input
                    value={worktreeName}
                    onChange={(e) => setWorktreeName(e.target.value)}
                    placeholder="feature-login"
                    className="h-9 w-full min-w-0 rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-1 font-mono text-sm text-(--color-text) outline-none transition-colors placeholder:text-(--color-text-subtle) focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/25"
                    maxLength={80}
                    autoFocus
                  />
                  <p className="text-[11px] font-normal text-(--color-text-subtle)">Blank uses “session”.</p>
                </label>
                <label className="block space-y-1 text-xs font-medium text-(--color-text-2)">
                  <span>Branch</span>
                  <input
                    value={worktreeBranch}
                    onChange={(e) => setWorktreeBranch(e.target.value)}
                    placeholder="openagentd/feature-login"
                    className="h-9 w-full min-w-0 rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-1 font-mono text-sm text-(--color-text) outline-none transition-colors placeholder:text-(--color-text-subtle) focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/25"
                    maxLength={255}
                  />
                  <p className="text-[11px] font-normal text-(--color-text-subtle)">Blank defaults to openagentd/name.</p>
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="hidden gap-2 rounded-md border border-(--color-border) bg-(--bg-key)/30 px-3 py-2 text-[11px] leading-4 text-(--color-text-muted) sm:flex">
                  <CircleHelp size={13} className="mt-0.5 shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
                  <p>Stored in OpenAgentd data, outside the source repo. Uncommitted source changes are not copied.</p>
                </div>
                <div className="rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-2 text-xs text-(--color-text-muted)">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <p className="font-medium text-(--color-text-2)">Existing worktrees</p>
                    <span className="rounded-full bg-(--bg-key) px-2 py-0.5 text-[10px] text-(--color-text-subtle)">{worktreeOptions.length}</span>
                  </div>
                  {worktreeOptions.length === 0 ? (
                    <p className="py-1 text-(--color-text-subtle)">No worktrees yet.</p>
                  ) : (
                    <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
                      {worktreeOptions.map((item) => (
                        <li key={item.directory} className="group flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-(--bg-key)" title={item.directory}>
                          <GitBranch size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-(--color-text-2)">{item.name}</p>
                            {item.branch && <p className="truncate text-[11px] text-(--color-text-subtle)">{item.branch}</p>}
                          </div>
                          {item.managed ? (
                            <button
                              type="button"
                              onClick={() => { void handleRemoveWorktree(item) }}
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
              </div>
              {error && <p className="rounded-md border border-(--color-error)/30 bg-(--color-error-subtle) px-3 py-2 text-xs text-(--color-error)">{error}</p>}
            </div>
            <DialogFooter className="shrink-0 flex-row justify-end gap-2 border-t border-(--color-border) bg-(--bg-page) px-4 pb-5 pt-3 sm:pl-5 sm:pr-6 sm:pb-6">
              <Button type="button" variant="outline" onClick={() => setWorktreeTarget(null)} className="h-9 w-auto px-4">Cancel</Button>
              <Button type="submit" disabled={worktreeLoading} className="h-9 w-auto px-4">
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
            className="fixed min-w-48 rounded-lg border border-(--color-border) bg-(--bg-card) p-1 text-sm text-(--color-text) shadow-xl"
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
            ) : desktopWorkspaceActions.worktree?.managed ? (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-(--color-error) hover:bg-(--color-error-subtle) focus-visible:bg-(--color-error-subtle) focus-visible:outline-none"
                onClick={() => {
                  const item = desktopWorkspaceActions.worktree
                  setDesktopWorkspaceActions(null)
                  if (item) void handleRemoveWorktree(item)
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
                Remove worktree
              </button>
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
            className="fixed min-w-44 rounded-lg border border-(--color-border) bg-(--bg-card) p-1 text-sm text-(--color-text) shadow-xl"
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
            <DialogTitle>{mobileSessionActions?.title || 'Untitled'}</DialogTitle>
            <DialogDescription>Choose a session action.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
            <Button
              type="button"
              variant="outline"
              className="justify-start"
              onClick={() => {
                const session = mobileSessionActions
                setMobileSessionActions(null)
                if (session) handleSessionEdit(session)
              }}
            >
              <Pencil size={14} aria-hidden="true" />
              Edit title
            </Button>
            <Button
              type="button"
              variant="outline"
              className="justify-start text-(--color-error)"
              onClick={() => {
                const session = mobileSessionActions
                setMobileSessionActions(null)
                if (session) setDeleteTarget(session)
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
              Delete session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete session</DialogTitle>
            <DialogDescription>
              &ldquo;{deleteTarget?.title || 'Untitled'}&rdquo; will be permanently deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="p-3">
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={confirmSessionDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editTarget !== null}
        onOpenChange={(open) => { if (!open) setEditTarget(null) }}
      >
        <DialogContent showCloseButton={false}>
          <form onSubmit={submitSessionTitle}>
            <DialogHeader>
              <DialogTitle>Edit session title</DialogTitle>
              <DialogDescription>
                Rename this session in the sidebar.
              </DialogDescription>
            </DialogHeader>
            <div className="px-3 py-2">
              <input
                ref={editTitleInputRef}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="h-9 w-full min-w-0 rounded-[10px] border border-(--color-border) bg-(--bg-page) px-3 py-1 text-sm text-(--color-text) outline-none focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/25"
                aria-label="Session title"
                maxLength={255}
              />
              {updateSessionTitle.isError && (
                <p className="mt-2 text-xs text-(--color-error)">Failed to update title.</p>
              )}
            </div>
            <DialogFooter className="p-3">
              <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
              <Button type="submit" disabled={!editTitle.trim() || updateSessionTitle.isPending}>
                {updateSessionTitle.isPending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeWorkspaceTarget !== null}
        onOpenChange={(open) => { if (!open) setRemoveWorkspaceTarget(null) }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove workspace from sidebar</DialogTitle>
            <DialogDescription>
              &ldquo;{removeWorkspaceTarget ? workspaceLabel(removeWorkspaceTarget) : ''}&rdquo; will be hidden from
              the sidebar. Its sessions stay on disk — reopening this folder later restores the list.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="p-3">
            <Button type="button" variant="outline" onClick={() => setRemoveWorkspaceTarget(null)}>Cancel</Button>
              <Button type="button" variant="destructive" onClick={confirmRemoveWorkspace}>Remove from sidebar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.aside>
    </>
  )
}
