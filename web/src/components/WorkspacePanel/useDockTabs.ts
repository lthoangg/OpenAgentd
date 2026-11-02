/**
 * Tab state for the Review panel's editor strips.
 *
 * Owns which tabs are open, in which pane (``dock-panes.ts``), and which is
 * active in each; keeps terminal tabs in step with the workspace's shells
 * (into the terminal pane on desktop); remembers the panes per session
 * (``dock-memory.ts``); handles the shell's requests (open a view, a diff, a
 * preview, an attachment, a terminal; split; ⌃`); and the keys that act on
 * the focused pane (⌘W, ⌘1–9, ⌃Tab). Opening tabs that need query data
 * (changed files, commits by sha) stays with the dock, which owns those
 * queries.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { GitCommit, WorkspaceFileInfo } from '@/api/types'
import type { PreviewTarget } from '@/api/preview'
import { appShortcut, useAppShortcut, useShortcuts } from '@/lib/keyboard/hooks'
import { DOCK_TAB_SHORTCUTS, NEXT_DOCK_TAB_CHORD, PREV_DOCK_TAB_CHORD } from '@/lib/app-shortcuts'
import { useTerminalStore } from '@/stores/useTerminalStore'

import type { ChangedFileInfo } from './diff-helpers'
import {
  type AttachmentTabRequest,
  type DiffTabRequest,
  type DockLayoutRequest,
  type DockTab,
  type DockView,
  type DockViewRequest,
  type PreviewTabRequest,
  REVIEW_TAB,
  attachmentTab,
  basename,
  commitTabId,
  diffTabId,
  fileTabId,
  isViewTab,
  previewTabId,
  previewTabTitle,
  terminalIdFromTabId,
  terminalTabId,
  viewTab,
} from './dock-tabs'
import {
  type Axis,
  type DockPanes,
  type OpenTabOptions,
  type PaneId,
  type SplitSide,
  EMPTY_DOCK_PANES,
  activateTab,
  canSplitOff,
  closePane as closePaneState,
  closeTabs as closePaneTabs,
  focusPane as focusPaneState,
  hiddenPanes,
  hideTerminals,
  isTerminalPane,
  joinPanes,
  keepTab,
  moveTab,
  moveWithinPane,
  nextPaneFor,
  openTab as openPaneTab,
  paneOf,
  paneOrder,
  paneTabs,
  planTabToward,
  resizeSplit as resizeSplitState,
  showTerminals,
  splitPane as splitPaneState,
  syncTerminalTabs,
  visiblePanes,
} from './dock-panes'
import { dockMemoryKey, loadDockPanes, saveDockPanes } from './dock-memory'

interface DockTabsOptions {
  workspace: string
  /** Tabs are remembered per session (a draft per workspace). */
  sessionId?: string | null
  /** Phones: one strip, no panes. */
  mobile?: boolean
  /** False while the dock is closed (kept mounted, hidden): its keys are off. */
  open?: boolean
  chatWorkspace: boolean
  onFileSelect?: (file: WorkspaceFileInfo | null) => void
  terminalOpenKey: number
  handledTerminalOpenKeyRef?: React.RefObject<number | null>
  viewRequest: DockViewRequest | null
  handledViewRequestKeyRef?: React.RefObject<number>
  onActiveViewChange?: (view: DockView | null) => void
  diffRequest?: DiffTabRequest | null
  handledDiffRequestKeyRef?: React.RefObject<number>
  previewRequest?: PreviewTabRequest | null
  handledPreviewRequestKeyRef?: React.RefObject<number>
  /** Shell request to open (or focus) a message attachment's tab. */
  attachmentRequest?: AttachmentTabRequest | null
  handledAttachmentRequestKeyRef?: React.RefObject<number>
  /** Split / terminal pane requests (⌘\, ⌘⇧\, ⌃`). */
  layoutRequest?: DockLayoutRequest | null
  handledLayoutRequestKeyRef?: React.RefObject<number>
  /** Called after a tab leaves the strip (close button, middle-click, Mod+W). */
  onTabClosed?: (tab: DockTab) => void
  /** Move keyboard focus to a tab's button (after ⌘1–9 / ⌃Tab from the dock). */
  focusTab?: (id: string) => void
  /** Mod+W with no tab open, or ⌃` hiding the only content: close the dock. */
  onCloseDock?: () => void
  /** Whether ``pane`` has room to split along ``axis`` (measured by the dock; omitted, it always has). */
  canSplitPane?: (pane: PaneId, axis: Axis) => boolean
  /** A split was refused for want of room. */
  onNoRoomToSplit?: () => void
}

