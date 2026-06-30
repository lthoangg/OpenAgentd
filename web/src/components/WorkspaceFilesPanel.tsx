/**
 * WorkspaceFilesPanel — right-side drawer listing every file the agent has
 * written into the session workspace (``.openagentd/team/{sid}``).
 *
 * Layout: drawer from the right (mirrors ``AgentCapabilities``).  Inside, a
 * two-pane split — tree grouped by directory on the left, preview on the
 * right.  Images render inline via the ``/media/`` proxy (with lightbox on
 * click).  Text/code files render as-is in a plain monospace view.
 * Everything else shows a "Download" fallback.
 *
 * Data flow:
 *   - GET /api/team/{sid}/files      → listing (polled on open, invalidated
 *                                       by team store after write/edit/rm)
 *   - GET /api/team/{sid}/media/{p}  → file bytes (fetched by preview only
 *                                       when the user selects a text file;
 *                                       images use the URL directly as src)
 */

import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X,
  FileText,
  FileImage,
  FileCode,
  FileVideo,
  File as FileIcon,
  Folder,
  Download,
  RefreshCw,
  Loader2,
  ExternalLink,
  Copy,
  Check,
  ArrowLeft,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { workspaceMediaUrl } from '@/api/client'
import { downloadWorkspaceFile } from '@/lib/workspace-download'
import { useWorkspaceFilesQuery } from '@/queries'
import { useIsMobile } from '@/hooks/use-mobile'
import { useModalFocus } from '@/hooks/useModalFocus'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { usePlatform } from '@/hooks/use-platform'
import { mediumHapticFeedback } from '@/lib/haptics'
import { formatBytes } from '@/utils/format'
import { ImageLightbox } from './ImageLightbox'
import { isVideoSrc } from '@/utils/workspace'
import type { WorkspaceFileInfo } from '@/api/types'

// ── File-type helpers ─────────────────────────────────────────────────────────

// Extensions we preview as plain text.  Anything else falls back to "Download".
const FILE_LONG_PRESS_MS = 520
const FILE_LONG_PRESS_MOVE_TOLERANCE = 10

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'env', 'gitignore',
  'csv', 'tsv', 'log',
  'py', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'html', 'css', 'scss', 'sass',
  'sh', 'bash', 'zsh', 'fish',
  'rs', 'go', 'java', 'kt', 'c', 'cpp', 'h', 'hpp', 'rb', 'php', 'swift',
  'sql', 'xml', 'svg',
])

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'])

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

type FileKind = 'image' | 'video' | 'text' | 'binary'

function kindOf(file: WorkspaceFileInfo): FileKind {
  const ext = extOf(file.name)
  // SVG is both an image (for preview) and text — prefer the visual preview.
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (file.mime.startsWith('image/')) return 'image'
  if (file.mime.startsWith('video/') || isVideoSrc(file.name)) return 'video'
  if (!ext) return 'text'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (file.mime.startsWith('text/')) return 'text'
  if (file.mime === 'application/json') return 'text'
  return 'binary'
}

function FileTypeIcon({ file, size = 12 }: { file: WorkspaceFileInfo; size?: number }) {
  const kind = kindOf(file)
  const cls = 'shrink-0 text-(--color-text-muted)'
  if (kind === 'image') return <FileImage size={size} className={cls} />
  if (kind === 'video') return <FileVideo size={size} className={cls} />
  if (kind === 'text') {
    // Code files get the code icon; plain text/markdown use the document icon.
    const ext = extOf(file.name)
    const isCode = ext && !['txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv'].includes(ext)
    return isCode ? <FileCode size={size} className={cls} /> : <FileText size={size} className={cls} />
  }
  return <FileIcon size={size} className={cls} />
}

// ── Tree grouping ─────────────────────────────────────────────────────────────
//
// Flat listing from the API is sorted lexicographically, which already groups
// by directory.  We split each path into (dir, file) and collect files under
// their dir bucket — one level of grouping is enough for the UX, even when
// paths are deeply nested (the dir label shows the full posix prefix).

interface Group {
  dir: string  // '' = root, otherwise POSIX path
  files: WorkspaceFileInfo[]
}

