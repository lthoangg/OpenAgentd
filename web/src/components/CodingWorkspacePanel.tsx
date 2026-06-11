import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ChevronRight, FileText, Folder, GitCompare, RefreshCw, X } from 'lucide-react'
import { getCodingWorkspaceGitDiff, listCodingWorkspaceFiles } from '@/api/client'
import { cn } from '@/lib/utils'
import { queryKeys } from '@/queries'
import { formatBytes } from '@/utils/format'
import { workspaceLabel } from '@/utils/workspace'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import type { WorkspaceFileInfo, WorkspaceGitDiffResponse } from '@/api/types'

interface TreeNode {
  name: string
  path: string
  children: Map<string, TreeNode>
  file?: WorkspaceFileInfo
}

function collectChangedPaths(diff?: WorkspaceGitDiffResponse): Set<string> {
  const paths = new Set<string>()
  if (!diff?.is_git_repo) return paths

  for (const line of diff.diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      if (match?.[2]) paths.add(match[2])
    }
  }
  for (const path of diff.untracked ?? []) paths.add(path)
  return paths
}

function pathHasChangedDescendant(path: string, changedPaths: Set<string>): boolean {
  const prefix = `${path}/`
  for (const changedPath of changedPaths) {
    if (changedPath === path || changedPath.startsWith(prefix)) return true
  }
  return false
}

function buildTree(files: WorkspaceFileInfo[]): TreeNode {
  const root: TreeNode = { name: '/', path: '', children: new Map() }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/')
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, path, children: new Map() }
        node.children.set(part, child)
      }
      if (index === parts.length - 1) child.file = file
      node = child
    })
  }
  return root
}

function TreeNodeView({
  node,
  depth,
  selectedPath,
  onFileSelect,
  changedPaths,
}: {
  node: TreeNode
  depth: number
  selectedPath?: string | null
  onFileSelect?: (file: WorkspaceFileInfo | null) => void
  changedPaths: Set<string>
}) {
  const [open, setOpen] = useState(false)
  const isDir = node.children.size > 0 && !node.file
  const children = Array.from(node.children.values()).sort((a, b) => {
    const aDir = a.children.size > 0 && !a.file
    const bDir = b.children.size > 0 && !b.file
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  if (!isDir && node.file) {
    const isSelected = node.file.path === selectedPath
    const isChanged = changedPaths.has(node.file.path)
    return (
      <button
        type="button"
        onClick={() => onFileSelect?.(isSelected ? null : node.file!)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition-colors',
          isSelected
            ? 'bg-(--bg-key) text-(--color-accent)'
            : isChanged
              ? 'text-(--accent-orange-text) hover:bg-(--bg-key)'
              : 'text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text)',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={node.file.path}
      >
        <FileText size={12} className={cn('shrink-0', isChanged ? 'text-(--accent-orange-text)' : 'text-(--color-text-subtle)')} />
        <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
        {isChanged && (
          <span className="shrink-0 font-mono text-[10px] font-semibold text-(--accent-orange-text)">
            M
          </span>
        )}
        <span className="shrink-0 text-[10px] text-(--color-text-subtle)">{formatBytes(node.file.size)}</span>
      </button>
    )
  }

  const hasChangedDescendant = node.path ? pathHasChangedDescendant(node.path, changedPaths) : false

  return (
    <div>
      {node.path && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-(--bg-key)',
            hasChangedDescendant ? 'text-(--color-text)' : 'text-(--color-text-2)',
          )}
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
          <Folder size={12} className={cn('shrink-0', hasChangedDescendant ? 'text-(--accent-orange-text)' : 'text-(--color-accent)')} />
          <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
          {hasChangedDescendant && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--accent-orange-text)" aria-label="Contains modified files" />}
        </button>
      )}
      {(open || !node.path) && children.map((child) => (
        <TreeNodeView key={child.path} node={child} depth={node.path ? depth + 1 : 0} selectedPath={selectedPath} onFileSelect={onFileSelect} changedPaths={changedPaths} />
      ))}
    </div>
  )
}

function diffLineClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-(--color-accent)'
  if (line.startsWith('@@')) return 'bg-(--color-accent)/10 text-(--color-accent)'
  if (line.startsWith('+')) return 'bg-(--color-diff-add-bg) text-(--color-diff-add-text)'
  if (line.startsWith('-')) return 'bg-(--color-diff-del-bg) text-(--color-diff-del-text)'
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'text-(--color-text)'
  return 'text-(--color-text-2)'
}

