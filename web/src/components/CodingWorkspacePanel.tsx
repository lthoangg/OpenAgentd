import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ChevronRight, FileText, Folder, GitCompare, RefreshCw, X } from 'lucide-react'
import { getCodingWorkspaceGitDiff, listCodingWorkspaceFiles } from '@/api/client'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/utils/format'
import { workspaceLabel } from '@/utils/workspace'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import type { WorkspaceFileInfo } from '@/api/types'

interface TreeNode {
  name: string
  path: string
  children: Map<string, TreeNode>
  file?: WorkspaceFileInfo
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

function TreeNodeView({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(false)
  const isDir = node.children.size > 0 && !node.file
  const children = Array.from(node.children.values()).sort((a, b) => {
    const aDir = a.children.size > 0 && !a.file
    const bDir = b.children.size > 0 && !b.file
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  if (!isDir && node.file) {
    return (
      <div
        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-(--color-text-2) hover:bg-(--bg-key)"
        style={{ paddingLeft: 8 + depth * 12 }}
        title={node.file.path}
      >
        <FileText size={12} className="shrink-0 text-(--color-text-subtle)" />
        <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
        <span className="shrink-0 text-[10px] text-(--color-text-subtle)">{formatBytes(node.file.size)}</span>
      </div>
    )
  }

  return (
    <div>
      {node.path && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-(--color-text-2) hover:bg-(--bg-key)"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
          <Folder size={12} className="shrink-0 text-(--color-accent)" />
          <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
        </button>
      )}
      {(open || !node.path) && children.map((child) => (
        <TreeNodeView key={child.path} node={child} depth={node.path ? depth + 1 : 0} />
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
  /** Old-file (left gutter) line number. Null for additions, hunk, meta. */
  oldLine: number | null
  /** New-file (right gutter) line number. Null for deletions, hunk, meta. */
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
  // Running counters seeded from each `@@` hunk header.
  let oldLineNo = 0
  let newLineNo = 0

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      current = {
        path: match?.[2] ?? line.replace('diff --git ', ''),
        additions: 0,
        deletions: 0,
        lines: [],
      }
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
      continue
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

/** Width of the gutter column in `ch` units. Fits up to 4-digit line numbers. */
const GUTTER_WIDTH_CH = 4

/**
 * Pick the single number to display for a diff line. Adds/context follow the
 * new-file numbering; deletes use the old-file number (they don't exist in
 * the new file), producing IDE-style sequences like `130 → 131 → 132 → 123
 * (delete) → 133 → 134`.
 */
function displayLineNumber(line: ParsedDiffLine): number | null {
  if (line.kind === 'add' || line.kind === 'context') return line.newLine
  if (line.kind === 'delete') return line.oldLine
  return null
}

function DiffGutter({ value }: { value: number | null }) {
  return (
    <span
      className="inline-block shrink-0 select-none text-right tabular-nums text-(--color-text-subtle)"
      style={{ width: `${GUTTER_WIDTH_CH}ch` }}
      aria-hidden="true"
    >
      {value ?? ''}
    </span>
  )
}

function DiffFileSection({ file }: { file: ParsedDiffFile }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="overflow-hidden bg-(--bg-page)">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} diff for ${file.path}`}
        className="flex w-full items-center gap-3 border-b border-(--color-border)/50 px-3 py-1.5 text-left hover:bg-(--bg-key)"
      >
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-(--color-text)"
          title={file.path}
        >
          {file.path}
        </span>
        <DiffChanges additions={file.additions} deletions={file.deletions} />
      </button>
      {open ? (
        <pre className="font-mono text-[11px] leading-relaxed">
          {file.lines.map((line, index) => (
            <span
              key={index}
              className={cn(
                'flex items-start gap-2 whitespace-pre-wrap break-all px-2',
                diffLineClassName(line.kind),
              )}
            >
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
    return (
      <div className="space-y-0">
        {files.map((file) => (
          <DiffFileSection key={file.path} file={file} />
        ))}
      </div>
    )
  }

  return (
    <pre className="rounded bg-(--bg-page) p-2 font-mono text-[11px] leading-relaxed">
      {diff.split('\n').map((line, index) => (
        <span key={index} className={cn('block whitespace-pre-wrap break-all', diffLineClass(line))}>
          {line || ' '}
        </span>
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
}: {
  workspace: string
  open: boolean
  initialTab?: 'files' | 'diff'
  onClose: () => void
  mobile?: boolean
}) {
  const prefersReducedMotion = useReducedMotion()
  const [tab, setTab] = useState<'files' | 'diff'>(initialTab)
  const files = useQuery({
    queryKey: ['coding-workspace-files', workspace],
    queryFn: () => listCodingWorkspaceFiles(workspace),
    enabled: open,
    staleTime: 5_000,
  })
  const diff = useQuery({
    queryKey: ['coding-workspace-diff', workspace],
    queryFn: () => getCodingWorkspaceGitDiff(workspace),
    enabled: open,
    staleTime: 5_000,
  })
  const tree = buildTree(files.data?.files ?? [])

  if (!open) return null

  return (
    <motion.aside
      initial={prefersReducedMotion ? { opacity: 0 } : mobile ? { opacity: 0 } : { width: 0 }}
      animate={prefersReducedMotion ? { opacity: 1 } : mobile ? { opacity: 1 } : { width: 440 }}
      exit={prefersReducedMotion ? { opacity: 0 } : mobile ? { opacity: 0 } : { width: 0 }}
      transition={{ duration: prefersReducedMotion ? 0.01 : 0.22, ease: [0.4, 0, 0.2, 1] }}
      className={cn(
        'fixed inset-y-0 right-0 z-40 min-h-0 w-full overflow-hidden border-l border-(--color-border) bg-(--bg-page) shadow-xl sm:relative sm:z-auto sm:w-auto sm:shrink-0 sm:shadow-none',
        mobile ? 'max-w-none' : 'max-w-[440px]',
      )}
    >
      <div className={cn('flex h-full min-h-0 w-full flex-col', mobile ? 'max-w-none' : 'max-w-[440px] sm:w-[440px]')}>
      <div className="flex items-center justify-between border-b border-(--color-border) px-3 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-(--color-text-subtle)">Workspace</p>
          <p className="mt-1 truncate font-mono text-xs text-(--color-text)" title={workspace}>{workspaceLabel(workspace)}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-(--color-text-muted) hover:bg-(--bg-key)" aria-label="Close workspace panel">
          <X size={16} />
        </button>
      </div>
      <div className="flex border-b border-(--color-border) p-1">
        <button
          type="button"
          onClick={() => setTab('files')}
          className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs', tab === 'files' ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-muted)')}
        >
          <Folder size={13} /> Files
        </button>
        <button
          type="button"
          onClick={() => setTab('diff')}
          className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs', tab === 'diff' ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-muted)')}
        >
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
            <TreeNodeView node={tree} depth={0} />
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
      <button
        type="button"
        onClick={() => { void files.refetch(); void diff.refetch() }}
        className="flex items-center justify-center gap-1.5 border-t border-(--color-border) px-3 py-2 text-xs text-(--color-text-muted) hover:bg-(--bg-key)"
      >
        <RefreshCw size={12} /> Refresh
      </button>
      </div>
    </motion.aside>
  )
}