function groupByDir(files: WorkspaceFileInfo[]): Group[] {
  const buckets = new Map<string, WorkspaceFileInfo[]>()
  for (const f of files) {
    const slash = f.path.lastIndexOf('/')
    const dir = slash < 0 ? '' : f.path.slice(0, slash)
    const bucket = buckets.get(dir) ?? []
    bucket.push(f)
    buckets.set(dir, bucket)
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => {
      // Root directory first, then alphabetical.
      if (a === '') return -1
      if (b === '') return 1
      return a.localeCompare(b)
    })
    .map(([dir, files]) => ({ dir, files }))
}

// ── Tree node ─────────────────────────────────────────────────────────────────

const FileRow = memo(function FileRow({
  file,
  selected,
  sessionId,
  onSelect,
}: {
  file: WorkspaceFileInfo
  selected: boolean
  sessionId: string
  onSelect: (file: WorkspaceFileInfo) => void
}) {
  const isMobile = useIsMobile()
  const { isTauri, os } = usePlatform()
  const isTauriMobile = isTauri && (os === 'ios' || os === 'android')
  const [actionsPoint, setActionsPoint] = useState<{ x: number; y: number } | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null)

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = null
    longPressStartRef.current = null
  }

  const copyPath = async () => {
    await navigator.clipboard.writeText(file.path)
  }

  return (
    <>
    <button
      onClick={() => onSelect(file)}
      onContextMenu={(event) => {
        if (isTauriMobile) return
        event.preventDefault()
        setActionsPoint({ x: event.clientX, y: event.clientY })
      }}
      onPointerDown={(event) => {
        if (!isMobile || !isTauriMobile || event.pointerType === 'mouse') return
        longPressStartRef.current = { x: event.clientX, y: event.clientY }
        longPressTimerRef.current = window.setTimeout(() => {
          longPressTimerRef.current = null
          longPressStartRef.current = null
          mediumHapticFeedback()
          setActionsPoint({ x: event.clientX, y: event.clientY })
        }, FILE_LONG_PRESS_MS)
      }}
      onPointerMove={(event) => {
        const start = longPressStartRef.current
        if (!start) return
        if (
          Math.abs(event.clientX - start.x) > FILE_LONG_PRESS_MOVE_TOLERANCE ||
          Math.abs(event.clientY - start.y) > FILE_LONG_PRESS_MOVE_TOLERANCE
        ) {
          clearLongPress()
        }
      }}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
      className={cn(
        'group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition-colors',
        selected
          ? 'bg-(--bg-key) text-(--color-accent)'
          : 'text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text)',
      )}
      title={file.path}
    >
      <FileTypeIcon file={file} />
      <span className="min-w-0 flex-1 truncate font-mono">{file.name}</span>
      <span className="shrink-0 text-[10px] text-(--color-text-subtle)">
        {formatBytes(file.size)}
      </span>
    </button>
    {actionsPoint && (
      <div
        className="fixed inset-0 z-[70]"
        onClick={() => setActionsPoint(null)}
        onContextMenu={(event) => {
          event.preventDefault()
          setActionsPoint(null)
        }}
      >
        <div
          role="menu"
          aria-label={`Actions for ${file.name}`}
          className="fixed min-w-44 rounded-sm border border-(--color-border) bg-(--bg-card) p-1 text-xs text-(--color-text) shadow-md"
          style={{ left: actionsPoint.x, top: actionsPoint.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
            onClick={() => {
              setActionsPoint(null)
              onSelect(file)
            }}
          >
            <FileText size={14} aria-hidden="true" />
            Preview
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
            onClick={() => {
              setActionsPoint(null)
              void copyPath()
            }}
          >
            <Copy size={14} aria-hidden="true" />
            Copy path
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
            onClick={() => {
              setActionsPoint(null)
              void downloadWorkspaceFile(sessionId, file)
            }}
          >
            <Download size={14} aria-hidden="true" />
            Download
          </button>
        </div>
      </div>
    )}
    </>
  )
})

