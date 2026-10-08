/**
 * WorkspacePanel — the review dock.
 *
 * Editor-style tab strip (Git review, file previews, full-height diffs,
 * commits, web previews, terminals, and on desktop the agent Tasks and
 * Schedule views)
 * over one content area. Desktop geometry is a ratio of the shell's center
 * region (measured here from ``centerRef``) in ``side`` mode, or the whole
 * center in ``overlay`` mode (maximized, or a window too narrow for a
 * side-by-side split). Mobile keeps the fixed full-screen sheet.
 *
 * Tab state lives in ``useDockTabs`` and Git write actions in
 * ``useGitActions``; this component owns the queries and the layout.
 *
 * Once opened, the shell keeps the dock mounted: closing it (``open``
 * false) tweens it shut and then parks it hidden and inert, so its tabs,
 * the last active tab, preview pages and their unsent comments, and scroll
 * positions are all there when it reopens. Queries pause while it is closed.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  getCodingWorkspaceStatus,
  getCodingWorkspaceGitHistory,
} from '@/api/client'
import { cn } from '@/lib/utils'
import { queryKeys } from '@/queries'
import {
  WORKSPACE_TREE_STALE_MS,
  workspaceFileListQueryOptions,
} from '@/queries/workspace-files'
import {
  COMMIT_DIFF_STALE_MS,
  WORKSPACE_DIFF_STALE_MS,
  commitDiffQueryOptions,
  workspaceDiffQueryOptions,
} from '@/queries/workspace-git'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { PanelResizeHandle, ResizableAside, settledWidthBesidePanels, type LiveWidth } from '@/components/ResizableAside'
import { useClaimStrandedFocus } from '@/hooks/use-dock-focus'
import { focusQuietly } from '@/lib/focus/quiet'
import { useElementWidth } from '@/hooks/use-element-width'
import { usePlatform } from '@/hooks/use-platform'
import {
  DOCK_MIN_WIDTH,
  dockMaxWidth,
  ratioFromWidth,
  resolveDockLayout,
} from '@/lib/workbench-layout'
import { useGitPanelStore, DEFAULT_WORKSPACE_STATE } from '@/stores/useGitPanelStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useUIStore } from '@/stores/useUIStore'
import type { SessionPlan, TodoItem, WorkspaceFileInfo } from '@/api/types'
import { type PreviewTarget, closePreview, isLocalBackend, lastPreviewUrl } from '@/api/preview'
import { EASINGS } from '@/lib/motion'
import {
  type ChangedFileStatus,
  type ChangedFileInfo,
  type DiffFileSection,
  collectChangedFiles,
  collectDiffSections,
} from './WorkspacePanel/diff-helpers'
import type { ParsedGraphLine } from './WorkspacePanel/CommitDetail'
import { GitReviewSubPanel } from './WorkspacePanel/GitReviewSubPanel'
import { CommitHistorySubPanel } from './WorkspacePanel/CommitHistorySubPanel'
import { TerminalSubPanel } from './WorkspacePanel/TerminalSubPanel'
import { FilePreviewSubPanel } from './WorkspacePanel/FilePreviewSubPanel'
import { DiffTabView } from './WorkspacePanel/DiffTabView'
import { CommitTabView } from './WorkspacePanel/CommitTabView'
import { TasksTabView } from './WorkspacePanel/TasksTabView'
import { PlanTabView } from './WorkspacePanel/PlanTabView'
import { PreviewTabView } from './Preview/PreviewTabView'
import type { DesignFeedback } from '@/lib/design-feedback'
import { SchedulerDockView } from './SchedulerPanel/SchedulerDockView'
import { DockTabBar } from './WorkspacePanel/DockTabBar'
import { DockLauncher } from './WorkspacePanel/DockLauncher'
import { DockActionMenus, type CommitActionTarget } from './WorkspacePanel/DockActionMenus'
import { CloseTerminalDialog } from './WorkspacePanel/CloseTerminalDialog'
import { useGitActions } from './WorkspacePanel/useGitActions'
import { useDockTabs } from './WorkspacePanel/useDockTabs'
import {
  type GitSubTab,
  GitViewToolbar,
  gitViewPanelId,
  gitViewTabId,
} from './WorkspacePanel/GitViewToolbar'
import {
  type DiffTabRequest,
  type DockTab,
  type DockView,
  type DockViewRequest,
  type PreviewTabRequest,
  PLAN_TAB,
  REVIEW_TAB_ID,
  basename,
  resolveFileTabInfo,
} from './WorkspacePanel/dock-tabs'

export type { ChangedFileStatus, ChangedFileInfo, DiffFileSection }

const EMPTY_TODOS: TodoItem[] = []
/** Dev server a new preview tab opens when the workspace has no last URL. */
const DEFAULT_PREVIEW_URL = 'http://localhost:5173'
/** Stable empty ref: with no center element the width falls back to the viewport. */
const NO_CENTER: React.RefObject<HTMLElement | null> = { current: null }
/** A closed dock parks (hidden, inert) once its close tween (0.22 s) is done. */
const PARK_AFTER_MS = 260

