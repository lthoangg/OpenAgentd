import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Check, Copy, Download, ExternalLink, FileText, GitCompare, Loader2, Plus, X } from 'lucide-react'
import { codingWorkspaceFileUrl, getCodingWorkspaceGitDiff } from '@/api/client'
import { downloadCodingWorkspaceFile } from '@/lib/coding-workspace-download'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/utils/format'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { queryKeys } from '@/queries'
import type { WorkspaceFileInfo } from '@/api/types'

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'env', 'gitignore',
  'csv', 'tsv', 'log',
  'py', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'html', 'css', 'scss', 'sass',
  'sh', 'bash', 'zsh', 'fish',
  'rs', 'go', 'java', 'kt', 'c', 'cpp', 'h', 'hpp', 'rb', 'php', 'swift',
  'sql', 'xml', 'svg',
])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'])
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024
const GUTTER_WIDTH_CH = 4

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

type FileKind = 'image' | 'text' | 'binary'

function kindOf(file: WorkspaceFileInfo): FileKind {
  const ext = extOf(file.name)
  if (IMAGE_EXTENSIONS.has(ext) || file.mime.startsWith('image/')) return 'image'
  if (!ext || TEXT_EXTENSIONS.has(ext) || file.mime.startsWith('text/') || file.mime === 'application/json') return 'text'
  return 'binary'
}

function CopyButton({ workspace, file }: { workspace: string; file: WorkspaceFileInfo }) {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const tooLarge = file.size > MAX_TEXT_PREVIEW_BYTES

  const handleCopy = async () => {
    if (busy || tooLarge) return
    setBusy(true)
    try {
      const res = await fetch(codingWorkspaceFileUrl(workspace, file.path))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await navigator.clipboard.writeText(await res.text())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Best-effort copy. The user can still download/open the file.
    } finally {
      setBusy(false)
    }
  }

  const label = tooLarge ? 'File too large to copy' : copied ? 'Copied!' : 'Copy file contents'
  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={busy || tooLarge}
      title={label}
      aria-label={label}
      className="flex h-9 min-w-9 items-center justify-center gap-1 rounded px-2 text-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) disabled:cursor-not-allowed disabled:opacity-40 md:h-auto md:min-w-0 md:py-1"
    >
      {copied ? <Check size={12} className="text-(--color-success)" /> : busy ? <Loader2 size={12} className="animate-spin" /> : <Copy size={12} />}
    </button>
  )
}

function LineGutter({ value }: { value: number }) {
  return (
    <span
      className="inline-block shrink-0 select-none text-right tabular-nums text-(--color-text-subtle)"
      style={{ width: `${GUTTER_WIDTH_CH}ch` }}
      aria-hidden="true"
    >
      {value}
    </span>
  )
}

const KEYWORDS = new Set([
  'and', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'default',
  'do', 'elif', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if',
  'import', 'in', 'interface', 'let', 'match', 'new', 'none', 'null', 'or', 'pass', 'return', 'self', 'static',
  'struct', 'switch', 'this', 'throw', 'true', 'try', 'type', 'undefined', 'var', 'while', 'with', 'yield',
])

function commentIndex(line: string): number {
  const markers = ['//', '#', '--']
  let found = -1
  for (const marker of markers) {
    const index = line.indexOf(marker)
    if (index >= 0 && (found < 0 || index < found)) found = index
  }
  return found
}

function highlightCodeLine(line: string): ReactNode[] {
  const out: React.ReactNode[] = []
  const commentAt = commentIndex(line)
  const code = commentAt >= 0 ? line.slice(0, commentAt) : line
  const comment = commentAt >= 0 ? line.slice(commentAt) : ''
  const tokenRe = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(code)) !== null) {
    if (match.index > last) out.push(code.slice(last, match.index))
    const token = match[0]
    const lower = token.toLowerCase()
    const cls = token.startsWith('"') || token.startsWith("'") || token.startsWith('`')
      ? 'text-emerald-300'
      : /^\d/.test(token)
        ? 'text-amber-300'
        : KEYWORDS.has(lower)
          ? 'text-sky-300'
          : 'text-(--color-text-2)'
    out.push(<span key={`${match.index}-${token}`} className={cls}>{token}</span>)
    last = match.index + token.length
  }
  if (last < code.length) out.push(code.slice(last))
  if (comment) out.push(<span key="comment" className="text-(--color-text-subtle)">{comment}</span>)
  return out.length > 0 ? out : [' ']
}

