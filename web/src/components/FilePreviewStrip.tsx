/**
 * FilePreviewStrip — horizontally scrolling row of file previews with an
 * optional scroll-position hint pill below.
 *
 * Used by InputBar when `files.length > 0`. The strip clips at the visible
 * width and scrolls horizontally; when content overflows, a 3px-tall pill
 * appears below the strip showing a thumb that mirrors the current scroll
 * position. The hint matches pencil's `attachmentScrollHint` /
 * `attachmentScrollThumb` pattern from the `MultiAttachOverflow` variant.
 *
 * If the content fits within the visible width (no overflow), the hint
 * is not rendered — keeping the bar visually quiet for small attachment
 * counts.
 *
 * Preview types by MIME / extension:
 *   image/*   → ImageAttachment (thumbnail + lightbox)
 *   video/*   → VideoCard (inline <video> thumbnail)
 *   audio/*   → AudioCard (compact <audio> player)
 *   text/* or known code extensions → TextFileCard (first-few-lines snippet)
 *   everything else → FileCard (icon + filename chip)
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { ImageAttachment } from './ImageAttachment'
import { FileCard } from './FileCard'
import { FileTypeIcon } from './FileTypeIcon'

interface FilePreviewStripProps {
  files: File[]
  blobUrls: Map<number, string>
  onRemove: (index: number) => void
  /** Whether to apply top margin (true) or bottom margin (false). */
  filesBelow: boolean
}

interface ScrollMetrics {
  thumbWidthPct: number
  thumbLeftPct: number
  hasOverflow: boolean
}

function computeMetrics(el: HTMLElement): ScrollMetrics {
  const { scrollLeft, scrollWidth, clientWidth } = el
  const hasOverflow = scrollWidth > clientWidth + 1
  if (!hasOverflow) {
    return { thumbWidthPct: 100, thumbLeftPct: 0, hasOverflow: false }
  }
  const thumbWidthPct = Math.max(15, (clientWidth / scrollWidth) * 100)
  const maxScroll = scrollWidth - clientWidth
  const scrollPct = maxScroll > 0 ? scrollLeft / maxScroll : 0
  const thumbLeftPct = scrollPct * (100 - thumbWidthPct)
  return { thumbWidthPct, thumbLeftPct, hasOverflow }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Extensions that are plain text / source code but carry no MIME or a generic MIME. */
const TEXT_EXTENSIONS = new Set([
  'py','go','rs','rb','java','kt','swift','c','cpp','h','hpp','cs','php',
  'sh','bash','zsh','fish','sql','graphql','proto','tf','tfvars',
  'ts','tsx','js','jsx','mjs','cjs','css','scss','html','xml','svg',
  'md','mdx','txt','csv','tsv','json','yaml','yml','toml','ini','conf','env',
])

function extOf(name: string): string {
  const lower = name.toLowerCase()
  const i = lower.lastIndexOf('.')
  return i >= 0 ? lower.slice(i + 1) : ''
}

function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (file.type === 'application/json' || file.type === 'application/x-yaml' || file.type === 'application/toml') return true
  return TEXT_EXTENSIONS.has(extOf(file.name))
}

function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/')
}

function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/')
}

// ── VideoCard ─────────────────────────────────────────────────────────────────

interface CardProps {
  file: File
  blobUrl: string
  onRemove: () => void
}

function VideoCard({ file, blobUrl, onRemove }: CardProps) {
  const displayName = file.name.length > 22 ? `${file.name.substring(0, 19)}…` : file.name

  return (
    <div className="group relative inline-block">
      <div className="flex flex-col overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card)">
        <video
          src={blobUrl}
          className="h-[100px] w-[160px] object-cover"
          preload="metadata"
          muted
        />
        <div className="flex items-center gap-1.5 px-2 py-1">
          <FileTypeIcon name={file.name} size={12} />
          <span className="truncate text-xs text-(--color-text-muted)" title={file.name}>{displayName}</span>
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-(--color-text-muted) shadow-sm opacity-100 transition-colors hover:border-(--color-border-strong) hover:text-(--color-text) md:-right-1.5 md:-top-1.5 md:h-4 md:w-4 md:opacity-0 md:group-hover:opacity-100"
        aria-label="Remove file"
        title="Remove"
      >
        <X size={12} className="md:h-2.5 md:w-2.5" />
      </button>
    </div>
  )
}

// ── AudioCard ─────────────────────────────────────────────────────────────────

