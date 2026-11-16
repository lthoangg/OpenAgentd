// size-ceiling: 1303 — one component: split the dock's state from the tab strip and the panes
/**
 * WorkspacePanel — the review dock.
 *
 * Editor-style tab strips (Git review, file previews, full-height diffs,
 * commits, web previews, terminals, the session's Plan and Goal, and on
 * desktop the agent Tasks, `/btw` side questions, and Schedule views)
 * over their content, in panes split right and down as often as there is
 * room (⌘\, ⌘⇧\, or a tab dragged onto a pane's edge; a terminal is a tab
 * like any other). Desktop geometry is a ratio of the shell's center
 * region (measured by ``useDockFrame`` from ``centerRef``) in ``side`` mode, or the whole
 * center in ``overlay`` mode (maximized, or a window too narrow for a
 * side-by-side split; then it leaves the composer uncovered unless
 * maximized). Mobile keeps the fixed full-screen sheet with one strip.
 *
 * A phone (touch and narrow, ``useIsPhone``) draws it as a page pushed over
 * the chat: it covers the whole screen under its own navigation bar (‹ Chat,
 * "Review", and the "+" that opens a view or tool), slides in from the right
 * over its full width and follows the edge swipe that closes it. A narrow
 * mouse window and a tablet keep the sheet under the app header.
 *
 * Tab state lives in ``useDockTabs`` (remembered per session), the frame (open,
 * close, width, motion) in ``useDockFrame``, the shared queries in
 * ``useDockQueries``, the panes' geometry in ``usePaneLayout``, and Git write
 * actions in ``useGitActions``; this component puts each pane's tab strip and
 * content together.
 *
 * Once opened, the shell keeps the dock mounted: closing it (``open``
 * false) tweens it shut and then parks it hidden and inert, so its tabs,
 * the last active tab, preview pages and their unsent comments, and scroll
 * positions are all there when it reopens. Queries pause while it is closed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useToastStore } from '@/stores/useToastStore'
import { useWorkspaceHasGit } from '@/queries/useChatWorkspace'
import { useSideQuestions } from '@/queries/useSideQuestionsQuery'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useIsPhone } from '@/hooks/use-is-phone'
import {
  PanelResizeHandle,
  ResizableAside,
} from '@/components/ResizableAside'
import { useClaimStrandedFocus } from '@/hooks/use-dock-focus'
import { focusQuietly } from '@/lib/focus/quiet'
import { usePlatform } from '@/hooks/use-platform'
import {
  DOCK_PANE_MIN_HEIGHT,
  DOCK_PANE_MIN_WIDTH,
} from '@/lib/workbench-layout'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useGoalControls, useSessionGoalQuery } from '@/queries/useSessionGoalQuery'
import { goalTabTitle } from '@/lib/goal'
import type { SessionPlan, TodoItem, WorkspaceFileInfo } from '@/api/types'
import { type PreviewTarget, lastPreviewUrl, previewsAvailable } from '@/api/preview'
import {
  type ChangedFileInfo,
} from './WorkspacePanel/diff-helpers'

import { FilePreviewSubPanel } from './WorkspacePanel/FilePreviewSubPanel'
import { TasksTabView } from './WorkspacePanel/TasksTabView'
import { SideQuestionsTabView } from './WorkspacePanel/SideQuestionsTabView'
import type { DesignFeedback } from '@/lib/design-feedback'
import { DockTabBar } from './WorkspacePanel/DockTabBar'
import { PhoneReviewBar } from './WorkspacePanel/PhoneReviewBar'
import { useDockFrame } from './WorkspacePanel/useDockFrame'
import { useDockQueries } from './WorkspacePanel/useDockQueries'
import { DockPreviewPages, usePreviewListeners } from './WorkspacePanel/DockPreviewPages'
import { ReviewTabView } from './WorkspacePanel/ReviewTabView'
import { barStyle, paneStyle, usePaneLayout } from './WorkspacePanel/usePaneLayout'
import { PaneSplitHandle } from './WorkspacePanel/PaneSplitHandle'
import { lazySurface } from '@/lib/lazy-surface'
import { DockLauncher, dockOpenItems } from './WorkspacePanel/DockLauncher'
import { DockActionMenus, type CommitActionTarget } from './WorkspacePanel/DockActionMenus'
import { CloseTerminalDialog } from './WorkspacePanel/CloseTerminalDialog'
import { useGitActions } from './WorkspacePanel/useGitActions'
import { useDockTabs } from './WorkspacePanel/useDockTabs'
import {
  type AttachmentTabRequest,
  type TerminalRunRequest,
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
  type PaneId,
} from './WorkspacePanel/dock-panes'

// Kept out of the startup bundle; prefetched while the app is idle.
const SchedulerDockView = lazySurface(() => import('./SchedulerPanel/SchedulerDockView'), 'SchedulerDockView')
const AttachmentTabView = lazySurface(() => import('./WorkspacePanel/AttachmentTabView'), 'AttachmentTabView')
const PlanTabView = lazySurface(() => import('./WorkspacePanel/PlanTabView'), 'PlanTabView')
const GoalTabView = lazySurface(() => import('./WorkspacePanel/GoalTabView'), 'GoalTabView')
const TerminalSubPanel = lazySurface(() => import('./WorkspacePanel/TerminalSubPanel'), 'TerminalSubPanel')
const CommitTabView = lazySurface(() => import('./WorkspacePanel/CommitTabView'), 'CommitTabView')
const DiffTabView = lazySurface(() => import('./WorkspacePanel/DiffTabView'), 'DiffTabView')

const EMPTY_TODOS: TodoItem[] = []
/** Tabs the pane menu's Refresh reloads: the ones read from the workspace's files and Git. */
const REFRESHABLE_TABS: ReadonlySet<DockTab['type']> = new Set(['review', 'file', 'diff'])
/** Dev server a new preview tab opens when the workspace has no last URL. */
const DEFAULT_PREVIEW_URL = 'http://localhost:5173'
/** Stable empty ref: with no center element the width falls back to the viewport. */
const NO_CENTER: React.RefObject<HTMLElement | null> = { current: null }

