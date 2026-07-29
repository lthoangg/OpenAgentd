import { useEffect, useMemo, useRef, useState, memo } from 'react'
import { FileLightbox } from './FileLightbox'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { motion } from 'framer-motion'
import { Check, Copy, Download, ExternalLink, FileText, Loader2, Plus, X } from 'lucide-react'
import { codingWorkspaceFileUrl } from '@/api/client'
import { downloadCodingWorkspaceFile } from '@/lib/coding-workspace-download'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/utils/format'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useResizableWidth } from '@/hooks/use-resizable-width'
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

// `highlight.js/lib/common` eagerly registers 37 grammars. The coding file
// viewer supports a known extension set, so register only its 21 actual
// languages — same visible coverage with less JS for every desktop/mobile
// app startup (the viewer is part of the eager app shell).
for (const [name, grammar] of Object.entries({
  bash, c, cpp, css, go, ini, java, javascript, json, kotlin, markdown,
  php, python, ruby, rust, scss, sql, swift, typescript, xml, yaml,
})) {
  hljs.registerLanguage(name, grammar)
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

type FileKind = 'image' | 'video' | 'pdf' | 'text' | 'binary'

function kindOf(file: WorkspaceFileInfo): FileKind {
  const ext = extOf(file.name)
  if (IMAGE_EXTENSIONS.has(ext) || file.mime.startsWith('image/')) return 'image'
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

// ---------------------------------------------------------------------------
// Syntax highlighting via highlight.js (already bundled for markdown blocks)
// ---------------------------------------------------------------------------

/**
 * Map common file extensions to highlight.js language names.
 * hljs uses its own canonical names — this covers every ext in TEXT_EXTENSIONS
 * plus a few extras. Unknown extensions fall back to plaintext.
 */
const EXT_TO_HLJS_LANG: Record<string, string> = {
  // Web
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript',
  html: 'html', css: 'css', scss: 'scss', sass: 'scss',
  // Data / config
  json: 'json', jsonl: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', env: 'ini',
  xml: 'xml', svg: 'xml',
  // Markup / docs
  md: 'markdown', markdown: 'markdown', rst: 'plaintext',
  // Shell
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  // Systems / compiled
  rs: 'rust', go: 'go', c: 'c', cpp: 'cpp', h: 'cpp', hpp: 'cpp',
  java: 'java', kt: 'kotlin', swift: 'swift',
  // Scripting
  py: 'python', rb: 'ruby', php: 'php',
  // Query
  sql: 'sql',
  // Data files (no highlighting)
  csv: 'plaintext', tsv: 'plaintext', log: 'plaintext', txt: 'plaintext',
  gitignore: 'plaintext',
}

/**
 * Highlight the full file content with hljs, returning one HTML string per
 * line. hljs preserves newlines in its output, so splitting on \n is safe.
 * Falls back to plain text if the language is unknown or highlighting fails.
 */
function highlightFile(content: string, ext: string): string[] {
  const lang = EXT_TO_HLJS_LANG[ext]
  try {
    const result = lang && lang !== 'plaintext'
      ? hljs.highlight(content, { language: lang, ignoreIllegals: true })
      : hljs.highlightAuto(content, ['javascript', 'typescript', 'python', 'bash', 'json', 'yaml', 'sql', 'css', 'html', 'rust', 'go'])
    return result.value.split('\n')
  } catch {
    return content.split('\n')
  }
}

// Memoized so re-selection of a line doesn't re-highlight the entire file.
// hljs output is safe — user content is HTML-entity-escaped by highlight.js.
const HighlightedCode = memo(function HighlightedCode({ html }: { html: string }) {
  return <span className="min-w-0 flex-1" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
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

  // Run hljs on the full content, then split into per-line HTML strings.
  // Must be above early returns to satisfy Rules of Hooks.
  const ext = extOf(file.name)
  const highlightedLines = useMemo(
    () => content !== null ? highlightFile(content, ext) : [],
    [content, ext],
  )

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
  const selectLine = (line: number) => {
    setSelection({ anchor: line, focus: line })
    setDragging(true)
  }
  const extendSelection = (line: number) => {
    if (!dragging) return
    setSelection((prev) => prev ? { ...prev, focus: line } : prev)
  }
  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col" onMouseLeave={() => setDragging(false)} onMouseUp={() => setDragging(false)}>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain touch-pan-y font-mono text-xs leading-relaxed" data-scroll-capture="true" data-select-container tabIndex={-1}>
        {highlightedLines.map((lineHtml, index) => {
          const lineNo = index + 1
          const selected = selectedStart !== null && selectedEnd !== null && lineNo >= selectedStart && lineNo <= selectedEnd
          return (
            <div
              key={index}
              data-line={lineNo}
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
              <HighlightedCode html={lineHtml} />
            </div>
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
        <img src={url} alt={file.name} className="block max-h-full max-w-full rounded border border-(--color-border) object-contain" />
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
          className="block max-h-full max-w-full rounded border border-(--color-border) bg-black object-contain"
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
          canvasClassName="max-h-full max-w-full rounded border border-(--color-border) object-contain"
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
        <button type="button" onClick={() => void downloadCodingWorkspaceFile(workspace, file)} className="flex items-center gap-1.5 rounded-sm border border-(--color-border) bg-(--bg-card) px-2.5 py-1.5 text-xs text-(--color-text-2) transition-colors hover:border-(--color-border-strong)">
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

export function DiffPreview({ diff }: { diff: string }) {
  const firstChangeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    firstChangeRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [diff])

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

  return (
    <div className="bg-(--bg-card) font-mono text-[11px] leading-relaxed">
      <div className="min-w-0">
        {parsed.map((p, index) => {
          if (p.kind === 'meta') return null

          if (p.kind === 'note') {
            return (
              <div
                key={index}
                className="flex min-w-0 items-center select-none border-y border-(--color-border)/20 bg-(--bg-page)"
              >
                <div className="sticky left-0 z-[1] shrink-0 border-r border-(--color-border)/40 bg-inherit">
                  <span className="block w-9 py-0.5" />
                </div>
                <span className="px-3 py-0.5 text-[10px] italic text-(--color-text-subtle)/50">
                  {p.text}
                </span>
              </div>
            )
          }

          if (p.kind === 'hunk') {
            return (
              <div
                key={index}
                className="flex min-w-0 items-center select-none border-y border-(--color-border)/20 bg-(--bg-page)"
              >
                <div className="sticky left-0 z-[1] shrink-0 border-r border-(--color-border)/40 bg-inherit">
                  <span className="block w-9 py-0.5" />
                </div>
                <span className="px-3 py-0.5 text-[10px] italic text-(--color-text-subtle)/50">
                  {p.skipped > 0 ? `${p.skipped} line${p.skipped === 1 ? '' : 's'} unchanged` : ''}
                </span>
              </div>
            )
          }

          const isAdded   = p.kind === 'add'
          const isRemoved = p.kind === 'del'
          return (
            <div
              key={index}
              ref={p.isFirstChange ? firstChangeRef : undefined}
              className={cn(
                'flex min-w-0 items-stretch whitespace-pre-wrap break-words text-(--color-text) [overflow-wrap:anywhere]',
                isAdded   && 'bg-(--color-diff-add-bg) text-(--color-diff-add-text)',
                isRemoved && 'bg-(--color-diff-del-bg) text-(--color-diff-del-text)',
              )}
            >
              <div className="sticky left-0 z-[1] flex shrink-0 select-none border-r border-(--color-border)/40 bg-inherit text-right text-[10px] text-(--color-text-subtle)">
                <span className="w-9 py-0.5 pr-1.5">{p.lineNo}</span>
              </div>
              <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words px-2 py-0.5 [overflow-wrap:anywhere]">{p.text}</pre>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function CodingFilePreviewContent({
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
  const leftSidebarWidth = typeof document !== 'undefined'
    ? (document.querySelector('aside.border-r')?.getBoundingClientRect().width ?? 0)
    : 0

  const resizable = useResizableWidth({
    storageKey: 'oa.codingFileViewer.width',
    defaultWidth: 560,
    minWidth: 420,
    maxWidth: Math.min(
      1000,
      Math.max(
        420,
        Math.floor((typeof window === 'undefined' ? 880 : window.innerWidth) - leftSidebarWidth - 380)
      )
    ),
    edge: 'left',
    disabled: mobile,
  })
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
        'fixed bottom-0 right-0 z-40 min-h-0 w-full overflow-hidden border-l border-(--color-border) bg-(--bg-page) shadow-xl md:relative md:inset-y-auto md:right-auto md:z-auto md:w-auto md:shrink-0 md:shadow-none',
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
            <button type="button" onClick={() => void downloadCodingWorkspaceFile(workspace, file)} disabled={deleted} title={deleted ? 'File deleted from workspace' : 'Download'} className="flex h-11 w-11 items-center justify-center rounded text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) disabled:cursor-not-allowed disabled:opacity-40 md:h-7 md:w-7">
              <Download size={14} />
            </button>
            {kind === 'text' && !deleted && <CopyButton workspace={workspace} file={file} />}
            <button type="button" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7" aria-label="Close file viewer">
              <X size={14} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <CodingFilePreviewContent workspace={workspace} file={file} onAddComment={onAddComment} />
        </div>
      </div>
    </motion.aside>
  )
}
