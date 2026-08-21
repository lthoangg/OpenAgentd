/**
 * FileLightbox — full-screen gallery supporting all attachment types.
 *
 * Animation strategy — zero JS per animation frame:
 *   - Overlay fade-in: CSS opacity transition, triggered by a single DOM write
 *     in a requestAnimationFrame after mount. No React state flush involved.
 *   - Gallery slide: CSS transform transition. On nav, the slide container is
 *     snapped instantly to ±100% (transition: none), then a rAF re-enables
 *     the transition and sets translateX to 0%. The compositor handles every
 *     frame; React only re-renders once (to swap the content).
 *   - Image drag (pan/pinch/swipe-to-close): all touch handlers write
 *     imgRef.current.style.transform directly. No state, no re-renders during
 *     the gesture. React state is updated only when a gesture commits
 *     (goTo / onClose) or when scale needs to reset between items.
 *
 * No framer-motion used here — it is kept only for the components that already
 * use it (Sidebar, InputComposer, ToastStack…). This component uses only the
 * platform: CSS transitions + the Composite layer via transform/opacity.
 */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type ReactNode,
} from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, ExternalLink, File, X } from 'lucide-react'
import { haptic } from '@/lib/haptics'
import { usePanZoom } from '@/hooks/use-pan-zoom'
import { resolveApiUrl } from '@/api/client'
import { tauriDownload } from '@/lib/tauri-download'
import { PdfDocumentViewer } from './PdfDocumentViewer'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

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

// ─── Constants ────────────────────────────────────────────────────────────────

/** Horizontal drag (px) that commits a prev/next navigation. */
const SWIPE_NAV_THRESHOLD = 56

/** Downward drag (px) on an image that triggers swipe-to-close. */
const SWIPE_CLOSE_THRESHOLD = 80

/** CSS easing for the gallery slide. */
const SLIDE_EASE = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)'

// ─── Download helper ──────────────────────────────────────────────────────────

function downloadName(item: FileLightboxItem): string {
  const { src, name } = item
  if (src.startsWith('data:')) {
    const match = /^data:([^;,]+)/.exec(src)
    const ext = match?.[1]?.split('/')[1]?.split('+')[0] ?? 'bin'
    const base = name.trim()
      ? name.trim().replace(/[^\w.-]+/g, '_')
      : `${item.type === 'image' ? 'image' : 'file'}-${Date.now()}`
    return `${base}.${ext}`
  }
  try {
    const url = new URL(src, window.location.origin)
    const last = url.pathname.split('/').filter(Boolean).pop()
    if (last && last.includes('.')) return last
    if (last) return item.type === 'image' ? `${last}.png` : name || last
  } catch { /* ignore */ }
  return name || `file-${Date.now()}`
}

async function triggerDownload(item: FileLightboxItem): Promise<void> {
  const url = resolveApiUrl(item.src) || item.src
  await tauriDownload(url, downloadName(item))
}

// ─── Shared UI primitives ─────────────────────────────────────────────────────