export function WorkspacePanel({
  workspace,
  open,
  mobile = false,
  centerRef = NO_CENTER,
  centerWidth,
  selectedFilePath = null,
  selectedFileOpenKey = 0,
  terminalOpenKey = 0,
  handledTerminalOpenKeyRef: parentHandledTerminalOpenKeyRef,
  terminalRunRequest = null,
  handledTerminalRunKeyRef,
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
  /** Shell request to run a shell code block's command in a terminal. */
  terminalRunRequest?: TerminalRunRequest | null
  handledTerminalRunKeyRef?: React.RefObject<number>
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
  const { os, isTauri } = usePlatform()
  // A phone is touch and narrow: its Review panel is a page over the chat. A
  // narrow mouse window (``mobile`` without touch) keeps the drawer.
  const phone = useIsPhone() && mobile
  // Each preview tab's listener, closed with the last tab using it (DockPreviewPages.tsx).
  const { handlePreviewId, handleTabClosed } = usePreviewListeners()
  // Where you are decides: Chat and a folder without Git have no Changes
  // view. Until the workspace tree says which this is, the view is offered as
  // usual but git is not probed.
  const workspaceGit = useWorkspaceHasGit(workspace)
  const noGit = chatWorkspace || workspaceGit === false
  const gitKnown = !chatWorkspace && workspaceGit === true
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
    noGit,
    onFileSelect,
    terminalOpenKey,
    handledTerminalOpenKeyRef: parentHandledTerminalOpenKeyRef,
    terminalRunRequest,
    handledTerminalRunKeyRef,
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
  const handledFileOpenKeyRef = useRef(-1)
  // How the dock opens, closes, parks, sizes and slides (useDockFrame.ts).
  const {
    parked,
    settleToggle,
    shownOpen,
    sliding,
    dockMaximized,
    overlay,
    dockResize,
    dockMotion,
    maximizeState,
  } = useDockFrame({ open, mobile, phone, slideIn, centerRef, centerWidth, prefersReducedMotion })
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
  // Git's own queries run only while its tab shows in a pane on screen.
  const reviewShown = shownPanes.some((pane) => activeTabs[pane]?.id === REVIEW_TAB_ID)
  const {
    files,
    changes,
    refreshChanges,
    workspaceStatus,
    changedFiles,
    changedPaths,
    filesByPath,
    gitState,
    gitHistory,
    commits,
    handleRefresh,
  } = useDockQueries({ workspace, open, gitKnown, noGit, reviewShown })

  const isLatestCommit = useMemo(() => {
    const activeSha = mobileCommitActions?.sha ?? desktopCommitActions?.sha
    if (!activeSha || commits.length === 0) return false
    return activeSha === commits[0].sha
  }, [mobileCommitActions, desktopCommitActions, commits])

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
  // Empty things take no room: the launcher and the "+" menu list Goal and
  // Side questions once the session has one (the palette opens either before).
  const hasGoal = goal !== null && goal.status !== 'cleared'
  const sideQuestions = useSideQuestions(sessionId, { countEnabled: open && !mobile, listEnabled: false })
  const hasSideQuestions = sideQuestions.total > 0 || sideQuestions.live !== null
  // The tab strip's "+" menu: every view and tool this dock can open, so one
  // is a tap away while other tabs are open. Tasks and side questions open
  // above the chat on phones, so only desktop lists them here; the plan and
  // the goal open here everywhere. Each pane's menu opens in that pane. The
  // pane's splits are in its ⋯ menu (desktop), not here.
  const openIds = new Set(visibleTabs.map((tab) => tab.id))
  const openItemsFor = (pane: PaneId) => dockOpenItems(os, {
    onOpenGit: noGit ? undefined : () => openGitTab(pane),
    onOpenGoal: openGoal && hasGoal ? () => openGoal(pane) : undefined,
    onOpenPlan: plan ? () => openTab(PLAN_TAB, { pane }) : undefined,
    onOpenTasks: mobile ? undefined : () => openTab(TASKS_TAB, { pane }),
    onOpenSideQuestions: mobile || !sessionId || !hasSideQuestions ? undefined : () => openTab(BTW_TAB, { pane }),
    onOpenSchedule: () => openTab(SCHEDULE_TAB, { pane }),
    onOpenTerminal: () => openTerminal(pane),
    onOpenPreview: canPreview ? () => openNewPreview(pane) : undefined,
    onOpenFile: openQuickOpen,
  }, openIds, { review: changedFiles.length }, { toolsFirst: noGit })

  // A phone's "+" is in the page's navigation bar, for the pane in focus.
  const phoneOpenItems = phone ? openItemsFor(focused) : []

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

  // The Git tab: its toolbar and the Changes or Commits list (ReviewTabView.tsx).
  const reviewView = (
    <ReviewTabView
      workspace={workspace}
      gitState={gitState}
      queriesEnabled={open && gitKnown && reviewShown}
      mobile={mobile}
      changes={changes}
      files={files}
      gitHistory={gitHistory}
      commits={commits}
      changedFiles={changedFiles}
      status={workspaceStatus.data}
      selectedFilePath={selectedFilePath}
      onRefresh={handleRefresh}
      openCommitTab={openCommitPreview}
      setMobileFileActions={setMobileFileActions}
      setDesktopFileActions={setDesktopFileActions}
      setMobileCommitActions={setMobileCommitActions}
      setDesktopCommitActions={setDesktopCommitActions}
    />
  )

  // ── Panes ─────────────────────────────────────────────────────────────────
  // Where each pane sits and how the bars between them resize (usePaneLayout.ts).
  const {
    boxes,
    bars,
    many,
    paneIds,
    layoutIndex,
    cornerPane,
    barValueNow,
    dragBar,
    stepBar,
    evenOut,
  } = usePaneLayout({ panes, shownPanes, panesRef, resizeSplit, mobile, prefersReducedMotion })

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

  const renderContent = (tab: DockTab | undefined, pane: PaneId, paneShown: boolean) => {
    if (!noGit && tab?.type === 'review') return reviewView
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
            onRefresh={mobile ? handleRefresh : undefined}
            mobile={mobile}
          />
        )
      case 'diff':
        return <DiffTabView key={tab.id} workspace={workspace} path={tab.path} onOpenFile={openChangedFile} mobile={mobile} />
      case 'commit':
        return <CommitTabView key={tab.id} workspace={workspace} commit={tab.commit} />
      case 'attachment':
        return <AttachmentTabView key={tab.id} item={tab.item} />
      case 'terminal':
        // Mounted only while on show in an open dock: the session lives in
        // the terminal store, and a detached terminal can be closed by the
        // idle reaper.
        return open && paneShown ? <TerminalSubPanel key={tab.termId} termId={tab.termId} /> : null
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
        return <DockLauncher items={openItemsFor(pane)} phone={phone} />
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
        {/* A phone's "+" is in the page's navigation bar, and its empty page has
            no tabs to strip: the launcher starts right under the bar. */}
        {!(phone && empty) && (
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
            onCloseAll={closeAllTabs}
            onMove={moveWithin}
            onKeep={keep}
            onSplit={mobile ? undefined : (id, side) => splitPane(pane, side, id)}
            canSplit={canSplitTab}
            onMoveToNextPane={mobile || shownPanes.length < 2 ? undefined : moveToNextPane}
            canMoveToNextPane={canMoveToNextPane}
            onRevealInGit={noGit ? undefined : revealInGit}
            onClosePane={!mobile && empty && shownPanes.length > 1 ? () => closePane(pane) : undefined}
            onSplitPane={mobile ? undefined : (side) => splitPane(pane, side)}
            onRefresh={!mobile && shown && REFRESHABLE_TABS.has(shown.type) ? handleRefresh : undefined}
            onDropTab={mobile ? undefined : dropTab}
            openItems={phone ? [] : openItemsFor(pane)}
            // ⌘1–⌘9 pick from the focused pane's strip, and only the desktop app receives them.
            numberKeys={isTauri && pane === focused}
            maximized={pane === cornerPane ? maximizeState : null}
            onToggleMaximized={() => useLayoutStore.getState().toggleDockMaximized()}
          />
        )}
        <div data-dock-pane-body="" className="relative min-h-0 flex-1 overflow-hidden">
          {renderContent(shown, pane, box !== undefined)}
        </div>
      </div>
    )
  }

  // Overlaying a narrow chat, the panel stops above the composer so the
  // message can be written beside the diff; maximized, it covers both.
  const leavesComposer = overlay && !dockMaximized


  return (
    <ResizableAside
      aria-label="Review panel"
      data-edge-drawer={mobile ? 'workspace-panel' : undefined}
      // Desktop sets its width as a style (``instantWidth``): no tween in or out.
      // A narrow mouse window's drawer fades; a phone's page only slides.
      initial={mobile && !phone ? { opacity: 0 } : false}
      exit={mobile && !phone ? { opacity: 0 } : undefined}
      resize={dockResize}
      getMotion={dockMotion}
      onAnimationComplete={settleToggle}
      pinContentWidth
      // The header's Review panel cap matches this column while it sits
      // beside the chat (open, or sliding); an overlay or the phone sheet floats.
      publishWidthAs={!mobile && !overlay && (shownOpen || sliding) ? '--oa-dock-w' : undefined}
      className={cn(
        'fixed bottom-0 right-0 z-40 min-h-0 w-full overflow-hidden bg-(--bg-page) shadow-(--shadow-depth)',
        // A phone's page is edged by its shadow, as the stack's pages are.
        !phone && 'border-l border-(--color-border)',
        // Overlay covers the chat column (kept mounted underneath); side mode
        // is an in-flow sibling that takes its ratio of the center. Keyed on
        // `mobile`, not only `md:`: a landscape phone is wider than md but
        // keeps the full-screen mobile dock, clear of side cutouts. The
        // drawer sits under the app header; a phone's page covers the screen.
        mobile
          ? cn('pl-safe pr-safe max-w-none', phone ? 'top-0' : 'mobile-safe-top')
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
        <PhoneReviewBar
          phone={phone}
          items={phoneOpenItems}
          stripShown={(strips[focused]?.length ?? 0) > 0}
          onRequestClose={onRequestClose}
        />
        <div ref={panesRef} data-dock-panes="" className="relative min-h-0 flex-1">
          {paneIds.map(renderPane)}
          <DockPreviewPages
            workspace={workspace}
            open={open}
            mobile={mobile}
            paneIds={paneIds}
            strips={strips}
            boxes={boxes}
            activeTabs={activeTabs}
            focusPane={focusPane}
            onPreviewId={handlePreviewId}
            onSendComments={onSendPreviewComments}
            onOpenTarget={openPreviewTarget}
            onRequestClose={closeTab}
          />
          {bars.map((bar) => (
            <PaneSplitHandle
              key={`${bar.path.join('.')}:${bar.after}`}
              axis={bar.axis}
              style={barStyle(bar)}
              valueNow={barValueNow(bar)}
              onDrag={(x, y, done) => dragBar(bar, x, y, done)}
              onStep={(px) => stepBar(bar, px)}
              onReset={() => evenOut(bar)}
            />
          ))}
        </div>
        <CloseTerminalDialog
          open={confirmCloseOpen}
          title={confirmCloseTitles.length > 0 ? confirmCloseTitles.join(', ') : 'This terminal'}
          count={confirmCloseTitles.length}
          onConfirm={confirmCloseTab}
          onCancel={cancelCloseTab}
        />
        <DockActionMenus
          workspace={workspace}
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