function TreeGroup({
  group,
  selectedPath,
  sessionId,
  onSelect,
}: {
  group: Group
  selectedPath: string | null
  sessionId: string
  onSelect: (file: WorkspaceFileInfo) => void
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-subtle)">
        <Folder size={11} />
        <span className="truncate">{group.dir || '/'}</span>
      </div>
      <ul className="space-y-0.5">
        {group.files.map((f) => (
          <li key={f.path}>
            <FileRow
              file={f}
              selected={f.path === selectedPath}
              sessionId={sessionId}
              onSelect={onSelect}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Previews ──────────────────────────────────────────────────────────────────

function ImagePreview({ sessionId, file }: { sessionId: string; file: WorkspaceFileInfo }) {
  const [open, setOpen] = useState(false)
  const url = workspaceMediaUrl(sessionId, file.path)
  return (
    <>
      <div className="flex h-full items-center justify-center bg-(--bg-page) p-4">
        <img
          src={url}
          alt={file.name}
          onClick={() => setOpen(true)}
          className="max-h-full max-w-full cursor-zoom-in rounded border border-(--color-border) object-contain"
        />
      </div>
      <ImageLightbox src={url} alt={file.name} isOpen={open} onClose={() => setOpen(false)} />
    </>
  )
}

function VideoPreview({ sessionId, file }: { sessionId: string; file: WorkspaceFileInfo }) {
  const url = workspaceMediaUrl(sessionId, file.path)
  return (
    <div className="flex h-full items-center justify-center bg-(--bg-page) p-4">
      <video
        src={url}
        controls
        preload="metadata"
        playsInline
        className="block max-h-full max-w-full rounded border border-(--color-border) bg-black object-contain"
      />
    </div>
  )
}

// Cap on bytes fetched for text preview — avoids loading a 50 MB log into
// the browser.  Beyond this we show a notice + download button.
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024  // 512 KB

function TextPreview({ sessionId, file }: { sessionId: string; file: WorkspaceFileInfo }) {
  const tooLarge = file.size > MAX_TEXT_PREVIEW_BYTES
  // Start in a loading state *unless* the file is too large — the effect is
  // skipped in that case and flipping loading=false there would trigger the
  // set-state-in-effect lint.  Keeping the initial state derived avoids it.
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!tooLarge)

  useEffect(() => {
    if (tooLarge) return
    let cancelled = false
    fetch(workspaceMediaUrl(sessionId, file.path))
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
  }, [sessionId, file.path, tooLarge])

  if (tooLarge) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FileText size={24} className="text-(--color-text-subtle)" />
        <p className="text-sm text-(--color-text-2)">File too large to preview</p>
        <p className="text-xs text-(--color-text-subtle)">
          {formatBytes(file.size)} — limit is {formatBytes(MAX_TEXT_PREVIEW_BYTES)}
        </p>
      </div>
    )
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-(--color-text-subtle)">
        <Loader2 size={16} className="animate-spin" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-(--color-error)">
        Failed to load: {error}
      </div>
    )
  }
  if (content === null) return null

  return (
    <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-(--color-text) [overflow-wrap:anywhere]">
      {content}
    </pre>
  )
}

function BinaryPreview({ sessionId, file }: { sessionId: string; file: WorkspaceFileInfo }) {
  const url = workspaceMediaUrl(sessionId, file.path)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FileIcon size={28} className="text-(--color-text-subtle)" />
      <div>
        <p className="text-sm text-(--color-text-2)">No inline preview for this file type</p>
        <p className="mt-0.5 text-xs text-(--color-text-subtle)">
          {file.mime} · {formatBytes(file.size)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 rounded-md bg-(--bg-key) px-3 py-1.5 text-xs text-(--color-accent) transition-colors hover:bg-(--bg-key)"
        >
          <ExternalLink size={12} /> Open in new tab
        </a>
        <DownloadWorkspaceFileButton
          sessionId={sessionId}
          file={file}
          className="flex items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-xs text-(--color-text-2) transition-colors hover:border-(--color-border-strong)"
        >
          <Download size={12} /> Download
        </DownloadWorkspaceFileButton>
      </div>
    </div>
  )
}

export function DownloadWorkspaceFileButton({
  sessionId,
  file,
  className,
  children,
}: {
  sessionId: string
  file: WorkspaceFileInfo
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={() => void downloadWorkspaceFile(sessionId, file)}
      className={className}
      title="Download"
      aria-label="Download"
    >
      {children}
    </button>
  )
}

export function CopyContentsButton({
  sessionId,
  file,
}: {
  sessionId: string
  file: WorkspaceFileInfo
}) {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const tooLarge = file.size > MAX_TEXT_PREVIEW_BYTES

  const handleCopy = async () => {
    if (busy || tooLarge) return
    setBusy(true)
    try {
      const res = await fetch(workspaceMediaUrl(sessionId, file.path))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Swallow — the button is best-effort.  Failure is rare (clipboard
      // permission denied, or the media proxy returned non-2xx) and the user
      // can fall back to Download.
    } finally {
      setBusy(false)
    }
  }

  const title = tooLarge
    ? `File too large to copy (${formatBytes(file.size)} > ${formatBytes(MAX_TEXT_PREVIEW_BYTES)})`
    : copied
      ? 'Copied!'
      : 'Copy file contents'

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={busy || tooLarge}
      title={title}
      aria-label={title}
      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-(--color-text-muted)"
    >
      {copied ? (
        <Check size={12} className="text-(--color-success)" />
      ) : busy ? (
        <Loader2 size={12} className="animate-spin" />
      ) : (
        <Copy size={12} />
      )}
    </button>
  )
}

