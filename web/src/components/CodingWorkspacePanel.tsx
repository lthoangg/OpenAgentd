import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useHotkey } from '@tanstack/react-hotkeys'
import { motion } from 'framer-motion'
import {
  Copy,
  FolderOpen,
  GitCompare,
  Plus,
  RefreshCw,
  TerminalSquare,
  Undo2,
  X,
  RotateCcw,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import {
  getCodingWorkspaceGitDiff,
  getCodingWorkspaceStatus,
  getCodingWorkspaceGitHistory,
  getCodingWorkspaceCommitDiff,
  discardCodingWorkspaceFile,
  undoCodingWorkspaceLastCommit,
  revertCodingWorkspaceCommit,
} from '@/api/client'
import { TerminalTabButton } from './Terminal/TerminalTabButton'
import { FileTypeIcon } from './FileTypeIcon'
import { softHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { queryKeys } from '@/queries'
import {
  WORKSPACE_TREE_STALE_MS,
  codingWorkspaceFilesQueryOptions,
} from '@/queries/workspace-files'

import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { usePlatform } from '@/hooks/use-platform'
import { formatShortcut } from '@/lib/keyboard-shortcut'
import { useGitPanelStore, DEFAULT_WORKSPACE_STATE } from '@/stores/useGitPanelStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useShallow } from 'zustand/react/shallow'
import { useToastStore } from '@/stores/useToastStore'
import type { WorkspaceFileInfo } from '@/api/types'
import { EASINGS } from '@/lib/motion'
import {
  type ChangedFileStatus,
  type ChangedFileInfo,
  type DiffFileSection,
  collectChangedFiles,
  collectDiffSections,
} from './CodingWorkspacePanel/diff-helpers'
import {
  CommitSyncBadge,
  type ParsedGraphLine,
} from './CodingWorkspacePanel/CommitDetail'
import { GitReviewSubPanel } from './CodingWorkspacePanel/GitReviewSubPanel'
import { CommitHistorySubPanel } from './CodingWorkspacePanel/CommitHistorySubPanel'
import { TerminalSubPanel } from './CodingWorkspacePanel/TerminalSubPanel'
import { FilePreviewSubPanel } from './CodingWorkspacePanel/FilePreviewSubPanel'

export type { ChangedFileStatus, ChangedFileInfo, DiffFileSection }

type WorkspacePanelTab =
  | { id: 'review'; type: 'review'; title: 'Git' }
  | { id: string; type: 'terminal'; title: string; termId: string }
  | { id: string; type: 'file'; title: string; file: WorkspaceFileInfo }

export function CodingWorkspacePanel({
  workspace,
  open,
  mobile = false,
  mobileDragOffset = null,
  selectedFilePath = null,
  selectedFileOpenKey = 0,
  terminalOpenKey = 0,
  handledTerminalOpenKeyRef: parentHandledTerminalOpenKeyRef,
  onFileSelect,
  onAddComment,
  onOpenPalette,
}: {
  workspace: string
  open: boolean
  initialTab?: 'files' | 'changed'
  onClose?: () => void
  mobile?: boolean
  mobileDragOffset?: number | null
  selectedFilePath?: string | null
  selectedFileOpenKey?: number
  terminalOpenKey?: number
  handledTerminalOpenKeyRef?: React.RefObject<number | null>
  onFileSelect?: (file: WorkspaceFileInfo | null) => void
  onAddComment?: (path: string, startLine: number, endLine: number) => void
  onOpenPalette?: () => void
}) {
  const prefersReducedMotion = useReducedMotion()
  const { os } = usePlatform()
  const [tabs, setTabs] = useState<WorkspacePanelTab[]>([{ id: 'review', type: 'review', title: 'Git' }])
  const [activeTabId, setActiveTabId] = useState('review')
  const [mobileFileActions, setMobileFileActions] = useState<ChangedFileInfo | null>(null)
  const [mobileCommitActions, setMobileCommitActions] = useState<{ sha: string; shortSha: string; subject: string } | null>(null)
  const [desktopCommitActions, setDesktopCommitActions] = useState<{ sha: string; shortSha: string; subject: string; x: number; y: number } | null>(null)
  const [desktopFileActions, setDesktopFileActions] = useState<{ file: ChangedFileInfo; x: number; y: number } | null>(null)
  const [discardTarget, setDiscardTarget] = useState<ChangedFileInfo | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [gitActionPending, setGitActionPending] = useState(false)
  const pushToast = useToastStore((s) => s.push)
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const commitsScrollRef = useRef<HTMLDivElement>(null)
  const pendingScrollShaRef = useRef<string | null>(null)
  const handledFileOpenKeyRef = useRef(-1)

  const files = useQuery({
    ...codingWorkspaceFilesQueryOptions(workspace),
    enabled: open,
    staleTime: WORKSPACE_TREE_STALE_MS,
  })
  const diff = useQuery({
    queryKey: queryKeys.coding.diff(workspace),
    queryFn: () => getCodingWorkspaceGitDiff(workspace),
    enabled: open,
    staleTime: 5_000,
  })
  const workspaceStatus = useQuery({
    queryKey: queryKeys.coding.status(workspace),
    queryFn: () => getCodingWorkspaceStatus(workspace),
    enabled: open,
    staleTime: 10_000,
  })
  const changedFiles = useMemo(() => collectChangedFiles(diff.data), [diff.data])
  const diffSections = useMemo(() => collectDiffSections(diff.data), [diff.data])

  const gitState = useGitPanelStore((s) => s.workspaces[workspace] || DEFAULT_WORKSPACE_STATE)

  const subTab = gitState.subTab
  const allBranches = gitState.allBranches
  const expandedCommitSha = gitState.expandedCommitSha
  const expandedDiffs = useMemo(() => new Set(gitState.expandedDiffs), [gitState.expandedDiffs])
  const expandedCommitFiles = useMemo(() => new Set(gitState.expandedCommitFiles), [gitState.expandedCommitFiles])

  const setSubTab = (tab: 'changes' | 'commits' | 'tree') => useGitPanelStore.getState().setSubTab(workspace, tab)
  const setAllBranches = (val: boolean) => useGitPanelStore.getState().setAllBranches(workspace, val)
  const setExpandedCommitSha = (updater: string | null | ((prev: string | null) => string | null)) => {
    if (typeof updater === 'function') {
      const next = updater(gitState.expandedCommitSha)
      useGitPanelStore.getState().setExpandedCommitSha(workspace, next)
    } else {
      useGitPanelStore.getState().setExpandedCommitSha(workspace, updater)
    }
  }
  const setExpandedCommitFiles = (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    if (typeof updater === 'function') {
      const next = updater(new Set(gitState.expandedCommitFiles))
      useGitPanelStore.getState().setExpandedCommitFiles(workspace, Array.from(next))
    } else {
      useGitPanelStore.getState().setExpandedCommitFiles(workspace, Array.from(updater))
    }
  }
  const historyLimit = 50

  const gitHistory = useInfiniteQuery({
    queryKey: queryKeys.coding.history(workspace, historyLimit, allBranches),
    queryFn: ({ pageParam }) => getCodingWorkspaceGitHistory(workspace, historyLimit, pageParam, allBranches),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? null,
    enabled: open && activeTabId === 'review' && (subTab === 'commits' || subTab === 'tree'),
    staleTime: 10_000,
  })

  const commits = useMemo(() => {
    return gitHistory.data?.pages.flatMap((page) => page.commits) ?? []
  }, [gitHistory.data?.pages])

  const isLatestCommit = useMemo(() => {
    const activeSha = mobileCommitActions?.sha ?? desktopCommitActions?.sha
    if (!activeSha || commits.length === 0) return false
    return activeSha === commits[0].sha
  }, [mobileCommitActions, desktopCommitActions, commits])

  const graph = useMemo(() => {
    return gitHistory.data?.pages[0]?.graph ?? ''
  }, [gitHistory.data?.pages])

  const commitsAhead = workspaceStatus.data?.commits_ahead ?? null
  const commitsBehind = workspaceStatus.data?.commits_behind ?? null
  const upstream = workspaceStatus.data?.upstream ?? null

  const parsedGraphLines = useMemo<ParsedGraphLine[]>(() => {
    if (!graph) return []
    return graph.split('\n').filter((line) => line.trim().length > 0).map((line, lineIndex) => {
      const match = /^(.*?)\b([0-9a-fA-F]{7,10})\b(.*?)$/.exec(line)
      if (!match) {
        return {
          key: `line-${lineIndex}`,
          raw: line,
          graphPart: line,
        }
      }

      const graphPart = match[1]
      const sha = match[2]
      const rest = match[3].trim()

      const decoMatch = /^\((.*?)\)\s*(.*)$/.exec(rest)
      if (decoMatch) {
        return {
          key: `line-${lineIndex}-${sha}`,
          raw: line,
          graphPart,
          sha,
          decorations: decoMatch[1],
          message: decoMatch[2],
        }
      }

      return {
        key: `line-${lineIndex}-${sha}`,
        raw: line,
        graphPart,
        sha,
        message: rest,
      }
    })
  }, [graph])

  const commitDiff = useQuery({
    queryKey: queryKeys.coding.commitDiff(workspace, expandedCommitSha ?? ''),
    queryFn: () => getCodingWorkspaceCommitDiff(workspace, expandedCommitSha ?? ''),
    enabled: open && activeTabId === 'review' && subTab === 'commits' && expandedCommitSha !== null,
    staleTime: 30_000,
  })

  const commitDiffText = commitDiff.data?.diff

  const commitChangedFiles = useMemo(() => {
    if (!commitDiffText) return []
    return collectChangedFiles({ workspace, is_git_repo: true, diff: commitDiffText })
  }, [commitDiffText, workspace])

  const commitDiffSections = useMemo(() => {
    if (!commitDiffText) return new Map<string, DiffFileSection>()
    return collectDiffSections({ workspace, is_git_repo: true, diff: commitDiffText })
  }, [commitDiffText, workspace])

  const terminalMetas = useTerminalStore(
    useShallow((s) =>
      Object.values(s.sessions)
        .filter((meta) => meta.contextKey === workspace)
        .sort((a, b) => a.order - b.order),
    ),
  )

  const activeTab = useMemo(() => {
    const found = tabs.find((item) => item.id === activeTabId)
    if (found) return found
    if (activeTabId.startsWith('terminal:')) {
      const termId = activeTabId.slice(9)
      const meta = terminalMetas.find((m) => m.id === termId)
      if (meta) {
        return { id: activeTabId, type: 'terminal' as const, title: meta.title, termId: meta.id }
      }
    }
    return tabs[0]
  }, [tabs, activeTabId, terminalMetas])

  const openFileTab = useCallback((file: WorkspaceFileInfo) => {
    const id = `file:${file.path}`
    setTabs((current) => {
      const existing = current.find((item) => item.id === id)
      if (existing?.type === 'file') {
        return current.map((item) => (item.id === id ? { ...existing, file } : item))
      }
      return [...current, { id, type: 'file', title: file.name || file.path.split('/').pop() || file.path, file }]
    })
    setActiveTabId(id)
    onFileSelect?.(file)
  }, [onFileSelect])

  useEffect(() => {
    setTabs((current) => {
      const nonTerminal = current.filter((item) => item.type !== 'terminal')
      const terminalTabs = terminalMetas.map((meta) => {
        const existing = current.find(
          (item) => item.type === 'terminal' && item.termId === meta.id,
        )
        return existing && existing.title === meta.title
          ? existing
          : { id: `terminal:${meta.id}`, type: 'terminal' as const, title: meta.title, termId: meta.id }
      })
      const changed =
        current.length !== nonTerminal.length + terminalTabs.length ||
        terminalTabs.some((tab) => !current.includes(tab))
      return changed ? [...nonTerminal, ...terminalTabs] : current
    })
  }, [terminalMetas])

  const openTerminal = useCallback(() => {
    const id = useTerminalStore.getState().open({ workspace }, workspace)
    const tabId = `terminal:${id}`
    const metas = useTerminalStore.getState().sessionsForContext(workspace)
    const meta = metas.find((m) => m.id === id)
    const title = meta?.title ?? `Terminal ${id}`
    setTabs((current) => {
      if (current.some((tab) => tab.id === tabId)) return current
      return [...current, { id: tabId, type: 'terminal' as const, title, termId: id }]
    })
    setActiveTabId(tabId)
  }, [workspace])

  const focusOrOpenTerminal = useCallback(() => {
    const metas = useTerminalStore.getState().sessionsForContext(workspace)
    const last = metas[metas.length - 1]
    if (last) setActiveTabId(`terminal:${last.id}`)
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

  useEffect(() => {
    if (activeTabId === 'review') return
    if (activeTabId.startsWith('terminal:')) {
      const termId = activeTabId.slice(9)
      const isLiveInStore = terminalMetas.some((m) => m.id === termId)
      if (!isLiveInStore && !tabs.some((tab) => tab.id === activeTabId)) {
        setActiveTabId('review')
      }
    } else if (!tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId('review')
    }
  }, [tabs, activeTabId, terminalMetas])

  const closeTab = (id: string) => {
    if (id === 'review') return
    const terminalTab = tabs.find(
      (item): item is Extract<WorkspacePanelTab, { type: 'terminal' }> =>
        item.id === id && item.type === 'terminal',
    )
    if (terminalTab) {
      useTerminalStore.getState().close(terminalTab.termId)
    }
    setTabs((current) => current.filter((item) => item.id !== id))
    if (activeTabId === id) {
      setActiveTabId('review')
      onFileSelect?.(null)
    }
  }

  useHotkey('Mod+W', () => closeTab(activeTabId), {
    enabled: activeTabId !== 'review',
    ignoreInputs: false,
    platform: os === 'macos' ? 'mac' : os === 'windows' ? 'windows' : 'linux',
    preventDefault: true,
    stopPropagation: false,
    target: typeof document === 'undefined' ? null : document,
  })

  const toggleDiffExpanded = (path: string) => {
    useGitPanelStore.getState().toggleDiffExpanded(workspace, path)
  }
  const allExpanded = changedFiles.length > 0 && changedFiles.every((f) => expandedDiffs.has(f.path))
  const handleExpandCollapseChange = (checked: boolean) => {
    if (checked) {
      const allPaths = changedFiles.map((f) => f.path)
      useGitPanelStore.getState().setExpandedDiffs(workspace, allPaths)
    } else {
      useGitPanelStore.getState().setExpandedDiffs(workspace, [])
    }
  }

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

  const handleUndoCommit = async () => {
    setGitActionPending(true)
    try {
      await undoCodingWorkspaceLastCommit(workspace)
      softHapticFeedback()
      pushToast({
        tone: 'success',
        title: 'Commit undone',
        description: 'The last commit was undone. Changes have been kept in your working copy.',
      })
      setMobileCommitActions(null)
      setDesktopCommitActions(null)
      void gitHistory.refetch()
      void diff.refetch()
      void files.refetch()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      pushToast({
        tone: 'error',
        title: 'Failed to undo commit',
        description: msg,
      })
    } finally {
      setGitActionPending(false)
    }
  }

  const handleRevertCommit = async (sha: string, shortSha: string) => {
    setGitActionPending(true)
    try {
      await revertCodingWorkspaceCommit(workspace, sha)
      softHapticFeedback()
      pushToast({
        tone: 'success',
        title: 'Commit reverted',
        description: `Successfully created revert commit for ${shortSha}.`,
      })
      setMobileCommitActions(null)
      setDesktopCommitActions(null)
      void gitHistory.refetch()
      void diff.refetch()
      void files.refetch()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      pushToast({
        tone: 'error',
        title: 'Failed to revert commit',
        description: msg,
      })
    } finally {
      setGitActionPending(false)
    }
  }

  const leftSidebarWidth = typeof document !== 'undefined'
    ? (document.querySelector('aside.border-r')?.getBoundingClientRect().width ?? 0)
    : 0

  const resizable = useResizableWidth({
    storageKey: 'oa.codingWorkspacePanel.width',
    defaultWidth: 380,
    minWidth: 300,
    maxWidth: Math.min(
      1200,
      Math.max(
        300,
        Math.floor((typeof window === 'undefined' ? 1200 : window.innerWidth) - leftSidebarWidth - 380),
      ),
    ),
    edge: 'left',
    disabled: mobile,
  })

  if (!open) return null

  return (
    <motion.aside
      initial={prefersReducedMotion ? { opacity: 0 } : mobile ? { opacity: 0 } : { width: 0 }}
      animate={
        prefersReducedMotion
          ? { opacity: 1 }
          : mobile
            ? (mobileDragOffset !== null ? { opacity: 1, x: mobileDragOffset } : { opacity: 1, x: 0 })
            : { width: resizable.width }
      }
      exit={prefersReducedMotion ? { opacity: 0 } : mobile ? { opacity: 0 } : { width: 0 }}
      transition={mobile && mobileDragOffset !== null ? { duration: 0 } : { duration: resizable.isResizing || prefersReducedMotion ? 0.01 : 0.22, ease: EASINGS.inOut }}
      className={cn(
        'fixed bottom-0 right-0 z-40 min-h-0 w-full overflow-hidden border-l border-(--color-border) bg-(--bg-page) shadow-xl md:relative md:inset-y-auto md:right-auto md:z-auto md:w-auto md:shrink-0 md:shadow-none',
        mobile ? 'mobile-safe-top max-w-none' : 'h-full',
      )}
    >
      <div className={cn('relative flex h-full min-h-0 w-full flex-col', mobile ? 'max-w-none' : 'md:w-full')}>
        {!mobile && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize workspace panel"
            title="Drag to resize · double-click to reset"
            className="absolute left-0 top-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-(--color-accent)/40"
            onPointerDown={resizable.startResize}
            onDoubleClick={resizable.resetWidth}
          />
        )}
        <div className="flex min-w-0 items-center gap-1 border-b border-(--color-border) bg-(--bg-card) px-2 py-1">
          <div className={cn('scrollbar-none flex min-w-0 items-center gap-1 overflow-x-auto', mobile ? 'max-w-[calc(100%-4rem)]' : 'max-w-[calc(100%-2rem)]')}>
            {tabs.map((tabItem) => (tabItem.type === 'terminal' ? (
              <TerminalTabButton
                key={tabItem.id}
                buttonRef={(node) => {
                  if (node) tabButtonRefs.current.set(tabItem.id, node)
                  else tabButtonRefs.current.delete(tabItem.id)
                }}
                meta={terminalMetas.find((m) => m.id === tabItem.termId) ?? {
                  id: tabItem.termId, contextKey: workspace, title: tabItem.title, status: 'connecting', order: 0,
                }}
                active={activeTabId === tabItem.id}
                mobile={mobile}
                onActivate={() => setActiveTabId(tabItem.id)}
              />
            ) : (
              (() => {
                const tabButton = (
                  <button
                    ref={(node) => {
                      if (node) tabButtonRefs.current.set(tabItem.id, node)
                      else tabButtonRefs.current.delete(tabItem.id)
                    }}
                    type="button"
                    onClick={() => setActiveTabId(tabItem.id)}
                    className={cn(
                      'group flex h-7 max-w-40 shrink-0 items-center gap-1.5 rounded-xs px-2 text-xs',
                      activeTabId === tabItem.id
                        ? tabItem.type === 'file'
                          ? 'border border-(--color-border-strong) bg-(--bg-key)/35 text-(--color-accent)'
                          : 'border border-(--color-border-strong) bg-(--bg-key)/35 text-(--color-text)'
                        : 'border border-transparent text-(--color-text-muted) hover:text-(--color-text-2)',
                    )}
                  >
                    {tabItem.type === 'review' ? (
                      <GitCompare size={12} aria-hidden="true" />
                    ) : (
                      <FileTypeIcon name={tabItem.file.name || tabItem.file.path} size={13} />
                    )}
                    <span className="truncate font-mono">{tabItem.title}</span>
                    {tabItem.type === 'file' && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(event) => { event.stopPropagation(); closeTab(tabItem.id) }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            event.stopPropagation()
                            closeTab(tabItem.id)
                          }
                        }}
                        className="ml-0.5 rounded-xs text-(--color-text-subtle) opacity-70 hover:text-(--color-text) md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                        aria-label={`Close ${tabItem.title}`}
                      >
                        <X size={11} aria-hidden="true" />
                      </span>
                    )}
                  </button>
                )
                if (tabItem.type !== 'file') return <div key={tabItem.id} className="shrink-0">{tabButton}</div>
                return (
                  <Tooltip key={tabItem.id} className="shrink-0">
                    <TooltipTrigger className="shrink-0" render={tabButton} />
                    <TooltipContent>{tabItem.file.path}</TooltipContent>
                  </Tooltip>
                )
              })()
            )))}
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onOpenPalette}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7"
                  aria-label={`Search files (${formatShortcut('P', os)})`}
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent>{`Search files (${formatShortcut('P', os)})`}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={openTerminal}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7"
                  aria-label="New terminal"
                >
                  <TerminalSquare size={14} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent>New terminal</TooltipContent>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {activeTab?.type === 'review' ? (
            <div className="flex h-full min-h-0 flex-col">
              {diff.data?.is_git_repo && (
                <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-card) p-1">
                  {!mobile ? (
                    <Dropdown
                      className="w-36"
                      trigger={
                        <>
                          <GitCompare size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
                          {subTab === 'changes'
                            ? `Changes (${changedFiles.length})`
                            : subTab === 'commits'
                            ? (
                              <span className="inline-flex items-center gap-1">
                                Commits
                                {commitsAhead != null && commitsAhead > 0 && (
                                  <CommitSyncBadge count={commitsAhead} direction="ahead" upstream={upstream} />
                                )}
                                {commitsBehind != null && commitsBehind > 0 && (
                                  <CommitSyncBadge count={commitsBehind} direction="behind" upstream={upstream} />
                                )}
                              </span>
                            )
                            : 'Tree'}
                        </>
                      }
                    >
                      <DropdownItem active={subTab === 'changes'} onSelect={() => setSubTab('changes')}>
                        Changes ({changedFiles.length})
                      </DropdownItem>
                      <DropdownItem active={subTab === 'commits'} onSelect={() => setSubTab('commits')}>
                        <span className="inline-flex items-center gap-1.5">
                          Commits
                          {commitsAhead != null && commitsAhead > 0 && (
                            <CommitSyncBadge count={commitsAhead} direction="ahead" upstream={upstream} />
                          )}
                          {commitsBehind != null && commitsBehind > 0 && (
                            <CommitSyncBadge count={commitsBehind} direction="behind" upstream={upstream} />
                          )}
                        </span>
                      </DropdownItem>
                      <DropdownItem active={subTab === 'tree'} onSelect={() => setSubTab('tree')}>
                        Tree
                      </DropdownItem>
                    </Dropdown>
                  ) : (
                    <div className="flex flex-1 gap-1 bg-inherit">
                      <button
                        type="button"
                        onClick={() => setSubTab('changes')}
                        className={cn(
                          'flex-1 rounded-xs py-1 text-center text-[11px] font-medium transition-colors cursor-pointer',
                          subTab === 'changes'
                            ? 'bg-(--bg-page) text-(--color-text) shadow-xs border border-(--color-border-strong)'
                            : 'text-(--color-text-muted) hover:text-(--color-text)',
                        )}
                      >
                        Changes ({changedFiles.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setSubTab('commits')}
                        className={cn(
                          'flex-1 rounded-xs py-1 text-center text-[11px] font-medium transition-colors cursor-pointer',
                          subTab === 'commits'
                            ? 'bg-(--bg-page) text-(--color-text) shadow-xs border border-(--color-border-strong)'
                            : 'text-(--color-text-muted) hover:text-(--color-text)',
                        )}
                      >
                        <span className="inline-flex items-center justify-center gap-1">
                          Commits
                          {commitsAhead != null && commitsAhead > 0 && (
                            <CommitSyncBadge count={commitsAhead} direction="ahead" upstream={upstream} />
                          )}
                          {commitsBehind != null && commitsBehind > 0 && (
                            <CommitSyncBadge count={commitsBehind} direction="behind" upstream={upstream} />
                          )}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setSubTab('tree')}
                        className={cn(
                          'flex-1 rounded-xs py-1 text-center text-[11px] font-medium transition-colors cursor-pointer',
                          subTab === 'tree'
                            ? 'bg-(--bg-page) text-(--color-text) shadow-xs border border-(--color-border-strong)'
                            : 'text-(--color-text-muted) hover:text-(--color-text)',
                        )}
                      >
                        Tree
                      </button>
                    </div>
                  )}

                  <div className="flex items-center gap-1.5 pr-1 shrink-0 select-none">
                    {subTab === 'changes' && changedFiles.length > 0 && (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={allExpanded}
                        onClick={() => handleExpandCollapseChange(!allExpanded)}
                        className="flex cursor-pointer select-none items-center gap-1.5 rounded-xs px-1 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
                      >
                        <span className="text-[11px] text-(--color-text-muted)">Expand all</span>
                        <span
                          aria-hidden="true"
                          className={cn(
                            'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors duration-200',
                            allExpanded
                              ? 'border-(--color-border-strong) bg-(--color-text-subtle)/25'
                              : 'border-(--color-border) bg-(--bg-key)',
                          )}
                        >
                          <span
                            className={cn(
                              'pointer-events-none block h-3 w-3 rounded-full transition-transform duration-200',
                              allExpanded
                                ? 'translate-x-[18px] bg-(--color-text-2)'
                                : 'translate-x-0.5 bg-(--color-text-subtle)/60',
                            )}
                          />
                        </span>
                      </button>
                    )}
                    {subTab === 'tree' && (
                      <label className="flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-sm border border-transparent px-1.5 text-[11px] text-(--color-text-muted) transition-colors">
                        <Checkbox
                          checked={allBranches}
                          onChange={(event) => setAllBranches(event.currentTarget.checked)}
                          className="border-(--color-border) bg-(--bg-card) checked:border-(--color-border-strong) checked:bg-(--bg-key)"
                          checkClassName="peer-checked:text-(--color-text)"
                        />
                        <span className="whitespace-nowrap">All branches</span>
                      </label>
                    )}
                  </div>
                </div>
              )}

              <div ref={commitsScrollRef} className="min-h-0 flex-1 overflow-auto touch-pan-y p-2">
                {subTab === 'changes' ? (
                  <GitReviewSubPanel
                    workspace={workspace}
                    changedFiles={changedFiles}
                    diffSections={diffSections}
                    diff={diff}
                    files={files}
                    selectedFilePath={selectedFilePath}
                    expandedDiffs={expandedDiffs}
                    toggleDiffExpanded={toggleDiffExpanded}
                    openFileTab={openFileTab}
                    mobile={mobile}
                    setMobileFileActions={setMobileFileActions}
                    setDesktopFileActions={setDesktopFileActions}
                  />
                ) : (
                  <CommitHistorySubPanel
                    workspace={workspace}
                    subTab={subTab}
                    gitHistory={gitHistory}
                    commits={commits}
                    expandedCommitSha={expandedCommitSha}
                    setExpandedCommitSha={setExpandedCommitSha}
                    expandedCommitFiles={expandedCommitFiles}
                    setExpandedCommitFiles={setExpandedCommitFiles}
                    commitDiff={commitDiff}
                    commitChangedFiles={commitChangedFiles}
                    commitDiffSections={commitDiffSections}
                    parsedGraphLines={parsedGraphLines}
                    commitsScrollRef={commitsScrollRef}
                    pendingScrollShaRef={pendingScrollShaRef}
                    setSubTab={setSubTab}
                    mobile={mobile}
                    setMobileCommitActions={setMobileCommitActions}
                    setDesktopCommitActions={setDesktopCommitActions}
                    setMobileFileActions={setMobileFileActions}
                    setDesktopFileActions={setDesktopFileActions}
                  />
                )}
              </div>
            </div>
          ) : activeTab?.type === 'file' ? (
            <FilePreviewSubPanel
              workspace={workspace}
              file={activeTab.file}
              onAddComment={onAddComment}
            />
          ) : activeTab?.type === 'terminal' ? (
            <TerminalSubPanel
              key={activeTab.termId}
              termId={activeTab.termId}
              workspace={workspace}
            />
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => {
            void files.refetch()
            void diff.refetch()
            if (subTab === 'commits' || subTab === 'tree') {
              void gitHistory.refetch()
            }
          }}
          className="flex h-9 items-center justify-center gap-1.5 border-t border-(--color-border) bg-(--bg-card) px-3 text-xs text-(--color-text-muted) hover:bg-(--bg-key)"
        >
          <RefreshCw size={12} /> Refresh
        </button>
        <Dialog open={mobileFileActions !== null} onOpenChange={(open) => { if (!open) setMobileFileActions(null) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="truncate font-mono text-sm">{mobileFileActions?.path ?? ''}</DialogTitle>
              <DialogDescription>Choose an action for this file.</DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
              {mobileFileActions?.status !== 'D' && (
                <Button type="button" variant="ghost" className="justify-start" onClick={() => {
                  const f = mobileFileActions; setMobileFileActions(null)
                  if (!f) return
                  softHapticFeedback()
                  const name = f.path.split('/').pop() ?? f.path
                  const file: WorkspaceFileInfo = files.data?.files.find((fi) => fi.path === f.path)
                    ?? { path: f.path, name, size: 0, mtime: 0, mime: 'text/plain' }
                  openFileTab(file)
                }}>
                  <FolderOpen size={14} aria-hidden="true" />
                  Open file
                </Button>
              )}
              <Button type="button" variant="ghost" className="justify-start" onClick={() => {
                const f = mobileFileActions; setMobileFileActions(null)
                if (!f) return
                softHapticFeedback()
                void navigator.clipboard.writeText(f.path)
              }}>
                <Copy size={14} aria-hidden="true" />
                Copy file path
              </Button>
              <Button type="button" variant="danger-subtle" className="justify-start" onClick={() => {
                const f = mobileFileActions
                setMobileFileActions(null)
                if (f) setDiscardTarget(f)
              }}>
                <Undo2 size={14} aria-hidden="true" />
                Discard changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={mobileCommitActions !== null} onOpenChange={(open) => { if (!open && !gitActionPending) setMobileCommitActions(null) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="truncate font-mono text-sm">{mobileCommitActions?.subject ?? ''}</DialogTitle>
              <DialogDescription>SHA: {mobileCommitActions?.shortSha}</DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
              {isLatestCommit && (
                <Button
                  type="button"
                  variant="danger-subtle"
                  className="justify-start"
                  disabled={gitActionPending}
                  onClick={() => {
                    const c = mobileCommitActions
                    if (c) void handleUndoCommit()
                  }}
                >
                  <Undo2 size={14} aria-hidden="true" />
                  {gitActionPending ? 'Undoing…' : 'Undo commit'}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                className="justify-start"
                disabled={gitActionPending}
                onClick={() => {
                  const c = mobileCommitActions
                  if (c) void handleRevertCommit(c.sha, c.shortSha)
                }}
              >
                <RotateCcw size={14} aria-hidden="true" />
                {gitActionPending ? 'Reverting…' : 'Revert commit'}
              </Button>
              <Button type="button" variant="ghost" className="justify-start" disabled={gitActionPending} onClick={() => {
                const c = mobileCommitActions; setMobileCommitActions(null)
                if (!c) return
                softHapticFeedback()
                void navigator.clipboard.writeText(c.shortSha)
              }}>
                <Copy size={14} aria-hidden="true" />
                Copy short SHA
              </Button>
              <Button type="button" variant="ghost" className="justify-start" disabled={gitActionPending} onClick={() => {
                const c = mobileCommitActions; setMobileCommitActions(null)
                if (!c) return
                softHapticFeedback()
                void navigator.clipboard.writeText(c.sha)
              }}>
                <Copy size={14} aria-hidden="true" />
                Copy full SHA
              </Button>
              <Button type="button" variant="ghost" className="justify-start" disabled={gitActionPending} onClick={() => {
                const c = mobileCommitActions; setMobileCommitActions(null)
                if (!c) return
                softHapticFeedback()
                void navigator.clipboard.writeText(c.subject)
              }}>
                <Copy size={14} aria-hidden="true" />
                Copy commit message
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {desktopCommitActions && (
          <div
            role="presentation"
            className="fixed inset-0 z-50 bg-transparent"
            onClick={() => setDesktopCommitActions(null)}
            onContextMenu={(e) => { e.preventDefault(); setDesktopCommitActions(null) }}
          >
            <div
              role="menu"
              className="fixed z-50 min-w-36 rounded-md border border-(--color-border) bg-(--bg-card) p-1 text-xs shadow-md"
              style={{
                top: `${Math.min(desktopCommitActions.y, typeof window !== 'undefined' ? window.innerHeight - 150 : desktopCommitActions.y)}px`,
                left: `${Math.min(desktopCommitActions.x, typeof window !== 'undefined' ? window.innerWidth - 180 : desktopCommitActions.x)}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {isLatestCommit && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={gitActionPending}
                  onClick={() => void handleUndoCommit()}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1 text-left text-(--color-error) hover:bg-(--color-error)/10 disabled:opacity-50"
                >
                  <Undo2 size={12} />
                  {gitActionPending ? 'Undoing…' : 'Undo commit'}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                disabled={gitActionPending}
                onClick={() => {
                  const c = desktopCommitActions
                  if (c) void handleRevertCommit(c.sha, c.shortSha)
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1 text-left text-(--color-text) hover:bg-(--bg-key) disabled:opacity-50"
              >
                <RotateCcw size={12} />
                {gitActionPending ? 'Reverting…' : 'Revert commit'}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const c = desktopCommitActions; setDesktopCommitActions(null)
                  if (!c) return
                  void navigator.clipboard.writeText(c.shortSha)
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1 text-left text-(--color-text) hover:bg-(--bg-key)"
              >
                <Copy size={12} />
                Copy short SHA
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const c = desktopCommitActions; setDesktopCommitActions(null)
                  if (!c) return
                  void navigator.clipboard.writeText(c.sha)
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1 text-left text-(--color-text) hover:bg-(--bg-key)"
              >
                <Copy size={12} />
                Copy full SHA
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const c = desktopCommitActions; setDesktopCommitActions(null)
                  if (!c) return
                  void navigator.clipboard.writeText(c.subject)
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1 text-left text-(--color-text) hover:bg-(--bg-key)"
              >
                <Copy size={12} />
                Copy commit message
              </button>
            </div>
          </div>
        )}
        {desktopFileActions && (
          <div
            role="presentation"
            className="fixed inset-0 z-50 bg-transparent"
            onClick={() => setDesktopFileActions(null)}
            onContextMenu={(e) => { e.preventDefault(); setDesktopFileActions(null) }}
          >
            <div
              role="menu"
              className="fixed z-50 min-w-36 rounded-md border border-(--color-border) bg-(--bg-card) p-1 text-xs shadow-md"
              style={{
                top: `${Math.min(desktopFileActions.y, typeof window !== 'undefined' ? window.innerHeight - 100 : desktopFileActions.y)}px`,
                left: `${Math.min(desktopFileActions.x, typeof window !== 'undefined' ? window.innerWidth - 180 : desktopFileActions.x)}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {desktopFileActions.file.status !== 'D' && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const f = desktopFileActions.file
                    setDesktopFileActions(null)
                    const name = f.path.split('/').pop() ?? f.path
                    const file: WorkspaceFileInfo = files.data?.files.find((fi) => fi.path === f.path)
                      ?? { path: f.path, name, size: 0, mtime: 0, mime: 'text/plain' }
                    openFileTab(file)
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1 text-left text-(--color-text) hover:bg-(--bg-key)"
                >
                  <FolderOpen size={12} />
                  Open file
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const f = desktopFileActions.file
                  setDesktopFileActions(null)
                  void navigator.clipboard.writeText(f.path)
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1 text-left text-(--color-text) hover:bg-(--bg-key)"
              >
                <Copy size={12} />
                Copy file path
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const f = desktopFileActions.file
                  setDesktopFileActions(null)
                  setDiscardTarget(f)
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1 text-left text-(--color-error) hover:bg-(--color-error)/10"
              >
                <Undo2 size={12} />
                Discard changes
              </button>
            </div>
          </div>
        )}
        <Dialog open={discardTarget !== null} onOpenChange={(open) => { if (!open && !discarding) setDiscardTarget(null) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Discard changes?</DialogTitle>
              <DialogDescription>
                Are you sure you want to discard all changes in <span className="font-mono text-(--color-text)">{discardTarget?.path}</span>? This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={discarding} onClick={() => setDiscardTarget(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={discarding}
                onClick={async () => {
                  if (!discardTarget) return
                  setDiscarding(true)
                  try {
                    await discardCodingWorkspaceFile(workspace, discardTarget.path, discardTarget.status)
                    softHapticFeedback()
                    pushToast({
                      tone: 'success',
                      title: 'Changes discarded',
                      description: `Reverted ${discardTarget.path} to its state in HEAD.`,
                    })
                    setDiscardTarget(null)
                    void diff.refetch()
                    void files.refetch()
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    pushToast({
                      tone: 'error',
                      title: 'Failed to discard changes',
                      description: msg,
                    })
                  } finally {
                    setDiscarding(false)
                  }
                }}
              >
                {discarding ? 'Discarding…' : 'Discard changes'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </motion.aside>
  )
}
