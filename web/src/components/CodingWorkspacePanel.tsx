import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ChevronRight, FileText, Folder, GitCompare, Plus, RefreshCw, Search, X } from 'lucide-react'
import { getCodingWorkspaceGitDiff, listCodingWorkspaceFiles } from '@/api/client'
import { CodingFilePreviewContent, DiffPreview } from './CodingFileViewerPanel'
import { cn } from '@/lib/utils'
import { queryKeys } from '@/queries'
import { formatBytes } from '@/utils/format'
import { workspaceLabel } from '@/utils/workspace'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import type { WorkspaceFileInfo, WorkspaceGitDiffResponse } from '@/api/types'

type ChangedFileStatus = 'A' | 'M' | 'D'
type WorkspacePanelTab =
  | { id: 'review'; type: 'review'; title: 'Changes' }
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

export function CodingWorkspacePanel({
  workspace,
  open,
  onClose,
  mobile = false,
  selectedFilePath = null,
  selectedFileOpenKey = 0,
  onFileSelect,
  onAddComment,
}: {
  workspace: string
  open: boolean
  initialTab?: 'files' | 'changed'
  onClose: () => void
  mobile?: boolean
  selectedFilePath?: string | null
  selectedFileOpenKey?: number
  onFileSelect?: (file: WorkspaceFileInfo | null) => void
  onAddComment?: (path: string, startLine: number, endLine: number) => void
}) {
  const prefersReducedMotion = useReducedMotion()
  const [tabs, setTabs] = useState<WorkspacePanelTab[]>([{ id: 'review', type: 'review', title: 'Changes' }])
  const [activeTabId, setActiveTabId] = useState('review')
  const [fileSearchOpen, setFileSearchOpen] = useState(false)
  const [fileSearch, setFileSearch] = useState('')
  const [expandedDiffs, setExpandedDiffs] = useState<Set<string>>(() => new Set())
  const searchInputRef = useRef<HTMLInputElement>(null)
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>())
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
    setExpandedDiffs((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const searchableFiles = useMemo(() => {
    const query = fileSearch.trim().toLowerCase()
    const allFiles = files.data?.files ?? []
    if (!query) return allFiles.slice(0, 30)
    return allFiles.filter((file) => file.path.toLowerCase().includes(query)).slice(0, 30)
  }, [fileSearch, files.data?.files])

  useEffect(() => {
    if (!selectedFilePath || files.data?.files == null) return
    const file = files.data.files.find((item) => item.path === selectedFilePath)
    if (file) openFileTab(file)
  }, [files.data?.files, openFileTab, selectedFileOpenKey, selectedFilePath])

  useEffect(() => {
    if (fileSearchOpen) searchInputRef.current?.focus()
  }, [fileSearchOpen])
  useEffect(() => {
    tabButtonRefs.current.get(activeTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])
  const resizable = useResizableWidth({
    storageKey: 'oa.codingWorkspacePanel.width',
    defaultWidth: 380,
    minWidth: 300,
    maxWidth: Math.min(640, Math.max(320, Math.floor((typeof window === 'undefined' ? 720 : window.innerWidth) - 320))),
    edge: 'left',
    disabled: mobile,
  })

  if (!open) return null

  return (
    <motion.aside
      initial={prefersReducedMotion ? { opacity: 0 } : mobile ? { opacity: 0 } : { width: 0 }}
      animate={prefersReducedMotion ? { opacity: 1 } : mobile ? { opacity: 1 } : { width: resizable.width }}
      exit={prefersReducedMotion ? { opacity: 0 } : mobile ? { opacity: 0 } : { width: 0 }}
      transition={{ duration: resizable.isResizing || prefersReducedMotion ? 0.01 : 0.22, ease: [0.4, 0, 0.2, 1] }}
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
        {mobile && <div className="flex min-h-10 items-center justify-between border-b border-(--color-border) px-2.5 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <Folder size={13} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
            <p className="truncate font-mono text-xs text-(--color-text)" title={workspace}>{workspaceLabel(workspace)}</p>
          </div>
          <button type="button" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-md text-(--color-text-muted) hover:bg-(--bg-key) md:h-auto md:w-auto md:p-1" aria-label="Close workspace panel">
            <X size={16} />
          </button>
        </div>}
        <div className="flex min-w-0 items-center gap-1 border-b border-(--color-border) px-2 py-1">
          <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
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
                  'group flex h-7 max-w-40 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs',
                  activeTabId === tabItem.id
                    ? tabItem.type === 'file'
                      ? 'border border-(--color-border-strong) text-(--color-accent)'
                      : 'border border-(--color-border-strong) text-(--color-text)'
                    : 'border border-transparent text-(--color-text-muted) hover:text-(--color-text-2)',
                )}
                title={tabItem.type === 'file' ? tabItem.file.path : tabItem.title}
              >
                {tabItem.type === 'review' ? <GitCompare size={12} aria-hidden="true" /> : <FileText size={12} aria-hidden="true" />}
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
            onClick={() => { setFileSearchOpen((value) => !value); setFileSearch('') }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)"
            aria-label="Open file search"
            title="Open file search"
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
        {fileSearchOpen && (
          <div
            className={cn(
              'z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm',
              mobile ? 'absolute inset-0' : 'fixed inset-0',
            )}
            onClick={() => setFileSearchOpen(false)}
          >
          <div className="flex max-h-[min(28rem,calc(100%-2rem))] w-full max-w-md flex-col overflow-hidden rounded-xl border border-(--color-border) bg-(--bg-card) shadow-2xl" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Search workspace files">
            <div className="flex h-14 items-center gap-3 border-b border-(--color-border) px-4">
              <Search size={16} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
              <input
                ref={searchInputRef}
                value={fileSearch}
                onChange={(event) => setFileSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setFileSearchOpen(false)
                  if (event.key === 'Enter' && searchableFiles[0]) {
                    openFileTab(searchableFiles[0])
                    setFileSearchOpen(false)
                  }
                }}
                placeholder="Search files…"
                className="min-w-0 flex-1 bg-transparent font-mono text-base text-(--color-text) outline-none placeholder:text-(--color-text-subtle) md:text-sm"
                aria-label="Search workspace files"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {searchableFiles.length === 0 ? (
                <p className="px-2 py-3 text-xs text-(--color-text-subtle)">No files found</p>
              ) : searchableFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => { openFileTab(file); setFileSearchOpen(false) }}
                  className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text)"
                  title={file.path}
                >
                  <FileText size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                  <span className="shrink-0 text-[10px] text-(--color-text-subtle)">{formatBytes(file.size)}</span>
                </button>
              ))}
            </div>
          </div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          {activeTab?.type === 'review' ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="min-h-0 flex-1 overflow-auto p-2">
          {
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
                      <div key={changedFile.path} className="overflow-hidden rounded border border-(--color-border-subtle) bg-(--bg-card)">
                        <button
                          type="button"
                          onClick={() => toggleDiffExpanded(changedFile.path)}
                          className={cn(
                            'flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-(--bg-key) hover:text-(--color-text)',
                            isSelected ? 'text-(--color-accent)' : 'text-(--color-text-2)',
                          )}
                          title={changedFile.path}
                          aria-label={`${expanded ? 'Collapse' : 'Expand'} diff for ${changedFile.path}`}
                          aria-expanded={expanded}
                        >
                          <ChevronRight size={12} className={cn('shrink-0 text-(--color-text-subtle) transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
                          <FileText size={12} className="shrink-0 text-(--accent-orange-text)" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate font-mono">{changedFile.path}</span>
                          <span className="shrink-0 font-mono text-[10px] text-(--color-diff-add-text)">{changedFile.additions > 0 ? `+${changedFile.additions}` : ''}</span>
                          <span className="shrink-0 font-mono text-[10px] text-(--color-diff-del-text)">{changedFile.deletions > 0 ? `-${changedFile.deletions}` : ''}</span>
                          <span className="shrink-0 font-mono text-[10px] font-semibold text-(--accent-orange-text)" aria-label={CHANGED_STATUS_LABELS[changedFile.status]}>{changedFile.status}</span>
                        </button>
                        {expanded && (
                          <div className="border-t border-(--color-border-subtle)">
                            {fileDiff ? <div className="max-h-[70vh] overflow-auto overscroll-contain touch-pan-y"><DiffPreview diff={fileDiff} /></div>
                              : <p className="px-2 py-3 text-xs text-(--color-text-subtle)">No diff body for this file.</p>}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          }
              </div>
            </div>
          ) : activeTab?.type === 'file' ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-card) px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-(--color-border) text-(--color-accent)">
                    <FileText size={13} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs font-medium text-(--color-text)" title={activeTab.file.path}>{activeTab.file.path}</p>
                    <p className="mt-0.5 truncate text-[10px] text-(--color-text-subtle)">{formatBytes(activeTab.file.size)} · {activeTab.file.mime}</p>
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <CodingFilePreviewContent workspace={workspace} file={activeTab.file} onAddComment={onAddComment} />
              </div>
            </div>
          ) : null}
        </div>
        <button type="button" onClick={() => { void files.refetch(); void diff.refetch() }} className="flex items-center justify-center gap-1.5 border-t border-(--color-border) px-3 py-2 text-xs text-(--color-text-muted) hover:bg-(--bg-key)">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
    </motion.aside>
  )
}