function PreviewArea({
  sessionId,
  file,
}: {
  sessionId: string
  file: WorkspaceFileInfo
}) {
  const kind = kindOf(file)
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-(--color-border) px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <FileTypeIcon file={file} size={13} />
            <div className="truncate font-mono text-xs text-(--color-text)">{file.path}</div>
          </div>
          <div className="mt-0.5 text-[10px] text-(--color-text-subtle)">
            {formatBytes(file.size)} · {file.mime}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <DownloadWorkspaceFileButton
            sessionId={sessionId}
            file={file}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
          >
            <Download size={12} />
          </DownloadWorkspaceFileButton>
          {kind === 'text' && <CopyContentsButton sessionId={sessionId} file={file} />}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {kind === 'image' ? (
          <ImagePreview sessionId={sessionId} file={file} />
        ) : kind === 'video' ? (
          <VideoPreview sessionId={sessionId} file={file} />
        ) : kind === 'text' ? (
          <TextPreview sessionId={sessionId} file={file} />
        ) : (
          <BinaryPreview sessionId={sessionId} file={file} />
        )}
      </div>
    </div>
  )
}

// ── Empty states ──────────────────────────────────────────────────────────────

function EmptyState({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <FileText size={24} className="text-(--color-text-subtle)" />
      <p className="text-sm text-(--color-text-2)">{message}</p>
      {hint && <p className="max-w-xs text-xs text-(--color-text-subtle)">{hint}</p>}
    </div>
  )
}

// ── Main drawer ──────────────────────────────────────────────────────────────

interface WorkspaceFilesPanelProps {
  /** Controls drawer visibility.  Parent keeps the component mounted so
   *  framer-motion can play both the enter and exit animations. */
  open: boolean
  sessionId: string | null
  onClose: () => void
}

