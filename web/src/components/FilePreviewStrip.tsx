/**
 * FilePreviewStrip — horizontally scrolling row of pending-upload previews.
 *
 * Each card shows a rich preview appropriate for the file type and opens
 * FileLightbox (the full-screen gallery) on click. All cards share the same
 * gallery so users can swipe / arrow through every attached file.
 *
 * Preview cards by type:
 *   image/*            → thumbnail (ImageAttachment style)
 *   video/*            → <video> poster frame with filename
 *   audio/*            → compact <audio controls>
 *   application/pdf    → pdf.js-rendered page-1 thumbnail with filename
 *   text/* / code exts → first-N-lines snippet in a <pre>
 *   everything else    → icon + filename chip (FileCard)
 *
 * Gallery:
 *   Clicking any card opens FileLightbox at that card's index.
 *   The gallery contains all attached files — mixed types supported.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileCard } from './FileCard'
import { FileTypeIcon } from './FileTypeIcon'
import { FileLightbox, type FileLightboxItem, type FileLightboxItemType } from './FileLightbox'
import { PdfThumbnail } from './PdfThumbnail'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface FilePreviewStripProps {
  files: File[]
  blobUrls: Map<number, string>
  onRemove: (index: number) => void
  /** When true preview strip renders below the input; margin flips accordingly. */
  filesBelow: boolean
}

// ─── Scroll-hint metrics ───────────────────────────────────────────────────────

interface ScrollMetrics {
  thumbWidthPct: number
  thumbLeftPct: number
  hasOverflow: boolean
}

function computeMetrics(el: HTMLElement): ScrollMetrics {
  const { scrollLeft, scrollWidth, clientWidth } = el
  const hasOverflow = scrollWidth > clientWidth + 1
  if (!hasOverflow) return { thumbWidthPct: 100, thumbLeftPct: 0, hasOverflow: false }
  const thumbWidthPct = Math.max(15, (clientWidth / scrollWidth) * 100)
  const maxScroll = scrollWidth - clientWidth
  const scrollPct = maxScroll > 0 ? scrollLeft / maxScroll : 0
  const thumbLeftPct = scrollPct * (100 - thumbWidthPct)
  return { thumbWidthPct, thumbLeftPct, hasOverflow }
}

// ─── File-type detection ───────────────────────────────────────────────────────

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

function itemTypeOf(file: File): FileLightboxItemType {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type === 'application/pdf') return 'pdf'
  if (
    file.type.startsWith('text/') ||
    file.type === 'application/json' ||
    file.type === 'application/x-yaml' ||
    file.type === 'application/toml' ||
    TEXT_EXTENSIONS.has(extOf(file.name))
  ) return 'text'
  return 'file'
}

// ─── Shared remove button ──────────────────────────────────────────────────────

function RemoveButton({ onRemove, label = 'Remove file' }: { onRemove: () => void; label?: string }) {
  return (
    <Tooltip className="absolute -right-2 -top-2 z-10 md:-right-1.5 md:-top-1.5">
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove() }}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-(--color-border) bg-(--bg-card) text-(--color-text-muted) shadow-sm opacity-100 transition-colors hover:border-(--color-border-strong) hover:text-(--color-text) md:h-4 md:w-4 md:opacity-0 md:group-hover:opacity-100"
            aria-label={label}
          >
            <X size={12} className="md:h-2.5 md:w-2.5" />
          </button>
        }
      />
      <TooltipContent>Remove</TooltipContent>
    </Tooltip>
  )
}

// ─── Per-type preview cards ────────────────────────────────────────────────────

interface CardProps {
  file: File
  blobUrl: string
  onRemove: () => void
  onOpen: () => void
}

function ImageCard({ file, blobUrl, onRemove, onOpen }: CardProps) {
  const [error, setError] = useState(false)

  return (
    <div className="group relative inline-block">
      <button
        type="button"
        onClick={onOpen}
        className="overflow-hidden rounded-md focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none"
        aria-label={`Preview ${file.name}`}
      >
        {error
          ? (
            <div className="flex h-[120px] w-[120px] items-center justify-center rounded-md border border-(--color-border) bg-(--bg-card) text-xs text-(--color-text-muted)">
              Failed to load
            </div>
          )
          : (
            <img
              src={blobUrl}
              alt={file.name}
              loading="lazy"
              decoding="async"
              onError={() => setError(true)}
              className="max-h-[120px] max-w-[120px] rounded-md object-cover"
            />
          )}
      </button>
      <RemoveButton onRemove={onRemove} label="Remove image" />
    </div>
  )
}