interface ParsedDiffLine {
  kind: 'meta' | 'hunk' | 'add' | 'delete' | 'context'
  content: string
  oldLine: number | null
  newLine: number | null
}

interface ParsedDiffFile {
  path: string
  additions: number
  deletions: number
  lines: ParsedDiffLine[]
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = []
  let current: ParsedDiffFile | null = null
  let oldLineNo = 0
  let newLineNo = 0

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      current = { path: match?.[2] ?? line.replace('diff --git ', ''), additions: 0, deletions: 0, lines: [] }
      files.push(current)
      oldLineNo = 0
      newLineNo = 0
      continue
    }
    if (!current) continue
    if (line.startsWith('@@')) {
      const match = HUNK_HEADER_RE.exec(line)
      if (match) {
        oldLineNo = Number(match[1])
        newLineNo = Number(match[2])
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      current.additions += 1
      current.lines.push({ kind: 'add', content: line, oldLine: null, newLine: newLineNo })
      newLineNo += 1
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletions += 1
      current.lines.push({ kind: 'delete', content: line, oldLine: oldLineNo, newLine: null })
      oldLineNo += 1
    } else if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      continue
    } else {
      current.lines.push({ kind: 'context', content: line || ' ', oldLine: oldLineNo, newLine: newLineNo })
      oldLineNo += 1
      newLineNo += 1
    }
  }

  return files
}

function diffLineClassName(kind: ParsedDiffLine['kind']) {
  if (kind === 'add') return 'bg-(--color-diff-add-bg) text-(--color-diff-add-text)'
  if (kind === 'delete') return 'bg-(--color-diff-del-bg) text-(--color-diff-del-text)'
  if (kind === 'hunk') return 'bg-(--color-accent)/10 text-(--color-accent)'
  if (kind === 'meta') return 'text-(--color-text-muted)'
  return 'text-(--color-text-2)'
}

function DiffChanges({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-xs">
      {additions > 0 && <span className="text-emerald-400">+{additions}</span>}
      {deletions > 0 && <span className="text-red-400">-{deletions}</span>}
    </span>
  )
}

const GUTTER_WIDTH_CH = 4

function displayLineNumber(line: ParsedDiffLine): number | null {
  if (line.kind === 'add' || line.kind === 'context') return line.newLine
  if (line.kind === 'delete') return line.oldLine
  return null
}

function DiffGutter({ value }: { value: number | null }) {
  return (
    <span className="inline-block shrink-0 select-none text-right tabular-nums text-(--color-text-subtle)" style={{ width: `${GUTTER_WIDTH_CH}ch` }} aria-hidden="true">
      {value ?? ''}
    </span>
  )
}

