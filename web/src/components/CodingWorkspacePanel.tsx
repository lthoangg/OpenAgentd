import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ChevronRight, ExternalLink, GitCompare, Plus, RefreshCw, X } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { getCodingWorkspaceGitDiff, listCodingWorkspaceFiles, getCodingWorkspaceGitHistory, getCodingWorkspaceCommitDiff } from '@/api/client'
import { CodingFilePreviewContent, DiffPreview } from './CodingFileViewerPanel'
import { FileTypeIcon } from './FileTypeIcon'
import { cn } from '@/lib/utils'
import { queryKeys } from '@/queries'

import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { useGitPanelStore, DEFAULT_WORKSPACE_STATE } from '@/stores/useGitPanelStore'
import type { WorkspaceFileInfo, WorkspaceGitDiffResponse } from '@/api/types'

type ChangedFileStatus = 'A' | 'M' | 'D'
type WorkspacePanelTab =
  | { id: 'review'; type: 'review'; title: 'Git' }
  | { id: string; type: 'file'; title: string; file: WorkspaceFileInfo }

interface ChangedFileInfo {
  path: string
  status: ChangedFileStatus
  additions: number
  deletions: number
}

interface DiffFileSection {
  path: string
  diff: string
}

const CHANGED_STATUS_LABELS: Record<ChangedFileStatus, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
}

function collectChangedFiles(diff?: WorkspaceGitDiffResponse): ChangedFileInfo[] {
  const files = new Map<string, ChangedFileInfo>()
  if (!diff?.is_git_repo) return []

  let current: ChangedFileInfo | null = null
  for (const line of diff.diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)
      if (!match?.[1] || !match[2]) {
        current = null
        continue
      }
      const path = match[2] === '/dev/null' ? match[1] : match[2]
      current = files.get(path) ?? { path, status: 'M', additions: 0, deletions: 0 }
      files.set(current.path, current)
      continue
    }
    if (!current) continue
    if (line.startsWith('new file mode')) current.status = 'A'
    else if (line.startsWith('deleted file mode')) current.status = 'D'
    else if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1
  }

  for (const path of diff.untracked ?? []) {
    const existing = files.get(path)
    if (existing) existing.status = 'A'
    else files.set(path, { path, status: 'A', additions: 0, deletions: 0 })
  }
  return Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path))
}

function collectDiffSections(diff?: WorkspaceGitDiffResponse): Map<string, DiffFileSection> {
  const sections = new Map<string, DiffFileSection>()
  if (!diff?.is_git_repo) return sections

  let currentPath: string | null = null
  let currentLines: string[] = []
  const flush = () => {
    if (currentPath) sections.set(currentPath, { path: currentPath, diff: currentLines.join('\n') })
  }

  for (const line of diff.diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)
      currentPath = match?.[2] === '/dev/null' ? match?.[1] ?? null : match?.[2] ?? null
      currentLines = [line]
      continue
    }
    if (currentPath) currentLines.push(line)
  }
  flush()
  return sections
}

interface CommitDetailProps {
  commitDiff: { isLoading: boolean; isError: boolean }
  commitChangedFiles: ChangedFileInfo[]
  commitDiffSections: Map<string, DiffFileSection>
  expandedCommitFiles: Set<string>
  setExpandedCommitFiles: React.Dispatch<React.SetStateAction<Set<string>>>
}