function VideoCard({ file, blobUrl, onRemove, onOpen }: CardProps) {
  const displayName = file.name.length > 22 ? `${file.name.slice(0, 19)}…` : file.name
  return (
    <div className="group relative inline-block">
      <button
        type="button"
        onClick={onOpen}
        className="flex flex-col overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none"
        aria-label={`Preview ${file.name}`}
      >
        <video
          src={blobUrl}
          className="h-[90px] w-[150px] object-cover"
          preload="metadata"
          muted
        />
        <div className="flex items-center gap-1.5 px-2 py-1">
          <FileTypeIcon name={file.name} size={12} />
          <Tooltip className="min-w-0">
            <TooltipTrigger
              className="min-w-0"
              render={<span className="truncate text-xs text-(--color-text-muted)">{displayName}</span>}
            />
            <TooltipContent>{file.name}</TooltipContent>
          </Tooltip>
        </div>
      </button>
      <RemoveButton onRemove={onRemove} />
    </div>
  )
}

function AudioCard({ file, blobUrl, onRemove, onOpen }: CardProps) {
  const displayName = file.name.length > 22 ? `${file.name.slice(0, 19)}…` : file.name
  return (
    <div className="group relative inline-block">
      <div className="flex flex-col gap-1.5 rounded-md border border-(--color-border) bg-(--bg-card) px-2.5 py-2">
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-1.5 rounded-xs text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
          aria-label={`Preview ${file.name}`}
        >
          <FileTypeIcon name={file.name} size={12} />
          <Tooltip className="min-w-0">
            <TooltipTrigger
              className="min-w-0"
              render={<span className="truncate text-xs font-medium text-(--color-text) hover:underline">{displayName}</span>}
            />
            <TooltipContent>{file.name}</TooltipContent>
          </Tooltip>
        </button>
        <audio
          src={blobUrl}
          controls
          className="h-7 w-[190px]"
          preload="metadata"
        />
      </div>
      <RemoveButton onRemove={onRemove} />
    </div>
  )
}

function PdfCard({ file, blobUrl, onRemove, onOpen }: CardProps) {
  const displayName = file.name.length > 22 ? `${file.name.slice(0, 19)}…` : file.name
  return (
    <div className="group relative inline-block">
      <button
        type="button"
        onClick={onOpen}
        className="flex flex-col overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none"
        aria-label={`Preview ${file.name}`}
      >
        <PdfThumbnail
          src={blobUrl}
          className="pointer-events-none flex h-[90px] w-[150px] items-center justify-center bg-(--bg-page)"
        />
        <div className="flex items-center gap-1.5 border-t border-(--color-border-subtle) px-2 py-1">
          <FileTypeIcon name={file.name} size={12} />
          <Tooltip className="min-w-0">
            <TooltipTrigger
              className="min-w-0"
              render={<span className="truncate text-xs text-(--color-text-muted)">{displayName}</span>}
            />
            <TooltipContent>{file.name}</TooltipContent>
          </Tooltip>
        </div>
      </button>
      <RemoveButton onRemove={onRemove} />
    </div>
  )
}

/** Reads the first ~400 bytes of a text File and returns up to 5 lines. */
function useTextSnippet(file: File): string | null {
  const [snippet, setSnippet] = useState<string | null>(null)
  useEffect(() => {
    const reader = new FileReader()
    reader.onload = () => {
      const text = reader.result as string
      setSnippet(text.split('\n').slice(0, 5).join('\n'))
    }
    reader.onerror = () => setSnippet('')
    reader.readAsText(file.slice(0, 400))
  }, [file])
  return snippet
}