/** Where a dragged tab lands: a place in a strip, a pane's middle, or a new pane on its edge. */
export type TabDropTarget =
  | { kind: 'strip'; pane: PaneId; index: number }
  | { kind: 'pane'; pane: PaneId }
  | { kind: 'split'; pane: PaneId; side: SplitSide }

const AXIS_OF_SIDE: Record<SplitSide, Axis> = { left: 'row', right: 'row', up: 'column', down: 'column' }

/** A terminal whose shell still runs: closing it asks first. */
function isRunningTerminal(tab: DockTab | undefined): boolean {
  if (tab?.type !== 'terminal') return false
  const status = useTerminalStore.getState().sessions[tab.termId]?.status
  return status === 'connected' || status === 'connecting'
}

/** A terminal with a command running in it: even its × asks first. */
function isBusyTerminal(tab: DockTab | undefined): boolean {
  return isRunningTerminal(tab) && tab?.type === 'terminal' && useTerminalStore.getState().sessions[tab.termId]?.busy === true
}

function focusIsInDock(): boolean {
  return typeof document !== 'undefined' && document.activeElement?.closest('[data-review-dock]') != null
}

/** A request handler that runs once per key, even across a remount. */
function useKeyedRequest<T extends { key: number }>(
  request: T | null | undefined,
  parentRef: React.RefObject<number | null> | undefined,
  handle: (request: T) => void,
) {
  const fallback = useRef<number | null>(0)
  const ref = parentRef ?? fallback
  const latest = useRef(handle)
  latest.current = handle
  useEffect(() => {
    if (ref.current === null) ref.current = 0
    if (!request || request.key <= ref.current) return
    ref.current = request.key
    latest.current(request)
  }, [request, ref])
}

