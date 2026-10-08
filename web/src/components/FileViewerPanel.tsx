/**
 * Workspace file preview renderers for the review dock: text (with line
 * comments), image, video, PDF, binary and deleted-file previews, plus the
 * shared ``DiffPreview``. The dock's file tab (``FilePreviewSubPanel``) owns
 * the surrounding toolbar.
 */
import { useEffect, useMemo, useRef, useState, memo } from 'react'
import { FileLightbox } from './FileLightbox'
import { Check, Copy, Download, ExternalLink, FileText, Loader2, Plus } from 'lucide-react'
import { codingWorkspaceFileUrl } from '@/api/client'
import { downloadWorkspaceFile } from '@/lib/workspace-download'
import { cn } from '@/lib/utils'
import { useFileRevealStore } from '@/stores/useFileRevealStore'
import { formatBytes } from '@/utils/format'
import { highlightLines } from '@/utils/code-highlight'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isVideoSrc } from '@/utils/workspace'
import { PdfThumbnail } from './PdfThumbnail'
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

type FileKind = 'image' | 'video' | 'pdf' | 'text' | 'binary'

function kindOf(file: WorkspaceFileInfo): FileKind {
  const ext = extOf(file.name)
  if (IMAGE_EXTENSIONS.has(ext) || file.mime.startsWith('image/')) return 'image'
  // Known source extensions win over the reported MIME: `.ts` maps to
  // `video/mp2t` (MPEG transport stream) in every stdlib MIME table, which
  // otherwise routes TypeScript files into the <video> branch below.
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (file.mime.startsWith('video/') || isVideoSrc(file.name)) return 'video'
  if (file.mime.startsWith('audio/')) return 'binary'
  // Must be checked before the generic small-file text fallback below —
  // otherwise any PDF under MAX_TEXT_PREVIEW_BYTES falls through to the
  // text branch and TextPreview renders its raw (binary) bytes as text.
  if (file.mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (!ext || TEXT_EXTENSIONS.has(ext) || file.mime.startsWith('text/') || file.mime === 'application/json') return 'text'
  if (file.size <= MAX_TEXT_PREVIEW_BYTES) return 'text'
  return 'binary'
}

export function CopyButton({ workspace, file }: { workspace: string; file: WorkspaceFileInfo }) {
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
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={handleCopy}
            disabled={busy || tooLarge}
            aria-label={label}
            className="flex h-9 min-w-9 items-center justify-center gap-1 rounded-md px-2 text-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 md:h-auto md:min-w-0 md:py-1"
          >
            {copied ? <Check size={12} className="text-(--color-success)" /> : busy ? <Loader2 size={12} className="animate-spin" /> : <Copy size={12} />}
          </button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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

// ---------------------------------------------------------------------------
// Syntax highlighting (shared with chat markdown — see utils/code-highlight)
// ---------------------------------------------------------------------------

/**
 * Map file extensions to the grammar names in ``utils/code-highlight``.
 *
 * Covers every ext in TEXT_EXTENSIONS plus a few extras. Unknown extensions
 * fall back to plaintext — the highlighter escapes and returns the source
 * unstyled rather than throwing.
 */
const EXT_TO_LANG: Record<string, string> = {
  // Web
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx',
  mjs: 'js', cjs: 'js',
  html: 'html', css: 'css', scss: 'scss', sass: 'scss',
  // Data / config
  json: 'json', jsonl: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', ini: 'ini', env: 'env',
  xml: 'html', svg: 'html',
  // Markup / docs
  md: 'markdown', markdown: 'markdown', rst: 'plaintext',
  // Shell
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  // Systems / compiled
  rs: 'rust', go: 'go', c: 'c', cpp: 'cpp', h: 'cpp', hpp: 'cpp',
  java: 'java', kt: 'kotlin', swift: 'swift',
  // Scripting
  py: 'python', rb: 'ruby', php: 'php',
  // Query
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  // Build / infra — newly highlightable now that chat and the viewer share
  // one grammar registry.
  dockerfile: 'dockerfile', mk: 'makefile', diff: 'diff', patch: 'diff',
  // Data files
  csv: 'csv', tsv: 'csv', log: 'plaintext', txt: 'plaintext',
  gitignore: 'plaintext',
}

// Memoized so re-selection of a line doesn't re-render every other line.
// Token text is HTML-escaped by the highlighter before it gets here.
const HighlightedCode = memo(function HighlightedCode({ html }: { html: string }) {
  return <span className="min-w-0 flex-1" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
})

/** Lines per ``LineBlock``: big enough to keep blocks few, small to skip. */
const LINES_PER_BLOCK = 200

/** Start indexes of the ``LineBlock`` chunks for ``count`` lines. */
function blockStarts(count: number): number[] {
  return Array.from({ length: Math.ceil(count / LINES_PER_BLOCK) }, (_, i) => i * LINES_PER_BLOCK)
}

/** A run of lines the browser may skip while offscreen (``.oa-line-block``). */
function LineBlock({ lines, lineHeightPx, children }: { lines: number; lineHeightPx: number; children: React.ReactNode }) {
  return (
    <div data-line-block className="oa-line-block" style={{ '--oa-line-block-height': `${lines * lineHeightPx}px` } as React.CSSProperties}>
      {children}
    </div>
  )
}

/** One file line. Memoized: a selection change re-renders only lines it flips. */
const FileLine = memo(function FileLine({
  lineNo,
  html,
  selected,
  comment,
}: {
  lineNo: number
  html: string
  selected: boolean
  /** Set on the last selected line: shows the add-comment button. */
  comment: { start: number; end: number; onAdd: (start: number, end: number) => void } | null
}) {
  return (
    <div
      data-line={lineNo}
      className={cn(
        'relative flex w-full items-start gap-3 whitespace-pre-wrap break-words px-3 text-left text-(--color-text-2)',
        selected && 'bg-(--bg-key)',
      )}
    >
      {comment ? (
        <Tooltip className="absolute left-[calc(0.75rem+4ch+0.25rem)] top-1 z-10">
          <TooltipTrigger
            render={
              <button
                type="button"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  comment.onAdd(comment.start, comment.end)
                }}
                className="flex h-4 w-4 items-center justify-center rounded-xs border border-(--color-border-strong) bg-(--bg-card) text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)"
                aria-label={comment.start === comment.end ? `Add comment for line ${comment.start}` : `Add comment for lines ${comment.start}-${comment.end}`}
              >
                <Plus size={13} aria-hidden="true" />
              </button>
            }
          />
          <TooltipContent>{comment.start === comment.end ? `Comment line ${comment.start}` : `Comment lines ${comment.start}-${comment.end}`}</TooltipContent>
        </Tooltip>
      ) : null}
      {/* Mouse handling is delegated to the scroller (``data-select-line``). */}
      <button type="button" data-select-line={lineNo} className="shrink-0" aria-label={`Select line ${lineNo}`}>
        <LineGutter value={lineNo} />
      </button>
      <HighlightedCode html={html} />
    </div>
  )
})