function CommitDetail({
  commitDiff,
  commitChangedFiles,
  commitDiffSections,
  expandedCommitFiles,
  setExpandedCommitFiles,
}: CommitDetailProps) {
  const toggleFileExpanded = (path: string) => {
    setExpandedCommitFiles((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (commitDiff.isLoading) {
    return <p className="px-2 py-2 text-[10px] text-(--color-text-subtle)">Loading commit changes…</p>
  }
  if (commitDiff.isError) {
    return <p className="px-2 py-2 text-[10px] text-(--color-error)">Failed to load commit changes</p>
  }

  if (commitChangedFiles.length === 0) {
    return <p className="px-2 py-2 text-[10px] text-(--color-text-subtle)">No files changed in this commit.</p>
  }

  return (
    <div className="mt-2 space-y-1.5 border-l border-(--color-border-strong) py-0.5 pr-0.5 pl-2">
      {commitChangedFiles.map((changedFile) => {
        const expanded = expandedCommitFiles.has(changedFile.path)
        const fileDiff = commitDiffSections.get(changedFile.path)?.diff
        return (
          <div key={changedFile.path} className="overflow-hidden rounded border border-(--color-border-subtle) bg-(--bg-card)">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleFileExpanded(changedFile.path) }}
              className="flex w-full cursor-pointer items-center gap-1.5 px-1.5 py-1 text-left text-[10px] text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text)"
              aria-expanded={expanded}
            >
              <ChevronRight size={10} className={cn('shrink-0 text-(--color-text-subtle) transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
              <FileTypeIcon name={changedFile.path} size={11} />
              <span className="min-w-0 flex-1 truncate font-mono">{changedFile.path}</span>
              <span className="shrink-0 font-mono text-[8px] text-(--color-diff-add-text)">{changedFile.additions > 0 ? `+${changedFile.additions}` : ''}</span>
              <span className="shrink-0 font-mono text-[8px] text-(--color-diff-del-text)">{changedFile.deletions > 0 ? `-${changedFile.deletions}` : ''}</span>
              <span className="shrink-0 font-mono text-[8px] font-semibold text-(--accent-orange-text)">{changedFile.status}</span>
            </button>
            {expanded && (
              <div className="border-t border-(--color-border-subtle)">
                {fileDiff ? (
                  <div className="max-h-[40vh] min-h-0 overflow-y-auto touch-pan-y">
                    <DiffPreview diff={fileDiff} />
                  </div>
                ) : (
                  <p className="px-2 py-2 text-[9px] text-(--color-text-subtle)">No diff body for this file.</p>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface ParsedGraphLine {
  key: string
  raw: string
  graphPart: string
  sha?: string
  decorations?: string
  message?: string
}

function renderGraphPrefix(prefix: string) {
  return prefix.split('').map((char, index) => {
    if (char === '*') {
      return (
        <span key={index} className="text-(--color-accent) font-bold font-mono">
          ●
        </span>
      )
    }
    if (char === '|') {
      return (
        <span key={index} className="text-slate-400 dark:text-slate-500 opacity-60 font-mono">
          |
        </span>
      )
    }
    if (char === '/' || char === '\\' || char === '_') {
      return (
        <span key={index} className="text-slate-500 dark:text-slate-400 opacity-85 font-mono">
          {char}
        </span>
      )
    }
    return <span key={index} className="font-mono">{char}</span>
  })
}

export function CodingWorkspacePanel({
  workspace,
  open,
  mobile = false,
  mobileDragOffset = null,
  selectedFilePath = null,
  selectedFileOpenKey = 0,
  onFileSelect,
  onAddComment,
  onOpenPalette,
}: {
  workspace: string
  open: boolean
  initialTab?: 'files' | 'changed'
  /**
   * Closing the panel is owned by the parent (mobile edge-swipe-to-close and
   * the topbar Files toggle), so the panel no longer renders its own close
   * button. Kept optional for API compatibility with callers that still pass
   * it.
   */
  onClose?: () => void
  mobile?: boolean
  /** Mobile only: live edge-swipe drag offset (px) for finger-tracking. */
  mobileDragOffset?: number | null
  selectedFilePath?: string | null
  selectedFileOpenKey?: number
  onFileSelect?: (file: WorkspaceFileInfo | null) => void
  onAddComment?: (path: string, startLine: number, endLine: number) => void
  onOpenPalette?: () => void
}) {
  const prefersReducedMotion = useReducedMotion()
  const [tabs, setTabs] = useState<WorkspacePanelTab[]>([{ id: 'review', type: 'review', title: 'Git' }])
  const [activeTabId, setActiveTabId] = useState('review')
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const commitsScrollRef = useRef<HTMLDivElement>(null)
  // Tracks a SHA that was navigated to from Tree and needs to be scrolled into view.
  const pendingScrollShaRef = useRef<string | null>(null)
  // Tracks the last selection-open request we acted on. We only auto-open a
  // file tab when the parent bumps `selectedFileOpenKey`, never on background
  // refreshes of the files query — otherwise a manually closed tab would
  // reopen itself the next time `files.data` refetches. Starts at -1 so the
  // very first request (key 0) is still honored.
  const handledFileOpenKeyRef = useRef(-1)
  const files = useQuery({
    queryKey: queryKeys.coding.files(workspace),
    queryFn: () => listCodingWorkspaceFiles(workspace),
    enabled: open,
    staleTime: 5_000,
  })
  const diff = useQuery({
    queryKey: queryKeys.coding.diff(workspace),
    queryFn: () => getCodingWorkspaceGitDiff(workspace),
    enabled: open,
    staleTime: 5_000,
  })
  const changedFiles = collectChangedFiles(diff.data)
  const diffSections = collectDiffSections(diff.data)

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

  const graph = useMemo(() => {
    return gitHistory.data?.pages[0]?.graph ?? ''
  }, [gitHistory.data?.pages])

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

  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!sentinelRef.current || !gitHistory.hasNextPage) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && gitHistory.hasNextPage && !gitHistory.isFetchingNextPage) {
          void gitHistory.fetchNextPage()
        }
      },
      { threshold: 0.1 }
    )

    const el = sentinelRef.current
    observer.observe(el)
    return () => {
      observer.unobserve(el)
    }
  }, [gitHistory, subTab])

  const commitDiff = useQuery({
    queryKey: queryKeys.coding.commitDiff(workspace, expandedCommitSha ?? ''),
    queryFn: () => getCodingWorkspaceCommitDiff(workspace, expandedCommitSha ?? ''),
    enabled: open && activeTabId === 'review' && subTab === 'commits' && expandedCommitSha !== null,
    staleTime: 30_000,
  })

  const commitChangedFiles = useMemo(() => {
    if (!commitDiff.data?.diff) return []
    return collectChangedFiles({ workspace, is_git_repo: true, diff: commitDiff.data.diff })
  }, [commitDiff.data?.diff, workspace])

  const commitDiffSections = useMemo(() => {
    if (!commitDiff.data?.diff) return new Map<string, DiffFileSection>()
    return collectDiffSections({ workspace, is_git_repo: true, diff: commitDiff.data.diff })
  }, [commitDiff.data?.diff, workspace])
  const activeTab = tabs.find((item) => item.id === activeTabId) ?? tabs[0]
  const openFileTab = useCallback((file: WorkspaceFileInfo) => {
    const id = `file:${file.path}`
    setTabs((current) => {
      const existing = current.find((item) => item.id === id)
      if (existing?.type === 'file') {
        return current.map((item) => item.id === id ? { ...existing, file } : item)
      }
      return [...current, { id, type: 'file', title: file.name || file.path.split('/').pop() || file.path, file }]
    })
    setActiveTabId(id)
    onFileSelect?.(file)
  }, [onFileSelect])
  const closeTab = (id: string) => {
    if (id === 'review') return
    setTabs((current) => current.filter((item) => item.id !== id))
    if (activeTabId === id) setActiveTabId('review')
  }
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
    // Only react to a fresh open request from the parent (signaled by a bumped
    // `selectedFileOpenKey`). Background refetches of the files query change
    // `files.data` but must NOT reopen a tab the user already closed.
    if (handledFileOpenKeyRef.current === selectedFileOpenKey) return
    if (!selectedFilePath) return
    if (files.data?.files == null) return // files not loaded yet; retry once they arrive
    const file = files.data.files.find((item) => item.path === selectedFilePath)
    if (file) {
      handledFileOpenKeyRef.current = selectedFileOpenKey
      openFileTab(file)
    }
  }, [files.data?.files, openFileTab, selectedFileOpenKey, selectedFilePath])

  useEffect(() => {
    tabButtonRefs.current.get(activeTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])

  // After the commits list renders, scroll the pending SHA into view (set by Tree navigation).
  useEffect(() => {
    const sha = pendingScrollShaRef.current
    if (!sha || subTab !== 'commits' || !commitsScrollRef.current) return
    const card = commitsScrollRef.current.querySelector(`[data-commit-sha="${sha}"]`)
    if (!card) return
    pendingScrollShaRef.current = null
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })


  const resizable = useResizableWidth({
    storageKey: 'oa.codingWorkspacePanel.width',
    defaultWidth: 380,
    minWidth: 300,
    maxWidth: Math.min(800, Math.max(320, Math.floor((typeof window === 'undefined' ? 800 : window.innerWidth) - 320))),
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
      transition={mobile && mobileDragOffset !== null ? { duration: 0 } : { duration: resizable.isResizing || prefersReducedMotion ? 0.01 : 0.22, ease: [0.4, 0, 0.2, 1] }}
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
            {tabs.map((tabItem) => (
              <button
                key={tabItem.id}
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
                title={tabItem.type === 'file' ? tabItem.file.path : tabItem.title}
              >
                {tabItem.type === 'review' ? <GitCompare size={12} aria-hidden="true" /> : <FileTypeIcon name={tabItem.file.name || tabItem.file.path} size={13} />}
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
                    className="ml-0.5 rounded text-(--color-text-subtle) opacity-70 hover:text-(--color-text) md:opacity-0 md:group-hover:opacity-100"
                    aria-label={`Close ${tabItem.title}`}
                  >
                    <X size={11} aria-hidden="true" />
                  </span>
                )}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onOpenPalette}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7"
            aria-label="Search files (Ctrl+P)"
            title="Search files (Ctrl+P)"
          >
            <Plus size={14} aria-hidden="true" />
          </button>
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
                            ? 'Commits'
                            : 'Tree'}
                        </>
                      }
                    >
                      <DropdownItem active={subTab === 'changes'} onSelect={() => setSubTab('changes')}>
                        Changes ({changedFiles.length})
                      </DropdownItem>
                      <DropdownItem active={subTab === 'commits'} onSelect={() => setSubTab('commits')}>
                        Commits
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
                          'flex-1 rounded py-1 text-center text-[11px] font-medium transition-colors cursor-pointer',
                          subTab === 'changes'
                            ? 'bg-(--bg-page) text-(--color-text) shadow-xs border border-(--color-border-strong)'
                            : 'text-(--color-text-muted) hover:text-(--color-text)'
                        )}
                      >
                        Changes ({changedFiles.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setSubTab('commits')}
                        className={cn(
                          'flex-1 rounded py-1 text-center text-[11px] font-medium transition-colors cursor-pointer',
                          subTab === 'commits'
                            ? 'bg-(--bg-page) text-(--color-text) shadow-xs border border-(--color-border-strong)'
                            : 'text-(--color-text-muted) hover:text-(--color-text)'
                        )}
                      >
                        Commits
                      </button>
                      <button
                        type="button"
                        onClick={() => setSubTab('tree')}
                        className={cn(
                          'flex-1 rounded py-1 text-center text-[11px] font-medium transition-colors cursor-pointer',
                          subTab === 'tree'
                            ? 'bg-(--bg-page) text-(--color-text) shadow-xs border border-(--color-border-strong)'
                            : 'text-(--color-text-muted) hover:text-(--color-text)'
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
                      <label className="flex h-7 cursor-pointer select-none items-center gap-1.5 rounded border border-transparent px-1.5 text-[11px] text-(--color-text-muted) transition-colors">
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

              <div ref={commitsScrollRef} className="min-h-0 flex-1 overflow-auto p-2">
                {subTab === 'changes' ? (
                  diff.isLoading || files.isLoading ? (
                    <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Loading changed files…</p>
                  ) : diff.isError ? (
                    <p className="px-2 py-4 text-xs text-(--color-error)">Failed to load changed files</p>
                  ) : !diff.data?.is_git_repo ? (
                    <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Not a git repository</p>
                  ) : changedFiles.length === 0 ? (
                    <p className="px-2 py-4 text-xs text-(--color-text-subtle)">No changed files</p>
                  ) : (
                    <div>
                      {diff.data.truncated && <p className="mb-2 rounded bg-(--color-warning)/10 px-2 py-1 text-xs text-(--color-warning)">Changed list may be incomplete because the diff was truncated.</p>}
                      <div className="space-y-2">
                        {changedFiles.map((changedFile) => {
                          const isSelected = selectedFilePath === changedFile.path
                          const expanded = expandedDiffs.has(changedFile.path)
                          const fileDiff = diffSections.get(changedFile.path)?.diff
                          return (
                            <div key={changedFile.path} className="group overflow-hidden rounded border border-(--color-border-subtle) bg-(--bg-card)">
                              <div className={cn(
                                'flex w-full items-center text-xs transition-colors hover:bg-(--bg-key) hover:text-(--color-text)',
                                isSelected ? 'text-(--color-accent)' : 'text-(--color-text-2)',
                              )}>
                                <button
                                  type="button"
                                  onClick={() => toggleDiffExpanded(changedFile.path)}
                                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-left"
                                  title={changedFile.path}
                                  aria-label={`${expanded ? 'Collapse' : 'Expand'} diff for ${changedFile.path}`}
                                  aria-expanded={expanded}
                                >
                                  <ChevronRight size={12} className={cn('shrink-0 text-(--color-text-subtle) transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
                                  <FileTypeIcon name={changedFile.path} size={13} />
                                  <span className="min-w-0 flex-1 truncate font-mono">{changedFile.path}</span>
                                  <span className="shrink-0 font-mono text-[10px] text-(--color-diff-add-text)">{changedFile.additions > 0 ? `+${changedFile.additions}` : ''}</span>
                                  <span className="shrink-0 font-mono text-[10px] text-(--color-diff-del-text)">{changedFile.deletions > 0 ? `-${changedFile.deletions}` : ''}</span>
                                  <span className="shrink-0 font-mono text-[10px] font-semibold text-(--accent-orange-text)" aria-label={CHANGED_STATUS_LABELS[changedFile.status]}>{changedFile.status}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const file = files.data?.files.find((f) => f.path === changedFile.path)
                                    if (file) openFileTab(file)
                                  }}
                                  className="mr-1 hidden shrink-0 rounded p-1 text-(--color-text-subtle) opacity-0 group-hover:opacity-100 hover:bg-(--bg-card) hover:text-(--color-text) md:flex"
                                  title="Open file"
                                  aria-label={`Open ${changedFile.path}`}
                                >
                                  <ExternalLink size={11} aria-hidden="true" />
                                </button>
                              </div>
                              {expanded && (
                                <div className="border-t border-(--color-border-subtle)">
                                  {fileDiff ? <div className="max-h-[70vh] min-h-0 overflow-y-auto touch-pan-y"><DiffPreview diff={fileDiff} /></div>
                                    : <p className="px-2 py-3 text-xs text-(--color-text-subtle)">No diff body for this file.</p>}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                ) : subTab === 'commits' ? (
                  gitHistory.isLoading ? (
                    <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Loading commits…</p>
                  ) : gitHistory.isError ? (
                    <p className="px-2 py-4 text-xs text-(--color-error)">Failed to load commits</p>
                  ) : gitHistory.data?.pages[0]?.is_git_repo === false ? (
                    <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Not a git repository</p>
                  ) : commits.length === 0 ? (
                    <p className="px-2 py-4 text-xs text-(--color-text-subtle)">No commits found</p>
                  ) : (
                    <div className="space-y-2">
                      {commits.map((commit) => {
                        const isExpanded = expandedCommitSha === commit.sha
                        return (
                          <div key={commit.sha} data-commit-sha={commit.sha} className="overflow-hidden rounded border border-(--color-border-subtle) bg-(--bg-card) p-2">
                            <button
                              type="button"
                              onClick={(e) => {
                                const card = (e.currentTarget as HTMLElement).closest('[data-commit-sha]') as HTMLElement | null
                                const scroller = commitsScrollRef.current
                                // Snapshot card's distance from the top of the scroller before any DOM change.
                                const cardOffsetBefore = card && scroller
                                  ? card.getBoundingClientRect().top - scroller.getBoundingClientRect().top
                                  : null
                                // flushSync forces React to paint synchronously so we can measure the
                                // new layout immediately after, with no rAF race condition.
                                flushSync(() => {
                                  setExpandedCommitSha((prev) => (prev === commit.sha ? null : commit.sha))
                                  setExpandedCommitFiles(new Set())
                                })
                                // Restore the card to the same visual position by correcting scrollTop.
                                if (card && scroller && cardOffsetBefore !== null) {
                                  const cardOffsetAfter = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top
                                  scroller.scrollTop += cardOffsetAfter - cardOffsetBefore
                                }
                              }}
                              className="flex w-full cursor-pointer flex-col gap-1 text-left"
                            >
                              <div className="flex w-full items-start justify-between gap-1.5">
                                <div className="flex items-start gap-1.5 min-w-0 flex-1">
                                  <span className="shrink-0 font-mono text-xs text-(--color-text-subtle) select-none mt-0.5">•</span>
                                  <span className="truncate font-mono text-[11px] font-semibold text-(--color-text)">
                                    {commit.subject}
                                  </span>
                                </div>
                                <span className="shrink-0 rounded border border-(--color-border-subtle) bg-(--bg-card) px-1 py-0.5 font-mono text-[9px] text-(--color-text-subtle)">
                                  {commit.short_sha}
                                </span>
                              </div>

                              {commit.refs && (
                                <div className="flex flex-wrap gap-1 mt-0.5">
                                  {commit.refs.split(',').map((ref) => (
                                    <span key={ref} className="text-[9px] font-semibold px-1 rounded bg-(--color-accent)/10 text-(--color-accent) border border-(--color-accent)/20">
                                      {ref.trim()}
                                    </span>
                                  ))}
                                </div>
                              )}

                              <div className="flex w-full items-center justify-between text-[10px] text-(--color-text-muted) mt-1">
                                <span>{commit.author_name}</span>
                                <span>{new Date(commit.timestamp * 1000).toLocaleDateString()}</span>
                              </div>
                            </button>

                            {isExpanded && (
                              <CommitDetail
                                commitDiff={commitDiff}
                                commitChangedFiles={commitChangedFiles}
                                commitDiffSections={commitDiffSections}
                                expandedCommitFiles={expandedCommitFiles}
                                setExpandedCommitFiles={setExpandedCommitFiles}
                              />
                            )}
                          </div>
                        )
                      })}

                      {gitHistory.isFetchingNextPage && (
                        <p className="text-center py-2 text-[10px] text-(--color-text-subtle)">Loading more commits…</p>
                      )}
                      <div ref={sentinelRef} className="h-1" />
                    </div>
                  )
                ) : (
                  gitHistory.isLoading ? (
                    <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Loading tree graph…</p>
                  ) : gitHistory.isError ? (
                    <p className="px-2 py-4 text-xs text-(--color-error)">Failed to load tree graph</p>
                  ) : gitHistory.data?.pages[0]?.is_git_repo === false ? (
                    <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Not a git repository</p>
                  ) : (
                    <div className="flex flex-col h-full min-h-0">
                      <div className="min-h-0 flex-1 overflow-auto rounded-sm border border-(--color-border) bg-(--bg-card) p-2 select-none">
                        {parsedGraphLines.length === 0 ? (
                          <p className="px-2 py-4 text-xs text-(--color-text-subtle)">No graph history.</p>
                        ) : (
                          <div className="flex flex-col min-w-max">
                            {parsedGraphLines.map((line) => (
                              <div key={line.key} className="flex items-center gap-2 hover:bg-(--bg-key)/40 px-1 py-0.5 rounded-xs transition-colors group h-5">
                                <span className="font-mono text-[11px] leading-none whitespace-pre select-none shrink-0 tracking-widest">
                                  {renderGraphPrefix(line.graphPart)}
                                </span>
                                {line.sha ? (
                                  <div className="flex items-center gap-2 min-w-0 flex-1">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        // The graph uses short SHAs (7-10 chars); resolve to the
                                        // full SHA from the loaded commits list so the expand check
                                        // (expandedCommitSha === commit.sha) matches correctly.
                                        const shortSha = line.sha ?? null
                                        const fullSha = shortSha
                                          ? (commits.find((c) => c.sha.startsWith(shortSha))?.sha ?? shortSha)
                                          : null
                                        pendingScrollShaRef.current = fullSha
                                        setExpandedCommitFiles(new Set())
                                        setExpandedCommitSha(fullSha)
                                        setSubTab('commits')
                                      }}
                                      className="shrink-0 cursor-pointer rounded border border-(--color-border-subtle) bg-(--bg-card) px-1 py-0.5 font-mono text-[9px] text-(--color-text-subtle) transition-colors hover:border-(--color-accent)/30 hover:bg-(--color-accent)/10 hover:text-(--color-accent)"
                                      title="Click to view commit details"
                                    >
                                      {line.sha.substring(0, 7)}
                                    </button>
                                    {line.decorations && (
                                      <div className="flex items-center gap-1 shrink-0 max-w-[200px] overflow-hidden">
                                        {line.decorations.split(',').map((ref) => {
                                          const trimmed = ref.trim()
                                          const isHead = trimmed.includes('HEAD ->')
                                          const isRemote = trimmed.includes('origin/')
                                          return (
                                            <span
                                              key={ref}
                                              className={cn(
                                                "text-[8px] font-semibold px-1 py-0.5 rounded border truncate leading-none select-none",
                                                isHead
                                                  ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                                                  : isRemote
                                                  ? "bg-rose-500/10 text-rose-500 border-rose-500/20"
                                                  : "bg-(--color-accent)/10 text-(--color-accent) border-(--color-accent)/20"
                                              )}
                                              title={trimmed}
                                            >
                                              {trimmed}
                                            </span>
                                          )
                                        })}
                                      </div>
                                    )}
                                    <span className="truncate font-mono text-[11px] text-(--color-text-2) group-hover:text-(--color-text) transition-colors flex-1" title={line.message}>
                                      {line.message}
                                    </span>
                                  </div>
                                ) : (
                                  line.raw.trim().length > line.graphPart.trim().length && (
                                    <span className="font-mono text-[11px] text-(--color-text-subtle) truncate flex-1">
                                      {line.raw.substring(line.graphPart.length)}
                                    </span>
                                  )
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                }
              </div>
            </div>
          ) : activeTab?.type === 'file' ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-key)/25 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <FileTypeIcon name={activeTab.file.name || activeTab.file.path} size={16} />
                  <p className="truncate font-mono text-xs font-medium text-(--color-text)" title={activeTab.file.path}>{activeTab.file.path}</p>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <CodingFilePreviewContent workspace={workspace} file={activeTab.file} onAddComment={onAddComment} />
              </div>
            </div>
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
      </div>
    </motion.aside>
  )
}
