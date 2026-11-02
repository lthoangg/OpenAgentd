/**
 * Tab state for the Review panel's editor strips.
 *
 * Owns which tabs are open, in which of the two groups (``dock-groups.ts``),
 * and which is active in each; keeps terminal tabs in step with the
 * workspace's shells (into the lower group on desktop); remembers the tabs
 * per session (``dock-memory.ts``); handles the shell's requests (open a
 * view, a diff, a preview, an attachment, a terminal; split; ⌃`); and the
 * keys that act on the focused group (⌘W, ⌘1–9, ⌃Tab). Opening tabs that
 * need query data (changed files, commits by sha) stays with the dock,
 * which owns those queries.
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
  type DockGroups,
  type GroupIndex,
  EMPTY_DOCK_GROUPS,
  activateTab,
  canMoveToOtherGroup,
  closeTabs as closeGroupTabs,
  groupOf,
  groupTabs,
  keepTab,
  lowerVisible,
  moveToOtherGroup,
  moveWithinGroup,
  openTab as openGroupTab,
  syncTerminalTabs,
  toggleLowerGroup,
  toggleSplit,
} from './dock-groups'
import { dockMemoryKey, loadDockGroups, saveDockGroups } from './dock-memory'

interface DockTabsOptions {
  workspace: string
  /** Tabs are remembered per session (a draft per workspace). */
  sessionId?: string | null
  /** Phones: one strip, no groups. */
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
  /** Split / terminal group requests (⌘\, ⌃`). */
  layoutRequest?: DockLayoutRequest | null
  handledLayoutRequestKeyRef?: React.RefObject<number>
  /** Called after a tab leaves the strip (close button, middle-click, Mod+W). */
  onTabClosed?: (tab: DockTab) => void
  /** Move keyboard focus to a tab's button (after ⌘1–9 / ⌃Tab from the dock). */
  focusTab?: (id: string) => void
  /** Mod+W with no tab open, or ⌃` hiding the only content: close the dock. */
  onCloseDock?: () => void
}

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
}: DockTabsOptions) {
  // Each session keeps its own tabs. A switch shows the next session's
  // (or none); a draft's tabs carry over to the session it becomes.
  const memoryKey = dockMemoryKey(sessionId, workspace)
  const [state, setState] = useState<DockGroups>(() => loadDockGroups(memoryKey) ?? EMPTY_DOCK_GROUPS)
  const [stateKey, setStateKey] = useState(memoryKey)
  if (stateKey !== memoryKey) {
    const loaded = loadDockGroups(memoryKey)
    const draftBecameSession = !loaded && stateKey === dockMemoryKey(null, workspace) && sessionId !== null
    setStateKey(memoryKey)
    if (!draftBecameSession) setState(loaded ?? { ...EMPTY_DOCK_GROUPS, lowerHidden: state.lowerHidden })
  }
  useEffect(() => {
    saveDockGroups(stateKey, state)
  }, [stateKey, state])
  // Phones have one strip: a split remembered from a desktop window joins.
  useEffect(() => {
    if (mobile && state.split) setState((current) => (current.split ? toggleSplit(current) : current))
  }, [mobile, state.split])

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
  const strips = useMemo<[DockTab[], DockTab[]]>(
    () => [groupTabs(state, 0).filter((tab) => !hidden(tab)), groupTabs(state, 1).filter((tab) => !hidden(tab))],
    [state, hidden],
  )
  const resolveActive = useCallback((group: GroupIndex): DockTab | undefined => {
    const id = state.active[group]
    const found = strips[group].find((item) => item.id === id)
    if (found) return found
    const termId = terminalIdFromTabId(id)
    const meta = termId ? terminalMetas.find((m) => m.id === termId) : undefined
    if (meta) return { id, type: 'terminal', title: meta.title, termId: meta.id }
    return strips[group][0]
  }, [state.active, strips, terminalMetas])
  const activeTabs = useMemo<[DockTab | undefined, DockTab | undefined]>(
    () => [resolveActive(0), resolveActive(1)],
    [resolveActive],
  )
  const lowerShown = !mobile && lowerVisible(state)
  const focused: GroupIndex = lowerShown ? state.focused : 0
  const activeTab = activeTabs[focused]
  const activeTabId = activeTab?.id ?? ''
  const visibleTabs = useMemo(() => [...strips[0], ...strips[1]], [strips])

  // ── Opening ───────────────────────────────────────────────────────────────
  const openTab = useCallback((tab: DockTab, options?: { group?: GroupIndex; preview?: boolean }) => {
    setState((current) => openGroupTab(current, tab, options))
  }, [])

  const openFileTab = useCallback((file: WorkspaceFileInfo, options?: { group?: GroupIndex; preview?: boolean }) => {
    openTab({ id: fileTabId(file.path), type: 'file', title: file.name || basename(file.path), file }, options)
    onFileSelect?.(file)
  }, [openTab, onFileSelect])

  const openDiffTab = useCallback((file: ChangedFileInfo, options?: { group?: GroupIndex; preview?: boolean }) => {
    openTab({ id: diffTabId(file.path), type: 'diff', title: basename(file.path), path: file.path, status: file.status }, options)
  }, [openTab])

  const openCommitTab = useCallback((commit: GitCommit, options?: { group?: GroupIndex; preview?: boolean }) => {
    openTab({ id: commitTabId(commit.sha), type: 'commit', title: commit.short_sha, commit }, options)
  }, [openTab])

  /** Open or focus the preview for ``target``; an open tab navigates to it. */
  const openPreviewTab = useCallback((target: PreviewTarget, options?: { focusOnly?: boolean; group?: GroupIndex }) => {
    const id = previewTabId(target)
    setState((current) => {
      const existing = current.tabs.find((item) => item.id === id)
      if (existing && options?.focusOnly) return activateTab(current, id)
      const navKey = existing?.type === 'preview' ? existing.navKey + 1 : 0
      return openGroupTab(current, { id, type: 'preview', title: previewTabTitle(target), target, navKey }, { group: options?.group })
    })
  }, [])

  /** Open the Git tab, or show the open one. Never in a chat workspace. */
  const openGitTab = useCallback((group?: GroupIndex) => {
    if (!chatWorkspace) openTab(REVIEW_TAB, { group })
  }, [chatWorkspace, openTab])

  /** A new shell: the lower group on desktop (``group`` when opened from a strip). */
  const openTerminal = useCallback((group?: GroupIndex) => {
    const id = useTerminalStore.getState().open({ workspace }, workspace)
    const meta = useTerminalStore.getState().sessionsForContext(workspace).find((m) => m.id === id)
    openTab(
      { id: terminalTabId(id), type: 'terminal', title: meta?.title ?? `Terminal ${id}`, termId: id },
      { group: mobile ? 0 : group ?? 1 },
    )
  }, [workspace, openTab, mobile])

  /** Show the last shell (where it is), or start one. */
  const focusOrOpenTerminal = useCallback(() => {
    const metas = useTerminalStore.getState().sessionsForContext(workspace)
    const last = metas[metas.length - 1]
    if (last) setState((current) => activateTab(syncTerminalTabs(current, metas, !mobile), terminalTabId(last.id)))
    else openTerminal()
  }, [workspace, openTerminal, mobile])

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
  useKeyedRequest(layoutRequest, handledLayoutRequestKeyRef, (request) => {
    if (mobile) return
    if (request.action === 'split') {
      setState(toggleSplit)
      return
    }
    const lowerHasTerminal = groupTabs(state, 1).some((tab) => tab.type === 'terminal')
    // An empty lower group (or one with only files) has no terminal to hide:
    // ⌃` starts one there instead.
    if (request.action === 'terminal-toggle' && lowerVisible(state) && lowerHasTerminal) {
      // Hiding the terminal group with nothing else open closes the panel.
      if (strips[0].length === 0) onCloseDock?.()
      setState(toggleLowerGroup)
      return
    }
    if (lowerHasTerminal) setState((current) => (lowerVisible(current) ? current : toggleLowerGroup(current)))
    else openTerminal(1)
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

  // A group's active tab went away without a close (its terminal exited, or
  // a chat workspace hides Git): show its first tab, or its launcher.
  useEffect(() => {
    setState((current) => {
      let next = current
      for (const group of [0, 1] as const) {
        const id = current.active[group]
        const strip = groupTabs(current, group).filter((tab) => !hidden(tab))
        const known = strip.some((tab) => tab.id === id)
        const termId = terminalIdFromTabId(id)
        const liveTerminal = termId !== null && terminalMetas.some((m) => m.id === termId) && groupOf(current, id) === group
        const fallback = strip[0]?.id ?? ''
        if (!known && !liveTerminal && id !== fallback) {
          next = { ...next, active: group === 0 ? [fallback, next.active[1]] : [next.active[0], fallback] }
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
    const next = closeGroupTabs(state, ids)
    setState(next)
    for (const target of targets) onTabClosed?.(target)
    if (closing.has(activeTabId)) {
      const shown = next.tabs.find((tab) => tab.id === next.active[next.focused])
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
  const stripOf = (id: string) => strips[groupOf(state, id)]
  /** Tab menu: every other tab of its group. The kept tab becomes active. */
  const closeOtherTabs = (id: string) => {
    setState((current) => activateTab(current, id))
    requestCloseTabs(stripOf(id).filter((tab) => tab.id !== id).map((tab) => tab.id))
  }
  /** Tab menu: the tabs after this one in its group. */
  const closeTabsToRight = (id: string) => {
    const strip = stripOf(id)
    const index = strip.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const right = strip.slice(index + 1)
    if (right.some((tab) => tab.id === state.active[groupOf(state, id)])) setState((current) => activateTab(current, id))
    requestCloseTabs(right.map((tab) => tab.id))
  }
  // On the empty launcher the key closes the dock; with the dock closed it
  // is left alone, so the desktop's native Close Window still works. Behind
  // a dialog the dispatcher swallows it.
  useAppShortcut('closeTab', () => {
    if (!activeTab) {
      if (lowerShown && state.focused === 1) setState(toggleSplit)
      else onCloseDock?.()
      return
    }
    if (isRunningTerminal(activeTab)) {
      setConfirmCloseIds([activeTab.id])
      return
    }
    closeTab(activeTab.id)
  }, {
    enabled: open && (activeTab !== undefined || onCloseDock !== undefined),
  })
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
  const focusGroup = useCallback((group: GroupIndex) => {
    setState((current) => (current.focused === group ? current : { ...current, focused: group }))
  }, [])
  const keep = useCallback((id: string) => setState((current) => keepTab(current, id)), [])
  const moveTab = useCallback((id: string, toIndex: number) => setState((current) => moveWithinGroup(current, id, toIndex)), [])
  const moveToOther = useCallback((id: string) => setState((current) => moveToOtherGroup(current, id)), [])
  const canMoveToOther = useCallback((id: string) => !mobile && canMoveToOtherGroup(state, id), [mobile, state])
  const toggleSplitGroups = useCallback(() => {
    if (!mobile) setState(toggleSplit)
  }, [mobile])
  const toggleLower = useCallback(() => setState(toggleLowerGroup), [])

  // ⌘1–⌘8 pick a tab of the focused group by position, ⌘9 the last one
  // (browsers, editors); ⌃Tab / ⌃⇧Tab step through them. Only while the dock
  // is open. Focus follows only when it was already in the dock, so
  // switching the file beside the composer does not pull the caret out of it.
  const focusedStrip = strips[focused]
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
    groups: state,
    strips,
    activeTabs,
    lowerShown,
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
    focusGroup,
    keep,
    moveTab,
    moveToOther,
    canMoveToOther,
    toggleSplit: toggleSplitGroups,
    toggleLower,
    closeTab: requestCloseTab,
    closeOtherTabs,
    closeTabsToRight,
    confirmCloseOpen: confirmCloseIds !== null,
    confirmCloseTitles,
    confirmCloseTab,
    cancelCloseTab,
  }
}