function TextPreview({
  workspace,
  file,
  onAddComment,
}: {
  workspace: string
  file: WorkspaceFileInfo
  onAddComment?: (path: string, startLine: number, endLine: number) => void
}) {
  const tooLarge = file.size > MAX_TEXT_PREVIEW_BYTES
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!tooLarge)
  const [selection, setSelection] = useState<{ anchor: number; focus: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const deleted = file.deleted === true

  useEffect(() => {
    if (tooLarge || deleted) return
    let cancelled = false
    fetch(codingWorkspaceFileUrl(workspace, file.path))
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.text()
      })
      .then((text) => {
        if (!cancelled) {
          setContent(text)
          setLoading(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [workspace, file.path, tooLarge, deleted])

  if (deleted) {
    return <DeletedFilePreview />
  }

  if (tooLarge) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FileText size={24} className="text-(--color-text-subtle)" />
        <p className="text-sm text-(--color-text-2)">File too large to preview</p>
        <p className="text-xs text-(--color-text-subtle)">{formatBytes(file.size)} — limit is {formatBytes(MAX_TEXT_PREVIEW_BYTES)}</p>
      </div>
    )
  }
  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 size={16} className="animate-spin text-(--color-text-subtle)" /></div>
  if (error) return <div className="flex h-full items-center justify-center px-4 text-center text-xs text-(--color-error)">Failed to load: {error}</div>
  if (content === null) return null

  const lines = content.split('\n')
  const selectedStart = selection ? Math.min(selection.anchor, selection.focus) : null
  const selectedEnd = selection ? Math.max(selection.anchor, selection.focus) : null
  const selectLine = (line: number) => {
    setSelection({ anchor: line, focus: line })
    setDragging(true)
  }
  const extendSelection = (line: number) => {
    if (!dragging) return
    setSelection((prev) => prev ? { ...prev, focus: line } : prev)
  }
  return (
    <div className="flex h-full min-h-0 flex-col" onMouseLeave={() => setDragging(false)} onMouseUp={() => setDragging(false)}>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-relaxed">
        {lines.map((line, index) => {
          const lineNo = index + 1
          const selected = selectedStart !== null && selectedEnd !== null && lineNo >= selectedStart && lineNo <= selectedEnd
          return (
            <div
              key={index}
              className={cn(
                'relative flex w-full items-start gap-3 whitespace-pre-wrap break-words px-3 text-left text-(--color-text-2)',
                selected && 'bg-(--bg-key)',
              )}
            >
              {selected && lineNo === selectedEnd && selectedStart !== null ? (
                <button
                  type="button"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onAddComment?.(file.path, selectedStart, selectedEnd)
                  }}
                  className="absolute left-[calc(0.75rem+4ch+0.25rem)] top-1 z-10 flex h-4 w-4 items-center justify-center rounded border border-(--color-border-strong) bg-(--bg-card) text-(--color-text-muted) shadow hover:bg-(--bg-key) hover:text-(--color-text)"
                  aria-label={selectedStart === selectedEnd ? `Add comment for line ${selectedStart}` : `Add comment for lines ${selectedStart}-${selectedEnd}`}
                  title={selectedStart === selectedEnd ? `Comment line ${selectedStart}` : `Comment lines ${selectedStart}-${selectedEnd}`}
                >
                  <Plus size={13} aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault()
                  selectLine(lineNo)
                }}
                onMouseEnter={() => extendSelection(lineNo)}
                className="shrink-0"
                aria-label={`Select line ${lineNo}`}
              >
                <LineGutter value={lineNo} />
              </button>
              <span className="min-w-0 flex-1">{highlightCodeLine(line)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ImagePreview({ workspace, file }: { workspace: string; file: WorkspaceFileInfo }) {
  if (file.deleted) return <DeletedFilePreview />
  const url = codingWorkspaceFileUrl(workspace, file.path)
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-(--bg-page) p-4">
      <img src={url} alt={file.name} className="block max-h-full max-w-full rounded border border-(--color-border) object-contain" />
    </div>
  )
}

function BinaryPreview({ workspace, file }: { workspace: string; file: WorkspaceFileInfo }) {
  if (file.deleted) return <DeletedFilePreview />
  const url = codingWorkspaceFileUrl(workspace, file.path)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FileText size={28} className="text-(--color-text-subtle)" />
      <div>
        <p className="text-sm text-(--color-text-2)">No inline preview for this file type</p>
        <p className="mt-0.5 text-xs text-(--color-text-subtle)">{file.mime} · {formatBytes(file.size)}</p>
      </div>
      <div className="flex items-center gap-2">
        <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 rounded-md bg-(--bg-key) px-3 py-1.5 text-xs text-(--color-accent) transition-colors hover:bg-(--bg-key)">
          <ExternalLink size={12} /> Open in new tab
        </a>
        <button type="button" onClick={() => void downloadCodingWorkspaceFile(workspace, file)} className="flex items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-xs text-(--color-text-2) transition-colors hover:border-(--color-border-strong)">
          <Download size={12} /> Download
        </button>
      </div>
    </div>
  )
}

function DeletedFilePreview() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <FileText size={24} className="text-(--color-text-subtle)" />
      <p className="text-sm text-(--color-text-2)">File deleted from workspace</p>
      <p className="text-xs text-(--color-text-subtle)">Open the Diff tab to review the removed contents.</p>
    </div>
  )
}

function diffLineClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-(--color-accent)'
  if (line.startsWith('@@')) return 'bg-(--color-accent)/10 text-(--color-accent)'
  if (line.startsWith('+')) return 'bg-(--color-diff-add-bg) text-(--color-diff-add-text)'
  if (line.startsWith('-')) return 'bg-(--color-diff-del-bg) text-(--color-diff-del-text)'
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file mode')) return 'text-(--color-text)'
  return 'text-(--color-text-2)'
}

function DiffPreview({ diff }: { diff: string }) {
  return (
    <pre className="h-full overflow-auto bg-(--bg-page) p-3 font-mono text-[11px] leading-relaxed">
      {diff.split('\n').map((line, index) => (
        <span key={index} className={cn('block whitespace-pre-wrap break-all px-1', diffLineClass(line))}>{line || ' '}</span>
      ))}
    </pre>
  )
}

export function CodingFilePreviewContent({
  workspace,
  file,
  viewMode,
  onAddComment,
}: {
  workspace: string
  file: WorkspaceFileInfo
  viewMode: 'file' | 'diff'
  onAddComment?: (path: string, startLine: number, endLine: number) => void
}) {
  const scopedDiff = useQuery({
    queryKey: [...queryKeys.coding.diff(workspace), file.path] as const,
    queryFn: () => getCodingWorkspaceGitDiff(workspace, [file.path]),
    enabled: viewMode === 'diff',
    staleTime: 5_000,
  })
  const kind = kindOf(file)

  if (viewMode === 'diff') {
    return scopedDiff.isLoading ? <div className="flex h-full items-center justify-center"><Loader2 size={16} className="animate-spin text-(--color-text-subtle)" /></div>
      : scopedDiff.isError ? <div className="flex h-full items-center justify-center px-4 text-center text-xs text-(--color-error)">Failed to load diff</div>
        : !scopedDiff.data?.is_git_repo ? <div className="flex h-full items-center justify-center px-4 text-center text-xs text-(--color-text-subtle)">Not a git repository</div>
          : !scopedDiff.data.diff ? <div className="flex h-full items-center justify-center px-4 text-center text-xs text-(--color-text-subtle)">No diff for this file</div>
            : <DiffPreview diff={scopedDiff.data.diff} />
  }

  return kind === 'image' ? <ImagePreview workspace={workspace} file={file} />
    : kind === 'text' ? <TextPreview key={file.path} workspace={workspace} file={file} onAddComment={onAddComment} />
      : <BinaryPreview workspace={workspace} file={file} />
}

export function CodingFileViewerPanel({
  workspace,
  file,
  onClose,
  onAddComment,
  mobile = false,
}: {
  workspace: string
  file: WorkspaceFileInfo | null
  onClose: () => void
  onAddComment?: (path: string, startLine: number, endLine: number) => void
  mobile?: boolean
}) {
  const prefersReducedMotion = useReducedMotion()
  const resizable = useResizableWidth({
    storageKey: 'oa.codingFileViewer.width',
    defaultWidth: 560,
    minWidth: 420,
    maxWidth: Math.min(880, Math.max(420, Math.floor((typeof window === 'undefined' ? 880 : window.innerWidth) - 320))),
    edge: 'left',
    disabled: mobile,
  })
  const [viewMode, setViewMode] = useState<'file' | 'diff'>('file')
  if (!file) return null

  const kind = kindOf(file)
  const deleted = file.deleted === true

  return (
    <motion.aside
      initial={prefersReducedMotion ? { opacity: 0 } : mobile ? { opacity: 0 } : { width: 0 }}
      animate={prefersReducedMotion ? { opacity: 1 } : mobile ? { opacity: 1 } : { width: resizable.width }}
      exit={prefersReducedMotion ? { opacity: 0 } : mobile ? { opacity: 0 } : { width: 0 }}
      transition={{ duration: resizable.isResizing || prefersReducedMotion ? 0.01 : 0.22, ease: [0.4, 0, 0.2, 1] }}
      className={cn(
        'fixed bottom-0 right-0 z-40 min-h-0 w-full overflow-hidden border-l border-(--color-border) bg-(--bg-card) shadow-xl md:relative md:inset-y-auto md:right-auto md:z-auto md:w-auto md:shrink-0 md:shadow-none',
        mobile ? 'mobile-safe-top max-w-none' : '',
      )}
      aria-label="File viewer"
    >
      <div className={cn('relative flex h-full min-h-0 w-full flex-col', mobile ? 'max-w-none' : 'md:w-full')}>
        {!mobile && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file viewer"
            title="Drag to resize · double-click to reset"
            className="absolute left-0 top-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-(--color-accent)/40"
            onPointerDown={resizable.startResize}
            onDoubleClick={resizable.resetWidth}
          />
        )}
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-(--color-border) px-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-(--color-text-subtle)">File</p>
            <p className="mt-1 truncate font-mono text-xs text-(--color-text)" title={file.path}>{file.path}</p>
            <p className="mt-0.5 text-[10px] text-(--color-text-subtle)">{formatBytes(file.size)} · {file.mime}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div className="mr-1 flex rounded-md border border-(--color-border) p-0.5">
              <button type="button" onClick={() => setViewMode('file')} className={cn('h-8 rounded px-2 text-[11px] md:h-auto md:py-1', viewMode === 'file' ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-muted) hover:text-(--color-text-2)')}>
                File
              </button>
              <button type="button" onClick={() => setViewMode('diff')} className={cn('flex h-8 items-center gap-1 rounded px-2 text-[11px] md:h-auto md:py-1', viewMode === 'diff' ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-muted) hover:text-(--color-text-2)')}>
                <GitCompare size={11} /> Diff
              </button>
            </div>
            <button type="button" onClick={() => void downloadCodingWorkspaceFile(workspace, file)} disabled={deleted} title={deleted ? 'File deleted from workspace' : 'Download'} className="flex h-9 w-9 items-center justify-center rounded text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) disabled:cursor-not-allowed disabled:opacity-40 md:h-auto md:w-auto md:p-1.5">
              <Download size={14} />
            </button>
            {kind === 'text' && !deleted && <CopyButton workspace={workspace} file={file} />}
            <button type="button" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-auto md:w-auto md:p-1.5" aria-label="Close file viewer">
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <CodingFilePreviewContent workspace={workspace} file={file} viewMode={viewMode} onAddComment={onAddComment} />
        </div>
      </div>
    </motion.aside>
  )
}
