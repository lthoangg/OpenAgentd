/**
 * FileLightbox — full-screen gallery supporting all attachment types.
 *
 * Sub-components handle rendering for each file type:
 *   FileLightboxImage   — <img> with pinch-zoom, swipe-to-close, double-tap-zoom
 *   FileLightboxVideo   — <video controls>, native player
 *   FileLightboxAudio   — <audio controls> with filename display
 *   FileLightboxPdf     — <embed type="application/pdf"> with fallback link
 *   FileLightboxText    — scrollable <pre> code/text viewer
 *   FileLightboxGeneric — icon + filename for unsupported types
 *
 * Shell behaviour (all types):
 *   - Escape / tap backdrop → close
 *   - ←/→ arrow keys → prev/next (when gallery has > 1 item)
 *   - Horizontal swipe → prev/next
 *   - Download button saves the active file
 *   - Portal-rendered so ancestor overflow/transform never clips the overlay
 *   - Safe-area aware: respects notch/home-bar on iOS and Android
 *
 * Usage:
 *   <FileLightbox items={items} index={2} isOpen={open} onClose={() => setOpen(false)} />
 */

import {
  useCallback, useEffect, useRef, useState,
  type ReactNode, type TouchEvent, type Touch as ReactTouch,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, ExternalLink, File, X } from 'lucide-react'
import { haptic } from '@/lib/haptics'

// ─── Public types ──────────────────────────────────────────────────────────────

export type FileLightboxItemType = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'file'

export interface FileLightboxItem {
  type: FileLightboxItemType
  /** Blob URL (pending upload) or API URL (persisted file). */
  src: string
  /** Display name used in captions and the download filename. */
  name: string
  /**
   * Pre-read text content for ``type: 'text'`` items.
   * FileLightbox will fetch it lazily from the blob URL if omitted.
   */
  textContent?: string
}

interface FileLightboxProps {
  items: FileLightboxItem[]
  /** Index of the item to open first. Defaults to 0. */
  index?: number
  isOpen: boolean
  onClose: () => void
  /**
   * Override the ARIA labels used for the dialog and buttons.
   * Defaults to generic "file" labels; pass 'image' when all items are images
   * so existing callers (ImageLightbox, tests) keep their exact aria strings.
   */
  labelMode?: 'image' | 'file'
}

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Horizontal drag distance (px) that commits a prev/next navigation. */
const SWIPE_NAV_THRESHOLD = 56

/** Downward drag distance (px) on an image that triggers swipe-to-close. */
const SWIPE_CLOSE_THRESHOLD = 80

// ─── Helpers ───────────────────────────────────────────────────────────────────

