import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, FileText, Folder, GitCompare, RefreshCw, X } from 'lucide-react'
import { getCodingWorkspaceGitDiff, listCodingWorkspaceFiles } from '@/api/client'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/utils/format'
import { workspaceLabel } from '@/utils/workspace'
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
  const [open, setOpen] = useState(depth < 1)
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
  if (line.startsWith('+')) return 'bg-emerald-500/10 text-emerald-400'
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-400'
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'text-(--color-text)'
  return 'text-(--color-text-2)'
}

function DiffPreview({ diff }: { diff: string }) {
  return (
    <pre className="overflow-x-auto rounded bg-(--bg-page) p-2 font-mono text-[11px] leading-relaxed">
      {diff.split('\n').map((line, index) => (
        <span key={index} className={cn('block whitespace-pre', diffLineClass(line))}>
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
}: {
  workspace: string
  open: boolean
  initialTab?: 'files' | 'diff'
  onClose: () => void
}) {
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

  return (
    <AnimatePresence>
      {open && <>
        <motion.button
          type="button"
          aria-label="Close workspace panel"
          className="fixed inset-0 z-40 cursor-default bg-transparent"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        />
        <motion.aside
          initial={{ x: '100%', opacity: 0.6 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: '100%', opacity: 0.6 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(720px,96vw)] flex-col border-l border-(--color-border) bg-(--bg-sidebar) shadow-2xl"
        >
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
      <div className="min-h-0 flex-1 overflow-auto p-2">
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
          <>
            {diff.data.truncated && <p className="mb-2 rounded bg-(--color-warning)/10 px-2 py-1 text-xs text-(--color-warning)">Diff truncated for display.</p>}
            <DiffPreview diff={diff.data.diff} />
          </>
        )}
      </div>
      <button
        type="button"
        onClick={() => { void files.refetch(); void diff.refetch() }}
        className="flex items-center justify-center gap-1.5 border-t border-(--color-border) px-3 py-2 text-xs text-(--color-text-muted) hover:bg-(--bg-key)"
      >
        <RefreshCw size={12} /> Refresh
      </button>
        </motion.aside>
      </>}
    </AnimatePresence>
  )
}