function parseGraph(graph: string): ParsedGraphLine[] {
  if (!graph) return []
  return graph.split('\n').filter((line) => line.trim().length > 0).map((line, lineIndex) => {
    const match = /^(.*?)\b([0-9a-fA-F]{7,10})\b(.*?)$/.exec(line)
    if (!match) return { key: `line-${lineIndex}`, raw: line, graphPart: line }
    const [, graphPart, sha, restRaw] = match
    const rest = restRaw.trim()
    const decoMatch = /^\((.*?)\)\s*(.*)$/.exec(rest)
    return decoMatch
      ? { key: `line-${lineIndex}-${sha}`, raw: line, graphPart, sha, decorations: decoMatch[1], message: decoMatch[2] }
      : { key: `line-${lineIndex}-${sha}`, raw: line, graphPart, sha, message: rest }
  })
}

export function WorkspacePanel({
  workspace,
  open,
  mobile = false,
  mobileDragOffset = null,
  centerRef = NO_CENTER,
  centerWidth,
  selectedFilePath = null,
  selectedFileOpenKey = 0,
  terminalOpenKey = 0,
  handledTerminalOpenKeyRef: parentHandledTerminalOpenKeyRef,
  viewRequest = null,
  handledViewRequestKeyRef: parentHandledViewRequestKeyRef,
  diffRequest = null,
  handledDiffRequestKeyRef,
  previewRequest = null,
  handledPreviewRequestKeyRef,
  onActiveViewChange,
  todos = EMPTY_TODOS,
  sessionId = null,
  plan = null,
  onClearPlan,
  onFileSelect,
  onAddComment,
  onSendPreviewComments,
  chatWorkspace = false,
  onRequestClose,
}: {
  workspace: string
  open: boolean
  mobile?: boolean
  mobileDragOffset?: number | null
  /**
   * The chat + dock region. The dock measures it itself, so the shell does
   * not re-render on every width change. Without it, the viewport is used.
   */
  centerRef?: React.RefObject<HTMLElement | null>
  /** Explicit center width; overrides the measurement (tests, fixed hosts). */
  centerWidth?: number
  selectedFilePath?: string | null
  selectedFileOpenKey?: number
  terminalOpenKey?: number
  handledTerminalOpenKeyRef?: React.RefObject<number | null>
  /** Shell request to open (or focus) the Tasks / Schedule / Plan tab. */
  viewRequest?: DockViewRequest | null
  /** Parent-owned so a remounted dock does not replay a handled request. */
  handledViewRequestKeyRef?: React.RefObject<number>
  /** Shell request to open (or focus) a diff tab. */
  diffRequest?: DiffTabRequest | null
  handledDiffRequestKeyRef?: React.RefObject<number>
  /** Shell request to open (or focus) a web preview tab. */
  previewRequest?: PreviewTabRequest | null
  handledPreviewRequestKeyRef?: React.RefObject<number>
  /** Reports the focused view tab (``null`` for other tabs or on unmount). */
  onActiveViewChange?: (view: DockView | null) => void
  /** Agent task list for the Tasks tab. */
  todos?: TodoItem[]
  sessionId?: string | null
  /** The session plan: the Plan tab, and a row above the Tasks tab's list. */
  plan?: SessionPlan | null
  onClearPlan?: () => void
  onFileSelect?: (file: WorkspaceFileInfo | null) => void
  onAddComment?: (path: string, startLine: number, endLine: number) => void
  /** Adds a preview's design comments to the composer as a chip. */
  onSendPreviewComments?: (feedback: DesignFeedback) => void
  /**
   * True when ``workspace`` is the chat root (see ``useChatWorkspace``).
   * Chat workspaces are not repositories: the Git review tab is hidden and its
   * git queries stay disabled so opening the dock on ``~`` neither probes a
   * home-sized repo nor offers whole-home discard/revert actions.
   */
  chatWorkspace?: boolean
  /** Closes the dock: ⌘W on the empty launcher. */
  onRequestClose?: () => void
}) {
  const prefersReducedMotion = useReducedMotion()
  const { os } = usePlatform()
  const gitViewIdBase = useId()
  // Preview listener behind each preview tab; file tabs of one workspace
  // share a listener, so it closes only with the last tab using it.
  const previewIdsRef = useRef(new Map<string, string>())
  const handlePreviewId = useCallback((tabId: string, previewId: string) => {
    previewIdsRef.current.set(tabId, previewId)
  }, [])
  const handleTabClosed = useCallback((tab: DockTab) => {
    if (tab.type !== 'preview') return
    const ids = previewIdsRef.current
    const previewId = ids.get(tab.id)
    ids.delete(tab.id)
    if (previewId && ![...ids.values()].includes(previewId)) void closePreview(previewId).catch(() => {})
  }, [])
  // Tab state comes first: the Git queries below are gated on the active tab.
  const {
    tabs,
    visibleTabs,
    activeTabId,
    setActiveTabId,
    activeTab,
    terminalMetas,
    openTab,
    openFileTab,
    openDiffTab,
    openCommitTab,
    openPreviewTab,
    openGitTab,
    openTerminal,
    moveTab,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    confirmCloseOpen,
    confirmCloseTitles,
    confirmCloseTab,
    cancelCloseTab,
  } = useDockTabs({
    workspace,
    open,
    chatWorkspace,
    onFileSelect,
    terminalOpenKey,
    handledTerminalOpenKeyRef: parentHandledTerminalOpenKeyRef,
    viewRequest,
    handledViewRequestKeyRef: parentHandledViewRequestKeyRef,
    onActiveViewChange,
    diffRequest,
    handledDiffRequestKeyRef,
    previewRequest,
    handledPreviewRequestKeyRef,
    onTabClosed: handleTabClosed,
    focusTab: (id) => requestAnimationFrame(() => {
      const button = tabButtonRefs.current.get(id)
      if (button) focusQuietly(button)
    }),
    onCloseDock: onRequestClose,
  })
  const [mobileFileActions, setMobileFileActions] = useState<ChangedFileInfo | null>(null)
  const [mobileCommitActions, setMobileCommitActions] = useState<CommitActionTarget | null>(null)
  const [desktopCommitActions, setDesktopCommitActions] = useState<(CommitActionTarget & { x: number; y: number }) | null>(null)
  const [desktopFileActions, setDesktopFileActions] = useState<{ file: ChangedFileInfo; x: number; y: number } | null>(null)
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const commitsScrollRef = useRef<HTMLDivElement>(null)
  const pendingScrollShaRef = useRef<string | null>(null)
  const handledFileOpenKeyRef = useRef(-1)
  // Closed and done animating: hidden and inert until it opens again. Not
  // inert at once, so the shell can still see focus inside it and return it.
  const [parked, setParked] = useState(false)
  useEffect(() => {
    if (open) {
      setParked(false)
      return
    }
    const timer = window.setTimeout(() => setParked(true), PARK_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [open])
  // Whether the open or close tween (mounting counts as opening) is still
  // running. Only then, and while closed, is the body pinned to the open
  // width; any other width change moves the body with the dock's edge.
  const [toggle, setToggle] = useState({ open, running: true })
  if (toggle.open !== open) setToggle({ open, running: true })
  const settleToggle = () => setToggle((current) => (current.running ? { ...current, running: false } : current))

  // ── Geometry ───────────────────────────────────────────────────────────────
  const dockRatio = useLayoutStore((s) => s.dockRatio)
  const dockMaximized = useLayoutStore((s) => s.dockMaximized)
  const measuredCenter = useElementWidth(centerRef, settledWidthBesidePanels)
  const center = centerWidth ?? measuredCenter
  const layout = resolveDockLayout({ centerWidth: center, ratio: dockRatio, maximized: dockMaximized })
  const overlay = !mobile && layout.mode === 'overlay'
  const dockResize = {
    width: layout.width,
    min: DOCK_MIN_WIDTH,
    max: dockMaxWidth(center),
    edge: 'left' as const,
    onCommit: (width: number) => useLayoutStore.getState().setDockRatio(ratioFromWidth(width, center)),
    onReset: () => useLayoutStore.getState().resetDockRatio(),
    disabled: mobile || overlay || !open,
    label: 'Resize review dock',
  }
  // Desktop always animates width (instantly while dragging or under reduced
  // motion) so the aside is sized even when motion is off. Closed, it tweens
  // to nothing while the body keeps its open width (clipped, not reflowed).
  const dockMotion = ({ width, isResizing }: LiveWidth) => ({
    animate: !open
      ? (mobile ? { opacity: 0 } : { width: 0 })
      : !mobile
        ? { width: overlay ? layout.width : width }
        : prefersReducedMotion
          ? { opacity: 1 }
          : mobileDragOffset !== null ? { opacity: 1, x: mobileDragOffset } : { opacity: 1, x: 0 },
    transition: mobile && mobileDragOffset !== null
      ? { duration: 0 }
      : { duration: isResizing || prefersReducedMotion ? 0.01 : 0.22, ease: EASINGS.inOut },
    pinWidth: !mobile && (!open || toggle.running) ? (overlay ? layout.width : width) : undefined,
  })
  // The toggle is meaningless while a narrow window already forces overlay.
  const maximizeState = mobile || (overlay && !dockMaximized) ? null : dockMaximized
  // Covering the chat makes it inert, which drops its focus onto <body>:
  // take it on the active tab, or the launcher's first row when empty.
  useClaimStrandedFocus(open && overlay, activeTabId, () =>
    tabButtonRefs.current.get(activeTabId) ?? document.querySelector<HTMLElement>('[data-dock-launcher] button'))

  // ── Server state ──────────────────────────────────────────────────────────
  const files = useQuery({
    ...workspaceFileListQueryOptions(workspace),
    enabled: open,
    staleTime: WORKSPACE_TREE_STALE_MS,
  })
  const diff = useQuery({
    ...workspaceDiffQueryOptions(workspace),
    enabled: open && !chatWorkspace,
    staleTime: WORKSPACE_DIFF_STALE_MS,
  })
  const workspaceStatus = useQuery({
    queryKey: queryKeys.coding.status(workspace),
    queryFn: ({ signal }) => getCodingWorkspaceStatus(workspace, signal),
    enabled: open && !chatWorkspace,
    staleTime: 10_000,
  })
  const changedFiles = useMemo(() => collectChangedFiles(diff.data), [diff.data])
  const diffSections = useMemo(() => collectDiffSections(diff.data), [diff.data])
  // Working-tree status per changed path; ``has`` doubles as "is changed".
  const changedPaths = useMemo(() => new Map(changedFiles.map((file) => [file.path, file.status])), [changedFiles])
  const filesByPath = useMemo(() => new Map((files.data?.files ?? []).map((file) => [file.path, file])), [files.data?.files])

  const gitState = useGitPanelStore((s) => s.workspaces[workspace] || DEFAULT_WORKSPACE_STATE)
  const subTab = gitState.subTab
  const allBranches = gitState.allBranches
  const expandedCommitSha = gitState.expandedCommitSha
  const expandedDiffs = useMemo(() => new Set(gitState.expandedDiffs), [gitState.expandedDiffs])
  const expandedCommitFiles = useMemo(() => new Set(gitState.expandedCommitFiles), [gitState.expandedCommitFiles])

  // Stable setters (read the store at call time) so the memoized Git list
  // views below are not re-rendered by a fresh callback on every dock render.
  const setSubTab = useCallback((tab: GitSubTab) => useGitPanelStore.getState().setSubTab(workspace, tab), [workspace])
  const setAllBranches = useCallback((val: boolean) => useGitPanelStore.getState().setAllBranches(workspace, val), [workspace])
  const setExpandedCommitSha = useCallback((updater: string | null | ((prev: string | null) => string | null)) => {
    const store = useGitPanelStore.getState()
    const current = (store.workspaces[workspace] || DEFAULT_WORKSPACE_STATE).expandedCommitSha
    store.setExpandedCommitSha(workspace, typeof updater === 'function' ? updater(current) : updater)
  }, [workspace])
  const setExpandedCommitFiles = useCallback((updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const store = useGitPanelStore.getState()
    const current = new Set((store.workspaces[workspace] || DEFAULT_WORKSPACE_STATE).expandedCommitFiles)
    store.setExpandedCommitFiles(workspace, Array.from(typeof updater === 'function' ? updater(current) : updater))
  }, [workspace])
  const historyLimit = 50
  // "All branches" is a Tree-only toggle; the Commits list always follows HEAD.
  const historyAllBranches = subTab === 'tree' && allBranches

  const gitHistory = useInfiniteQuery({
    queryKey: queryKeys.coding.history(workspace, historyLimit, historyAllBranches),
    queryFn: ({ pageParam, signal }) => getCodingWorkspaceGitHistory(workspace, historyLimit, pageParam, historyAllBranches, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? null,
    enabled: open && !chatWorkspace && activeTabId === REVIEW_TAB_ID && (subTab === 'commits' || subTab === 'tree'),
    staleTime: 10_000,
  })

  const commits = useMemo(() => gitHistory.data?.pages.flatMap((page) => page.commits) ?? [], [gitHistory.data?.pages])

  const isLatestCommit = useMemo(() => {
    const activeSha = mobileCommitActions?.sha ?? desktopCommitActions?.sha
    if (!activeSha || commits.length === 0) return false
    return activeSha === commits[0].sha
  }, [mobileCommitActions, desktopCommitActions, commits])

  const graph = gitHistory.data?.pages[0]?.graph ?? ''
  const parsedGraphLines = useMemo(() => parseGraph(graph), [graph])

  const commitsAhead = workspaceStatus.data?.commits_ahead ?? null
  const commitsBehind = workspaceStatus.data?.commits_behind ?? null
  const upstream = workspaceStatus.data?.upstream ?? null

  const commitDiff = useQuery({
    ...commitDiffQueryOptions(workspace, expandedCommitSha ?? ''),
    enabled: open && !chatWorkspace && activeTabId === REVIEW_TAB_ID && subTab === 'commits' && expandedCommitSha !== null,
    staleTime: COMMIT_DIFF_STALE_MS,
  })
  const commitDiffText = commitDiff.data?.diff

  // React Query hands back a new result object every render; the list views
  // get memoized slices of the fields they read so ``memo`` can skip them.
  const diffView = useMemo(
    () => ({ isLoading: diff.isLoading, isError: diff.isError, data: diff.data }),
    [diff.isLoading, diff.isError, diff.data],
  )
  const filesView = useMemo(() => ({ isLoading: files.isLoading, data: files.data }), [files.isLoading, files.data])
  const { isLoading: historyLoading, isError: historyError, isFetchingNextPage, hasNextPage, fetchNextPage, refetch: refetchHistory, data: historyData } = gitHistory
  const historyView = useMemo(
    () => ({ isLoading: historyLoading, isError: historyError, isFetchingNextPage, hasNextPage, fetchNextPage, refetch: refetchHistory, data: historyData }),
    [historyLoading, historyError, isFetchingNextPage, hasNextPage, fetchNextPage, refetchHistory, historyData],
  )
  const commitDiffView = useMemo(
    () => ({ isLoading: commitDiff.isLoading, isError: commitDiff.isError }),
    [commitDiff.isLoading, commitDiff.isError],
  )
  const commitChangedFiles = useMemo(() => {
    if (!commitDiffText) return []
    return collectChangedFiles({ workspace, is_git_repo: true, diff: commitDiffText })
  }, [commitDiffText, workspace])
  const commitDiffSections = useMemo(() => {
    if (!commitDiffText) return new Map<string, DiffFileSection>()
    return collectDiffSections({ workspace, is_git_repo: true, diff: commitDiffText })
  }, [commitDiffText, workspace])

  // ── Tabs ───────────────────────────────────────────────────────────────────
  /** Open a changed path, synthesising file info when the listing lacks it. */
  const openChangedFile = useCallback((path: string) => {
    const file = filesByPath.get(path) ?? { path, name: basename(path), size: 0, mtime: 0, mime: 'text/plain' }
    openFileTab(file)
  }, [filesByPath, openFileTab])

  const openCommitTabBySha = (sha: string) => {
    const commit = commits.find((item) => item.sha === sha)
    if (commit) openCommitTab(commit)
  }

  const previewsAvailable = isLocalBackend()
  const openNewPreview = useCallback(() => {
    openPreviewTab({ kind: 'url', url: lastPreviewUrl(workspace) ?? DEFAULT_PREVIEW_URL })
  }, [openPreviewTab, workspace])
  const openFilePreview = useCallback((path: string) => {
    openPreviewTab({ kind: 'file', path })
  }, [openPreviewTab])
  const openPreviewTarget = useCallback((target: PreviewTarget) => openPreviewTab(target), [openPreviewTab])
  const previewTabs = visibleTabs.filter((tab): tab is Extract<DockTab, { type: 'preview' }> => tab.type === 'preview')

  const handleRefresh = useCallback(() => {
    void files.refetch()
    if (chatWorkspace) return
    void diff.refetch()
    void workspaceStatus.refetch()
    if (subTab === 'commits' || subTab === 'tree') {
      void gitHistory.refetch()
    }
  }, [files, diff, workspaceStatus, gitHistory, subTab, chatWorkspace])

  const toggleDiffExpanded = useCallback((path: string) => {
    useGitPanelStore.getState().toggleDiffExpanded(workspace, path)
  }, [workspace])
  const allExpanded = changedFiles.length > 0 && changedFiles.every((f) => expandedDiffs.has(f.path))
  const toggleExpandAll = () => {
    useGitPanelStore.getState().setExpandedDiffs(workspace, allExpanded ? [] : changedFiles.map((f) => f.path))
  }

  // Expansions persist per workspace; forget files that are no longer
  // changed so a later edit to them does not reopen as a stale peek and the
  // stored list does not grow forever. A truncated diff lists only part of
  // the change set, so it cannot prove a path is gone.
  useEffect(() => {
    if (!diff.data?.is_git_repo || diff.data.truncated) return
    const stored = useGitPanelStore.getState().workspaces[workspace]?.expandedDiffs ?? []
    const kept = stored.filter((path) => changedPaths.has(path))
    if (kept.length !== stored.length) useGitPanelStore.getState().setExpandedDiffs(workspace, kept)
  }, [diff.data, changedPaths, workspace])

  useEffect(() => {
    if (handledFileOpenKeyRef.current === selectedFileOpenKey) return
    if (!selectedFilePath) return
    if (files.data?.files == null) return
    const file = files.data.files.find((item) => item.path === selectedFilePath)
    if (file) {
      handledFileOpenKeyRef.current = selectedFileOpenKey
      openFileTab(file)
    }
  }, [files.data?.files, openFileTab, selectedFileOpenKey, selectedFilePath])

  useEffect(() => {
    tabButtonRefs.current.get(activeTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])

  useEffect(() => {
    const sha = pendingScrollShaRef.current
    if (!sha || subTab !== 'commits' || !commitsScrollRef.current) return
    const card = commitsScrollRef.current.querySelector(`[data-commit-sha="${sha}"]`)
    if (!card) return
    pendingScrollShaRef.current = null
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [subTab, commits])

  // ── Git actions ───────────────────────────────────────────────────────────
  const {
    gitActionPending,
    handleUndoCommit,
    handleRevertCommit,
    discardTarget,
    setDiscardTarget,
    discarding,
    handleConfirmDiscard,
  } = useGitActions({
    workspace,
    onCommitChanged: () => {
      setMobileCommitActions(null)
      setDesktopCommitActions(null)
      void gitHistory.refetch()
      void diff.refetch()
      void files.refetch()
    },
    onWorkingTreeChanged: () => {
      void diff.refetch()
      void files.refetch()
    },
  })

  const reviewView = (
    <div className="flex h-full min-h-0 flex-col">
      {diff.data?.is_git_repo && (
        <GitViewToolbar
          idBase={gitViewIdBase}
          subTab={subTab}
          onSubTabChange={setSubTab}
          changedCount={changedFiles.length}
          commitsAhead={commitsAhead}
          commitsBehind={commitsBehind}
          upstream={upstream}
          mobile={mobile}
          allExpanded={changedFiles.length > 0 ? allExpanded : null}
          onToggleExpandAll={toggleExpandAll}
          allBranches={allBranches}
          onAllBranchesChange={setAllBranches}
        />
      )}
      <div
        ref={commitsScrollRef}
        id={diff.data?.is_git_repo ? gitViewPanelId(gitViewIdBase) : undefined}
        role={diff.data?.is_git_repo ? 'tabpanel' : undefined}
        aria-labelledby={diff.data?.is_git_repo ? gitViewTabId(gitViewIdBase, subTab) : undefined}
        className="min-h-0 flex-1 overflow-auto touch-pan-y"
      >
        {subTab === 'changes' ? (
          <GitReviewSubPanel
            workspace={workspace}
            changedFiles={changedFiles}
            diffSections={diffSections}
            diff={diffView}
            files={filesView}
            selectedFilePath={selectedFilePath}
            expandedDiffs={expandedDiffs}
            toggleDiffExpanded={toggleDiffExpanded}
            openChangedFile={openChangedFile}
            openDiffTab={openDiffTab}
            mobile={mobile}
            setMobileFileActions={setMobileFileActions}
            setDesktopFileActions={setDesktopFileActions}
          />
        ) : (
          <CommitHistorySubPanel
            workspace={workspace}
            subTab={subTab}
            gitHistory={historyView}
            commits={commits}
            expandedCommitSha={expandedCommitSha}
            setExpandedCommitSha={setExpandedCommitSha}
            expandedCommitFiles={expandedCommitFiles}
            setExpandedCommitFiles={setExpandedCommitFiles}
            commitDiff={commitDiffView}
            commitChangedFiles={commitChangedFiles}
            commitDiffSections={commitDiffSections}
            parsedGraphLines={parsedGraphLines}
            commitsScrollRef={commitsScrollRef}
            pendingScrollShaRef={pendingScrollShaRef}
            setSubTab={setSubTab}
            openCommitTab={openCommitTab}
            mobile={mobile}
            setMobileCommitActions={setMobileCommitActions}
            setDesktopCommitActions={setDesktopCommitActions}
            setMobileFileActions={setMobileFileActions}
            setDesktopFileActions={setDesktopFileActions}
          />
        )}
      </div>
    </div>
  )

  return (
    <ResizableAside
      aria-label="Review dock"
      initial={mobile ? { opacity: 0 } : { width: 0 }}
      exit={mobile ? { opacity: 0 } : { width: 0 }}
      resize={dockResize}
      getMotion={dockMotion}
      onAnimationComplete={settleToggle}
      pinContentWidth
      className={cn(
        'fixed bottom-0 right-0 z-40 min-h-0 w-full overflow-hidden border-l border-(--color-border) bg-(--bg-page) shadow-(--shadow-depth) md:w-auto md:shadow-none',
        // Overlay covers the chat column (kept mounted underneath); side mode
        // is an in-flow sibling that takes its ratio of the center.
        overlay
          ? 'md:absolute md:inset-y-0 md:right-0 md:z-20'
          : 'md:relative md:inset-y-auto md:right-auto md:z-auto md:shrink-0',
        mobile ? 'mobile-safe-top max-w-none' : 'h-full',
        !open && 'pointer-events-none',
        parked && 'invisible',
      )}
    >
      <div data-review-dock data-dock-parked={parked || undefined} inert={parked} className="relative flex h-full min-h-0 w-full flex-col">
        {!mobile && !overlay && open && <PanelResizeHandle edge="left" />}
        <DockTabBar
          tabs={visibleTabs}
          activeTabId={activeTabId}
          workspace={workspace}
          terminalMetas={terminalMetas}
          mobile={mobile}
          os={os}
          registerTabRef={(id, node) => {
            if (node) tabButtonRefs.current.set(id, node)
            else tabButtonRefs.current.delete(id)
          }}
          onActivate={setActiveTabId}
          onClose={closeTab}
          onCloseOthers={closeOtherTabs}
          onCloseToRight={closeTabsToRight}
          onMove={moveTab}
          onNewTerminal={openTerminal}
          onNewPreview={previewsAvailable ? openNewPreview : undefined}
          onRefresh={handleRefresh}
          maximized={maximizeState}
          onToggleMaximized={() => useLayoutStore.getState().toggleDockMaximized()}
        />
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* Preview tabs stay mounted so the page and its comments survive tab switches. */}
          {previewTabs.map((tab) => (
            <div key={tab.id} className={cn('absolute inset-0', activeTab?.id !== tab.id && 'hidden')}>
              <PreviewTabView
                workspace={workspace}
                tabId={tab.id}
                target={tab.target}
                navKey={tab.navKey}
                onPreviewId={handlePreviewId}
                onSendComments={onSendPreviewComments}
                onOpenTarget={openPreviewTarget}
                active={open && activeTab?.id === tab.id}
                onRequestClose={closeTab}
              />
            </div>
          ))}
          {!chatWorkspace && activeTab?.type === 'review' ? (
            reviewView
          ) : activeTab?.type === 'file' ? (
            <FilePreviewSubPanel
              workspace={workspace}
              file={resolveFileTabInfo(activeTab.file, filesByPath.get(activeTab.file.path), changedPaths.get(activeTab.file.path))}
              onAddComment={onAddComment}
              onOpenPreview={previewsAvailable && !chatWorkspace ? openFilePreview : undefined}
            />
          ) : activeTab?.type === 'diff' ? (
            <DiffTabView key={activeTab.id} workspace={workspace} path={activeTab.path} onOpenFile={openChangedFile} />
          ) : activeTab?.type === 'commit' ? (
            <CommitTabView key={activeTab.id} workspace={workspace} commit={activeTab.commit} />
          ) : activeTab?.type === 'terminal' ? (
            // Unmounted while closed: the session lives in the terminal store,
            // and a hidden terminal detaches so the idle reaper can close it.
            open ? <TerminalSubPanel key={activeTab.termId} termId={activeTab.termId} workspace={workspace} /> : null
          ) : activeTab?.type === 'tasks' ? (
            <TasksTabView todos={todos} sessionId={sessionId} plan={plan} onClearPlan={onClearPlan} onOpenPlan={() => openTab(PLAN_TAB)} />
          ) : activeTab?.type === 'plan' ? (
            <PlanTabView plan={plan} sessionId={sessionId} onClearPlan={onClearPlan} onOpenFile={openChangedFile} />
          ) : activeTab?.type === 'schedule' ? (
            <SchedulerDockView contextWorkspace={chatWorkspace ? null : workspace} />
          ) : activeTab?.type === 'preview' ? (
            null
          ) : (
            <DockLauncher
              os={os}
              onOpenGit={chatWorkspace ? undefined : openGitTab}
              onOpenTerminal={openTerminal}
              onOpenPreview={previewsAvailable ? openNewPreview : undefined}
              onOpenFile={mobile ? undefined : () => useUIStore.getState().openQuickOpen('')}
            />
          )}
        </div>
        <CloseTerminalDialog
          open={confirmCloseOpen}
          title={confirmCloseTitles.length > 0 ? confirmCloseTitles.join(', ') : 'This terminal'}
          count={confirmCloseTitles.length}
          onConfirm={confirmCloseTab}
          onCancel={cancelCloseTab}
        />
        <DockActionMenus
          mobileFileActions={mobileFileActions}
          setMobileFileActions={setMobileFileActions}
          desktopFileActions={desktopFileActions}
          setDesktopFileActions={setDesktopFileActions}
          mobileCommitActions={mobileCommitActions}
          setMobileCommitActions={setMobileCommitActions}
          desktopCommitActions={desktopCommitActions}
          setDesktopCommitActions={setDesktopCommitActions}
          isLatestCommit={isLatestCommit}
          gitActionPending={gitActionPending}
          hasWorkingDiff={(path) => changedPaths.has(path)}
          onOpenFile={openChangedFile}
          onOpenDiffTab={openDiffTab}
          onOpenCommitTab={openCommitTabBySha}
          onUndoCommit={handleUndoCommit}
          onRevertCommit={handleRevertCommit}
          discardTarget={discardTarget}
          setDiscardTarget={setDiscardTarget}
          discarding={discarding}
          onConfirmDiscard={() => void handleConfirmDiscard()}
        />
      </div>
    </ResizableAside>
  )
}