/**
 * ``LINES_PER_BLOCK`` lines. Memoized on its slice of the selection, so a
 * drag re-renders only the blocks whose selected lines change.
 */
const FileLineBlock = memo(function FileLineBlock({
  lines,
  start,
  selStart,
  selEnd,
  comment,
}: {
  lines: string[]
  start: number
  /** Selected 1-based line range clipped to this block; 0 when none. */
  selStart: number
  selEnd: number
  comment: { start: number; end: number; onAdd: (start: number, end: number) => void } | null
}) {
  const end = Math.min(start + LINES_PER_BLOCK, lines.length)
  const rows: React.ReactNode[] = []
  for (let index = start; index < end; index++) {
    const lineNo = index + 1
    rows.push(
      <FileLine
        key={index}
        lineNo={lineNo}
        html={lines[index]}
        selected={lineNo >= selStart && lineNo <= selEnd}
        comment={comment && lineNo === comment.end ? comment : null}
      />,
    )
  }
  // 12px text at leading-relaxed.
  return <LineBlock lines={end - start} lineHeightPx={19.5}>{rows}</LineBlock>
})

function findLineElement(node: Node | null): HTMLElement | null {
  let curr: Node | null = node
  while (curr && curr !== document.body) {
    if (curr instanceof HTMLElement && curr.hasAttribute('data-line')) {
      return curr
    }
    curr = curr.parentNode
  }
  return null
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
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleMouseUp = (e: MouseEvent | TouchEvent) => {
      if (dragging) return

      const target = e.target as HTMLElement
      const isInside = containerRef.current?.contains(target)

      // If clicking a button inside our container, keep the selection
      if (isInside && target.closest('button')) {
        return
      }

      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) {
        setSelection(null)
        return
      }

      try {
        const range = sel.getRangeAt(0)
        // If selection is not collapsed, check if it's within our container
        if (!containerRef.current?.contains(range.commonAncestorContainer)) {
          setSelection(null)
          return
        }

        const startLineEl = findLineElement(range.startContainer)
        const endLineEl = findLineElement(range.endContainer)

        if (startLineEl && endLineEl) {
          const lineA = parseInt(startLineEl.getAttribute('data-line') || '', 10)
          const lineB = parseInt(endLineEl.getAttribute('data-line') || '', 10)
          if (!isNaN(lineA) && !isNaN(lineB)) {
            setSelection({ anchor: lineA, focus: lineB })
          }
        }
      } catch {
        setSelection(null)
      }
    }

    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('touchend', handleMouseUp)
    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('touchend', handleMouseUp)
    }
  }, [dragging])

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

  // Highlight the full content, split into per-line HTML strings.
  // Must be above early returns to satisfy Rules of Hooks.
  const ext = extOf(file.name)
  const highlightedLines = useMemo(
    () => content !== null ? highlightLines(content, EXT_TO_LANG[ext]) : [],
    [content, ext],
  )

  // A clicked ``path:line`` or ``path:start-end`` selects those lines and
  // centres them, once loaded.
  const revealRequest = useFileRevealStore((s) => (s.request?.path === file.path ? s.request : null))
  useEffect(() => {
    if (!revealRequest || highlightedLines.length === 0) return
    useFileRevealStore.getState().consume(revealRequest.key)
    const line = Math.min(revealRequest.line, highlightedLines.length)
    const endLine = Math.min(revealRequest.endLine ?? line, highlightedLines.length)
    setSelection({ anchor: line, focus: endLine })
    const row = (n: number) => containerRef.current?.querySelector<HTMLElement>(`[data-line="${n}"]`)
    const first = row(line)
    if (first) centerInScrollContainer(first, row(endLine) ?? first)
  }, [highlightedLines.length, revealRequest])

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
  if (error) return <div className="flex h-full items-center justify-center px-4 text-center text-xs text-(--color-text-muted)">{error.includes('404') ? 'File no longer exists' : `Failed to load: ${error}`}</div>
  if (content === null) return null
  const selectedStart = selection ? Math.min(selection.anchor, selection.focus) : null
  const selectedEnd = selection ? Math.max(selection.anchor, selection.focus) : null
  const gutterLine = (target: EventTarget) => {
    const button = (target as HTMLElement).closest?.('[data-select-line]')
    return button ? Number(button.getAttribute('data-select-line')) : null
  }
  // Delegated from every line's gutter button, so lines carry no handlers.
  const handleMouseDown = (event: React.MouseEvent) => {
    const line = gutterLine(event.target)
    if (line === null) return
    event.preventDefault()
    setSelection({ anchor: line, focus: line })
    setDragging(true)
  }
  const handleMouseOver = (event: React.MouseEvent) => {
    if (!dragging) return
    const line = gutterLine(event.target)
    if (line !== null) setSelection((prev) => (prev && prev.focus !== line ? { ...prev, focus: line } : prev))
  }
  const comment = selectedStart !== null && selectedEnd !== null
    ? { start: selectedStart, end: selectedEnd, onAdd: (start: number, end: number) => onAddComment?.(file.path, start, end) }
    : null
  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col" onMouseLeave={() => setDragging(false)} onMouseUp={() => setDragging(false)}>
      <div
        className="min-h-0 flex-1 overflow-auto overscroll-contain touch-pan-y font-mono text-xs leading-relaxed"
        data-scroll-capture="true"
        data-select-container
        tabIndex={-1}
        onMouseDown={handleMouseDown}
        onMouseOver={handleMouseOver}
      >
        {blockStarts(highlightedLines.length).map((start) => {
          const end = start + LINES_PER_BLOCK
          const overlaps = selectedStart !== null && selectedEnd !== null && selectedStart <= end && selectedEnd > start
          return (
            <FileLineBlock
              key={start}
              lines={highlightedLines}
              start={start}
              selStart={overlaps ? Math.max(selectedStart, start + 1) : 0}
              selEnd={overlaps ? Math.min(selectedEnd, end) : 0}
              comment={comment && comment.end > start && comment.end <= end ? comment : null}
            />
          )
        })}
      </div>
    </div>
  )
}

