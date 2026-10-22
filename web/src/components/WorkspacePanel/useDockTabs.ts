/**
 * Tab state for the review dock's editor strip.
 *
 * Owns which tabs are open and which is active; keeps terminal tabs in step
 * with the terminal store; starts over (empty) when the dock is handed
 * another workspace; handles the shell's "open terminal" and "open Git /
 * Tasks / Schedule" requests; and closes the active tab on Mod+W. Opening
 * tabs that need query data (changed files, commits by sha) stays with the
 * dock, which owns those queries.
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

/**
 * Open ``tab``: an open one is updated in place; a new one goes right after
 * ``afterId`` (the active tab), as in editors and browsers. New terminals
 * go at the end.
 */
function withTab(current: DockTab[], tab: DockTab, afterId: string): DockTab[] {
  const index = current.findIndex((item) => item.id === tab.id)
  if (index >= 0) return current.map((item, i) => (i === index ? tab : item))
  const after = tab.type === 'terminal' ? -1 : current.findIndex((item) => item.id === afterId)
  if (after < 0) return [...current, tab]
  return [...current.slice(0, after + 1), tab, ...current.slice(after + 1)]
}

interface DockTabsOptions {
  workspace: string
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
  /** Called after a tab leaves the strip (close button, middle-click, Mod+W). */
  onTabClosed?: (tab: DockTab) => void
  /** Move keyboard focus to a tab's button (after ⌘1–9 / ⌃Tab from the dock). */
  focusTab?: (id: string) => void
  /** Mod+W with no tab open: close the dock itself. */
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

export function useDockTabs({
  workspace,
  open = true,
  chatWorkspace,
  onFileSelect,
  terminalOpenKey,
  handledTerminalOpenKeyRef: parentHandledTerminalOpenKeyRef,
  viewRequest,
  handledViewRequestKeyRef: parentHandledViewRequestKeyRef,
  onActiveViewChange,
  diffRequest,
  handledDiffRequestKeyRef: parentHandledDiffRequestKeyRef,
  previewRequest,
  handledPreviewRequestKeyRef: parentHandledPreviewRequestKeyRef,
  attachmentRequest,
  handledAttachmentRequestKeyRef: parentHandledAttachmentRequestKeyRef,
  onTabClosed,
  focusTab,
  onCloseDock,
}: DockTabsOptions) {
  // The strip starts empty, on the launcher: Git opens on demand like any
  // other tab. Chat workspaces never show it (the root is not a repository).
  const [tabs, setTabs] = useState<DockTab[]>([])
  // A panel mounted for a project workspace can be re-used for a chat one, so
  // filter the review tab out of the strip rather than only skipping it at
  // construction time.
  const visibleTabs = chatWorkspace ? tabs.filter((tab) => tab.type !== 'review') : tabs
  const [activeTabId, setActiveTabId] = useState('')
  // Read by the tab-opening updaters, which insert after the active tab.
  const activeTabIdRef = useRef(activeTabId)
  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])
  // The dock stays open across workspace switches, so this instance can be
  // handed another workspace. Tabs belong to the workspace they were opened
  // in: start over empty (no file tabs pointing into the old tree). Terminal
  // tabs are re-derived from the new workspace's sessions by the sync effect
  // below.
  const [tabsWorkspace, setTabsWorkspace] = useState(workspace)
  if (tabsWorkspace !== workspace) {
    setTabsWorkspace(workspace)
    setTabs([])
    setActiveTabId('')
  }

  const terminalMetas = useTerminalStore(
    useShallow((s) =>
      Object.values(s.sessions)
        .filter((meta) => meta.contextKey === workspace)
        .sort((a, b) => a.order - b.order),
    ),
  )

  const activeTab = useMemo<DockTab | undefined>(() => {
    const found = visibleTabs.find((item) => item.id === activeTabId)
    if (found) return found
    const termId = terminalIdFromTabId(activeTabId)
    const meta = termId ? terminalMetas.find((m) => m.id === termId) : undefined
    if (meta) return { id: activeTabId, type: 'terminal', title: meta.title, termId: meta.id }
    return visibleTabs[0]
  }, [visibleTabs, activeTabId, terminalMetas])

  const openTab = useCallback((tab: DockTab) => {
    setTabs((current) => withTab(current, tab, activeTabIdRef.current))
    setActiveTabId(tab.id)
  }, [])

  const openFileTab = useCallback((file: WorkspaceFileInfo) => {
    openTab({ id: fileTabId(file.path), type: 'file', title: file.name || basename(file.path), file })
    onFileSelect?.(file)
  }, [openTab, onFileSelect])

  const openDiffTab = useCallback((file: ChangedFileInfo) => {
    openTab({ id: diffTabId(file.path), type: 'diff', title: basename(file.path), path: file.path, status: file.status })
  }, [openTab])

  const openCommitTab = useCallback((commit: GitCommit) => {
    openTab({ id: commitTabId(commit.sha), type: 'commit', title: commit.short_sha, commit })
  }, [openTab])

  /** Open or focus the preview for ``target``; an open tab navigates to it. */
  const openPreviewTab = useCallback((target: PreviewTarget, options?: { focusOnly?: boolean }) => {
    const id = previewTabId(target)
    setTabs((current) => {
      const existing = current.find((item) => item.id === id)
      if (existing && options?.focusOnly) return current
      const navKey = existing?.type === 'preview' ? existing.navKey + 1 : 0
      return withTab(current, { id, type: 'preview', title: previewTabTitle(target), target, navKey }, activeTabIdRef.current)
    })
    setActiveTabId(id)
  }, [])

  /** Open the Git tab, or show the open one. Never in a chat workspace. */
  const openGitTab = useCallback(() => {
    if (!chatWorkspace) openTab(REVIEW_TAB)
  }, [chatWorkspace, openTab])

  /** Move a tab to ``toIndex`` of the strip (drag, ⌥⇧←/→, the tab menu). */
  const moveTab = useCallback((id: string, toIndex: number) => {
    setTabs((current) => {
      const from = current.findIndex((item) => item.id === id)
      if (from < 0) return current
      const to = Math.max(0, Math.min(current.length - 1, toIndex))
      if (from === to) return current
      const next = [...current]
      const [tab] = next.splice(from, 1)
      next.splice(to, 0, tab)
      return next
    })
  }, [])

  // Keep terminal tabs in step with the store without re-sorting the strip:
  // a terminal stays where the user put it. Gone sessions drop out, renamed
  // ones update in place, and new ones join at the end.
  useEffect(() => {
    setTabs((current) => {
      const metas = new Map(terminalMetas.map((meta) => [meta.id, meta]))
      let changed = false
      const kept: DockTab[] = []
      for (const item of current) {
        if (item.type !== 'terminal') {
          kept.push(item)
          continue
        }
        const meta = metas.get(item.termId)
        if (!meta) {
          changed = true
        } else if (meta.title !== item.title) {
          changed = true
          kept.push({ ...item, title: meta.title })
        } else {
          kept.push(item)
        }
      }
      const present = new Set(kept.map((item) => (item.type === 'terminal' ? item.termId : null)))
      const added: DockTab[] = terminalMetas
        .filter((meta) => !present.has(meta.id))
        .map((meta) => ({ id: terminalTabId(meta.id), type: 'terminal', title: meta.title, termId: meta.id }))
      return changed || added.length > 0 ? [...kept, ...added] : current
    })
  }, [terminalMetas])

  const openTerminal = useCallback(() => {
    const id = useTerminalStore.getState().open({ workspace }, workspace)
    const meta = useTerminalStore.getState().sessionsForContext(workspace).find((m) => m.id === id)
    openTab({ id: terminalTabId(id), type: 'terminal', title: meta?.title ?? `Terminal ${id}`, termId: id })
  }, [workspace, openTab])

  const focusOrOpenTerminal = useCallback(() => {
    const metas = useTerminalStore.getState().sessionsForContext(workspace)
    const last = metas[metas.length - 1]
    if (last) setActiveTabId(terminalTabId(last.id))
    else openTerminal()
  }, [workspace, openTerminal])

  const fallbackHandledTerminalOpenKeyRef = useRef(0)
  const handledTerminalOpenKeyRef = parentHandledTerminalOpenKeyRef ?? fallbackHandledTerminalOpenKeyRef
  useEffect(() => {
    if (handledTerminalOpenKeyRef.current === null) {
      handledTerminalOpenKeyRef.current = 0
    }
    if (terminalOpenKey > handledTerminalOpenKeyRef.current) {
      handledTerminalOpenKeyRef.current = terminalOpenKey
      focusOrOpenTerminal()
    }
  }, [terminalOpenKey, focusOrOpenTerminal, handledTerminalOpenKeyRef])

  const fallbackHandledViewRequestKeyRef = useRef(0)
  const handledViewRequestKeyRef = parentHandledViewRequestKeyRef ?? fallbackHandledViewRequestKeyRef
  useEffect(() => {
    if (!viewRequest || viewRequest.key <= handledViewRequestKeyRef.current) return
    handledViewRequestKeyRef.current = viewRequest.key
    if (chatWorkspace && viewRequest.view === 'review') return
    openTab(viewTab(viewRequest.view))
  }, [viewRequest, openTab, handledViewRequestKeyRef, chatWorkspace])

  const fallbackHandledDiffRequestKeyRef = useRef(0)
  const handledDiffRequestKeyRef = parentHandledDiffRequestKeyRef ?? fallbackHandledDiffRequestKeyRef
  useEffect(() => {
    if (!diffRequest || diffRequest.key <= handledDiffRequestKeyRef.current) return
    handledDiffRequestKeyRef.current = diffRequest.key
    openDiffTab({
      path: diffRequest.path,
      status: diffRequest.status ?? 'M',
      additions: 0,
      deletions: 0,
    })
  }, [diffRequest, openDiffTab, handledDiffRequestKeyRef])

  const fallbackHandledPreviewRequestKeyRef = useRef(0)
  const handledPreviewRequestKeyRef = parentHandledPreviewRequestKeyRef ?? fallbackHandledPreviewRequestKeyRef
  useEffect(() => {
    if (!previewRequest || previewRequest.key <= handledPreviewRequestKeyRef.current) return
    handledPreviewRequestKeyRef.current = previewRequest.key
    openPreviewTab(previewRequest.target, { focusOnly: previewRequest.focusOnly })
  }, [previewRequest, openPreviewTab, handledPreviewRequestKeyRef])

  const fallbackHandledAttachmentRequestKeyRef = useRef(0)
  const handledAttachmentRequestKeyRef = parentHandledAttachmentRequestKeyRef ?? fallbackHandledAttachmentRequestKeyRef
  useEffect(() => {
    if (!attachmentRequest || attachmentRequest.key <= handledAttachmentRequestKeyRef.current) return
    handledAttachmentRequestKeyRef.current = attachmentRequest.key
    openTab(attachmentTab(attachmentRequest.item))
  }, [attachmentRequest, openTab, handledAttachmentRequestKeyRef])

  const activeView: DockView | null =
    activeTab && isViewTab(activeTab) ? activeTab.type : null
  const onActiveViewChangeRef = useRef(onActiveViewChange)
  useEffect(() => {
    onActiveViewChangeRef.current = onActiveViewChange
  }, [onActiveViewChange])
  useEffect(() => {
    onActiveViewChangeRef.current?.(activeView)
  }, [activeView])
  useEffect(() => () => onActiveViewChangeRef.current?.(null), [])

  useEffect(() => {
    // The active tab went away without a close (its terminal exited, or a
    // chat workspace hides Git), or tabs appeared on the launcher (terminals
    // adopted on mount): show the first tab, or the launcher.
    if (activeTabId === '') {
      if (visibleTabs.length > 0) setActiveTabId(visibleTabs[0].id)
      return
    }
    const termId = terminalIdFromTabId(activeTabId)
    const known = visibleTabs.some((tab) => tab.id === activeTabId)
    const liveTerminal = termId !== null && terminalMetas.some((m) => m.id === termId)
    if (!known && !liveTerminal) setActiveTabId(visibleTabs[0]?.id ?? '')
  }, [visibleTabs, activeTabId, terminalMetas])

  /** Close several tabs at once (no confirmation; see ``requestCloseTabs``). */
  const closeTabs = (ids: readonly string[]) => {
    const closing = new Set(ids)
    if (closing.size === 0) return
    const targets = tabs.filter((item) => closing.has(item.id))
    for (const target of targets) {
      if (target.type === 'terminal') useTerminalStore.getState().close(target.termId)
    }
    setTabs((current) => current.filter((item) => !closing.has(item.id)))
    for (const target of targets) onTabClosed?.(target)
    if (closing.has(activeTabId)) {
      // Editor convention: the neighbour on the right, else the left; with
      // none left the dock shows its launcher.
      const index = visibleTabs.findIndex((item) => item.id === activeTabId)
      const right = visibleTabs.slice(index + 1).find((item) => !closing.has(item.id))
      const neighbour = right ?? visibleTabs.slice(0, index).reverse().find((item) => !closing.has(item.id))
      setActiveTabId(neighbour?.id ?? '')
      onFileSelect?.(neighbour?.type === 'file' ? neighbour.file : null)
    }
  }
  const closeTab = (id: string) => closeTabs([id])

  // ⌘W on a terminal whose shell is still running asks first: the key is
  // easy to hit while typing in it, and closing stops the shell. The tab's ×
  // button is a deliberate click and closes right away, unless a command is
  // running in that terminal: closing would kill it.
  const [confirmCloseIds, setConfirmCloseIds] = useState<string[] | null>(null)
  /** Close tabs, asking first when that would stop a running shell. */
  const requestCloseTabs = (ids: readonly string[]) => {
    if (ids.some((id) => isRunningTerminal(visibleTabs.find((tab) => tab.id === id)))) setConfirmCloseIds([...ids])
    else closeTabs(ids)
  }
  /** The tab's × and middle-click: asks only while a command is running. */
  const requestCloseTab = (id: string) => {
    if (isBusyTerminal(visibleTabs.find((tab) => tab.id === id))) setConfirmCloseIds([id])
    else closeTab(id)
  }
  const idsOf = (list: readonly DockTab[]) => list.map((tab) => tab.id)
  /** Tab menu: every other tab. The kept tab becomes the active one. */
  const closeOtherTabs = (id: string) => {
    setActiveTabId(id)
    requestCloseTabs(idsOf(visibleTabs.filter((tab) => tab.id !== id)))
  }
  /** Tab menu: the tabs after this one. */
  const closeTabsToRight = (id: string) => {
    const index = visibleTabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    if (visibleTabs.slice(index + 1).some((tab) => tab.id === activeTabId)) setActiveTabId(id)
    requestCloseTabs(idsOf(visibleTabs.slice(index + 1)))
  }
  // On the empty launcher the key closes the dock; with the dock closed it
  // is left alone, so the desktop's native Close Window still works. Behind
  // a dialog the dispatcher swallows it.
  useAppShortcut('closeTab', () => {
    if (!activeTab) {
      onCloseDock?.()
      return
    }
    if (isRunningTerminal(activeTab)) {
      setConfirmCloseIds([activeTab.id])
      return
    }
    closeTab(activeTabId)
  }, {
    enabled: open && (activeTab === undefined ? onCloseDock !== undefined : activeTab.id === activeTabId),
  })
  const confirmCloseTab = () => {
    if (confirmCloseIds) closeTabs(confirmCloseIds)
    setConfirmCloseIds(null)
  }
  const cancelCloseTab = () => setConfirmCloseIds(null)
  // What the confirmation names: the running terminals among the batch.
  const confirmCloseTitles = (confirmCloseIds ?? [])
    .map((id) => visibleTabs.find((tab) => tab.id === id))
    .filter((tab) => isRunningTerminal(tab))
    .map((tab) => tab!.title)

  // ⌘1–⌘8 pick a tab by position, ⌘9 the last one (browsers, editors);
  // ⌃Tab / ⌃⇧Tab step through them. Only while the dock is open. Focus
  // follows only when it was already in the dock, so switching the file
  // beside the composer does not pull the caret out of it.
  const activateTab = (id: string | undefined) => {
    if (!id) return
    const follow = focusIsInDock()
    setActiveTabId(id)
    const tab = visibleTabs.find((item) => item.id === id)
    if (tab?.type === 'file') onFileSelect?.(tab.file)
    if (follow) focusTab?.(id)
  }
  const stepTab = (delta: number) => {
    if (visibleTabs.length === 0) return
    const index = Math.max(0, visibleTabs.findIndex((tab) => tab.id === activeTabId))
    activateTab(visibleTabs[(index + delta + visibleTabs.length) % visibleTabs.length]?.id)
  }
  useShortcuts([
    ...DOCK_TAB_SHORTCUTS.map((name, i) => appShortcut(name, () => {
      activateTab(i === DOCK_TAB_SHORTCUTS.length - 1 ? visibleTabs.at(-1)?.id : visibleTabs[i]?.id)
    })),
    { chord: NEXT_DOCK_TAB_CHORD, handler: () => stepTab(1), options: { allowInEditable: true } },
    { chord: PREV_DOCK_TAB_CHORD, handler: () => stepTab(-1), options: { allowInEditable: true } },
  ], { enabled: open && visibleTabs.length > 0 })

  return {
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
    closeTab: requestCloseTab,
    closeOtherTabs,
    closeTabsToRight,
    confirmCloseOpen: confirmCloseIds !== null,
    confirmCloseTitles,
    confirmCloseTab,
    cancelCloseTab,
  }
}
