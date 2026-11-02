/**
 * WorkspacePanel — the review dock.
 *
 * Editor-style tab strips (Git review, file previews, full-height diffs,
 * commits, web previews, terminals, the session's Plan and Goal, and on
 * desktop the agent Tasks, `/btw` side questions, and Schedule views)
 * over their content, in panes split right and down as often as there is
 * room (⌘\, ⌘⇧\, or a tab dragged onto a pane's edge; a terminal is a tab
 * like any other). Desktop geometry is a ratio of the shell's center
 * region (measured here from ``centerRef``) in ``side`` mode, or the whole
 * center in ``overlay`` mode (maximized, or a window too narrow for a
 * side-by-side split; then it leaves the composer uncovered unless
 * maximized). Mobile keeps the fixed full-screen sheet with one strip.
 *
 * Tab state lives in ``useDockTabs`` (remembered per session) and Git write actions in
 * ``useGitActions``; this component owns the queries and the layout.
 *
 * Once opened, the shell keeps the dock mounted: closing it (``open``
 * false) tweens it shut and then parks it hidden and inert, so its tabs,
 * the last active tab, preview pages and their unsent comments, and scroll
 * positions are all there when it reopens. Queries pause while it is closed.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getCodingWorkspaceStatus,
  getCodingWorkspaceGitHistory,
} from '@/api/client'
import { Columns2, Rows2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { useToastStore } from '@/stores/useToastStore'
import { queryKeys } from '@/queries'
import {
  WORKSPACE_TREE_STALE_MS,
  workspaceFileListQueryOptions,
} from '@/queries/workspace-files'
import {
  COMMIT_DIFF_STALE_MS,
  WORKSPACE_DIFF_STALE_MS,
  commitDiffQueryOptions,
  workspaceChangesQueryOptions,
} from '@/queries/workspace-git'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { PANEL_SLIDE_MS, PanelResizeHandle, ResizableAside, settledWidthBesidePanels, type LiveWidth } from '@/components/ResizableAside'
import { useToggleTween } from '@/hooks/useToggleTween'
import { useClaimStrandedFocus } from '@/hooks/use-dock-focus'
import { focusQuietly } from '@/lib/focus/quiet'
import { useElementWidth } from '@/hooks/use-element-width'
import { usePlatform } from '@/hooks/use-platform'
import { useTouchFirst } from '@/hooks/use-touch-first'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import {
  DOCK_MIN_WIDTH,
  DOCK_PANE_MIN_HEIGHT,
  DOCK_PANE_MIN_WIDTH,
  dockMaxWidth,
  ratioFromWidth,
  resolveDockLayout,
} from '@/lib/workbench-layout'
import { useGitPanelStore, DEFAULT_WORKSPACE_STATE } from '@/stores/useGitPanelStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useGoalControls, useSessionGoalQuery } from '@/queries/useSessionGoalQuery'
import { goalTabTitle } from '@/lib/goal'
import type { SessionPlan, TodoItem, WorkspaceFileInfo } from '@/api/types'
import { type PreviewTarget, closePreview, lastPreviewUrl, previewsAvailable } from '@/api/preview'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import {
  type ChangedFileStatus,
  type ChangedFileInfo,
  type DiffFileSection,
  changedFilesFromResponse,
  collectChangedFiles,
  collectDiffSections,
} from './WorkspacePanel/diff-helpers'
import { GitReviewSubPanel } from './WorkspacePanel/GitReviewSubPanel'
import { CommitHistorySubPanel } from './WorkspacePanel/CommitHistorySubPanel'
import { TerminalSubPanel } from './WorkspacePanel/TerminalSubPanel'
import { FilePreviewSubPanel } from './WorkspacePanel/FilePreviewSubPanel'
import { DiffTabView } from './WorkspacePanel/DiffTabView'
import { CommitTabView } from './WorkspacePanel/CommitTabView'
import { TasksTabView } from './WorkspacePanel/TasksTabView'
import { SideQuestionsTabView } from './WorkspacePanel/SideQuestionsTabView'
import type { DesignFeedback } from '@/lib/design-feedback'
import { DockTabBar } from './WorkspacePanel/DockTabBar'
import { PaneSplitHandle } from './WorkspacePanel/PaneSplitHandle'
import { lazySurface } from '@/lib/lazy-surface'
import { DockLauncher, dockOpenItems, type DockOpenItem } from './WorkspacePanel/DockLauncher'
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
  type AttachmentTabRequest,
  type DiffTabRequest,
  type DockLayoutRequest,
  type DockTab,
  type DockView,
  type DockViewRequest,
  type PreviewTabRequest,
  BTW_TAB,
  GOAL_TAB,
  PLAN_TAB,
  REVIEW_TAB_ID,
  SCHEDULE_TAB,
  TASKS_TAB,
  basename,
  fileTabId,
  resolveFileTabInfo,
} from './WorkspacePanel/dock-tabs'
import {
  type Axis,
  type PaneBox,
  type PaneId,
  type PaneLayout,
  type SplitBar,
  isPaneLeaf,
  layoutBoxes,
  paneOrder,
  sizesWithBarAt,
} from './WorkspacePanel/dock-panes'

// Kept out of the startup bundle; prefetched while the app is idle.
const SchedulerDockView = lazySurface(() => import('./SchedulerPanel/SchedulerDockView'), 'SchedulerDockView')
const PreviewTabView = lazySurface(() => import('./Preview/PreviewTabView'), 'PreviewTabView')
const AttachmentTabView = lazySurface(() => import('./WorkspacePanel/AttachmentTabView'), 'AttachmentTabView')
const PlanTabView = lazySurface(() => import('./WorkspacePanel/PlanTabView'), 'PlanTabView')
const GoalTabView = lazySurface(() => import('./WorkspacePanel/GoalTabView'), 'GoalTabView')

export type { ChangedFileStatus, ChangedFileInfo, DiffFileSection }

const EMPTY_TODOS: TodoItem[] = []
/** Dev server a new preview tab opens when the workspace has no last URL. */
const DEFAULT_PREVIEW_URL = 'http://localhost:5173'
/** Stable empty ref: with no center element the width falls back to the viewport. */
const NO_CENTER: React.RefObject<HTMLElement | null> = { current: null }
/** A closed dock parks (hidden, inert) once its close tween (0.22 s) is done. */
const PARK_AFTER_MS = 260