function touchDistance(a: Touch | ReactTouch, b: Touch | ReactTouch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

/** Derive a download filename, replicating the behaviour of the old filenameFromSrc. */
function downloadName(item: FileLightboxItem): string {
  const { src, name } = item

  // data: URI — extract MIME extension and sanitize the display name.
  if (src.startsWith('data:')) {
    const match = /^data:([^;,]+)/.exec(src)
    const ext = match?.[1]?.split('/')[1]?.split('+')[0] ?? 'bin'
    const base = name.trim()
      ? name.trim().replace(/[^\w.-]+/g, '_')
      : `${item.type === 'image' ? 'image' : 'file'}-${Date.now()}`
    return `${base}.${ext}`
  }

  // HTTP/blob URL — use the last path segment.
  try {
    const url = new URL(src, window.location.origin)
    const last = url.pathname.split('/').filter(Boolean).pop()
    if (last && last.includes('.')) return last
    // No extension: for images fall back to .png, for others use name or timestamp.
    if (last) {
      if (item.type === 'image') return `${last}.png`
      return name || last
    }
  } catch { /* ignore */ }

  return name || `file-${Date.now()}`
}

async function triggerDownload(item: FileLightboxItem): Promise<void> {
  const filename = downloadName(item)
  try {
    const res = await fetch(item.src)
    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objectUrl)
  } catch {
    // Fallback: direct navigation
    const a = document.createElement('a')
    a.href = item.src
    a.download = filename
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
}

// ─── Shared UI primitives ─────────────────────────────────────────────────────

function IconButton({
  onClick,
  icon,
  label,
  tooltip,
}: {
  onClick: () => void
  icon: ReactNode
  label: string
  tooltip: string
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-(--color-text) transition-colors hover:bg-(--bg-key) focus-visible:ring-2 focus-visible:ring-(--color-text) focus-visible:outline-none"
      >
        {icon}
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute top-full right-0 mt-2 whitespace-nowrap rounded-sm border border-(--color-border) bg-(--bg-key) px-2 py-1 text-xs text-(--color-text) opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {tooltip}
      </span>
    </div>
  )
}

// ─── Sub-components (exported so they can be imported individually) ────────────

// ── FileLightboxImage ──────────────────────────────────────────────────────────

interface ImageProps {
  item: FileLightboxItem
  translateX: number
  translateY: number
  scale: number
  onTouchStart: (e: TouchEvent<HTMLDivElement>) => void
  onTouchMove: (e: TouchEvent<HTMLDivElement>) => void
  onTouchEnd: () => void
  onDoubleClick: () => void
  /** Single-tap handler (for double-tap detection). */
  onClick: () => void
}

export function FileLightboxImage({
  item, translateX, translateY, scale,
  onTouchStart, onTouchMove, onTouchEnd, onDoubleClick, onClick,
}: ImageProps) {
  const [error, setError] = useState(false)

  return (
    <div
      className="flex max-h-[75vh] max-w-[80vw] touch-none select-none flex-col items-center justify-center"
      onClick={(e) => e.stopPropagation()}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onDoubleClick={onDoubleClick}
    >
      {error
        ? (
          <div className="flex h-40 w-64 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-sm text-(--color-text-muted)">
            Failed to load image
          </div>
        )
        : (
          <img
            key={item.src}
            src={item.src}
            alt={item.name}
            draggable={false}
            onError={() => setError(true)}
            className="max-h-[75vh] max-w-[80vw] rounded-sm object-contain shadow-2xl transition-transform duration-150 ease-out"
            style={{ transform: `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})` }}
            onClick={onClick}
          />
        )}
      {item.name && (
        <p className="mt-3 max-w-[80vw] truncate text-center text-sm text-(--color-text-muted)">
          {item.name}
        </p>
      )}
    </div>
  )
}

// ── FileLightboxVideo ──────────────────────────────────────────────────────────

export function FileLightboxVideo({ item }: { item: FileLightboxItem }) {
  return (
    <div
      className="flex flex-col items-center gap-3"
      onClick={(e) => e.stopPropagation()}
    >
      <video
        key={item.src}
        src={item.src}
        controls
        playsInline
        className="max-h-[70vh] max-w-[90vw] rounded-sm shadow-2xl sm:max-w-[80vw]"
      />
      {item.name && (
        <p className="max-w-[80vw] truncate text-center text-sm text-(--color-text-muted)">
          {item.name}
        </p>
      )}
    </div>
  )
}

// ── FileLightboxAudio ──────────────────────────────────────────────────────────

export function FileLightboxAudio({ item }: { item: FileLightboxItem }) {
  return (
    <div
      className="mx-4 flex w-full max-w-sm flex-col items-center gap-4 rounded-sm border border-(--color-border) bg-(--bg-card) px-6 py-8 sm:mx-0"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="w-full truncate text-center text-sm font-medium text-(--color-text)">
        {item.name}
      </p>
      <audio
        key={item.src}
        src={item.src}
        controls
        className="w-full"
      />
    </div>
  )
}

// ── FileLightboxPdf ────────────────────────────────────────────────────────────

export function FileLightboxPdf({ item }: { item: FileLightboxItem }) {
  return (
    <div
      className="flex flex-col items-center gap-3"
      onClick={(e) => e.stopPropagation()}
    >
      {/* embed works in all modern browsers for blob: and http: URLs */}
      <embed
        key={item.src}
        src={item.src}
        type="application/pdf"
        className="h-[72vh] w-[min(760px,88vw)] rounded-sm shadow-2xl"
      />
      {/* Fallback link in case the browser PDF plugin is disabled */}
      <a
        href={item.src}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 text-xs text-(--color-text-muted) hover:text-(--color-text)"
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink size={12} />
        Open in new tab
      </a>
    </div>
  )
}

// ── FileLightboxText ───────────────────────────────────────────────────────────

export function FileLightboxText({ item }: { item: FileLightboxItem }) {
  const [content, setContent] = useState<string | null>(item.textContent ?? null)

  // Lazily fetch text from a blob URL if textContent wasn't pre-supplied.
  useEffect(() => {
    if (content !== null) return
    if (!item.src) return
    let cancelled = false
    fetch(item.src)
      .then((r) => r.text())
      .then((t) => { if (!cancelled) setContent(t) })
      .catch(() => { if (!cancelled) setContent('(failed to load)') })
    return () => { cancelled = true }
  }, [item.src, content])

  return (
    <div
      className="mx-4 flex max-h-[75vh] w-[min(720px,90vw)] flex-col overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card) shadow-2xl sm:mx-0"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header bar */}
      <div className="flex shrink-0 items-center border-b border-(--color-border-subtle) px-4 py-2">
        <span className="truncate font-mono text-sm font-medium text-(--color-text)">
          {item.name}
        </span>
      </div>
      {/* Scrollable content */}
      <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-(--color-text-muted)">
        {content === null ? 'Loading…' : content}
      </pre>
    </div>
  )
}

