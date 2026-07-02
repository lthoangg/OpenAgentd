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
import { AnimatePresence, motion } from 'framer-motion'
import {
  X,
  FileText,
  Download,
  RefreshCw,
  Loader2,
  ExternalLink,
  Copy,
  Check,
  ArrowLeft,
  ChevronRight,
} from 'lucide-react'
import folderIcon from 'material-icon-theme/icons/folder.svg?url'
import folderOpenIcon from 'material-icon-theme/icons/folder-open.svg?url'
import { FileTypeIcon } from './FileTypeIcon'
import { cn } from '@/lib/utils'
import { workspaceMediaUrl } from '@/api/client'
import { downloadWorkspaceFile } from '@/lib/workspace-download'
import { useWorkspaceFilesQuery } from '@/queries'
import { useIsMobile } from '@/hooks/use-mobile'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { usePlatform } from '@/hooks/use-platform'
import { mediumHapticFeedback } from '@/lib/haptics'
import { formatBytes } from '@/utils/format'
import { ImageLightbox } from './ImageLightbox'
import { isVideoSrc } from '@/utils/workspace'
import type { WorkspaceFileInfo } from '@/api/types'

// ── File-type helpers ─────────────────────────────────────────────────────────

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
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (file.mime.startsWith('image/')) return 'image'
  if (file.mime.startsWith('video/') || isVideoSrc(file.name)) return 'video'
  if (!ext) return 'text'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (file.mime.startsWith('text/')) return 'text'
  if (file.mime === 'application/json') return 'text'
  return 'binary'
}

// ── Tree data model ───────────────────────────────────────────────────────────
//
// Build a proper nested tree from the flat path list so every directory level
// is independently collapsible.  Folders sort before files; siblings are
// sorted alphabetically within each group.

type TreeNode =
  | { kind: 'folder'; name: string; path: string; children: TreeNode[] }
  | { kind: 'file';   name: string; path: string; file: WorkspaceFileInfo }

function buildTree(files: WorkspaceFileInfo[]): TreeNode[] {
  // Map from folder path → ordered children list (insertion order preserved).
  const folders = new Map<string, TreeNode[]>()
  folders.set('', [])

  for (const f of files) {
    const segments = f.path.split('/')
    // Ensure every ancestor folder node exists.
    for (let i = 1; i < segments.length; i++) {
      const parentPath = segments.slice(0, i - 1).join('/')
      const folderPath = segments.slice(0, i).join('/')
      if (!folders.has(folderPath)) {
        folders.set(folderPath, [])
        const parent = folders.get(parentPath)!
        parent.push({ kind: 'folder', name: segments[i - 1], path: folderPath, children: folders.get(folderPath)! })
      }
    }
    // Insert the file under its direct parent.
    const parentPath = segments.slice(0, segments.length - 1).join('/')
    folders.get(parentPath)!.push({ kind: 'file', name: f.name, path: f.path, file: f })
  }

  function sortNodes(nodes: TreeNode[]): TreeNode[] {
    return nodes
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map((n) => n.kind === 'folder' ? { ...n, children: sortNodes(n.children) } : n)
  }

  return sortNodes(folders.get('')!)
}

/** Returns the set of folder paths that are ancestors of `selectedPath`. */
function ancestorPaths(selectedPath: string): Set<string> {
  const parts = selectedPath.split('/')
  const result = new Set<string>()
  for (let i = 1; i < parts.length; i++) result.add(parts.slice(0, i).join('/'))
  return result
}