function DiffFileSection({ file }: { file: ParsedDiffFile }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="overflow-hidden bg-(--bg-page)">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} diff for ${file.path}`} className="flex w-full items-center gap-3 border-b border-(--color-border)/50 px-3 py-1.5 text-left hover:bg-(--bg-key)">
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-(--color-text)" title={file.path}>{file.path}</span>
        <DiffChanges additions={file.additions} deletions={file.deletions} />
      </button>
      {open ? (
        <pre className="font-mono text-[11px] leading-relaxed">
          {file.lines.map((line, index) => (
            <span key={index} className={cn('flex items-start gap-2 whitespace-pre-wrap break-all px-2', diffLineClassName(line.kind))}>
              <DiffGutter value={displayLineNumber(line)} />
              <span className="min-w-0 flex-1">{line.content}</span>
            </span>
          ))}
        </pre>
      ) : null}
    </section>
  )
}

function DiffPreview({ diff }: { diff: string }) {
  const files = parseUnifiedDiff(diff)
  if (files.length > 0) {
    return <div className="space-y-0">{files.map((file) => <DiffFileSection key={file.path} file={file} />)}</div>
  }

  return (
    <pre className="rounded bg-(--bg-page) p-2 font-mono text-[11px] leading-relaxed">
      {diff.split('\n').map((line, index) => (
        <span key={index} className={cn('block whitespace-pre-wrap break-all', diffLineClass(line))}>{line || ' '}</span>
      ))}
    </pre>
  )
}

export function CodingWorkspacePanel({
  workspace,
  open,
  initialTab = 'files',
  onClose,
  mobile = false,
  selectedFilePath = null,
  onFileSelect,
}: {
  workspace: string
  open: boolean
  initialTab?: 'files' | 'diff'
  onClose: () => void
  mobile?: boolean
  selectedFilePath?: string | null
  onFileSelect?: (file: WorkspaceFileInfo | null) => void
}) {
  const prefersReducedMotion = useReducedMotion()
  const [tab, setTab] = useState<'files' | 'diff'>(initialTab)
  const files = useQuery({
    queryKey: queryKeys.coding.files(workspace),
    queryFn: () => listCodingWorkspaceFiles(workspace),
    enabled: open,
    staleTime: 5_000,
  })
  const diff = useQuery({
    queryKey: queryKeys.coding.diff(workspace),
    queryFn: () => getCodingWorkspaceGitDiff(workspace),
    enabled: open && tab === 'diff',
    staleTime: 5_000,
  })
  const tree = buildTree(files.data?.files ?? [])
  const changedPaths = collectChangedPaths(diff.data)
  const resizable = useResizableWidth({
    storageKey: 'oa.codingWorkspacePanel.width',
    defaultWidth: 440,
    minWidth: 360,
    maxWidth: 720,
    edge: 'left',
    disabled: mobile,
  })

  if (!open) return null

  return (
    <motion.aside
      initial={prefersReducedMotion ? { opacity: 0 } : mobile ? { opacity: 0 } : { width: 0 }}
      animate={prefersReducedMotion ? { opacity: 1 } : mobile ? { opacity: 1 } : { width: resizable.width }}
      exit={prefersReducedMotion ? { opacity: 0 } : mobile ? { opacity: 0 } : { width: 0 }}
      transition={{ duration: prefersReducedMotion ? 0.01 : 0.22, ease: [0.4, 0, 0.2, 1] }}
      className={cn('mobile-safe-top fixed bottom-0 right-0 z-40 min-h-0 w-full overflow-hidden border-l border-(--color-border) bg-(--bg-page) shadow-xl md:relative md:inset-y-auto md:right-auto md:z-auto md:w-auto md:shrink-0 md:shadow-none', mobile ? 'max-w-none' : '-mt-10 h-[calc(100%+2.5rem)] max-w-[440px]')}
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
        <div className="flex items-center justify-between border-b border-(--color-border) px-3 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-(--color-text-subtle)">Workspace</p>
            <p className="mt-1 truncate font-mono text-xs text-(--color-text)" title={workspace}>{workspaceLabel(workspace)}</p>
          </div>
          <button type="button" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-md text-(--color-text-muted) hover:bg-(--bg-key) md:h-auto md:w-auto md:p-1" aria-label="Close workspace panel">
            <X size={16} />
          </button>
        </div>
        <div className="flex border-b border-(--color-border) p-1">
          <button type="button" onClick={() => setTab('files')} className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs', tab === 'files' ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-muted)')}>
            <Folder size={13} /> Files
            {changedPaths.size > 0 && <span className="rounded-full bg-(--color-warning)/15 px-1.5 py-0.5 font-mono text-[10px] text-(--accent-orange-text)">{changedPaths.size}</span>}
          </button>
          <button type="button" onClick={() => setTab('diff')} className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs', tab === 'diff' ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-muted)')}>
            <GitCompare size={13} /> Diff
          </button>
        </div>
        <div className={cn('min-h-0 flex-1 overflow-auto', tab === 'files' && 'p-2')}>
          {tab === 'files' ? (
            files.isLoading ? (
              <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Loading files…</p>
            ) : files.isError ? (
              <p className="px-2 py-4 text-xs text-(--color-error)">Failed to load files</p>
            ) : files.data?.files.length === 0 ? (
              <p className="px-2 py-4 text-xs text-(--color-text-subtle)">No files shown</p>
            ) : (
              <TreeNodeView node={tree} depth={0} selectedPath={selectedFilePath} onFileSelect={onFileSelect} changedPaths={changedPaths} />
            )
          ) : diff.isLoading ? (
            <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Loading diff…</p>
          ) : diff.isError ? (
            <p className="px-2 py-4 text-xs text-(--color-error)">Failed to load git diff</p>
          ) : !diff.data?.is_git_repo ? (
            <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Not a git repository</p>
          ) : !diff.data.diff ? (
            <p className="px-2 py-4 text-xs text-(--color-text-subtle)">No uncommitted diff</p>
          ) : (
            <div className="space-y-0">
              {diff.data.truncated && <p className="mb-2 rounded bg-(--color-warning)/10 px-2 py-1 text-xs text-(--color-warning)">Diff truncated for display.</p>}
              <DiffPreview diff={diff.data.diff} />
            </div>
          )}
        </div>
        <button type="button" onClick={() => { void files.refetch(); void diff.refetch() }} className="flex items-center justify-center gap-1.5 border-t border-(--color-border) px-3 py-2 text-xs text-(--color-text-muted) hover:bg-(--bg-key)">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
    </motion.aside>
  )
}
