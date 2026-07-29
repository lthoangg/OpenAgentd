import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ChevronRight, Copy, Download, ExternalLink, FolderOpen, GitCompare, Plus, RefreshCw, TerminalSquare, Undo2, X, RotateCcw } from 'lucide-react'
import { LongPressButton } from '@/components/ui/long-press-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { getCodingWorkspaceGitDiff, getCodingWorkspaceStatus, getCodingWorkspaceGitHistory, getCodingWorkspaceCommitDiff, discardCodingWorkspaceFile, undoCodingWorkspaceLastCommit, revertCodingWorkspaceCommit } from '@/api/client'
import { CodingFilePreviewContent, DiffPreview, CopyButton } from './CodingFileViewerPanel'
import { TerminalView } from './Terminal/TerminalView'
import { TerminalTabButton } from './Terminal/TerminalTabButton'
import { FileTypeIcon } from './FileTypeIcon'
import { softHapticFeedback } from '@/lib/haptics'
import { downloadCodingWorkspaceFile } from '@/lib/coding-workspace-download'
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
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useGitPanelStore, DEFAULT_WORKSPACE_STATE } from '@/stores/useGitPanelStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useShallow } from 'zustand/react/shallow'
import { useToastStore } from '@/stores/useToastStore'
import type { WorkspaceFileInfo, WorkspaceGitDiffResponse } from '@/api/types'

type ChangedFileStatus = 'A' | 'M' | 'D'
type WorkspacePanelTab =
  | { id: 'review'; type: 'review'; title: 'Git' }
  | { id: string; type: 'terminal'; title: string; termId: string }
  | { id: string; type: 'file'; title: string; file: WorkspaceFileInfo }

interface ChangedFileInfo {
  path: string
  status: ChangedFileStatus
  additions: number
  deletions: number
}

function safeDecodeURIComponent(val: string): string {
  try {
    return decodeURIComponent(val)
  } catch {
    return val
  }
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
  // Same header/content split as DiffPreview: `new file mode` etc. only occur
  // in the per-file header (before the first `@@` hunk), and once content
  // starts every `+`/`-` line counts — including ones whose own content
  // begins with `--`/`++` (removed `---` frontmatter renders as `----`).
  let inFileHeader = true
  for (const line of diff.diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inFileHeader = true
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)
      if (!match?.[1] || !match[2]) {
        current = null
        continue
      }
      const path = match[2] === 'dev/null' ? match[1] : match[2]
      current = files.get(path) ?? { path, status: 'M', additions: 0, deletions: 0 }
      files.set(current.path, current)
      continue
    }
    if (!current) continue
    if (line.startsWith('@@')) {
      inFileHeader = false
      continue
    }
    if (inFileHeader) {
      if (line.startsWith('new file mode')) current.status = 'A'
      else if (line.startsWith('deleted file mode')) current.status = 'D'
      continue
    }
    if (line.startsWith('+')) current.additions += 1
    else if (line.startsWith('-')) current.deletions += 1
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
  mobile?: boolean
  setMobileFileActions: React.Dispatch<React.SetStateAction<ChangedFileInfo | null>>
  setDesktopFileActions: React.Dispatch<React.SetStateAction<{ file: ChangedFileInfo; x: number; y: number } | null>>
}

function CommitSyncBadge({
  count,
  direction,
  upstream,
}: {
  count: number
  direction: 'ahead' | 'behind'
  upstream?: string | null
}) {
  const isAhead = direction === 'ahead'
  const noun = count === 1 ? 'commit' : 'commits'
  const target = upstream || 'origin'
  return (
    <span
      title={`${count} ${isAhead ? `local ${noun} ahead of ${target}` : `${noun} behind ${target}`}`}
      className={cn(
        'rounded border border-(--color-border-subtle) bg-(--bg-card) px-1 py-0.5 font-mono text-[9px] font-semibold leading-none',
        isAhead ? 'text-(--color-diff-add-text)' : 'text-(--color-diff-del-text)',
      )}
    >
      {count}{isAhead ? '↑' : '↓'}
    </span>
  )
}