export function WorkspaceFilesPanel({ open, sessionId, onClose }: WorkspaceFilesPanelProps) {
  const isMobile = useIsMobile()
  const { isMacOverlay } = usePlatform()
  const { data, isLoading, isError, refetch, isFetching } = useWorkspaceFilesQuery(sessionId)
  const prefersReducedMotion = useReducedMotion()

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // Mobile: which pane is active — 'tree' (file list) or 'preview'
  const [mobilePane, setMobilePane] = useState<'tree' | 'preview'>('tree')
  const handleModalClose = useCallback(() => {
    if (isMobile && mobilePane === 'preview') {
      setMobilePane('tree')
      return
    }
    onClose()
  }, [isMobile, mobilePane, onClose])
  useModalFocus(open, handleModalClose)

  // Refresh on open so the list is fresh even if query was stale.
  useEffect(() => {
    if (open && sessionId) refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId])

  // Wrap ``data?.files ?? []`` in a memo so the ``files`` reference is stable
  // when the query returns the same cache entry — otherwise downstream
  // memoised derivations (``groups``) would recompute every render.
  const files = useMemo<WorkspaceFileInfo[]>(() => data?.files ?? [], [data])
  const groups = useMemo(() => groupByDir(files), [files])

  // Keep selection valid as the list churns — e.g. the selected file was deleted
  // by a new turn's rm tool call.  When the selection disappears, clear it.
  useEffect(() => {
    if (!selectedPath) return
    if (!files.some((f) => f.path === selectedPath)) {
      setSelectedPath(null)
      setMobilePane('tree')
    }
  }, [files, selectedPath])

  const selected = selectedPath ? files.find((f) => f.path === selectedPath) ?? null : null

  const handleSelectFile = (f: WorkspaceFileInfo) => {
    setSelectedPath(f.path)
    if (isMobile) setMobilePane('preview')
  }

  const handleBackToTree = () => {
    setMobilePane('tree')
  }

  // On mobile, tree pane and preview pane are mutually exclusive full-width views.
  const showTree = !isMobile || mobilePane === 'tree'
  const showPreview = !isMobile || mobilePane === 'preview'

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/40 [[data-mobile-shell]_&]:top-[calc(var(--spacing-app-header)+env(safe-area-inset-top,0px))]"
          />

          <motion.aside
            key="drawer"
            initial={prefersReducedMotion ? { opacity: 0 } : { x: '100%', opacity: 0 }}
            animate={prefersReducedMotion ? { opacity: 1 } : { x: 0, opacity: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { x: '100%', opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.01 : 0.22, ease: [0.4, 0, 0.2, 1] }}
            className={cn(
              'fixed bottom-0 right-0 top-[env(safe-area-inset-top,0px)] z-50 flex w-[min(960px,95vw)] flex-col overflow-hidden border-l border-(--color-border) bg-(--bg-card) shadow-2xl',
              '[[data-mobile-shell]_&]:top-[calc(var(--spacing-app-header)+env(safe-area-inset-top,0px))] [[data-mobile-shell]_&]:right-[env(safe-area-inset-right,0px)] [[data-mobile-shell]_&]:w-[min(960px,calc(100vw-env(safe-area-inset-left,0px)-env(safe-area-inset-right,0px)))]',
              isMacOverlay && 'top-(--spacing-app-header)',
            )}
            role="dialog"
            aria-modal="true"
            aria-label="Workspace files"
            data-modal-focus="true"
          >
            {/* Header */}
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-(--color-border) px-4 py-3">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {/* Mobile back button — only shown in preview pane */}
                {isMobile && mobilePane === 'preview' && (
                  <button
                    onClick={handleBackToTree}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                    aria-label="Back to file list"
                  >
                    <ArrowLeft size={14} />
                  </button>
                )}
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-(--color-text)">Workspace</h2>
                  <p className="truncate text-[11px] text-(--color-text-subtle)">
                    {isMobile && mobilePane === 'preview' && selected
                      ? selected.name
                      : <>Files the agent has written into this session{data?.truncated ? ' · list truncated' : ''}</>
                    }
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => refetch()}
                  disabled={!sessionId || isFetching}
                  className="rounded p-1.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) disabled:opacity-50"
                  title="Refresh"
                  aria-label="Refresh"
                >
                  <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={onClose}
                  className="rounded p-1.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                  title="Close (Esc)"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
            </header>

            {/* Body: tree + preview split (desktop) / master-detail (mobile) */}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              {/* Tree — full width on mobile tree pane, fixed 260px on desktop */}
              {showTree && (
                <nav className={cn(
                  'overflow-y-auto border-r border-(--color-border) px-2 py-3',
                  isMobile ? 'w-full' : 'w-[260px] shrink-0',
                )}>
                  {!sessionId ? (
                    <p className="px-2 py-4 text-xs italic text-(--color-text-subtle)">
                      No active session.
                    </p>
                  ) : isLoading ? (
                    <div className="px-2 py-6 text-center text-xs text-(--color-text-subtle)">
                      <Loader2 size={14} className="mx-auto animate-spin" />
                    </div>
                  ) : isError ? (
                    <p className="px-2 py-4 text-xs text-(--color-error)">
                      Failed to load workspace files
                    </p>
                  ) : groups.length === 0 ? (
                    <p className="px-2 py-4 text-xs italic text-(--color-text-subtle)">
                      No files yet.  Anything the agent writes will appear here.
                    </p>
                  ) : (
                    groups.map((group) => (
                      <TreeGroup
                        key={group.dir}
                        group={group}
                        selectedPath={selectedPath}
                        sessionId={sessionId}
                        onSelect={handleSelectFile}
                      />
                    ))
                  )}
                </nav>
              )}

              {/* Preview — full width on mobile preview pane, flex-1 on desktop */}
              {showPreview && (
                <div className="min-w-0 flex-1">
                  {selected && sessionId ? (
                    <PreviewArea key={selected.path} sessionId={sessionId} file={selected} />
                  ) : (
                    <EmptyState
                      message="Select a file"
                      hint="Images, markdown, and code files render inline. Other formats offer download."
                    />
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="shrink-0 border-t border-(--color-border) px-4 py-2 text-[11px] text-(--color-text-muted) pb-safe">
              {files.length > 0 && <span>{files.length} file{files.length === 1 ? '' : 's'} · </span>}
              {isMobile ? 'Tap a file to preview' : 'Esc or click outside to close'}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