function TextCard({ file, onRemove, onOpen }: Omit<CardProps, 'blobUrl'> & { blobUrl: string }) {
  const snippet = useTextSnippet(file)
  const displayName = file.name.length > 22 ? `${file.name.slice(0, 19)}…` : file.name

  return (
    <div className="group relative inline-block">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-[190px] flex-col overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card) text-left focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none"
        aria-label={`Preview ${file.name}`}
      >
        <div className="flex items-center gap-1.5 border-b border-(--color-border-subtle) px-2 py-1.5">
          <FileTypeIcon name={file.name} size={12} />
          <Tooltip className="min-w-0">
            <TooltipTrigger
              className="min-w-0"
              render={<span className="truncate text-xs font-medium text-(--color-text)">{displayName}</span>}
            />
            <TooltipContent>{file.name}</TooltipContent>
          </Tooltip>
        </div>
        <pre className="h-[68px] overflow-hidden whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-[10px] leading-relaxed text-(--color-text-muted) select-none">
          {snippet ?? ''}
        </pre>
      </button>
      <RemoveButton onRemove={onRemove} />
    </div>
  )
}

// ─── Build gallery items ───────────────────────────────────────────────────────

/**
 * For text files we read the full content once so FileLightbox can show it
 * without re-fetching. Only runs when the file list changes.
 */
function useTextContents(files: File[]): Map<number, string> {
  const [contents, setContents] = useState<Map<number, string>>(new Map())
  useEffect(() => {
    const next = new Map<number, string>()
    let pending = 0
    files.forEach((file, idx) => {
      if (itemTypeOf(file) !== 'text') return
      pending++
      const reader = new FileReader()
      reader.onload = () => {
        next.set(idx, reader.result as string)
        pending--
        if (pending === 0) setContents(new Map(next))
      }
      reader.onerror = () => {
        next.set(idx, '')
        pending--
        if (pending === 0) setContents(new Map(next))
      }
      reader.readAsText(file)
    })
    if (pending === 0) setContents(new Map())
  }, [files])
  return contents
}

// ─── FilePreviewStrip ──────────────────────────────────────────────────────────

export function FilePreviewStrip({ files, blobUrls, onRemove, filesBelow }: FilePreviewStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState<ScrollMetrics>({ thumbWidthPct: 100, thumbLeftPct: 0, hasOverflow: false })
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null)

  const textContents = useTextContents(files)

  // Build the gallery items array once per file list change.
  const galleryItems = useMemo<FileLightboxItem[]>(() =>
    files.map((file, idx) => ({
      type: itemTypeOf(file),
      src: blobUrls.get(idx) ?? '',
      name: file.name,
      textContent: textContents.get(idx),
    })),
  [files, blobUrls, textContents])

  // Scroll-hint metrics
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
    <>
      <div className={`${filesBelow ? 'mt-3' : 'mb-3'} -mx-2 -my-2`}>
        <div ref={scrollRef} className="overflow-x-auto px-2 py-2">
          <div className="flex w-max flex-nowrap items-center gap-2">
            {files.map((file, idx) => {
              const blobUrl = blobUrls.get(idx) ?? ''
              const remove = () => onRemove(idx)
              const open = () => setGalleryIndex(idx)
              const type = itemTypeOf(file)

              return (
                <div key={idx} className="shrink-0">
                  {type === 'image' && (
                    <ImageCard file={file} blobUrl={blobUrl} onRemove={remove} onOpen={open} />
                  )}
                  {type === 'video' && (
                    <VideoCard file={file} blobUrl={blobUrl} onRemove={remove} onOpen={open} />
                  )}
                  {type === 'audio' && (
                    <AudioCard file={file} blobUrl={blobUrl} onRemove={remove} onOpen={open} />
                  )}
                  {type === 'pdf' && (
                    <PdfCard file={file} blobUrl={blobUrl} onRemove={remove} onOpen={open} />
                  )}
                  {type === 'text' && (
                    <TextCard file={file} blobUrl={blobUrl} onRemove={remove} onOpen={open} />
                  )}
                  {type === 'file' && (
                    <FileCard
                      name={file.name}
                      mediaType={file.type}
                      removable
                      onRemove={remove}
                    />
                  )}
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
              style={{ width: `${metrics.thumbWidthPct}%`, marginLeft: `${metrics.thumbLeftPct}%` }}
            />
          </div>
        )}
      </div>

      {/* Gallery lightbox — shared across all file types */}
      <FileLightbox
        items={galleryItems}
        index={galleryIndex ?? 0}
        isOpen={galleryIndex !== null}
        onClose={() => setGalleryIndex(null)}
      />
    </>
  )
}