/** Collects every folder path in the tree (for default-open state). */
function allFolderPaths(nodes: TreeNode[]): Set<string> {
  const result = new Set<string>()
  function walk(ns: TreeNode[]) {
    for (const n of ns) {
      if (n.kind === 'folder') {
        result.add(n.path)
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return result
}

// ── Tree rows ─────────────────────────────────────────────────────────────────
//
// Each row receives its `depth` (0 = root level) and adds
// `depth * 12px` of left padding so the hierarchy is visually obvious.
// No hover background — only the selected file gets a highlight (accent text).
// Folders toggle open/closed; the chevron rotates to indicate state.

const INDENT_PX = 12

const FileRow = memo(function FileRow({
  file,
  depth,
  selected,
  sessionId,
  onSelect,
}: {
  file: WorkspaceFileInfo
  depth: number
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
          ) clearLongPress()
        }}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
        onPointerLeave={clearLongPress}
        style={{ paddingLeft: depth * INDENT_PX + 6 }}
        className={cn(
          'flex w-full items-center gap-1.5 py-[3px] pr-2 text-left',
          selected ? 'text-(--color-accent)' : 'text-(--color-text-2)',
        )}
        title={file.path}
      >
        <FileTypeIcon name={file.name} size={14} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-5">{file.name}</span>
      </button>

      {actionsPoint && (
        <div
          className="fixed inset-0 z-[70]"
          onClick={() => setActionsPoint(null)}
          onContextMenu={(event) => { event.preventDefault(); setActionsPoint(null) }}
        >
          <div
            role="menu"
            aria-label={`Actions for ${file.name}`}
            className="fixed min-w-44 rounded-sm border border-(--color-border) bg-(--bg-card) p-1 text-xs text-(--color-text) shadow-md"
            style={{ left: actionsPoint.x, top: actionsPoint.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button" role="menuitem"
              className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
              onClick={() => { setActionsPoint(null); onSelect(file) }}
            >
              <FileText size={14} aria-hidden="true" /> Preview
            </button>
            <button
              type="button" role="menuitem"
              className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
              onClick={() => { setActionsPoint(null); void navigator.clipboard.writeText(file.path) }}
            >
              <Copy size={14} aria-hidden="true" /> Copy path
            </button>
            <button
              type="button" role="menuitem"
              className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
              onClick={() => { setActionsPoint(null); void downloadWorkspaceFile(sessionId, file) }}
            >
              <Download size={14} aria-hidden="true" /> Download
            </button>
          </div>
        </div>
      )}
    </>
  )
})

function FolderRow({
  name,
  depth,
  open,
  onToggle,
}: {
  name: string
  depth: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{ paddingLeft: depth * INDENT_PX + 2 }}
      className="flex w-full items-center gap-1 py-[3px] pr-2 text-left text-(--color-text-2)"
      aria-expanded={open}
    >
      <ChevronRight
        size={12}
        className={cn('shrink-0 text-(--color-text-subtle) transition-transform duration-100', open && 'rotate-90')}
        aria-hidden="true"
      />
      <img
        src={open ? folderOpenIcon : folderIcon}
        alt="" aria-hidden="true"
        className="shrink-0 object-contain"
        style={{ width: 14, height: 14 }}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-5">{name}</span>
    </button>
  )
}

function FileTree({
  nodes,
  depth,
  selectedPath,
  sessionId,
  openFolders,
  onSelect,
  onToggleFolder,
}: {
  nodes: TreeNode[]
  depth: number
  selectedPath: string | null
  sessionId: string
  openFolders: Set<string>
  onSelect: (file: WorkspaceFileInfo) => void
  onToggleFolder: (path: string) => void
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <div key={node.path}>
            <FolderRow
              name={node.name}
              depth={depth}
              open={openFolders.has(node.path)}
              onToggle={() => onToggleFolder(node.path)}
            />
            {openFolders.has(node.path) && (
              <FileTree
                nodes={node.children}
                depth={depth + 1}
                selectedPath={selectedPath}
                sessionId={sessionId}
                openFolders={openFolders}
                onSelect={onSelect}
                onToggleFolder={onToggleFolder}
              />
            )}
          </div>
        ) : (
          <FileRow
            key={node.path}
            file={node.file}
            depth={depth}
            selected={node.path === selectedPath}
            sessionId={sessionId}
            onSelect={onSelect}
          />
        )
      )}
    </>
  )
}

// ── Previews ──────────────────────────────────────────────────────────────────