function IconButton({
  onClick, icon, label, tooltip,
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
        className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-(--color-text) transition-colors hover:bg-(--bg-key) focus-visible:ring-2 focus-visible:ring-(--color-text) focus-visible:outline-none"
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

// ─── Sub-components ───────────────────────────────────────────────────────────

// ── FileLightboxImage ──────────────────────────────────────────────────────────

interface ImageProps {
  item: FileLightboxItem
  imgRef: React.RefObject<HTMLImageElement | null>
  panZoom: ReturnType<typeof usePanZoom<HTMLImageElement>>
}

export function FileLightboxImage({ item, imgRef, panZoom }: ImageProps) {
  const [error, setError] = useState(false)

  return (
    <div
      className="flex h-full w-full max-h-full max-w-full select-none items-center justify-center"
      {...panZoom.bind}
    >
      {error
        ? (
          <div
            className="flex h-40 w-64 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-sm text-(--color-text-muted)"
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
          >
            Failed to load image
          </div>
        )
        : (
          <img
            ref={imgRef}
            key={item.src}
            src={item.src}
            alt={item.name}
            draggable={false}
            onError={() => setError(true)}
            className="block h-auto w-auto max-h-full max-w-full rounded-sm object-contain cursor-zoom-in transition-[cursor] duration-100"
            style={{ willChange: 'transform' }}
            onClick={(e) => e.stopPropagation()}
          />
        )}
    </div>
  )
}

// ── FileLightboxVideo ──────────────────────────────────────────────────────────

export function FileLightboxVideo({ item }: { item: FileLightboxItem }) {
  return (
    <div
      className="flex flex-col items-center justify-center max-h-full max-w-full"
      onClick={(e) => e.stopPropagation()}
    >
      <video
        key={item.src}
        src={item.src}
        controls
        playsInline
        className="max-h-full max-w-full rounded-sm"
      />
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
      <audio key={item.src} src={item.src} controls className="w-full" />
    </div>
  )
}

// ── FileLightboxPdf ────────────────────────────────────────────────────────────

/**
 * Renders the full, multi-page document (via `PdfDocumentViewer`) rather
 * than a single static first-page image — the lightbox is the "main
 * viewing" surface, so it should feel like a real PDF reader.
 *
 * This is deliberately simple:
 *   - No `<embed>` — iOS/Android have no PDF plugin for it to delegate to,
 *     so it renders blank there regardless of CSP.
 *   - Scrolling between pages is 100% native (`overflow-y-auto`) inside
 *     `PdfDocumentViewer` — no custom touch/gesture code here or there.
 *     The outer gallery's swipe-to-navigate/swipe-to-close handling is
 *     skipped entirely while a PDF is active (see `activeTypeRef` below),
 *     so native scrolling never fights the gallery gestures. (An earlier
 *     version gave this component its own touch listeners on top of the
 *     gallery's, which fought each other and made small swipes close the
 *     lightbox unintentionally.)
 *   - "Open in new tab" still hands off to the OS/browser's own PDF viewer
 *     for search/print/share.
 */
export function FileLightboxPdf({ item }: { item: FileLightboxItem }) {
  return (
    <div
      className="flex h-[80dvh] max-h-full w-[min(760px,90vw)] max-w-full flex-col items-center gap-3"
      onClick={(e) => e.stopPropagation()}
    >
      <PdfDocumentViewer
        key={item.src}
        src={item.src}
        className="min-h-0 w-full flex-1"
      />
      <a
        href={item.src}
        target="_blank"
        rel="noopener noreferrer"
        className="flex shrink-0 items-center gap-1.5 text-xs text-(--color-text-muted) hover:text-(--color-text)"
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
  const containerRef = useRef<HTMLDivElement>(null)
  const touchStartRef = useRef({ x: 0, y: 0 })
  const gestureLockRef = useRef<'horizontal' | 'vertical' | null>(null)

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

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const handleStart = (e: globalThis.TouchEvent) => {
      touchStartRef.current = {
        x: e.touches[0]?.clientX ?? 0,
        y: e.touches[0]?.clientY ?? 0,
      }
      gestureLockRef.current = null
    }

    const handleMove = (e: globalThis.TouchEvent) => {
      const dx = (e.touches[0]?.clientX ?? 0) - touchStartRef.current.x
      const dy = (e.touches[0]?.clientY ?? 0) - touchStartRef.current.y

      if (gestureLockRef.current === null) {
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          gestureLockRef.current = Math.abs(dy) > Math.abs(dx) ? 'vertical' : 'horizontal'
        }
      }

      if (gestureLockRef.current === 'vertical') {
        e.stopPropagation()
      } else if (gestureLockRef.current === 'horizontal') {
        if (e.cancelable) {
          e.preventDefault()
        }
      }
    }

    el.addEventListener('touchstart', handleStart, { passive: true })
    el.addEventListener('touchmove', handleMove, { passive: false })

    return () => {
      el.removeEventListener('touchstart', handleStart)
      el.removeEventListener('touchmove', handleMove)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="mx-4 flex h-[60dvh] max-h-full w-[min(720px,90vw)] flex-col overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card) sm:mx-0"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center border-b border-(--color-border-subtle) px-4 py-2">
        <span className="text-xs text-(--color-text-muted)">{extOf(item.name).toUpperCase() || 'TEXT'}</span>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto overscroll-contain touch-pan-y whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-(--color-text-muted)">
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
      <p className="max-w-[240px] truncate text-sm font-medium text-(--color-text)">{item.name}</p>
      <p className="text-xs text-(--color-text-muted)">No preview available</p>
      <a
        href={item.src}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 text-xs text-(--color-text-muted) hover:text-(--color-text)"
      >
        <ExternalLink size={12} />
        Open in new tab
      </a>
    </div>
  )
}

// ─── FileLightbox (shell) ──────────────────────────────────────────────────────

export function FileLightbox({ items, index = 0, isOpen, onClose, labelMode = 'file' }: FileLightboxProps) {
  const isImageMode   = labelMode === 'image'
  const dialogLabel   = isImageMode ? 'Image lightbox' : `File preview: ${items[Math.max(0, Math.min(index, items.length - 1))]?.name ?? ''}`
  const downloadLabel = isImageMode ? 'Download image' : 'Download file'
  const closeLabel    = isImageMode ? 'Close lightbox' : 'Close preview'
  const prevLabel     = isImageMode ? 'Previous image' : 'Previous file'
  const nextLabel     = isImageMode ? 'Next image'     : 'Next file'

  const [current, setCurrent] = useState(() => Math.max(0, Math.min(index, items.length - 1)))

  const hasMultiple = items.length > 1
  const active      = items[current] ?? items[0]
  const activeTypeRef = useRef(active.type)
  useEffect(() => {
    activeTypeRef.current = active.type
  }, [active.type])
  // ── DOM refs for zero-JS-per-frame animations ──────────────────────────────
  /** The fixed overlay div — used for the fade-in CSS transition on open. */
  const overlayRef  = useRef<HTMLDivElement>(null)
  /** The slide container div — x-translated for gallery navigation. */
  const slideRef    = useRef<HTMLDivElement>(null)
  /** The <img> element inside FileLightboxImage — transformed for drag/zoom. */
  const imgRef      = useRef<HTMLImageElement>(null)

  // ── Gallery gesture state (image pan/zoom is owned by usePanZoom) ───────
  const touchStartXRef = useRef(0)
  const touchStartYRef = useRef(0)
  const axisRef = useRef<'horizontal' | 'vertical' | null>(null)
  const dragXRef = useRef(0)
  const dragYRef = useRef(0)

  const panZoom = usePanZoom(imgRef)
  const { zoomPercent, zoomIn, zoomOut, reset: resetZoom } = panZoom
  const applySlideTransform = useCallback((dx: number, dy: number) => {
    if (slideRef.current) slideRef.current.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
  }, [])

  // ── Overlay fade-in ─────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (!isOpen) return
    const el = overlayRef.current
    if (!el) return
    el.style.opacity = '0'
    const id = requestAnimationFrame(() => { el.style.opacity = '1' })
    return () => cancelAnimationFrame(id)
  }, [isOpen])

  // ── Index sync on (re)open ─────────────────────────────────────────────────
  useEffect(() => {
    if (isOpen) {
      setCurrent(Math.max(0, Math.min(index, items.length - 1)))
      resetZoom()
    }
  }, [isOpen, index, resetZoom, items.length])

  // ── Navigation ────────────────────────────────────────────────────────────
  const goTo = useCallback((next: number) => {
    setCurrent((prev) => {
      const target = ((next % items.length) + items.length) % items.length
      if (target !== prev) {
        haptic('select')
      }
      return target
    })
    // Reset image transform immediately on nav.
    resetZoom()
    dragXRef.current = 0
    dragYRef.current = 0
    axisRef.current = null
  }, [items.length, resetZoom])

  const goPrev = useCallback(() => goTo(current - 1), [current, goTo])
  const goNext = useCallback(() => goTo(current + 1), [current, goTo])

  // ── Scroll lock + Keyboard nav ──────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [isOpen])

  useHotkey('Escape', onClose, { enabled: isOpen })
  useHotkey('ArrowLeft', goPrev, { enabled: Boolean(isOpen && hasMultiple), preventDefault: true })
  useHotkey('ArrowRight', goNext, { enabled: Boolean(isOpen && hasMultiple), preventDefault: true })
  useHotkey({ key: '+' }, zoomIn, { enabled: Boolean(isOpen && active.type === 'image'), preventDefault: true })
  useHotkey('=', zoomIn, { enabled: Boolean(isOpen && active.type === 'image'), preventDefault: true })
  useHotkey('-', zoomOut, { enabled: Boolean(isOpen && active.type === 'image'), preventDefault: true })
  useHotkey('0', resetZoom, { enabled: Boolean(isOpen && active.type === 'image'), preventDefault: true })

  // ── Close ──────────────────────────────────────────────────────────────────
  const closeLightbox = useCallback(() => {
    resetZoom()
    dragXRef.current = 0
    dragYRef.current = 0
    axisRef.current = null
    onClose()
  }, [onClose, resetZoom])

  // ── Gallery touch handlers at fit ───────────────────────────────────────
  // Once zoomed, usePanZoom owns the gesture. At fit, retain the existing
  // horizontal navigation and downward-close behaviour for image galleries.
  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (activeTypeRef.current === 'pdf' || e.touches.length !== 1 || zoomPercent !== 100) return
    const touch = e.touches[0]
    if (!touch) return
    touchStartXRef.current = touch.clientX
    touchStartYRef.current = touch.clientY
    dragXRef.current = 0
    dragYRef.current = 0
    axisRef.current = null
  }, [zoomPercent])

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (activeTypeRef.current === 'pdf' || e.touches.length !== 1 || zoomPercent !== 100) return
    const touch = e.touches[0]
    if (!touch) return
    const dx = touch.clientX - touchStartXRef.current
    const dy = touch.clientY - touchStartYRef.current
    if (axisRef.current === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      axisRef.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
    }
    if (axisRef.current === 'horizontal' && hasMultiple) {
      dragXRef.current = dx
      applySlideTransform(dx, 0)
    } else if (axisRef.current === 'vertical' && dy > 0) {
      dragYRef.current = Math.min(160, dy)
      applySlideTransform(0, dragYRef.current)
    }
  }, [hasMultiple, zoomPercent, applySlideTransform])

  const handleTouchEnd = useCallback(() => {
    if (activeTypeRef.current === 'pdf' || zoomPercent !== 100) return
    if (axisRef.current === 'horizontal' && hasMultiple) {
      if (dragXRef.current < -SWIPE_NAV_THRESHOLD) goNext()
      else if (dragXRef.current > SWIPE_NAV_THRESHOLD) goPrev()
    } else if (axisRef.current === 'vertical' && dragYRef.current > SWIPE_CLOSE_THRESHOLD) {
      closeLightbox()
      return
    }
    if (slideRef.current) {
      slideRef.current.style.transition = `transform 200ms ${SLIDE_EASE}`
      slideRef.current.style.transform = 'translate3d(0,0,0)'
      slideRef.current.addEventListener('transitionend', () => {
        if (slideRef.current) slideRef.current.style.transition = ''
      }, { once: true })
    }
    dragXRef.current = 0
    dragYRef.current = 0
    axisRef.current = null
  }, [closeLightbox, goNext, goPrev, hasMultiple, zoomPercent])

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!isOpen || !active) return null

  return createPortal(
    <div
      ref={overlayRef}
      className="mobile-safe-overlay fixed inset-0 z-50 flex select-none flex-col bg-black/80"
      // opacity starts at 0, useLayoutEffect rAF sets it to 1 — CSS transition fires
      style={{ opacity: 0, transition: 'opacity 150ms ease-out' }}
      onClick={closeLightbox}
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
      // The lightbox is portalled to <body> and owns its own touch
      // handling (pan/swipe-to-navigate, swipe-down-to-close). It doesn't
      // stop propagation on those touches, so without this the outer
      // useEdgeSwipe controller in TeamChatView also sees them — either
      // opening a drawer from an edge-zone touch mid-viewing, or closing
      // a drawer that's still open behind the lightbox.
      data-swipe-ignore
    >
      {/* ── Top action bar ──────────────────────────────────────────────────── */}
      <div
        className="z-10 flex w-full shrink-0 justify-end gap-2 px-[max(1rem,env(safe-area-inset-right,0px))] pt-[max(1rem,env(safe-area-inset-top,0px))] pb-2 [[data-mobile-shell='ios']_&]:pt-[max(4rem,calc(env(safe-area-inset-top)+1rem))]"
        onClick={(e) => e.stopPropagation()}
      >
        <IconButton
          onClick={() => void triggerDownload(active)}
          icon={<Download size={18} />}
          label={downloadLabel}
          tooltip="Download"
        />
        <IconButton
          onClick={closeLightbox}
          icon={<X size={18} />}
          label={closeLabel}
          tooltip="Close (Esc)"
        />
      </div>

      {/* ── Prev / next chevrons ── desktop only; mobile uses swipe ─────────── */}
      {hasMultiple && (
        <>
          <button
            type="button"
            aria-label={prevLabel}
            onClick={(e) => { e.stopPropagation(); goPrev() }}
            className="absolute left-[max(0.75rem,env(safe-area-inset-left,0px))] top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-(--color-border) bg-(--bg-card)/80 text-(--color-text) backdrop-blur transition-colors hover:bg-(--bg-key) sm:flex"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            aria-label={nextLabel}
            onClick={(e) => { e.stopPropagation(); goNext() }}
            className="absolute right-[max(0.75rem,env(safe-area-inset-right,0px))] top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-(--color-border) bg-(--bg-card)/80 text-(--color-text) backdrop-blur transition-colors hover:bg-(--bg-key) sm:flex"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}

      {/* ── Viewer + caption ─────────────────────────────────────────────────── */}
      {/*
        overflow-hidden clips the slide during nav.
        slideRef is what gets translateX-animated — a single persistent div
        that re-keys its content when `current` changes.
      */}
      <div
        className="flex w-full flex-1 touch-none items-center justify-center overflow-hidden px-2 sm:px-14 min-h-0"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div
          ref={slideRef}
          className="flex h-full w-full flex-col items-center justify-center gap-4 min-h-0"
          style={{ willChange: 'transform' }}
        >
          {/* Active Preview Area */}
          <div className="flex-1 min-h-0 w-full flex items-center justify-center">
            {active.type === 'image' && (
              <FileLightboxImage
                key={active.src}
                item={active}
                imgRef={imgRef}
                panZoom={panZoom}
              />
            )}
            {active.type === 'video'  && <FileLightboxVideo   key={active.src} item={active} />}
            {active.type === 'audio'  && <FileLightboxAudio   key={active.src} item={active} />}
            {active.type === 'pdf'    && <FileLightboxPdf     key={active.src} item={active} />}
            {active.type === 'text'   && <FileLightboxText    key={active.src} item={active} />}
            {active.type === 'file'   && <FileLightboxGeneric key={active.src} item={active} />}
          </div>

          {/* Filename right below the active preview card */}
          {active.name && (
            <p
              className="max-w-[80vw] shrink-0 break-words text-center text-sm text-(--color-text-muted)"
              onClick={(e) => e.stopPropagation()}
            >
              {active.name}
            </p>
          )}
        </div>
      </div>

      {/* ── Bottom bar: counter + dots + mobile swipe hint ──────────────────── */}
      <div
        className="z-10 flex w-full shrink-0 flex-col items-center gap-2 pb-[max(1.25rem,env(safe-area-inset-bottom,1.25rem))] pt-3"
        onClick={(e) => e.stopPropagation()}
      >
        {hasMultiple && (
          <div className="flex flex-col items-center gap-2">
            {/* Counter pill */}
            <div
              className="rounded-full border border-(--color-border) bg-(--bg-card)/80 px-3 py-0.5 font-mono text-xs text-(--color-text-muted) backdrop-blur"
              aria-live="polite"
            >
              {current + 1} / {items.length}
            </div>

            {/* Dot strip ≤ 10 items */}
            {items.length <= 10 && (
              <div className="flex gap-1.5" aria-hidden="true">
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
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