// ── FileLightboxGeneric ────────────────────────────────────────────────────────

export function FileLightboxGeneric({ item }: { item: FileLightboxItem }) {
  return (
    <div
      className="flex flex-col items-center gap-4 rounded-sm border border-(--color-border) bg-(--bg-card) px-10 py-10"
      onClick={(e) => e.stopPropagation()}
    >
      <File size={40} className="text-(--color-text-muted)" />
      <p className="max-w-[60vw] truncate font-mono text-sm text-(--color-text)">
        {item.name}
      </p>
      <p className="text-xs text-(--color-text-muted)">No preview available</p>
    </div>
  )
}

// ─── FileLightbox (shell) ──────────────────────────────────────────────────────

export function FileLightbox({ items, index = 0, isOpen, onClose, labelMode = 'file' }: FileLightboxProps) {
  const isImageMode = labelMode === 'image'
  const dialogLabel     = isImageMode ? 'Image lightbox' : `File preview: ${items[Math.max(0, Math.min(index, items.length - 1))]?.name ?? ''}`
  const downloadLabel   = isImageMode ? 'Download image' : 'Download file'
  const closeLabel      = isImageMode ? 'Close lightbox' : 'Close preview'
  const prevLabel       = isImageMode ? 'Previous image' : 'Previous file'
  const nextLabel       = isImageMode ? 'Next image'     : 'Next file'
  const [current, setCurrent] = useState(() => Math.max(0, Math.min(index, items.length - 1)))

  // Image-specific gesture state
  const [scale, setScale] = useState(1)
  const [translateX, setTranslateX] = useState(0)
  const [translateY, setTranslateY] = useState(0)

  const touchStartXRef = useRef(0)
  const touchStartYRef = useRef(0)
  const axisRef = useRef<'horizontal' | 'vertical' | null>(null)
  const pinchStartRef = useRef<number | null>(null)
  const lastTapRef = useRef(0)

  const hasMultiple = items.length > 1
  const active = items[current] ?? items[0]
  const isImage = active?.type === 'image'

  // Sync index when the lightbox (re)opens or the starting index changes.
  useEffect(() => {
    if (isOpen) {
      setCurrent(Math.max(0, Math.min(index, items.length - 1)))
      setScale(1)
      setTranslateX(0)
      setTranslateY(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, index])

  const goTo = useCallback((next: number) => {
    setCurrent((prev) => {
      const target = ((next % items.length) + items.length) % items.length
      if (target !== prev) haptic('select')
      return target
    })
    setScale(1)
    setTranslateX(0)
    setTranslateY(0)
  }, [items.length])

  const goPrev = useCallback(() => goTo(current - 1), [current, goTo])
  const goNext = useCallback(() => goTo(current + 1), [current, goTo])

  // Keyboard navigation + body-scroll lock.
  useEffect(() => {
    if (!isOpen) return
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (hasMultiple && e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
      else if (hasMultiple && e.key === 'ArrowRight') { e.preventDefault(); goNext() }
    }
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handle)
    return () => {
      document.removeEventListener('keydown', handle)
      document.body.style.overflow = prev
    }
  }, [isOpen, onClose, hasMultiple, goPrev, goNext])

  const closeLightbox = useCallback(() => {
    setScale(1)
    setTranslateX(0)
    setTranslateY(0)
    pinchStartRef.current = null
    onClose()
  }, [onClose])

  // Touch handlers — only applied to the image viewer to avoid disrupting
  // native scroll/controls in video / audio / text viewers.
  const handleTouchStart = useCallback((e: TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 1) {
      touchStartXRef.current = e.touches[0]?.clientX ?? 0
      touchStartYRef.current = e.touches[0]?.clientY ?? 0
      axisRef.current = null
      pinchStartRef.current = null
    } else if (e.touches.length === 2) {
      pinchStartRef.current = touchDistance(e.touches[0], e.touches[1])
    }
  }, [])

  const handleTouchMove = useCallback((e: TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && pinchStartRef.current !== null) {
      const next = touchDistance(e.touches[0], e.touches[1])
      setScale(Math.min(4, Math.max(1, next / pinchStartRef.current)))
      return
    }
    if (e.touches.length !== 1 || scale > 1.05) return
    const dx = (e.touches[0]?.clientX ?? 0) - touchStartXRef.current
    const dy = (e.touches[0]?.clientY ?? 0) - touchStartYRef.current
    if (axisRef.current === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      axisRef.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
    }
    if (axisRef.current === 'horizontal' && hasMultiple) setTranslateX(dx)
    else if (axisRef.current === 'vertical' && dy > 0) setTranslateY(Math.min(160, dy))
  }, [scale, hasMultiple])

  const handleTouchEnd = useCallback(() => {
    if (axisRef.current === 'horizontal' && hasMultiple) {
      if (translateX < -SWIPE_NAV_THRESHOLD) goNext()
      else if (translateX > SWIPE_NAV_THRESHOLD) goPrev()
      else setTranslateX(0)
    } else if (translateY > SWIPE_CLOSE_THRESHOLD && scale <= 1.05) {
      closeLightbox()
      return
    }
    setTranslateX(0)
    setTranslateY(0)
    axisRef.current = null
    pinchStartRef.current = null
  }, [translateX, translateY, scale, hasMultiple, goNext, goPrev, closeLightbox])

  const handleDoubleClick = useCallback(() => {
    setScale((s) => (s > 1 ? 1 : 2))
  }, [])

  const handleImageClick = useCallback(() => {
    const now = Date.now()
    if (now - lastTapRef.current < 300) handleDoubleClick()
    lastTapRef.current = now
  }, [handleDoubleClick])

  if (!isOpen || !active) return null

  return createPortal(
    <div
      className="mobile-safe-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={closeLightbox}
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
    >
      {/* ── Top-right action bar ───────────────────────────────────────────── */}
      <div
        className="absolute right-[max(1rem,env(safe-area-inset-right,0px))] top-[max(1rem,env(safe-area-inset-top,0px))] z-10 flex items-center gap-2 [[data-mobile-shell='ios']_&]:top-[max(4rem,calc(env(safe-area-inset-top)+1rem))]"
        onClick={(e) => e.stopPropagation()}
      >
        <IconButton
          onClick={() => void triggerDownload(active)}
          icon={<Download size={20} />}
          label={downloadLabel}
          tooltip="Download"
        />
        <IconButton
          onClick={closeLightbox}
          icon={<X size={20} />}
          label={closeLabel}
          tooltip="Close (Esc)"
        />
      </div>

      {/* ── Prev / next chevrons (hidden on xs; swipe is the mobile affordance) */}
      {hasMultiple && (
        <>
          <button
            type="button"
            aria-label={prevLabel}
            onClick={(e) => { e.stopPropagation(); goPrev() }}
            className="absolute left-[max(0.5rem,env(safe-area-inset-left,0px))] top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-(--color-border) bg-(--bg-card)/80 text-(--color-text) backdrop-blur transition-colors hover:bg-(--bg-key) sm:flex"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            aria-label={nextLabel}
            onClick={(e) => { e.stopPropagation(); goNext() }}
            className="absolute right-[max(0.5rem,env(safe-area-inset-right,0px))] top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-(--color-border) bg-(--bg-card)/80 text-(--color-text) backdrop-blur transition-colors hover:bg-(--bg-key) sm:flex"
          >
            <ChevronRight size={22} />
          </button>

          {/* Counter pill */}
          <div
            className="absolute bottom-[max(1rem,env(safe-area-inset-bottom,0px))] left-1/2 z-10 -translate-x-1/2 rounded-full border border-(--color-border) bg-(--bg-card)/80 px-3 py-1 font-mono text-xs text-(--color-text-muted) backdrop-blur"
            aria-live="polite"
          >
            {current + 1} / {items.length}
          </div>

          {/* Dot strip for ≤10 items */}
          {items.length <= 10 && (
            <div
              className="absolute bottom-[max(3rem,calc(env(safe-area-inset-bottom)+2.5rem))] left-1/2 z-10 flex -translate-x-1/2 gap-1.5"
              aria-hidden="true"
            >
              {items.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); goTo(i) }}
                  className={`h-1.5 rounded-full transition-all duration-200 ${
                    i === current
                      ? 'w-4 bg-(--color-text)'
                      : 'w-1.5 bg-(--color-text-muted)/50 hover:bg-(--color-text-muted)'
                  }`}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Per-type viewer ────────────────────────────────────────────────── */}
      {active.type === 'image' && (
        <FileLightboxImage
          item={active}
          translateX={isImage ? translateX : 0}
          translateY={isImage ? translateY : 0}
          scale={isImage ? scale : 1}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onDoubleClick={handleDoubleClick}
          onClick={handleImageClick}
        />
      )}
      {active.type === 'video' && <FileLightboxVideo item={active} />}
      {active.type === 'audio' && <FileLightboxAudio item={active} />}
      {active.type === 'pdf'   && <FileLightboxPdf   item={active} />}
      {active.type === 'text'  && <FileLightboxText  item={active} />}
      {active.type === 'file'  && <FileLightboxGeneric item={active} />}
    </div>,
    document.body,
  )
}