function CommitDetail({
  commitDiff,
  commitChangedFiles,
  commitDiffSections,
  expandedCommitFiles,
  setExpandedCommitFiles,
  mobile = false,
  setMobileFileActions,
  setDesktopFileActions,
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
            <LongPressButton
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleFileExpanded(changedFile.path) }}
              enabled={mobile}
              onLongPress={() => setMobileFileActions(changedFile)}
              onContextMenu={(e) => {
                if (!mobile) {
                  e.preventDefault()
                  setDesktopFileActions({
                    file: changedFile,
                    x: e.clientX,
                    y: e.clientY,
                  })
                }
              }}
              className="flex w-full cursor-pointer items-center gap-1.5 px-1.5 py-1 text-left text-[10px] text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text)"
              aria-expanded={expanded}
            >
              <ChevronRight size={10} className={cn('shrink-0 text-(--color-text-subtle) transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
              <FileTypeIcon name={changedFile.path} size={11} />
              <span className="min-w-0 flex-1 truncate font-mono">{changedFile.path}</span>
              <span className="shrink-0 font-mono text-[8px] text-(--color-diff-add-text)">{changedFile.additions > 0 ? `+${changedFile.additions}` : ''}</span>
              <span className="shrink-0 font-mono text-[8px] text-(--color-diff-del-text)">{changedFile.deletions > 0 ? `-${changedFile.deletions}` : ''}</span>
              <span className="shrink-0 font-mono text-[8px] font-semibold text-(--accent-orange-text)">{changedFile.status}</span>
            </LongPressButton>
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
  terminalOpenKey = 0,
  handledTerminalOpenKeyRef: parentHandledTerminalOpenKeyRef,
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
  /** Bump to open (or focus) the Terminal tab — ⌘⇧` / palette. Key 0 is
   *  the mount default and is ignored; only increments act. */
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
  const [copiedSha, setCopiedSha] = useState<string | null>(null)
  const [discardTarget, setDiscardTarget] = useState<ChangedFileInfo | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [gitActionPending, setGitActionPending] = useState(false)
  const pushToast = useToastStore((s) => s.push)
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
    // Shared cache entry with the @-mention picker and command palette —
    // same endpoint, same payload. See ``workspace-files.ts``.
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

  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const hasNextPageRef = useRef(gitHistory.hasNextPage)
  const isFetchingNextPageRef = useRef(gitHistory.isFetchingNextPage)
  const fetchNextPageRef = useRef(gitHistory.fetchNextPage)
  useEffect(() => {
    hasNextPageRef.current = gitHistory.hasNextPage
    isFetchingNextPageRef.current = gitHistory.isFetchingNextPage
    fetchNextPageRef.current = gitHistory.fetchNextPage
  })

  useEffect(() => {
    if (!sentinelRef.current || !hasNextPageRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPageRef.current && !isFetchingNextPageRef.current) {
          void fetchNextPageRef.current()
        }
      },
      { threshold: 0.1 }
    )

    const el = sentinelRef.current
    observer.observe(el)
    return () => {
      observer.unobserve(el)
    }
  }, [subTab])

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
        return current.map((item) => item.id === id ? { ...existing, file } : item)
      }
      return [...current, { id, type: 'file', title: file.name || file.path.split('/').pop() || file.path, file }]
    })
    setActiveTabId(id)
    onFileSelect?.(file)
  }, [onFileSelect])
  // ── Terminal tabs — sessions owned by useTerminalStore ─────────────
  // Sync tabs to store sessions: adopt new/live ones, drop closed ones.
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
    // ⌘⇧` / palette: focus the most recent terminal, or open the first one
    // (VS Code behaviour). Explicit "New terminal" always opens another.
    const metas = useTerminalStore.getState().sessionsForContext(workspace)
    const last = metas[metas.length - 1]
    if (last) setActiveTabId(`terminal:${last.id}`)
    else openTerminal()
  }, [workspace, openTerminal])
  // Parent-driven open requests (⌘⇧` shortcut, command palette). Same
  // bump-key pattern as selectedFileOpenKey: only a fresh increment acts,
  // so background re-renders never re-open a tab the user closed.
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

  // Reset active tab to review if active tab was closed (e.g. terminal tab closed directly via store).
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
      // Kills the PTY server-side; the tab-sync effect removes the tab.
      useTerminalStore.getState().close(terminalTab.termId)
    }
    setTabs((current) => current.filter((item) => item.id !== id))
    if (activeTabId === id) {
      setActiveTabId('review')
      // Notify the parent so it can clear its codingFileViewer state.
      // Without this, reopening the panel re-mounts CodingWorkspacePanel
      // with the same selectedFilePath/selectedFileOpenKey, causing the
      // closed tab to reappear immediately.
      onFileSelect?.(null)
    }
  }
  // Cmd+W / Ctrl+W closes the active file tab instead of propagating to the
  // desktop (where the OS would close the app window). Only intercepts when a
  // file tab is active — the Git review tab cannot be closed, so the shortcut
  // is left unregistered in that case and the event is not consumed.
  useKeyboardShortcuts({
    w: activeTabId !== 'review' ? () => closeTab(activeTabId) : undefined,
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
        Math.floor((typeof window === 'undefined' ? 1200 : window.innerWidth) - leftSidebarWidth - 380)
      )
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
            {tabs.map((tabItem) => tabItem.type === 'terminal' ? (
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
                    className="ml-0.5 rounded text-(--color-text-subtle) opacity-70 hover:text-(--color-text) md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
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
            aria-label={`Search files (${formatShortcut('P', os)})`}
            title={`Search files (${formatShortcut('P', os)})`}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={openTerminal}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7"
            aria-label="New terminal"
            title="New terminal"
          >
            <TerminalSquare size={14} aria-hidden="true" />
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
                            ? <span className="inline-flex items-center gap-1">
                                Commits
                                {commitsAhead != null && commitsAhead > 0 && (
                                  <CommitSyncBadge count={commitsAhead} direction="ahead" upstream={upstream} />
                                )}
                                {commitsBehind != null && commitsBehind > 0 && (
                                  <CommitSyncBadge count={commitsBehind} direction="behind" upstream={upstream} />
                                )}
                              </span>
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

              <div ref={commitsScrollRef} className="min-h-0 flex-1 overflow-auto touch-pan-y p-2">
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
                              <LongPressButton
                                type="button"
                                onClick={() => toggleDiffExpanded(changedFile.path)}
                                enabled={mobile}
                                onLongPress={() => setMobileFileActions(changedFile)}
                                onContextMenu={(e) => {
                                  if (!mobile) {
                                    e.preventDefault()
                                    setDesktopFileActions({
                                      file: changedFile,
                                      x: e.clientX,
                                      y: e.clientY,
                                    })
                                  }
                                }}
                                className={cn(
                                  'flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-(--bg-key) hover:text-(--color-text)',
                                  isSelected ? 'text-(--color-accent)' : 'text-(--color-text-2)',
                                )}
                                title={changedFile.path}
                                aria-label={`${expanded ? 'Collapse' : 'Expand'} diff for ${changedFile.path}`}
                                aria-expanded={expanded}
                              >
                                <ChevronRight size={12} className={cn('shrink-0 text-(--color-text-subtle) transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
                                <FileTypeIcon name={changedFile.path} size={13} />
                                <span className="min-w-0 flex-1 truncate font-mono">{changedFile.path}</span>
                                {changedFile.status !== 'D' && (
                                  <span
                                    role="button"
                                    tabIndex={0}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      const name = changedFile.path.split('/').pop() ?? changedFile.path
                                      const file: WorkspaceFileInfo = files.data?.files.find((f) => f.path === changedFile.path)
                                        ?? { path: changedFile.path, name, size: 0, mtime: 0, mime: 'text/plain' }
                                      openFileTab(file)
                                    }}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click() }}
                                    className="hidden shrink-0 rounded p-0.5 text-(--color-text-subtle) opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-(--color-text) md:block"
                                    title="Open file"
                                    aria-label={`Open ${changedFile.path}`}
                                  >
                                    <ExternalLink size={11} aria-hidden="true" />
                                  </span>
                                )}
                                <span className="shrink-0 font-mono text-[10px] text-(--color-diff-add-text)">{changedFile.additions > 0 ? `+${changedFile.additions}` : ''}</span>
                                <span className="shrink-0 font-mono text-[10px] text-(--color-diff-del-text)">{changedFile.deletions > 0 ? `-${changedFile.deletions}` : ''}</span>
                                <span className="shrink-0 font-mono text-[10px] font-semibold text-(--accent-orange-text)" aria-label={CHANGED_STATUS_LABELS[changedFile.status]}>{changedFile.status}</span>
                              </LongPressButton>

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
                    <>
                      {copiedSha && (
                        <div className="mb-2 flex items-center gap-1.5 rounded border border-(--color-border) bg-(--bg-card) px-2 py-1.5 text-[11px] text-(--color-text-2)">
                          <Copy size={10} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
                          <span className="font-mono">{copiedSha.length > 10 ? copiedSha.substring(0, 10) + '…' : copiedSha}</span>
                          <span className="text-(--color-text-muted)">copied</span>
                        </div>
                      )}
                      <div className="space-y-2">
                        {commits.map((commit) => {
                          const isExpanded = expandedCommitSha === commit.sha
                          return (
                          <div key={commit.sha} data-commit-sha={commit.sha} className="overflow-hidden rounded border border-(--color-border-subtle) bg-(--bg-card) p-2 transition-colors hover:border-(--color-border) hover:bg-(--bg-key)">
                            <LongPressButton
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
                              enabled={mobile}
                             onLongPress={() => setMobileCommitActions({ sha: commit.sha, shortSha: commit.short_sha, subject: safeDecodeURIComponent(commit.subject) })}
                             onContextMenu={(e) => {
                               if (!mobile) {
                                 e.preventDefault()
                                 setDesktopCommitActions({
                                   sha: commit.sha,
                                   shortSha: commit.short_sha,
                                   subject: safeDecodeURIComponent(commit.subject),
                                   x: e.clientX,
                                   y: e.clientY,
                                 })
                               }
                             }}
                             className="flex w-full cursor-pointer flex-col gap-1 text-left"
                            >
                              <div className="flex w-full items-start justify-between gap-1.5">
                                <div className="flex items-start gap-1.5 min-w-0 flex-1">
                                  <span className="shrink-0 font-mono text-xs text-(--color-text-subtle) select-none mt-0.5">•</span>
                                  <span className="truncate font-mono text-[11px] font-semibold text-(--color-text)">
                                    {safeDecodeURIComponent(commit.subject)}
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
                                <span>{new Date(commit.timestamp * 1000).toLocaleDateString('en-GB')} {new Date(commit.timestamp * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                              </div>
                            </LongPressButton>

                            {isExpanded && (
                              <>
                                {commit.body && (
                                  <p className="mt-2 max-h-32 overflow-y-auto touch-pan-y whitespace-pre-wrap break-words rounded border border-(--color-border) bg-(--bg-page) px-2 py-1.5 text-[11px] leading-relaxed text-(--color-text-2)">
                                    {commit.body}
                                  </p>
                                )}
                                <CommitDetail
                                  commitDiff={commitDiff}
                                  commitChangedFiles={commitChangedFiles}
                                  commitDiffSections={commitDiffSections}
                                  expandedCommitFiles={expandedCommitFiles}
                                  setExpandedCommitFiles={setExpandedCommitFiles}
                                  mobile={mobile}
                                  setMobileFileActions={setMobileFileActions}
                                  setDesktopFileActions={setDesktopFileActions}
                                />
                              </>
                            )}
                          </div>
                        )
                      })}

                      {gitHistory.isFetchingNextPage && (
                        <p className="text-center py-2 text-[10px] text-(--color-text-subtle)">Loading more commits…</p>
                      )}
                      <div ref={sentinelRef} className="h-1" />
                    </div>
                    </>
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
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void downloadCodingWorkspaceFile(workspace, activeTab.file)}
                    title="Download file"
                    aria-label="Download file"
                    className="flex h-9 w-9 items-center justify-center rounded text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) disabled:cursor-not-allowed disabled:opacity-40 md:h-auto md:w-auto md:p-1"
                  >
                    <Download size={13} />
                  </button>
                  <CopyButton workspace={workspace} file={activeTab.file} />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <CodingFilePreviewContent workspace={workspace} file={activeTab.file} onAddComment={onAddComment} />
              </div>
            </div>
          ) : null}
          {/* Only the active terminal is mounted — sessions live in
              useTerminalStore, so hidden terminals keep their PTY and
              scrollback without holding a renderer in the DOM. */}
          {activeTab?.type === 'terminal' && (
            <div className="h-full p-1.5">
              <TerminalView key={activeTab.termId} sessionId={activeTab.termId} />
            </div>
          )}
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
                void navigator.clipboard.writeText(c.shortSha).then(() => { setCopiedSha(c.shortSha); setTimeout(() => setCopiedSha(null), 2000) })
              }}>
                <Copy size={14} aria-hidden="true" />
                Copy short SHA
              </Button>
              <Button type="button" variant="ghost" className="justify-start" disabled={gitActionPending} onClick={() => {
                const c = mobileCommitActions; setMobileCommitActions(null)
                if (!c) return
                softHapticFeedback()
                void navigator.clipboard.writeText(c.sha).then(() => { setCopiedSha(c.sha); setTimeout(() => setCopiedSha(null), 2000) })
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
      </div>

      {/* Discard confirmation dialog */}
      <Dialog open={discardTarget !== null} onOpenChange={(open) => { if (!open && !discarding) setDiscardTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              {discardTarget?.status === 'A'
                ? `"${discardTarget.path}" is a new file and will be permanently deleted.`
                : `All unsaved changes to "${discardTarget?.path}" will be lost and cannot be recovered.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={discarding}
              onClick={() => setDiscardTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger-subtle"
              disabled={discarding}
              onClick={async () => {
                const f = discardTarget
                if (!f) return
                setDiscarding(true)
                try {
                  await discardCodingWorkspaceFile(workspace, f.path, f.status)
                  softHapticFeedback()
                  void diff.refetch()
                  void files.refetch()
                } catch {
                  // leave dialog open so user sees the failure
                } finally {
                  setDiscarding(false)
                  setDiscardTarget(null)
                }
              }}
            >
              <Undo2 size={14} aria-hidden="true" className="mr-1.5" />
              {discarding ? 'Discarding…' : discardTarget?.status === 'A' ? 'Delete file' : 'Discard changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {desktopCommitActions && (
        <div
          className="fixed inset-0 z-50 pointer-events-auto"
          onClick={() => setDesktopCommitActions(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setDesktopCommitActions(null)
          }}
        >
          <div
            role="menu"
            aria-label="Commit actions"
            className="fixed min-w-48 rounded border border-(--color-border) bg-(--bg-card) p-1 text-xs text-(--color-text) shadow-md"
            style={{
              left: Math.min(desktopCommitActions.x, window.innerWidth - 200 - 8),
              top: Math.min(desktopCommitActions.y, window.innerHeight - 180 - 8)
            }}
            onClick={(event) => event.stopPropagation()}
          >
            {isLatestCommit && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-(--color-error) hover:bg-(--color-error)/10 focus-visible:bg-(--color-error)/10 focus-visible:outline-none cursor-pointer"
                disabled={gitActionPending}
                onClick={() => void handleUndoCommit()}
              >
                <Undo2 size={12} aria-hidden="true" />
                {gitActionPending ? 'Undoing…' : 'Undo commit'}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none cursor-pointer"
              disabled={gitActionPending}
              onClick={() => void handleRevertCommit(desktopCommitActions.sha, desktopCommitActions.shortSha)}
            >
              <RotateCcw size={12} aria-hidden="true" />
              {gitActionPending ? 'Reverting…' : 'Revert commit'}
            </button>
            <div className="my-1 border-t border-(--color-border-subtle)" />
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none cursor-pointer"
              onClick={() => {
                const c = desktopCommitActions
                setDesktopCommitActions(null)
                softHapticFeedback()
                void navigator.clipboard.writeText(c.shortSha).then(() => {
                  setCopiedSha(c.shortSha)
                  setTimeout(() => setCopiedSha(null), 2000)
                })
              }}
            >
              <Copy size={12} aria-hidden="true" />
              Copy short SHA
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none cursor-pointer"
              onClick={() => {
                const c = desktopCommitActions
                setDesktopCommitActions(null)
                softHapticFeedback()
                void navigator.clipboard.writeText(c.sha).then(() => {
                  setCopiedSha(c.sha)
                  setTimeout(() => setCopiedSha(null), 2000)
                })
              }}
            >
              <Copy size={12} aria-hidden="true" />
              Copy full SHA
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none cursor-pointer"
              onClick={() => {
                const c = desktopCommitActions
                setDesktopCommitActions(null)
                softHapticFeedback()
                void navigator.clipboard.writeText(c.subject)
              }}
            >
              <Copy size={12} aria-hidden="true" />
              Copy commit message
            </button>
          </div>
        </div>
      )}

      {desktopFileActions && (
        <div
          className="fixed inset-0 z-50 pointer-events-auto"
          onClick={() => setDesktopFileActions(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setDesktopFileActions(null)
          }}
        >
          <div
            role="menu"
            aria-label="File actions"
            className="fixed min-w-48 rounded border border-(--color-border) bg-(--bg-card) p-1 text-xs text-(--color-text) shadow-md"
            style={{
              left: Math.min(desktopFileActions.x, window.innerWidth - 200 - 8),
              top: Math.min(desktopFileActions.y, window.innerHeight - 150 - 8)
            }}
            onClick={(event) => event.stopPropagation()}
          >
            {desktopFileActions.file.status !== 'D' && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none cursor-pointer"
                onClick={() => {
                  const f = desktopFileActions.file
                  setDesktopFileActions(null)
                  softHapticFeedback()
                  const name = f.path.split('/').pop() ?? f.path
                  const file: WorkspaceFileInfo = files.data?.files.find((fi) => fi.path === f.path)
                    ?? { path: f.path, name, size: 0, mtime: 0, mime: 'text/plain' }
                  openFileTab(file)
                }}
              >
                <FolderOpen size={12} aria-hidden="true" />
                Open file
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none cursor-pointer"
              onClick={() => {
                const f = desktopFileActions.file
                setDesktopFileActions(null)
                softHapticFeedback()
                void navigator.clipboard.writeText(f.path)
              }}
            >
              <Copy size={12} aria-hidden="true" />
              Copy file path
            </button>
            <div className="my-1 border-t border-(--color-border-subtle)" />
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-(--color-error) hover:bg-(--color-error)/10 focus-visible:bg-(--color-error)/10 focus-visible:outline-none cursor-pointer"
              onClick={() => {
                const f = desktopFileActions.file
                setDesktopFileActions(null)
                setDiscardTarget(f)
              }}
            >
              <Undo2 size={12} aria-hidden="true" />
              Discard changes
            </button>
          </div>
        </div>
      )}
    </motion.aside>
  )
}