function ImagePreview({ workspace, file }: { workspace: string; file: WorkspaceFileInfo }) {
  const [open, setOpen] = useState(false)
  if (file.deleted) return <DeletedFilePreview />
  const url = codingWorkspaceFileUrl(workspace, file.path)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-full min-h-0 w-full items-center justify-center overflow-auto overscroll-contain touch-pan-y bg-(--bg-page) p-4"
        aria-label={`Open ${file.name} preview in lightbox`}
      >
        <img src={url} alt={file.name} className="block max-h-full max-w-full rounded-sm border border-(--color-border) object-contain" />
      </button>
      <FileLightbox
        items={[{ type: 'image', src: url, name: file.name }]}
        isOpen={open}
        onClose={() => setOpen(false)}
        labelMode="image"
      />
    </>
  )
}

function VideoPreview({ workspace, file }: { workspace: string; file: WorkspaceFileInfo }) {
  const [open, setOpen] = useState(false)
  if (file.deleted) return <DeletedFilePreview />
  const url = codingWorkspaceFileUrl(workspace, file.path)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-full min-h-0 w-full items-center justify-center overflow-auto overscroll-contain touch-pan-y bg-(--bg-page) p-4"
        aria-label={`Open ${file.name} preview in lightbox`}
      >
        <video
          src={url}
          controls
          preload="metadata"
          playsInline
          className="block max-h-full max-w-full rounded-sm border border-(--color-border) bg-black object-contain"
        />
      </button>
      <FileLightbox
        items={[{ type: 'video', src: url, name: file.name }]}
        isOpen={open}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

function PdfPreview({ workspace, file }: { workspace: string; file: WorkspaceFileInfo }) {
  const [open, setOpen] = useState(false)
  if (file.deleted) return <DeletedFilePreview />
  const url = codingWorkspaceFileUrl(workspace, file.path)

  // The panel shows the PDF like an image — a static render of page 1.
  // The full interactive multi-page viewer lives in the lightbox (opened on
  // click), which is also where mobile gets its "open in new tab" fallback.
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-full min-h-0 w-full items-center justify-center overflow-auto overscroll-contain touch-pan-y bg-(--bg-page) p-4"
        aria-label={`Open ${file.name} preview in lightbox`}
      >
        <PdfThumbnail
          src={url}
          className="flex h-full w-full items-center justify-center"
          canvasClassName="max-h-full max-w-full rounded-sm border border-(--color-border) object-contain"
        />
      </button>
      <FileLightbox
        items={[{ type: 'pdf', src: url, name: file.name }]}
        isOpen={open}
        onClose={() => setOpen(false)}
      />
    </>
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
        <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 rounded-sm border border-(--color-border-strong) bg-(--bg-key) px-2.5 py-1.5 text-xs text-(--color-accent) transition-colors hover:bg-(--bg-key)">
          <ExternalLink size={12} /> Open in new tab
        </a>
        <button type="button" onClick={() => void downloadWorkspaceFile(workspace, file)} className="flex items-center gap-1.5 rounded-sm border border-(--color-border) bg-(--bg-card) px-2.5 py-1.5 text-xs text-(--color-text-2) transition-colors hover:border-(--color-border-strong)">
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
      <p className="text-xs text-(--color-text-subtle)">Open Changes to review the removed contents.</p>
    </div>
  )
}