export function useDockTabs({
  workspace,
  sessionId = null,
  mobile = false,
  open = true,
  chatWorkspace,
  onFileSelect,
  terminalOpenKey,
  handledTerminalOpenKeyRef,
  viewRequest,
  handledViewRequestKeyRef,
  onActiveViewChange,
  diffRequest,
  handledDiffRequestKeyRef,
  previewRequest,
  handledPreviewRequestKeyRef,
  attachmentRequest,
  handledAttachmentRequestKeyRef,
  layoutRequest,
  handledLayoutRequestKeyRef,
  onTabClosed,
  focusTab,
  onCloseDock,
  canSplitPane,
  onNoRoomToSplit,
}: DockTabsOptions) {
  // Each session keeps its own panes. A switch shows the next session's
  // (or one empty pane); a draft's tabs carry over to the session it becomes.
  const memoryKey = dockMemoryKey(sessionId, workspace)
  const [state, setState] = useState<DockPanes>(() => loadDockPanes(memoryKey) ?? EMPTY_DOCK_PANES)
  const [stateKey, setStateKey] = useState(memoryKey)
  if (stateKey !== memoryKey) {
    const loaded = loadDockPanes(memoryKey)
    const draftBecameSession = !loaded && stateKey === dockMemoryKey(null, workspace) && sessionId !== null
    setStateKey(memoryKey)
    if (!draftBecameSession) setState(loaded ?? { ...EMPTY_DOCK_PANES, terminalsHidden: state.terminalsHidden })
  }
  useEffect(() => {
    saveDockPanes(stateKey, state)
  }, [stateKey, state])
  // Phones have one strip: panes remembered from a desktop window join.
  const paneCount = paneOrder(state.layout).length
  useEffect(() => {
    if (mobile && paneCount > 1) setState(joinPanes)
  }, [mobile, paneCount])

  const terminalMetas = useTerminalStore(
    useShallow((s) =>
      Object.values(s.sessions)
        .filter((meta) => meta.contextKey === workspace)
        .sort((a, b) => a.order - b.order),
    ),
  )
  // Shells belong to the workspace: adopt them into whatever tabs are shown.
  useEffect(() => {
    setState((current) => syncTerminalTabs(current, terminalMetas, !mobile))
  }, [terminalMetas, mobile, stateKey])

  // A chat workspace is not a repository: no Git tab in its strips.
  const hidden = useCallback((tab: DockTab) => chatWorkspace && tab.type === 'review', [chatWorkspace])
  const shownPanes = useMemo(() => visiblePanes(state), [state])
  const strips = useMemo<Record<PaneId, DockTab[]>>(
    () => Object.fromEntries(Object.keys(state.panes).map((pane) => [pane, paneTabs(state, pane).filter((tab) => !hidden(tab))])),
    [state, hidden],
  )
  const activeTabs = useMemo<Record<PaneId, DockTab | undefined>>(() => Object.fromEntries(Object.keys(state.panes).map((pane) => {
    const id = state.panes[pane].active
    const strip = strips[pane] ?? []
    const found = strip.find((item) => item.id === id)
    if (found) return [pane, found]
    const termId = terminalIdFromTabId(id)
    const meta = termId ? terminalMetas.find((m) => m.id === termId) : undefined
    if (meta) return [pane, { id, type: 'terminal', title: meta.title, termId: meta.id }]
    return [pane, strip[0]]
  })), [state.panes, strips, terminalMetas])
  const focused: PaneId = shownPanes.includes(state.focused) ? state.focused : shownPanes[0] ?? state.focused
  const activeTab = activeTabs[focused]
  const activeTabId = activeTab?.id ?? ''
  const visibleTabs = useMemo(() => paneOrder(state.layout).flatMap((pane) => strips[pane] ?? []), [state.layout, strips])

  // ── Opening ───────────────────────────────────────────────────────────────
  type OpenOptions = { pane?: PaneId; preview?: boolean }
  const openTab = useCallback((tab: DockTab, options?: OpenTabOptions) => {
    setState((current) => openPaneTab(current, tab, options))
  }, [])

  const openFileTab = useCallback((file: WorkspaceFileInfo, options?: OpenOptions) => {
    openTab({ id: fileTabId(file.path), type: 'file', title: file.name || basename(file.path), file }, options)
    onFileSelect?.(file)
  }, [openTab, onFileSelect])

  const openDiffTab = useCallback((file: ChangedFileInfo, options?: OpenOptions) => {
    openTab({ id: diffTabId(file.path), type: 'diff', title: basename(file.path), path: file.path, status: file.status }, options)
  }, [openTab])

  const openCommitTab = useCallback((commit: GitCommit, options?: OpenOptions) => {
    openTab({ id: commitTabId(commit.sha), type: 'commit', title: commit.short_sha, commit }, options)
  }, [openTab])

  /** Open or focus the preview for ``target``; an open tab navigates to it. */
  const openPreviewTab = useCallback((target: PreviewTarget, options?: { focusOnly?: boolean; pane?: PaneId }) => {
    const id = previewTabId(target)
    setState((current) => {
      const existing = current.tabs.find((item) => item.id === id)
      if (existing && options?.focusOnly) return activateTab(current, id)
      const navKey = existing?.type === 'preview' ? existing.navKey + 1 : 0
      return openPaneTab(current, { id, type: 'preview', title: previewTabTitle(target), target, navKey }, { pane: options?.pane })
    })
  }, [])

  /** Open the Git tab, or show the open one. Never in a chat workspace. */
  const openGitTab = useCallback((pane?: PaneId) => {
    if (!chatWorkspace) openTab(REVIEW_TAB, { pane })
  }, [chatWorkspace, openTab])

  /** A new shell: in ``pane`` when opened from a strip, else the terminal pane. */
  const openTerminal = useCallback((pane?: PaneId) => {
    const id = useTerminalStore.getState().open({ workspace }, workspace)
    const meta = useTerminalStore.getState().sessionsForContext(workspace).find((m) => m.id === id)
    const tab: DockTab = { id: terminalTabId(id), type: 'terminal', title: meta?.title ?? `Terminal ${id}`, termId: id }
    openTab(tab, mobile ? undefined : pane ? { pane } : { pane: 'terminal' })
  }, [workspace, openTab, mobile])

  /** Show the last shell (where it is), or start one. */
  const focusOrOpenTerminal = useCallback(() => {
    const metas = useTerminalStore.getState().sessionsForContext(workspace)
    const last = metas[metas.length - 1]
    if (last) setState((current) => activateTab(syncTerminalTabs(current, metas, !mobile), terminalTabId(last.id)))
    else openTerminal()
  }, [workspace, openTerminal, mobile])

  // ── Splitting ─────────────────────────────────────────────────────────────
  /** Split ``pane`` on ``side`` (with ``tabId`` moved in), if there is room. */
  const splitPane = useCallback((pane: PaneId, side: SplitSide, tabId?: string) => {
    if (mobile) return
    if (canSplitPane && !canSplitPane(pane, AXIS_OF_SIDE[side])) {
      onNoRoomToSplit?.()
      return
    }
    setState((current) => splitPaneState(current, pane, side, tabId))
  }, [mobile, canSplitPane, onNoRoomToSplit])

  // ── Shell requests ────────────────────────────────────────────────────────
  useKeyedRequest({ key: terminalOpenKey }, handledTerminalOpenKeyRef, focusOrOpenTerminal)
  useKeyedRequest(viewRequest, handledViewRequestKeyRef, (request) => {
    if (chatWorkspace && request.view === 'review') return
    openTab(viewTab(request.view))
  })
  // Files and diffs opened from the transcript or a list are previews.
  useKeyedRequest(diffRequest, handledDiffRequestKeyRef, (request) => {
    openDiffTab({ path: request.path, status: request.status ?? 'M', additions: 0, deletions: 0 }, { preview: true })
  })
  useKeyedRequest(previewRequest, handledPreviewRequestKeyRef, (request) => {
    openPreviewTab(request.target, { focusOnly: request.focusOnly })
  })
  useKeyedRequest(attachmentRequest, handledAttachmentRequestKeyRef, (request) => {
    openTab(attachmentTab(request.item), { preview: true })
  })
  /**
   * ⌃`: hide the terminal panes on screen (closing the panel instead when
   * nothing else would be left), or show them, or the last terminal, or start
   * one. ``show`` only shows (the panel was closed).
   */
  const toggleTerminalPanes = (show: boolean) => {
    const terminalPanes = shownPanes.filter((pane) => isTerminalPane(state, pane))
    if (!show && terminalPanes.length > 0) {
      const others = shownPanes.filter((pane) => !terminalPanes.includes(pane) && (strips[pane]?.length ?? 0) > 0)
      if (others.length === 0) onCloseDock?.()
      else setState(hideTerminals)
      return
    }
    if (hiddenPanes(state).size > 0) {
      setState(showTerminals)
      return
    }
    const terminal = [...state.tabs].reverse().find((tab) => tab.type === 'terminal')
    if (terminal) setState((current) => activateTab(current, terminal.id))
    else openTerminal()
  }
  useKeyedRequest(layoutRequest, handledLayoutRequestKeyRef, (request) => {
    if (mobile) return
    if (request.action === 'split-right' || request.action === 'split-down') {
      splitPane(focused, request.action === 'split-right' ? 'right' : 'down')
      return
    }
    toggleTerminalPanes(request.action === 'terminal-show')
  })

  // ── Active view (for the shell's toggles) ─────────────────────────────────
  const activeView: DockView | null = activeTab && isViewTab(activeTab) ? activeTab.type : null
  const onActiveViewChangeRef = useRef(onActiveViewChange)
  useEffect(() => {
    onActiveViewChangeRef.current = onActiveViewChange
  }, [onActiveViewChange])
  useEffect(() => {
    onActiveViewChangeRef.current?.(activeView)
  }, [activeView])
  useEffect(() => () => onActiveViewChangeRef.current?.(null), [])

  // A pane's active tab went away without a close (its terminal exited, or
  // a chat workspace hides Git): show its first tab, or its launcher.
  useEffect(() => {
    setState((current) => {
      let next = current
      for (const [pane, value] of Object.entries(current.panes)) {
        const strip = paneTabs(current, pane).filter((tab) => !hidden(tab))
        const known = strip.some((tab) => tab.id === value.active)
        const termId = terminalIdFromTabId(value.active)
        const liveTerminal = termId !== null && terminalMetas.some((m) => m.id === termId) && paneOf(current, value.active) === pane
        const fallback = strip[0]?.id ?? ''
        if (!known && !liveTerminal && value.active !== fallback) {
          next = { ...next, panes: { ...next.panes, [pane]: { ...next.panes[pane], active: fallback } } }
        }
      }
      return next
    })
  }, [strips, terminalMetas, hidden])

  // ── Closing ───────────────────────────────────────────────────────────────
  /** Close several tabs at once (no confirmation; see ``requestCloseTabs``). */
  const closeTabs = (ids: readonly string[]) => {
    const closing = new Set(ids)
    if (closing.size === 0) return
    const targets = state.tabs.filter((item) => closing.has(item.id))
    for (const target of targets) {
      if (target.type === 'terminal') useTerminalStore.getState().close(target.termId)
    }
    const next = closePaneTabs(state, ids)
    setState(next)
    for (const target of targets) onTabClosed?.(target)
    if (closing.has(activeTabId)) {
      const shown = next.tabs.find((tab) => tab.id === next.panes[next.focused]?.active)
      onFileSelect?.(shown?.type === 'file' ? shown.file : null)
    }
  }
  const closeTab = (id: string) => closeTabs([id])

  // ⌘W on a terminal whose shell is still running asks first: the key is
  // easy to hit while typing in it, and closing stops the shell. The tab's ×
  // button is a deliberate click and closes right away, unless a command is
  // running in that terminal: closing would kill it.
  const [confirmCloseIds, setConfirmCloseIds] = useState<string[] | null>(null)
  const findTab = (id: string) => visibleTabs.find((tab) => tab.id === id)
  /** Close tabs, asking first when that would stop a running shell. */
  const requestCloseTabs = (ids: readonly string[]) => {
    if (ids.some((id) => isRunningTerminal(findTab(id)))) setConfirmCloseIds([...ids])
    else closeTabs(ids)
  }
  /** The tab's × and middle-click: asks only while a command is running. */
  const requestCloseTab = (id: string) => {
    if (isBusyTerminal(findTab(id))) setConfirmCloseIds([id])
    else closeTab(id)
  }
  const stripOf = (id: string) => strips[paneOf(state, id) ?? ''] ?? []
  /** Tab menu: every other tab of its pane. The kept tab becomes active. */
  const closeOtherTabs = (id: string) => {
    setState((current) => activateTab(current, id))
    requestCloseTabs(stripOf(id).filter((tab) => tab.id !== id).map((tab) => tab.id))
  }
  /** Tab menu: the tabs after this one in its pane. */
  const closeTabsToRight = (id: string) => {
    const strip = stripOf(id)
    const index = strip.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const right = strip.slice(index + 1)
    if (right.some((tab) => tab.id === state.panes[paneOf(state, id) ?? '']?.active)) setState((current) => activateTab(current, id))
    requestCloseTabs(right.map((tab) => tab.id))
  }
  /** Close an empty pane (its strip's ×, ⌘W on its launcher). */
  const closePane = useCallback((pane: PaneId) => setState((current) => closePaneState(current, pane)), [])
  // On an empty launcher the key closes its pane, or with one pane the dock;
  // with the dock closed it is left alone, so the desktop's native Close
  // Window still works. Behind a dialog the dispatcher swallows it.
  useAppShortcut('closeTab', () => {
    if (!activeTab) {
      if (shownPanes.length > 1) closePane(focused)
      else onCloseDock?.()
      return
    }
    if (isRunningTerminal(activeTab)) {
      setConfirmCloseIds([activeTab.id])
      return
    }
    closeTab(activeTab.id)
  }, {
    enabled: open && (activeTab !== undefined || shownPanes.length > 1 || onCloseDock !== undefined),
  })
  // ⌃⌥+arrow (Ctrl+Alt elsewhere): the focused tab goes to that
  // side, into a new pane or, as its pane's only tab, into the pane there.
  // From the composer and a terminal too, like ⌃`.
  const sendTabToward = (side: SplitSide) => {
    const plan = planTabToward(state, focused, activeTab?.id, side)
    if (plan.kind === 'move') setState((current) => moveTab(current, plan.tabId, plan.target))
    else splitPane(plan.pane, side, plan.tabId)
  }
  const towardOptions = { enabled: open && !mobile, allowInEditable: true }
  useShortcuts([
    appShortcut('splitTabLeft', () => { sendTabToward('left') }, towardOptions),
    appShortcut('splitTabRight', () => { sendTabToward('right') }, towardOptions),
    appShortcut('splitTabUp', () => { sendTabToward('up') }, towardOptions),
    appShortcut('splitTabDown', () => { sendTabToward('down') }, towardOptions),
  ])
  const confirmCloseTab = () => {
    if (confirmCloseIds) closeTabs(confirmCloseIds)
    setConfirmCloseIds(null)
  }
  const cancelCloseTab = () => setConfirmCloseIds(null)
  // What the confirmation names: the running terminals among the batch.
  const confirmCloseTitles = (confirmCloseIds ?? [])
    .map((id) => findTab(id))
    .filter((tab) => isRunningTerminal(tab))
    .map((tab) => tab!.title)

  // ── Activating, moving ────────────────────────────────────────────────────
  const activate = useCallback((id: string) => {
    setState((current) => activateTab(current, id))
    const tab = visibleTabs.find((item) => item.id === id)
    if (tab?.type === 'file') onFileSelect?.(tab.file)
  }, [onFileSelect, visibleTabs])
  const focusPane = useCallback((pane: PaneId) => setState((current) => focusPaneState(current, pane)), [])
  const keep = useCallback((id: string) => setState((current) => keepTab(current, id)), [])
  const moveWithin = useCallback((id: string, toIndex: number) => setState((current) => moveWithinPane(current, id, toIndex)), [])
  const moveToNextPane = useCallback((id: string) => setState((current) => {
    const target = nextPaneFor(current, id)
    return target ? moveTab(current, id, target) : current
  }), [])
  const canMoveToNextPane = useCallback((id: string) => !mobile && nextPaneFor(state, id) !== null, [mobile, state])
  const canSplitTab = useCallback((id: string) => !mobile && canSplitOff(state, id), [mobile, state])
  /** A dragged tab let go over ``target``. */
  const dropTab = useCallback((id: string, target: TabDropTarget) => {
    if (target.kind === 'split') splitPane(target.pane, target.side, id)
    else setState((current) => moveTab(current, id, target.pane, target.kind === 'strip' ? target.index : undefined))
  }, [splitPane])
  /** A terminal pane's Hide button: ⌃`. */
  const toggleTerminals = () => toggleTerminalPanes(false)
  const resizeSplit = useCallback((path: readonly number[], sizes: readonly number[]) => {
    setState((current) => resizeSplitState(current, path, sizes))
  }, [])

  // ⌘1–⌘8 pick a tab of the focused pane by position, ⌘9 the last one
  // (browsers, editors); ⌃Tab / ⌃⇧Tab step through them. Only while the dock
  // is open. Focus follows only when it was already in the dock, so
  // switching the file beside the composer does not pull the caret out of it.
  const focusedStrip = strips[focused] ?? []
  const activateByKey = (id: string | undefined) => {
    if (!id) return
    const follow = focusIsInDock()
    activate(id)
    if (follow) focusTab?.(id)
  }
  const stepTab = (delta: number) => {
    if (focusedStrip.length === 0) return
    const index = Math.max(0, focusedStrip.findIndex((tab) => tab.id === activeTabId))
    activateByKey(focusedStrip[(index + delta + focusedStrip.length) % focusedStrip.length]?.id)
  }
  useShortcuts([
    ...DOCK_TAB_SHORTCUTS.map((name, i) => appShortcut(name, () => {
      activateByKey(i === DOCK_TAB_SHORTCUTS.length - 1 ? focusedStrip.at(-1)?.id : focusedStrip[i]?.id)
    })),
    { chord: NEXT_DOCK_TAB_CHORD, handler: () => stepTab(1), options: { allowInEditable: true } },
    { chord: PREV_DOCK_TAB_CHORD, handler: () => stepTab(-1), options: { allowInEditable: true } },
  ], { enabled: open && focusedStrip.length > 0 })

  return {
    state,
    shownPanes,
    strips,
    activeTabs,
    focused,
    visibleTabs,
    activeTabId,
    activeTab,
    terminalMetas,
    openTab,
    openFileTab,
    openDiffTab,
    openCommitTab,
    openPreviewTab,
    openGitTab,
    openTerminal,
    activate,
    setActiveTabId: activate,
    focusPane,
    keep,
    moveWithin,
    moveToNextPane,
    canMoveToNextPane,
    canSplitTab,
    splitPane,
    dropTab,
    closePane,
    toggleTerminals,
    resizeSplit,
    closeTab: requestCloseTab,
    closeOtherTabs,
    closeTabsToRight,
    confirmCloseOpen: confirmCloseIds !== null,
    confirmCloseTitles,
    confirmCloseTab,
    cancelCloseTab,
  }
}