function AudioCard({ file, blobUrl, onRemove }: CardProps) {
  const displayName = file.name.length > 22 ? `${file.name.substring(0, 19)}…` : file.name

  return (
    <div className="group relative inline-block">
      <div className="flex flex-col gap-1.5 rounded-sm border border-(--color-border) bg-(--bg-card) px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <FileTypeIcon name={file.name} size={12} />
          <span className="truncate text-xs font-medium text-(--color-text)" title={file.name}>{displayName}</span>
        </div>
        <audio
          src={blobUrl}
          controls
          className="h-7 w-[200px]"
          preload="metadata"
        />
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-(--color-text-muted) shadow-sm opacity-100 transition-colors hover:border-(--color-border-strong) hover:text-(--color-text) md:-right-1.5 md:-top-1.5 md:h-4 md:w-4 md:opacity-0 md:group-hover:opacity-100"
        aria-label="Remove file"
        title="Remove"
      >
        <X size={12} className="md:h-2.5 md:w-2.5" />
      </button>
    </div>
  )
}

// ── TextFileCard ──────────────────────────────────────────────────────────────

/** Max bytes read from a text file for the preview snippet. */
const TEXT_PREVIEW_BYTES = 400

function TextFileCard({ file, onRemove }: Omit<CardProps, 'blobUrl'>) {
  const [snippet, setSnippet] = useState<string | null>(null)
  const displayName = file.name.length > 22 ? `${file.name.substring(0, 19)}…` : file.name

  useEffect(() => {
    const slice = file.slice(0, TEXT_PREVIEW_BYTES)
    const reader = new FileReader()
    reader.onload = () => {
      const text = reader.result as string
      // Take up to 5 lines
      const lines = text.split('\n').slice(0, 5).join('\n')
      setSnippet(lines)
    }
    reader.onerror = () => setSnippet(null)
    reader.readAsText(slice)
  }, [file])

  return (
    <div className="group relative inline-block">
      <div className="flex w-[200px] flex-col overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card)">
        {/* Header */}
        <div className="flex items-center gap-1.5 border-b border-(--color-border-subtle) px-2 py-1.5">
          <FileTypeIcon name={file.name} size={12} />
          <span className="truncate text-xs font-medium text-(--color-text)" title={file.name}>{displayName}</span>
        </div>
        {/* Snippet */}
        <pre className="h-[72px] overflow-hidden px-2 py-1.5 font-mono text-[10px] leading-relaxed text-(--color-text-muted) select-none">
          {snippet ?? ''}
        </pre>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-(--color-text-muted) shadow-sm opacity-100 transition-colors hover:border-(--color-border-strong) hover:text-(--color-text) md:-right-1.5 md:-top-1.5 md:h-4 md:w-4 md:opacity-0 md:group-hover:opacity-100"
        aria-label="Remove file"
        title="Remove"
      >
        <X size={12} className="md:h-2.5 md:w-2.5" />
      </button>
    </div>
  )
}

// ── FilePreviewStrip ──────────────────────────────────────────────────────────

export function FilePreviewStrip({
  files,
  blobUrls,
  onRemove,
  filesBelow,
}: FilePreviewStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState<ScrollMetrics>({
    thumbWidthPct: 100,
    thumbLeftPct: 0,
    hasOverflow: false,
  })

  // Recompute on file count change and window resize.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setMetrics(computeMetrics(el))
  }, [files.length])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => setMetrics(computeMetrics(el))
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  if (files.length === 0) return null

  return (
    <div className={`${filesBelow ? 'mt-3' : 'mb-3'} -mx-2 -my-2`}>
      <div ref={scrollRef} className="overflow-x-auto px-2 py-2">
        <div className="flex w-max flex-nowrap items-center gap-2">
          {files.map((file, idx) => {
            const blobUrl = blobUrls.get(idx) || ''
            const remove = () => onRemove(idx)

            if (file.type.startsWith('image/')) {
              return (
                <div key={idx} className="shrink-0">
                  <ImageAttachment
                    src={blobUrl}
                    alt={file.name}
                    removable
                    compact
                    onRemove={remove}
                  />
                </div>
              )
            }

            if (isVideoFile(file)) {
              return (
                <div key={idx} className="shrink-0">
                  <VideoCard file={file} blobUrl={blobUrl} onRemove={remove} />
                </div>
              )
            }

            if (isAudioFile(file)) {
              return (
                <div key={idx} className="shrink-0">
                  <AudioCard file={file} blobUrl={blobUrl} onRemove={remove} />
                </div>
              )
            }

            if (isTextFile(file)) {
              return (
                <div key={idx} className="shrink-0">
                  <TextFileCard file={file} onRemove={remove} />
                </div>
              )
            }

            return (
              <div key={idx} className="shrink-0">
                <FileCard
                  name={file.name}
                  mediaType={file.type}
                  removable
                  onRemove={remove}
                />
              </div>
            )
          })}
        </div>
      </div>
      {metrics.hasOverflow && (
        <div
          className="mx-2 mt-1 h-[3px] overflow-hidden rounded-full bg-(--color-border-subtle)"
          aria-hidden="true"
        >
          <div
            className="h-full rounded-full bg-(--color-text-subtle)/60 transition-[left,width] duration-100"
            style={{
              width: `${metrics.thumbWidthPct}%`,
              marginLeft: `${metrics.thumbLeftPct}%`,
            }}
          />
        </div>
      )}
    </div>
  )
}