/**
 * Vertically centre ``el`` (through ``last``, for a range) inside its nearest
 * scroll container only; a range taller than the container shows its top.
 * ``scrollIntoView`` also scrolls every other ancestor, including
 * ``overflow: hidden`` shells, which shifts the whole workbench out of view
 * with no way to scroll it back.
 */
function centerInScrollContainer(el: HTMLElement, last: HTMLElement = el) {
  let container = el.parentElement
  while (container) {
    const { overflowY } = getComputedStyle(container)
    if (overflowY === 'auto' || overflowY === 'scroll') break
    container = container.parentElement
  }
  if (!container) return
  const top = el.getBoundingClientRect().top
  const height = last.getBoundingClientRect().bottom - top
  const offset = top - container.getBoundingClientRect().top
  container.scrollTop += offset - Math.max(0, (container.clientHeight - height) / 2)
}

/**
 * Unified diff body with a line-number gutter. ``autoScroll`` centres the
 * first change in the nearest scroll container on mount — right for a
 * single-file view, wrong for inline peeks in a list (each would move the
 * list), so those pass ``autoScroll={false}``.
 */
export function DiffPreview({ diff, autoScroll = true }: { diff: string; autoScroll?: boolean }) {
  const firstChangeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!autoScroll) return
    const target = firstChangeRef.current
    if (target) centerInScrollContainer(target)
  }, [diff, autoScroll])

  // Pre-parse the diff lines so each hunk header knows how many old-file lines
  // were skipped since the previous hunk ended. We do this outside the render
  // map so the counters run in a single sequential pass.
  type ParsedLine =
    | { kind: 'meta' }
    | { kind: 'note'; text: string }
    | { kind: 'hunk'; skipped: number }
    | { kind: 'add' | 'del' | 'ctx'; lineNo: number; text: string; isFirstChange: boolean }

  const parsed = useMemo<ParsedLine[]>(() => {
    const result: ParsedLine[] = []
    let oldLine = 0
    let newLine = 0
    let prevHunkOldEnd = 0
    let firstChangeSeen = false
    // Whether we are inside a per-file header (from `diff --git` until the
    // first `@@` hunk). Header-only lines (`index`, `---`/`+++` file names,
    // `rename from/to`, mode changes, …) must never be treated as metadata
    // once hunk content starts: a removed `---` frontmatter delimiter renders
    // as `----` and an added `++i;` as `+++i;`, and the old prefix checks
    // silently dropped those content lines and desynced every following
    // line number.
    let inFileHeader = true

    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git ')) {
        inFileHeader = true
        result.push({ kind: 'meta' })
        continue
      }

      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (hunk) {
        inFileHeader = false
        const nextOldStart = Number(hunk[1])
        const hunkOldCount = hunk[2] !== undefined ? Number(hunk[2]) : 1
        const skipped = prevHunkOldEnd > 0 ? nextOldStart - prevHunkOldEnd : nextOldStart - 1
        oldLine = nextOldStart
        newLine = Number(hunk[3])
        prevHunkOldEnd = oldLine + hunkOldCount
        result.push({ kind: 'hunk', skipped: Math.max(0, skipped) })
        continue
      }

      if (inFileHeader) {
        // Header lines carry no file content. Keep human-readable notices
        // ("Binary files … differ", the backend's synthetic "Binary or large
        // file not shown: …") visible; hide the rest.
        if (line.startsWith('Binary')) result.push({ kind: 'note', text: line })
        else result.push({ kind: 'meta' })
        continue
      }

      // "\ No newline at end of file"
      if (line.startsWith('\\')) { result.push({ kind: 'meta' }); continue }

      const isAdded   = line.startsWith('+')
      const isRemoved = line.startsWith('-')
      const isFirstChange = !firstChangeSeen && (isAdded || isRemoved)
      if (isFirstChange) firstChangeSeen = true
      const lineNo = isRemoved ? oldLine : newLine
      if (!isAdded)   oldLine += 1
      if (!isRemoved) newLine += 1
      result.push({
        kind: isAdded ? 'add' : isRemoved ? 'del' : 'ctx',
        lineNo,
        // Strip exactly the one-column diff marker ('+', '-', or the context
        // space) so context lines align with add/del lines.
        text: line.slice(1) || ' ',
        isFirstChange,
      })
    }
    return result
  }, [diff])

  // Rows wrap, so nothing scrolls sideways and the gutter needs no
  // ``sticky``: a sticky cell on every row made scrolling ~6x costlier.
  const rows: React.ReactNode[] = []
  parsed.forEach((p, index) => {
    if (p.kind === 'meta') return

    if (p.kind === 'note') {
      rows.push(
        <div
          key={index}
          className="flex min-w-0 items-center select-none border-y border-(--color-border)/20 bg-(--bg-page)"
        >
          <div className="shrink-0 border-r border-(--color-border)/40 bg-inherit">
            <span className="block w-9 py-0.5" />
          </div>
          <span className="px-3 py-0.5 text-xs md:text-[11px] italic text-(--color-text-subtle)">
            {p.text}
          </span>
        </div>,
      )
      return
    }

    if (p.kind === 'hunk') {
      // No skipped lines to report (e.g. the first hunk starts at the
      // top of the file) — rendering the empty separator anyway left a
      // blank bordered strip between the file header row and the
      // first real diff line, reading as a stray gap.
      if (p.skipped <= 0) return
      rows.push(
        <div
          key={index}
          className="flex min-w-0 items-center select-none border-y border-(--color-border)/20 bg-(--bg-page)"
        >
          <div className="shrink-0 border-r border-(--color-border)/40 bg-inherit">
            <span className="block w-9 py-0.5" />
          </div>
          <span className="px-3 py-0.5 text-xs md:text-[11px] italic text-(--color-text-subtle)">
            {p.skipped} line{p.skipped === 1 ? '' : 's'} unchanged
          </span>
        </div>,
      )
      return
    }

    const isAdded   = p.kind === 'add'
    const isRemoved = p.kind === 'del'
    rows.push(
      <div
        key={index}
        ref={p.isFirstChange ? firstChangeRef : undefined}
        className={cn(
          'flex min-w-0 items-stretch whitespace-pre-wrap break-words text-(--color-text) [overflow-wrap:anywhere]',
          isAdded   && 'bg-(--color-diff-add-bg) text-(--color-diff-add-text)',
          isRemoved && 'bg-(--color-diff-del-bg) text-(--color-diff-del-text)',
        )}
      >
        <div className="flex shrink-0 select-none border-r border-(--color-border)/40 bg-inherit text-right text-xs md:text-[11px] text-(--color-text-subtle)">
          <span className="w-9 py-0.5 pr-1.5">{p.lineNo}</span>
        </div>
        <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words px-2 py-0.5 [overflow-wrap:anywhere]">{p.text}</pre>
      </div>,
    )
  })

  return (
    <div className="bg-(--bg-card) font-mono text-[11px] leading-relaxed">
      <div className="min-w-0">
        {blockStarts(rows.length).map((start) => (
          // 11px text at leading-relaxed plus the row's 4px padding.
          <LineBlock key={start} lines={Math.min(LINES_PER_BLOCK, rows.length - start)} lineHeightPx={22}>
            {rows.slice(start, start + LINES_PER_BLOCK)}
          </LineBlock>
        ))}
      </div>
    </div>
  )
}

export function FilePreviewContent({
  workspace,
  file,
  onAddComment,
}: {
  workspace: string
  file: WorkspaceFileInfo
  onAddComment?: (path: string, startLine: number, endLine: number) => void
}) {
  const kind = kindOf(file)

  return kind === 'image' ? <ImagePreview workspace={workspace} file={file} />
    : kind === 'video' ? <VideoPreview workspace={workspace} file={file} />
    : kind === 'pdf' ? <PdfPreview workspace={workspace} file={file} />
    : kind === 'text' ? <TextPreview key={file.path} workspace={workspace} file={file} onAddComment={onAddComment} />
      : <BinaryPreview workspace={workspace} file={file} />
}

/** Copy-to-clipboard only makes sense for a text preview of a live file. */
export function canCopyFileContents(file: WorkspaceFileInfo): boolean {
  return kindOf(file) === 'text' && file.deleted !== true
}