/**
 * A pane's place over the panes' area (``top``: an inset from its top, the
 * tab strip for a preview page). The hairline before a pane belongs to the
 * bar there, so the pane starts 1px in.
 */
function paneStyle(box: PaneBox, top = '0px'): React.CSSProperties {
  const x = box.left > 0 ? 1 : 0
  const y = box.top > 0 ? 1 : 0
  return {
    left: `calc(${box.left * 100}% + ${x}px)`,
    top: `calc(${box.top * 100}% + ${y}px + ${top})`,
    width: `calc(${box.width * 100}% - ${x}px)`,
    height: `calc(${box.height * 100}% - ${y}px - ${top})`,
  }
}

/** A bar's 7px hit area, centred on the line between two panes. */
function barStyle(bar: SplitBar): React.CSSProperties {
  const { box, at } = bar
  return bar.axis === 'row'
    ? { left: `calc(${(box.left + at * box.width) * 100}% - 3px)`, top: `${box.top * 100}%`, height: `${box.height * 100}%` }
    : { top: `calc(${(box.top + at * box.height) * 100}% - 3px)`, left: `${box.left * 100}%`, width: `${box.width * 100}%` }
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
  attachmentRequest = null,
  handledAttachmentRequestKeyRef,
  layoutRequest = null,
  handledLayoutRequestKeyRef,
  launcherFocusKey = 0,
  handledLauncherFocusKeyRef: parentHandledLauncherFocusKeyRef,
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
  slideIn = false,
}: {
  workspace: string
  open: boolean
  /**
   * Mounted by the show toggle (not open from the start): slide in from 0
   * like a later open, instead of appearing at full width.
   */
  slideIn?: boolean
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
  /** Shell request to open (or focus) a message attachment's tab. */
  attachmentRequest?: AttachmentTabRequest | null
  handledAttachmentRequestKeyRef?: React.RefObject<number>
  /** Shell request to split the focused pane or show/hide the terminal panes. */
  layoutRequest?: DockLayoutRequest | null
  handledLayoutRequestKeyRef?: React.RefObject<number>
  /**
   * Grows when the user opens the panel (⌘D, the header button): if it opens
   * empty, the launcher's first row takes focus. Parent-owned handled key,
   * so a remount does not replay it.
   */
  launcherFocusKey?: number
  handledLauncherFocusKeyRef?: React.RefObject<number>
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
  const panesRef = useRef<HTMLDivElement>(null)
  const pushToast = useToastStore((s) => s.push)
  // A split needs room for two panes of the least size.
  const canSplitPane = useCallback((pane: PaneId, axis: Axis) => {
    const rect = panesRef.current?.querySelector(`[data-dock-pane="${pane}"]`)?.getBoundingClientRect()
    if (!rect || rect.width === 0) return true
    return axis === 'row' ? rect.width >= DOCK_PANE_MIN_WIDTH * 2 : rect.height >= DOCK_PANE_MIN_HEIGHT * 2
  }, [])
  const noRoomToSplit = useCallback(() => {
    pushToast({ tone: 'info', title: 'No room to split this pane', description: 'Widen or maximize the Review panel, or close a pane.' })
  }, [pushToast])
  const {
    state: panes,
    shownPanes,
    strips,
    activeTabs,
    focused,
    visibleTabs,
    activeTabId,
    terminalMetas,
    openTab,
    openFileTab,
    openDiffTab,
    openCommitTab,
    openPreviewTab,
    openGitTab,
    openTerminal,
    activate,
    focusPane,
    keep,
    moveWithin,
    moveToNextPane,
    canMoveToNextPane,
    canSplitTab,
    splitPane,
    dropTab,
    closePane,
    resizeSplit,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    closeTabsToLeft,
    closeAllTabs,
    confirmCloseOpen,
    confirmCloseTitles,
    confirmCloseTab,
    cancelCloseTab,
  } = useDockTabs({
    workspace,
    sessionId,
    mobile,
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
    attachmentRequest,
    handledAttachmentRequestKeyRef,
    layoutRequest,
    handledLayoutRequestKeyRef,
    onTabClosed: handleTabClosed,
    focusTab: (id) => requestAnimationFrame(() => {
      const button = tabButtonRefs.current.get(id)
      if (button) focusQuietly(button)
    }),
    onCloseDock: onRequestClose,
    canSplitPane,
    onNoRoomToSplit: noRoomToSplit,
  })
  const [mobileFileActions, setMobileFileActions] = useState<ChangedFileInfo | null>(null)
  const [mobileCommitActions, setMobileCommitActions] = useState<CommitActionTarget | null>(null)
  const [desktopCommitActions, setDesktopCommitActions] = useState<(CommitActionTarget & { x: number; y: number }) | null>(null)
  const [desktopFileActions, setDesktopFileActions] = useState<{ file: ChangedFileInfo; x: number; y: number } | null>(null)
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const commitsScrollRef = useRef<HTMLDivElement>(null)
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
  // Whether the open or close tween (mounting counts as opening on a phone)
  // is still running. Only then, and while closed, is the body pinned to the
  // open width; any other width change moves the body with the dock's edge.
  // The phone sheet settles on its animation's end; desktop slides its width
  // with a CSS transition for a fixed time (``useToggleTween``).
  const [toggle, setToggle] = useState({ open, running: mobile })
  if (toggle.open !== open) setToggle({ open, running: mobile })
  const settleToggle = () => setToggle((current) => (current.running ? { ...current, running: false } : current))
  // Mounted by the toggle: lay out one frame at 0 wide, so the width has a
  // start to slide from (layout is flushed before the second render).
  const [entering, setEntering] = useState(slideIn && open && !mobile)
  useLayoutEffect(() => {
    if (!entering) return
    void document.body.getBoundingClientRect()
    setEntering(false)
  }, [entering])
  const shownOpen = open && !entering
  const sliding = useToggleTween(shownOpen, PANEL_SLIDE_MS) && !mobile

  // ── Geometry ───────────────────────────────────────────────────────────────
  const dockRatio = useLayoutStore((s) => s.dockRatio)
  const dockMaximized = useLayoutStore((s) => s.dockMaximized)
  const measuredCenter = useElementWidth(centerRef, settledWidthBesidePanels)
  const center = centerWidth ?? measuredCenter
  const touch = useTouchFirst()
  const layout = resolveDockLayout({ centerWidth: center, ratio: dockRatio, maximized: dockMaximized, touch })
  const overlay = !mobile && layout.mode === 'overlay'
  const dockResize = {
    width: layout.width,
    min: DOCK_MIN_WIDTH,
    max: dockMaxWidth(center, { touch }),
    edge: 'left' as const,
    onCommit: (width: number) => useLayoutStore.getState().setDockRatio(ratioFromWidth(width, center)),
    onReset: () => useLayoutStore.getState().resetDockRatio(),
    disabled: mobile || overlay || !open,
    label: 'Resize Review panel',
  }
  // Desktop sets the width as a style and slides it only while showing or
  // hiding (never for a drag or a window resize). Closed or sliding, the
  // body keeps its open width, clipped rather than reflowed, so it rides
  // the moving edge. The phone sheet fades and follows a swipe.
  const dockMotion = ({ width, isResizing }: LiveWidth) => ({
    animate: !shownOpen
      ? (mobile ? { opacity: 0 } : { width: 0 })
      : !mobile
        ? { width: overlay ? layout.width : width }
        : prefersReducedMotion
          ? { opacity: 1 }
          : mobileDragOffset !== null ? { opacity: 1, x: mobileDragOffset } : { opacity: 1, x: 0 },
    transition: mobile && mobileDragOffset !== null
      ? { duration: 0 }
      : { duration: !mobile || isResizing || prefersReducedMotion ? 0.01 : DURATIONS_S.base, ease: EASINGS.inOut },
    pinWidth: !mobile && (!open || toggle.running || sliding) ? (overlay ? layout.width : width) : undefined,
    instantWidth: !mobile,
    tweenWidth: sliding,
  })
  // The toggle is meaningless while a narrow window already forces overlay.
  const maximizeState = mobile || (overlay && !dockMaximized) ? null : dockMaximized
  // Covering the chat makes it inert, which drops its focus onto <body>:
  // take it on the active tab, or the launcher's first row when empty.
  useClaimStrandedFocus(open && overlay, activeTabId, () =>
    tabButtonRefs.current.get(activeTabId) ?? document.querySelector<HTMLElement>('[data-dock-launcher] button'))
  // Opened by the user with nothing in it, the launcher is the choice to
  // make: its first row takes focus, so ↓ and Return pick. Not when the
  // panel comes back open with the window, nor when it opens on a tab.
  const localHandledLauncherFocusKeyRef = useRef(0)
  const handledLauncherFocusKeyRef = parentHandledLauncherFocusKeyRef ?? localHandledLauncherFocusKeyRef
  const tabCountRef = useRef(visibleTabs.length)
  tabCountRef.current = visibleTabs.length
  useEffect(() => {
    if (!open || !launcherFocusKey || handledLauncherFocusKeyRef.current === launcherFocusKey) return
    let frame = requestAnimationFrame(() => {
      // A second frame: a view request's tab lands in the render after this one.
      frame = requestAnimationFrame(() => {
        // Marked here, not before: a cancelled run (Strict Mode) must not use it up.
        handledLauncherFocusKeyRef.current = launcherFocusKey
        if (tabCountRef.current > 0) return
        const row = document.querySelector<HTMLElement>('[data-dock-launcher] button')
        if (row && !row.closest('[inert]')) row.focus()
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, launcherFocusKey, handledLauncherFocusKeyRef])

  // ── Server state ──────────────────────────────────────────────────────────
  const files = useQuery({
    ...workspaceFileListQueryOptions(workspace),
    enabled: open,
    staleTime: WORKSPACE_TREE_STALE_MS,
  })
  // The changed paths only; each file's diff body loads when it is expanded
  // or opened in a tab (see ``workspace-git.ts``).
  const changes = useQuery({
    ...workspaceChangesQueryOptions(workspace),
    enabled: open && !chatWorkspace,
    staleTime: WORKSPACE_DIFF_STALE_MS,
  })
  const queryClient = useQueryClient()
  /** Refetch the changed paths and every diff body on screen. */
  const refreshChanges = useCallback(() => {
    void changes.refetch()
    void queryClient.invalidateQueries({ queryKey: queryKeys.coding.diff(workspace) })
  }, [changes, queryClient, workspace])
  const workspaceStatus = useQuery({
    queryKey: queryKeys.coding.status(workspace),
    queryFn: ({ signal }) => getCodingWorkspaceStatus(workspace, signal),
    enabled: open && !chatWorkspace,
    staleTime: 10_000,
  })
  const changedFiles = useMemo(() => changedFilesFromResponse(changes.data), [changes.data])
  // Working-tree status per changed path; ``has`` doubles as "is changed".
  const changedPaths = useMemo(() => new Map(changedFiles.map((file) => [file.path, file.status])), [changedFiles])
  const filesByPath = useMemo(() => new Map((files.data?.files ?? []).map((file) => [file.path, file])), [files.data?.files])

  const gitState = useGitPanelStore((s) => s.workspaces[workspace] || DEFAULT_WORKSPACE_STATE)
  const subTab = gitState.subTab
  // Git's own queries run only while its tab shows in a pane on screen.
  const reviewShown = shownPanes.some((pane) => activeTabs[pane]?.id === REVIEW_TAB_ID)
  // Each Git view (changes, commits) keeps its place across tab switches.
  const rememberReviewScroll = useScrollMemory(`review:${workspace}:${subTab}`, commitsScrollRef)
  const expandedCommitSha = gitState.expandedCommitSha
  const expandedDiffs = useMemo(() => new Set(gitState.expandedDiffs), [gitState.expandedDiffs])
  const expandedCommitFiles = useMemo(() => new Set(gitState.expandedCommitFiles), [gitState.expandedCommitFiles])

  // Stable setters (read the store at call time) so the memoized Git list
  // views below are not re-rendered by a fresh callback on every dock render.
  const setSubTab = useCallback((tab: GitSubTab) => useGitPanelStore.getState().setSubTab(workspace, tab), [workspace])
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
  const gitHistory = useInfiniteQuery({
    queryKey: queryKeys.coding.history(workspace, historyLimit),
    queryFn: ({ pageParam, signal }) => getCodingWorkspaceGitHistory(workspace, historyLimit, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? null,
    enabled: open && !chatWorkspace && reviewShown && subTab === 'commits',
    staleTime: 10_000,
  })

  const commits = useMemo(() => gitHistory.data?.pages.flatMap((page) => page.commits) ?? [], [gitHistory.data?.pages])

  const isLatestCommit = useMemo(() => {
    const activeSha = mobileCommitActions?.sha ?? desktopCommitActions?.sha
    if (!activeSha || commits.length === 0) return false
    return activeSha === commits[0].sha
  }, [mobileCommitActions, desktopCommitActions, commits])

  const commitsAhead = workspaceStatus.data?.commits_ahead ?? null
  const commitsBehind = workspaceStatus.data?.commits_behind ?? null
  const upstream = workspaceStatus.data?.upstream ?? null

  const commitDiff = useQuery({
    ...commitDiffQueryOptions(workspace, expandedCommitSha ?? ''),
    enabled: open && !chatWorkspace && reviewShown && subTab === 'commits' && expandedCommitSha !== null,
    staleTime: COMMIT_DIFF_STALE_MS,
  })
  const commitDiffText = commitDiff.data?.diff

  // React Query hands back a new result object every render; the list views
  // get memoized slices of the fields they read so ``memo`` can skip them.
  // ``isFetching`` matters only to a failed list's Retry; reading it always
  // would re-render the rows on every background refetch.
  const changesRetrying = changes.isError && changes.isFetching
  const changesView = useMemo(
    () => ({ isLoading: changes.isLoading, isError: changes.isError, isFetching: changesRetrying, refetch: changes.refetch, data: changes.data }),
    [changes.isLoading, changes.isError, changesRetrying, changes.refetch, changes.data],
  )
  const filesView = useMemo(() => ({ isLoading: files.isLoading, data: files.data }), [files.isLoading, files.data])
  const { isLoading: historyLoading, isError: historyError, isFetchingNextPage, hasNextPage, fetchNextPage, refetch: refetchHistory, data: historyData } = gitHistory
  const historyFetching = historyError && gitHistory.isFetching
  const historyView = useMemo(
    () => ({ isLoading: historyLoading, isError: historyError, isFetching: historyFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch: refetchHistory, data: historyData }),
    [historyLoading, historyError, historyFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetchHistory, historyData],
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
  // Files, diffs and commits opened from a list or a link are previews: the
  // next one replaces them until they are kept (double-click, Keep Open).
  /** Open a changed path, synthesising file info when the listing lacks it. */
  const openChangedFile = useCallback((path: string) => {
    const file = filesByPath.get(path) ?? { path, name: basename(path), size: 0, mtime: 0, mime: 'text/plain' }
    openFileTab(file, { preview: true })
  }, [filesByPath, openFileTab])
  const isListedFile = useCallback((path: string) => filesByPath.has(path), [filesByPath])
  const openDiffPreview = useCallback((file: ChangedFileInfo) => openDiffTab(file, { preview: true }), [openDiffTab])
  const openCommitPreview = useCallback((commit: Parameters<typeof openCommitTab>[0]) => openCommitTab(commit, { preview: true }), [openCommitTab])

  const openCommitTabBySha = (sha: string) => {
    const commit = commits.find((item) => item.sha === sha)
    if (commit) openCommitPreview(commit)
  }

  const canPreview = previewsAvailable()
  const openNewPreview = useCallback((pane?: PaneId) => {
    openPreviewTab({ kind: 'url', url: lastPreviewUrl(workspace) ?? DEFAULT_PREVIEW_URL }, { pane })
  }, [openPreviewTab, workspace])
  const openFilePreview = useCallback((path: string) => {
    openPreviewTab({ kind: 'file', path })
  }, [openPreviewTab])
  const openPreviewTarget = useCallback((target: PreviewTarget) => openPreviewTab(target), [openPreviewTab])
  const openQuickOpen = () => useUIStore.getState().openQuickOpen('')
  // The Goal tab's title follows the goal ("Goal 7/50", "Goal paused").
  const { data: goalData } = useSessionGoalQuery(sessionId)
  const goal = goalData?.goal ?? null
  const goalControls = useGoalControls(sessionId)
  const agentWorking = useAgentStore((s) => s.isAgentWorking)
  const goalTitle = goalTabTitle(goal, agentWorking)
  const stripTabs = useMemo(
    () => Object.fromEntries(Object.entries(strips).map(([pane, strip]) => [pane, strip.some((tab) => tab.type === 'goal' && tab.title !== goalTitle)
      ? strip.map((tab) => (tab.type === 'goal' ? { ...tab, title: goalTitle } : tab))
      : strip])) as Record<PaneId, DockTab[]>,
    [strips, goalTitle],
  )
  const openGoal = sessionId ? (pane?: PaneId) => openTab(GOAL_TAB, { pane }) : undefined
  // The tab strip's "+" menu: every view and tool this dock can open, so one
  // is a tap away while other tabs are open. Tasks and side questions open
  // above the chat on phones, so only desktop lists them here; the plan and
  // the goal open here everywhere. Each pane's menu opens in that pane.
  const openIds = new Set(visibleTabs.map((tab) => tab.id))
  const openItemsFor = (pane: PaneId) => dockOpenItems(os, {
    onOpenGit: chatWorkspace ? undefined : () => openGitTab(pane),
    onOpenGoal: openGoal ? () => openGoal(pane) : undefined,
    onOpenPlan: plan ? () => openTab(PLAN_TAB, { pane }) : undefined,
    onOpenTasks: mobile ? undefined : () => openTab(TASKS_TAB, { pane }),
    onOpenSideQuestions: mobile || !sessionId ? undefined : () => openTab(BTW_TAB, { pane }),
    onOpenSchedule: () => openTab(SCHEDULE_TAB, { pane }),
    onOpenTerminal: () => openTerminal(pane),
    onOpenPreview: canPreview ? () => openNewPreview(pane) : undefined,
    onOpenFile: openQuickOpen,
  }, openIds)
  // The "+" menu ends with the pane's splits (desktop): a new empty pane beside it.
  const menuItemsFor = (pane: PaneId): DockOpenItem[] => mobile ? openItemsFor(pane) : [
    ...openItemsFor(pane),
    { id: 'split-right', label: 'Split Right', icon: <Columns2 size={14} aria-hidden="true" />, shortcut: shortcutLabel(APP_SHORTCUTS.splitDock, os), group: 'pane', run: () => splitPane(pane, 'right') },
    { id: 'split-down', label: 'Split Down', icon: <Rows2 size={14} aria-hidden="true" />, shortcut: shortcutLabel(APP_SHORTCUTS.splitDockDown, os), group: 'pane', run: () => splitPane(pane, 'down') },
  ]

  const handleRefresh = useCallback(() => {
    void files.refetch()
    if (chatWorkspace) return
    refreshChanges()
    void workspaceStatus.refetch()
    if (subTab === 'commits') {
      void gitHistory.refetch()
    }
  }, [files, refreshChanges, workspaceStatus, gitHistory, subTab, chatWorkspace])

  const toggleDiffExpanded = useCallback((path: string) => {
    useGitPanelStore.getState().toggleDiffExpanded(workspace, path)
  }, [workspace])
  const allExpanded = changedFiles.length > 0 && changedFiles.every((f) => expandedDiffs.has(f.path))
  const toggleExpandAll = () => {
    useGitPanelStore.getState().setExpandedDiffs(workspace, allExpanded ? [] : changedFiles.map((f) => f.path))
  }

  // Expansions persist per workspace; forget files that are no longer
  // changed so a later edit to them does not reopen as a stale peek and the
  // stored list does not grow forever. A capped list (over 5,000 files)
  // cannot prove a path is gone.
  useEffect(() => {
    if (!changes.data?.is_git_repo || changes.data.truncated) return
    const stored = useGitPanelStore.getState().workspaces[workspace]?.expandedDiffs ?? []
    const kept = stored.filter((path) => changedPaths.has(path))
    if (kept.length !== stored.length) useGitPanelStore.getState().setExpandedDiffs(workspace, kept)
  }, [changes.data, changedPaths, workspace])

  useEffect(() => {
    if (handledFileOpenKeyRef.current === selectedFileOpenKey) return
    if (!selectedFilePath) return
    if (files.data?.files == null) return
    const file = files.data.files.find((item) => item.path === selectedFilePath)
    if (file) {
      handledFileOpenKeyRef.current = selectedFileOpenKey
      openFileTab(file, { preview: true })
    }
  }, [files.data?.files, openFileTab, selectedFileOpenKey, selectedFilePath])

  useEffect(() => {
    for (const tab of Object.values(activeTabs)) tabButtonRefs.current.get(tab?.id ?? '')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabs, visibleTabs.length])

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
      refreshChanges()
      void files.refetch()
    },
    onWorkingTreeChanged: () => {
      refreshChanges()
      void files.refetch()
    },
  })

  const reviewView = (
    <div className="flex h-full min-h-0 flex-col">
      {changes.data?.is_git_repo && (
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
        />
      )}
      <div
        ref={rememberReviewScroll}
        id={changes.data?.is_git_repo ? gitViewPanelId(gitViewIdBase) : undefined}
        role={changes.data?.is_git_repo ? 'tabpanel' : undefined}
        aria-labelledby={changes.data?.is_git_repo ? gitViewTabId(gitViewIdBase, subTab) : undefined}
        // Vertical only: ``overflow: auto`` lets one over-wide row pan the
        // whole list sideways.
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto touch-pan-y"
      >
        {subTab === 'changes' ? (
          <GitReviewSubPanel
            workspace={workspace}
            changedFiles={changedFiles}
            changes={changesView}
            files={filesView}
            selectedFilePath={selectedFilePath}
            expandedDiffs={expandedDiffs}
            toggleDiffExpanded={toggleDiffExpanded}
            openDiffTab={openDiffPreview}
            mobile={mobile}
            setMobileFileActions={setMobileFileActions}
            setDesktopFileActions={setDesktopFileActions}
          />
        ) : (
          <CommitHistorySubPanel
            workspace={workspace}
            gitHistory={historyView}
            commits={commits}
            expandedCommitSha={expandedCommitSha}
            setExpandedCommitSha={setExpandedCommitSha}
            expandedCommitFiles={expandedCommitFiles}
            setExpandedCommitFiles={setExpandedCommitFiles}
            commitDiff={commitDiffView}
            commitChangedFiles={commitChangedFiles}
            commitDiffSections={commitDiffSections}
            commitsScrollRef={commitsScrollRef}
            openCommitTab={openCommitPreview}
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

  // ── Panes ─────────────────────────────────────────────────────────────────
  // Maximize (⌘⇧D) grows the whole panel: every pane stays on screen.
  const onScreen = useMemo(() => new Set(shownPanes), [shownPanes])
  const many = onScreen.size > 1
  // A bar being dragged: its split's sizes until the drop.
  const [liveSizes, setLiveSizes] = useState<{ key: string; sizes: number[] } | null>(null)
  const { panes: boxes, bars } = useMemo(
    () => layoutBoxes(panes.layout, onScreen, (key) => (liveSizes?.key === key ? liveSizes.sizes : undefined)),
    [panes.layout, onScreen, liveSizes],
  )
  // Panes in the order they were made, so a split never moves one in the
  // DOM (a moved iframe reloads); F6 follows the layout (``data-focus-order``).
  const paneIds = useMemo(() => Object.keys(panes.panes).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), [panes.panes])
  const layoutIndex = useMemo(() => new Map(paneOrder(panes.layout).map((id, index) => [id, index])), [panes.layout])
  // The panel-wide Maximize sits on the top-right pane, as in an editor.
  const cornerPane = useMemo(() => {
    let best: PaneId | null = null
    let right = -1
    for (const [pane, box] of boxes) {
      if (box.top === 0 && box.left + box.width > right + 1e-9) {
        best = pane
        right = box.left + box.width
      }
    }
    return best
  }, [boxes])

  const splitAt = (path: readonly number[]): Extract<PaneLayout, { axis: Axis }> | null => {
    let node: PaneLayout = panes.layout
    for (const index of path) {
      if (isPaneLeaf(node)) return null
      node = node.children[index]
    }
    return isPaneLeaf(node) ? null : node
  }
  /** A bar's split on screen, in px, and the least share a pane keeps there. */
  const barExtent = (bar: SplitBar) => {
    const rect = panesRef.current?.getBoundingClientRect()
    if (!rect) return null
    const row = bar.axis === 'row'
    const start = row ? rect.left + bar.box.left * rect.width : rect.top + bar.box.top * rect.height
    const size = row ? bar.box.width * rect.width : bar.box.height * rect.height
    return size > 0 ? { start, size, min: (row ? DOCK_PANE_MIN_WIDTH : DOCK_PANE_MIN_HEIGHT) / size } : null
  }
  const dragBar = (bar: SplitBar, clientX: number, clientY: number, done: boolean) => {
    const node = splitAt(bar.path)
    const extent = barExtent(bar)
    if (!node || !extent) return
    const at = ((bar.axis === 'row' ? clientX : clientY) - extent.start) / extent.size
    const sizes = sizesWithBarAt(node.sizes, bar, at, extent.min)
    if (!done) {
      setLiveSizes({ key: bar.path.join('.'), sizes })
      return
    }
    setLiveSizes(null)
    resizeSplit(bar.path, sizes)
  }
  const stepBar = (bar: SplitBar, px: number) => {
    const node = splitAt(bar.path)
    const extent = barExtent(bar)
    if (node && extent) resizeSplit(bar.path, sizesWithBarAt(node.sizes, bar, bar.at + px / extent.size, extent.min))
  }
  /** Double-click or Enter: the panes of that split share its room evenly. */
  const evenOut = (bar: SplitBar) => {
    const node = splitAt(bar.path)
    if (!node) return
    const share = bar.shown.reduce((total, index) => total + node.sizes[index], 0) / bar.shown.length
    resizeSplit(bar.path, node.sizes.map((size, index) => (bar.shown.includes(index) ? share : size)))
  }

  /** Reveal in Git: the Changes list with this file's diff open. */
  const revealInGit = useCallback((path: string) => {
    const store = useGitPanelStore.getState()
    store.setSubTab(workspace, 'changes')
    const expanded = store.workspaces[workspace]?.expandedDiffs ?? []
    if (!expanded.includes(path)) store.setExpandedDiffs(workspace, [...expanded, path])
    openGitTab()
  }, [openGitTab, workspace])

  // An edit (a comment on its lines) keeps a preview tab.
  const handleAddComment = useCallback((path: string, startLine: number, endLine: number) => {
    keep(fileTabId(path))
    onAddComment?.(path, startLine, endLine)
  }, [keep, onAddComment])

  const refreshLabelFor = (tab: DockTab | undefined) =>
    tab?.type === 'review' || tab?.type === 'diff' || tab?.type === 'commit'
      ? chatWorkspace ? 'Refresh files' : 'Refresh Git status'
      : tab?.type === 'file'
        ? 'Refresh files'
        : null

  const renderContent = (tab: DockTab | undefined, pane: PaneId, paneShown: boolean) => {
    if (!chatWorkspace && tab?.type === 'review') return reviewView
    switch (tab?.type) {
      case 'file':
        return (
          <FilePreviewSubPanel
            workspace={workspace}
            file={resolveFileTabInfo(tab.file, filesByPath.get(tab.file.path), changedPaths.get(tab.file.path))}
            onAddComment={onAddComment ? handleAddComment : undefined}
            onOpenPreview={canPreview && !chatWorkspace ? openFilePreview : undefined}
            onOpenFile={openChangedFile}
            isListed={isListedFile}
            listingTruncated={files.data?.truncated === true}
          />
        )
      case 'diff':
        return <DiffTabView key={tab.id} workspace={workspace} path={tab.path} onOpenFile={openChangedFile} />
      case 'commit':
        return <CommitTabView key={tab.id} workspace={workspace} commit={tab.commit} />
      case 'attachment':
        return <AttachmentTabView key={tab.id} item={tab.item} />
      case 'terminal':
        // Mounted only while on show in an open dock: the session lives in
        // the terminal store, and a detached terminal can be closed by the
        // idle reaper.
        return open && paneShown ? <TerminalSubPanel key={tab.termId} termId={tab.termId} workspace={workspace} /> : null
      case 'tasks':
        return (
          <TasksTabView
            todos={todos}
            sessionId={sessionId}
            plan={plan}
            onClearPlan={onClearPlan}
            onOpenPlan={() => openTab(PLAN_TAB)}
            goal={goal}
            onOpenGoal={openGoal}
            onGoalAction={goalControls}
          />
        )
      case 'plan':
        return (
          <PlanTabView
            plan={plan}
            sessionId={sessionId}
            todos={todos}
            onClearPlan={onClearPlan}
            onOpenFile={openChangedFile}
            onOpenPreview={canPreview ? openFilePreview : undefined}
            workspace={workspace}
          />
        )
      case 'btw':
        return <SideQuestionsTabView sessionId={sessionId} active={open} />
      case 'goal':
        return <GoalTabView sessionId={sessionId} plan={plan} todos={todos} onOpenPlan={plan ? () => openTab(PLAN_TAB) : undefined} />
      case 'schedule':
        return <SchedulerDockView contextWorkspace={chatWorkspace ? null : workspace} />
      case 'preview':
        return null
      default:
        return <DockLauncher items={openItemsFor(pane)} />
    }
  }

  const renderPane = (pane: PaneId) => {
    const box = boxes.get(pane)
    const shown = activeTabs[pane]
    const order = layoutIndex.get(pane) ?? 0
    const empty = (strips[pane]?.length ?? 0) === 0
    return (
      <div
        key={pane}
        data-dock-pane={pane}
        // With several panes on screen, the others' open tabs step back.
        data-pane-unfocused={many && pane !== focused ? '' : undefined}
        data-focus-region="dock"
        data-focus-order={order}
        aria-label={many ? `Pane ${order + 1}` : undefined}
        role={many ? 'group' : undefined}
        // A pane with no place in the layout stays mounted, out of sight and
        // of the accessibility tree.
        hidden={!box}
        className={cn('absolute flex min-h-0 min-w-0 flex-col', !box && 'hidden')}
        style={box ? paneStyle(box) : undefined}
        onFocusCapture={() => focusPane(pane)}
        onPointerDownCapture={() => focusPane(pane)}
      >
        <DockTabBar
          tabs={stripTabs[pane] ?? []}
          activeTabId={shown?.id ?? ''}
          previewTabId={panes.panes[pane]?.preview ?? null}
          workspace={workspace}
          terminalMetas={terminalMetas}
          mobile={mobile}
          os={os}
          registerTabRef={(id, node) => {
            if (node) tabButtonRefs.current.set(id, node)
            else tabButtonRefs.current.delete(id)
          }}
          onActivate={activate}
          onClose={closeTab}
          onCloseOthers={closeOtherTabs}
          onCloseToRight={closeTabsToRight}
          onCloseToLeft={closeTabsToLeft}
          onCloseAll={closeAllTabs}
          onMove={moveWithin}
          onKeep={keep}
          onSplit={mobile ? undefined : (id, side) => splitPane(pane, side, id)}
          canSplit={canSplitTab}
          onMoveToNextPane={mobile || shownPanes.length < 2 ? undefined : moveToNextPane}
          canMoveToNextPane={canMoveToNextPane}
          onRevealInGit={chatWorkspace ? undefined : revealInGit}
          onClosePane={!mobile && empty && shownPanes.length > 1 ? () => closePane(pane) : undefined}
          onDropTab={mobile ? undefined : dropTab}
          onRefresh={handleRefresh}
          refreshLabel={refreshLabelFor(shown)}
          openItems={menuItemsFor(pane)}
          maximized={pane === cornerPane ? maximizeState : null}
          onToggleMaximized={() => useLayoutStore.getState().toggleDockMaximized()}
        />
        <div data-dock-pane-body="" className="relative min-h-0 flex-1 overflow-hidden">
          {renderContent(shown, pane, box !== undefined)}
        </div>
      </div>
    )
  }

  // Preview tabs stay mounted so the page and its comments survive tab
  // switches and moves between panes: one layer over the panes, each page
  // placed over its pane's body, in a fixed order (a moved iframe reloads).
  const previewTabs = paneIds
    .flatMap((pane) => (strips[pane] ?? [])
      .filter((tab): tab is Extract<DockTab, { type: 'preview' }> => tab.type === 'preview')
      .map((tab) => ({ tab, pane })))
    .sort((a, b) => (a.tab.id < b.tab.id ? -1 : a.tab.id > b.tab.id ? 1 : 0))

  // A click in a page goes to its frame, so no pointer event reaches the
  // pane: the window's blur, with the frame focused, says where focus went.
  useEffect(() => {
    if (mobile) return
    let timer = 0
    const onBlur = () => {
      window.clearTimeout(timer)
      // After the blur: the frame is the active element by then everywhere.
      timer = window.setTimeout(() => {
        const frame = document.activeElement
        if (!(frame instanceof HTMLIFrameElement)) return
        const pane = frame.closest('[data-dock-preview-pane]')?.getAttribute('data-dock-preview-pane')
        if (pane) focusPane(pane)
      }, 0)
    }
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.clearTimeout(timer)
    }
  }, [mobile, focusPane])

  // Overlaying a narrow chat, the panel stops above the composer so the
  // message can be written beside the diff; maximized, it covers both.
  const leavesComposer = overlay && !dockMaximized

  return (
    <ResizableAside
      aria-label="Review panel"
      // Desktop sets its width as a style (``instantWidth``): no tween in or out.
      initial={mobile ? { opacity: 0 } : false}
      exit={mobile ? { opacity: 0 } : undefined}
      resize={dockResize}
      getMotion={dockMotion}
      onAnimationComplete={settleToggle}
      pinContentWidth
      // The header's Review panel cap matches this column while it sits
      // beside the chat (open, or sliding); an overlay or the phone sheet floats.
      publishWidthAs={!mobile && !overlay && (shownOpen || sliding) ? '--oa-dock-w' : undefined}
      className={cn(
        'fixed bottom-0 right-0 z-40 min-h-0 w-full overflow-hidden border-l border-(--color-border) bg-(--bg-page) shadow-(--shadow-depth)',
        // Overlay covers the chat column (kept mounted underneath); side mode
        // is an in-flow sibling that takes its ratio of the center. Keyed on
        // `mobile`, not only `md:`: a landscape phone is wider than md but
        // keeps the full-screen mobile dock, clear of side cutouts.
        mobile
          ? 'mobile-safe-top pl-safe pr-safe max-w-none'
          : cn(
              'h-full md:w-auto md:shadow-none',
              overlay
                ? cn(
                    'md:absolute md:top-0 md:right-0 md:z-20',
                    leavesComposer ? 'md:bottom-(--composer-h) md:h-auto md:border-b' : 'md:bottom-0',
                  )
                : 'md:relative md:inset-y-auto md:right-auto md:z-auto md:shrink-0',
            ),
        !open && 'pointer-events-none',
        parked && 'invisible',
      )}
    >
      <div
        data-review-dock
        data-dock-parked={parked || undefined}
        data-dock-split={many || undefined}
        // Lets reading-column tabs (Plan, Side questions) drop their width cap.
        data-dock-maximized={maximizeState === true || undefined}
        inert={parked}
        className="relative flex h-full min-h-0 w-full flex-col"
        onKeyDown={(event) => {
          // Escape gives the chat back from a maximized panel, unless a shell
          // or a field inside it wants the key.
          if (event.key !== 'Escape' || event.defaultPrevented || maximizeState !== true) return
          if ((event.target as Element).closest('.xterm, input, textarea, [contenteditable="true"]')) return
          event.preventDefault()
          useLayoutStore.getState().setDockMaximized(false)
        }}
      >
        {!mobile && !overlay && open && <PanelResizeHandle edge="left" />}
        <div ref={panesRef} data-dock-panes="" className="relative min-h-0 flex-1">
          {paneIds.map(renderPane)}
          {previewTabs.map(({ tab, pane }) => {
            const box = boxes.get(pane)
            const showing = box !== undefined && activeTabs[pane]?.id === tab.id
            return (
              <div
                key={tab.id}
                data-dock-preview={tab.id}
                data-dock-preview-pane={pane}
                className={cn('absolute', !showing && 'hidden')}
                style={box ? paneStyle(box, 'var(--spacing-tab-bar)') : undefined}
                onFocusCapture={() => focusPane(pane)}
                onPointerDownCapture={() => focusPane(pane)}
              >
                <PreviewTabView
                  workspace={workspace}
                  tabId={tab.id}
                  target={tab.target}
                  navKey={tab.navKey}
                  onPreviewId={handlePreviewId}
                  onSendComments={onSendPreviewComments}
                  onOpenTarget={openPreviewTarget}
                  active={open && showing}
                  onRequestClose={closeTab}
                />
              </div>
            )
          })}
          {bars.map((bar) => {
            const sizes = (liveSizes?.key === bar.path.join('.') ? liveSizes.sizes : splitAt(bar.path)?.sizes) ?? []
            const pair = (sizes[bar.before] ?? 0) + (sizes[bar.after] ?? 0)
            return (
              <PaneSplitHandle
                key={`${bar.path.join('.')}:${bar.after}`}
                axis={bar.axis}
                style={barStyle(bar)}
                valueNow={pair > 0 ? Math.round(((sizes[bar.before] ?? 0) / pair) * 100) : 50}
                onDrag={(x, y, done) => dragBar(bar, x, y, done)}
                onStep={(px) => stepBar(bar, px)}
                onReset={() => evenOut(bar)}
              />
            )
          })}
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
          onOpenDiffTab={openDiffPreview}
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