function ImagePreview({ sessionId, file }: { sessionId: string; file: WorkspaceFileInfo }) {
  const [open, setOpen] = useState(false)
  const url = workspaceMediaUrl(sessionId, file.path)
  return (
    <>
      <div className="flex h-full items-center justify-center overflow-hidden overscroll-contain touch-pan-y bg-(--bg-page) p-4">
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
    <div className="flex h-full items-center justify-center overflow-hidden overscroll-contain touch-pan-y bg-(--bg-page) p-4">
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
    <pre
      // tabIndex makes the element focusable so keyboard scroll works inside
      // the pane instead of leaking to the chat area behind it.
      // onKeyDown stops propagation for every key that scrolls a container
      // (arrows, Page/Home/End, Space) so the global "type to focus input"
      // and "Tab cycles agents" handlers in TeamChatView don't fire.
      tabIndex={0}
      data-scroll-capture="true"
      data-select-container
      onKeyDown={(e) => {
        const scrollKeys = new Set([
          'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
          'PageUp', 'PageDown', 'Home', 'End', ' ',
        ])
        if (scrollKeys.has(e.key)) e.stopPropagation()
      }}
      className="h-full overflow-auto overscroll-contain whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-(--color-text) outline-none [overflow-wrap:anywhere] touch-pan-y"
    >
      {content}
    </pre>
  )
}

function BinaryPreview({ sessionId, file }: { sessionId: string; file: WorkspaceFileInfo }) {
  const url = workspaceMediaUrl(sessionId, file.path)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FileText size={28} className="text-(--color-text-subtle)" />
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
            <FileTypeIcon name={file.name} size={14} />
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
  open: boolean
  sessionId: string | null
  onClose: () => void
}

const DEFAULT_WIDTH = 420
const MIN_WIDTH = 300
const MAX_WIDTH = 900

export function WorkspaceFilesPanel({ open, sessionId, onClose }: WorkspaceFilesPanelProps) {
  const isMobile = useIsMobile()
  const prefersReducedMotion = useReducedMotion()
  const { data, isLoading, isError, refetch, isFetching } = useWorkspaceFilesQuery(sessionId)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // Mobile: which pane is active — 'tree' (file list) or 'preview'
  const [mobilePane, setMobilePane] = useState<'tree' | 'preview'>('tree')

  const handleClose = useCallback(() => {
    // On mobile, back-navigate from preview before closing
    if (isMobile && mobilePane === 'preview') {
      setMobilePane('tree')
      return
    }
    onClose()
  }, [isMobile, mobilePane, onClose])

  // Escape key — only on mobile (desktop has no backdrop/overlay)
  useEffect(() => {
    if (!open || !isMobile) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, isMobile, handleClose])

  // Resizable width — desktop only
  const resizable = useResizableWidth({
    storageKey: 'oa.workspaceFilesPanel.width',
    defaultWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    edge: 'left',
    disabled: isMobile,
  })

  // Refresh on open
  useEffect(() => {
    if (open && sessionId) refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId])

  const files = useMemo<WorkspaceFileInfo[]>(() => data?.files ?? [], [data])
  const nodes = useMemo(() => buildTree(files), [files])

  // All folders open by default; user can collapse individually.
  // When the agent creates new directories mid-session, those are also opened.
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set())

  const toggleFolder = useCallback((path: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // Whenever the tree changes (initial load or agent adds new dirs), open any
  // folder paths that aren't already tracked — preserves manual collapses.
  useEffect(() => {
    const all = allFolderPaths(nodes)
    if (all.size === 0) return
    setOpenFolders((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const p of all) { if (!next.has(p)) { next.add(p); changed = true } }
      return changed ? next : prev
    })
  }, [nodes])

  // Also ensure ancestors of the selected file are open (handles the edge case
  // where a selection arrives before the tree has loaded).
  useEffect(() => {
    if (!selectedPath) return
    const ancestors = ancestorPaths(selectedPath)
    if (ancestors.size === 0) return
    setOpenFolders((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const p of ancestors) { if (!next.has(p)) { next.add(p); changed = true } }
      return changed ? next : prev
    })
  }, [selectedPath, nodes])

  // Drop selection when the file disappears (agent deleted it)
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

  const showTree    = !isMobile || mobilePane === 'tree'
  const showPreview = !isMobile || mobilePane === 'preview'

  // ── Panel content (shared between mobile and desktop) ─────────────────────
  const panelContent = (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      {/* Resize handle — desktop only */}
      {!isMobile && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize workspace files panel"
          title="Drag to resize · double-click to reset"
          className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-(--color-accent)/40"
          onPointerDown={resizable.startResize}
          onDoubleClick={resizable.resetWidth}
        />
      )}

      {/* Header */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-(--color-border) px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isMobile && mobilePane === 'preview' && (
            <button
              onClick={() => setMobilePane('tree')}
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
            aria-label="Close workspace files panel"
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {showTree && (
          <nav
            aria-label="Workspace files"
            className={cn(
              'overflow-y-auto overscroll-contain touch-pan-y border-r border-(--color-border) py-1',
              isMobile ? 'w-full' : 'w-[260px] shrink-0',
            )}
            onKeyDown={(e) => {
              // Arrow-key navigation between visible tree rows.
              // Collect all focusable buttons inside the nav at event time
              // (the tree is dynamic — folders open/close).
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
              const nav = e.currentTarget
              const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>('button'))
              if (buttons.length === 0) return
              const idx = buttons.indexOf(document.activeElement as HTMLButtonElement)
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                buttons[Math.min(idx + 1, buttons.length - 1)]?.focus()
              } else {
                e.preventDefault()
                buttons[Math.max(idx - 1, 0)]?.focus()
              }
            }}
          >
            {!sessionId ? (
              <p className="px-3 py-4 text-xs italic text-(--color-text-subtle)">No active session.</p>
            ) : isLoading ? (
              <div className="py-6 text-center text-xs text-(--color-text-subtle)">
                <Loader2 size={14} className="mx-auto animate-spin" />
              </div>
            ) : isError ? (
              <p className="px-3 py-4 text-xs text-(--color-error)">Failed to load workspace files</p>
            ) : nodes.length === 0 ? (
              <p className="px-3 py-4 text-xs italic text-(--color-text-subtle)">
                No files yet. Anything the agent writes will appear here.
              </p>
            ) : (
              <FileTree
                nodes={nodes}
                depth={0}
                selectedPath={selectedPath}
                sessionId={sessionId}
                openFolders={openFolders}
                onSelect={handleSelectFile}
                onToggleFolder={toggleFolder}
              />
            )}
          </nav>
        )}
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
    </div>
  )

  // ── Desktop: in-flow push panel ───────────────────────────────────────────
  // Rendered as a flex sibling of <main> — animates width 0→N so the chat
  // area is pushed left rather than covered. No backdrop needed.
  if (!isMobile) {
    return (
      <AnimatePresence>
        {open && (
          <motion.aside
            key="files-panel"
            role="complementary"
            aria-label="Workspace files"
            initial={prefersReducedMotion ? { opacity: 0 } : { width: 0, opacity: 0 }}
            animate={prefersReducedMotion ? { opacity: 1 } : { width: resizable.width, opacity: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { width: 0, opacity: 0 }}
            transition={{ duration: resizable.isResizing || prefersReducedMotion ? 0.01 : 0.22, ease: [0.4, 0, 0.2, 1] }}
            className="h-full shrink-0 overflow-hidden border-l border-(--color-border) bg-(--bg-page)"
          >
            {panelContent}
          </motion.aside>
        )}
      </AnimatePresence>
    )
  }

  // ── Mobile: fixed overlay from the right, below the app header ───────────
  // Backdrop dims the content area (below header). Panel slides in from right.
  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop — below the header, no blur */}
          <motion.div
            key="files-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="mobile-safe-top fixed inset-x-0 bottom-0 z-40 bg-black/30"
            onClick={onClose}
            aria-hidden="true"
          />
          {/* Panel */}
          <motion.aside
            key="files-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Workspace files"
            initial={prefersReducedMotion ? { opacity: 0 } : { x: '100%' }}
            animate={prefersReducedMotion ? { opacity: 1 } : { x: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { x: '100%' }}
            transition={{ duration: prefersReducedMotion ? 0.01 : 0.22, ease: [0.4, 0, 0.2, 1] }}
            className="mobile-safe-top fixed inset-x-0 bottom-0 z-50 overflow-hidden border-t border-(--color-border) bg-(--bg-page) shadow-xl"
          >
            {panelContent}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
