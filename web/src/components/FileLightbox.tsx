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
 * use it (Sidebar, InputBar, ToastStack…). This component uses only the
 * platform: CSS transitions + the Composite layer via transform/opacity.
 */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type ReactNode, type TouchEvent, type Touch as ReactTouch,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, ExternalLink, File, X } from 'lucide-react'
import { haptic } from '@/lib/haptics'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function touchDistance(a: Touch | ReactTouch, b: Touch | ReactTouch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
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

// ─── Sub-components ───────────────────────────────────────────────────────────

// ── FileLightboxImage ──────────────────────────────────────────────────────────

interface ImageProps {
  item: FileLightboxItem
  imgRef: React.RefObject<HTMLImageElement | null>
  onTouchStart: (e: TouchEvent<HTMLDivElement>) => void
  onTouchMove: (e: TouchEvent<HTMLDivElement>) => void
  onTouchEnd: () => void
  onDoubleClick: () => void
  onClick: () => void
}

export function FileLightboxImage({
  item, imgRef,
  onTouchStart, onTouchMove, onTouchEnd, onDoubleClick, onClick,
}: ImageProps) {
  const [error, setError] = useState(false)

  return (
    <div
      className="flex max-h-[85dvh] max-w-[92vw] touch-none select-none items-center justify-center sm:max-h-[80vh] sm:max-w-[80vw]"
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
            ref={imgRef}
            key={item.src}
            src={item.src}
            alt={item.name}
            draggable={false}
            onError={() => setError(true)}
            // transform is written directly by touch handlers — no inline style prop
            className="max-h-[85dvh] max-w-[92vw] rounded-sm object-contain sm:max-h-[80vh] sm:max-w-[80vw]"
            style={{ willChange: 'transform' }}
            onClick={onClick}
          />
        )}
    </div>
  )
}

// ── FileLightboxVideo ──────────────────────────────────────────────────────────

export function FileLightboxVideo({ item }: { item: FileLightboxItem }) {
  return (
    <div className="flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
      <video
        key={item.src}
        src={item.src}
        controls
        playsInline
        className="max-h-[70dvh] max-w-[92vw] rounded-sm sm:max-w-[80vw]"
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

export function FileLightboxPdf({ item }: { item: FileLightboxItem }) {
  return (
    <div className="flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
      <embed
        key={item.src}
        src={item.src}
        type="application/pdf"
        className="h-[72dvh] w-[min(760px,88vw)] rounded-sm"
      />
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
      className="mx-4 flex max-h-[75dvh] w-[min(720px,90vw)] flex-col overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card) sm:mx-0"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center border-b border-(--color-border-subtle) px-4 py-2">
        <span className="text-xs text-(--color-text-muted)">{extOf(item.name).toUpperCase() || 'TEXT'}</span>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-xs leading-relaxed text-(--color-text-muted)">
        {content === null ? 'Loading…' : content}
      </pre>
    </div>
  )
}

// ── FileLightboxGeneric ────────────────────────────────────────────────────────

export function FileLightboxGeneric({ item: _item }: { item: FileLightboxItem }) {
  return (
    <div
      className="flex flex-col items-center gap-4 rounded-sm border border-(--color-border) bg-(--bg-card) px-10 py-10"
      onClick={(e) => e.stopPropagation()}
    >
      <File size={40} className="text-(--color-text-muted)" />
      <p className="text-xs text-(--color-text-muted)">No preview available</p>
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
  // ── DOM refs for zero-JS-per-frame animations ──────────────────────────────
  /** The fixed overlay div — used for the fade-in CSS transition on open. */
  const overlayRef  = useRef<HTMLDivElement>(null)
  /** The slide container div — x-translated for gallery navigation. */
  const slideRef    = useRef<HTMLDivElement>(null)
  /** The <img> element inside FileLightboxImage — transformed for drag/zoom. */
  const imgRef      = useRef<HTMLImageElement>(null)

  // Direction ref (1 = forward/next, -1 = backward/prev) — read in the slide
  // useLayoutEffect, updated synchronously in goTo before setCurrent.
  const directionRef  = useRef(1)
  // Tracks whether this is the first render of the current open session.
  // The slide animation is skipped on initial mount so opening doesn't
  // trigger an unwanted slide-in.
  const didSlideRef   = useRef(false)
  // Stores the pending rAF id for the slide animation so rapid navigation doesn't queue stale frames.
  const slideRafRef   = useRef<number>(0)

  // ── Image gesture state (all refs — zero renders during drag) ─────────────
  const touchStartXRef  = useRef(0)
  const touchStartYRef  = useRef(0)
  const axisRef         = useRef<'horizontal' | 'vertical' | null>(null)
  const pinchStartRef   = useRef<number | null>(null)
  const pinchScaleRef   = useRef(1)     // current pinch scale accumulator
  const scaleRef        = useRef(1)     // committed scale (after gesture ends)
  const lastTapRef      = useRef(0)
  // Live drag offsets — written by touchmove, read by touchend
  const dragXRef        = useRef(0)
  const dragYRef        = useRef(0)

  // ── Overlay fade-in + slide reset ─────────────────────────────────────────
  // Reset didSlideRef here (in a useLayoutEffect) so it runs BEFORE the
  // slide useLayoutEffect([current]) below — layout effects run in declaration
  // order, so this fires first and marks the next current change as "first".
  useLayoutEffect(() => {
    if (!isOpen) return
    didSlideRef.current = false
    const el = overlayRef.current
    if (!el) return
    el.style.opacity = '0'
    const id = requestAnimationFrame(() => { el.style.opacity = '1' })
    return () => cancelAnimationFrame(id)
  }, [isOpen])

  // ── Gallery slide animation ────────────────────────────────────────────────
  // Skip the very first render (opening the lightbox) — no slide needed.
  // On subsequent current changes: snap to ±100% instantly, then rAF to 0%.
  // Cancel the previous rAF so rapid navigation doesn't queue stale frames.
  useLayoutEffect(() => {
    const el = slideRef.current
    if (!el) return
    if (!didSlideRef.current) {
      // First render of this open session — position at center with no animation.
      didSlideRef.current = true
      el.style.transition = 'none'
      el.style.transform  = 'translateX(0%)'
      return
    }
    cancelAnimationFrame(slideRafRef.current)
    const dir = directionRef.current
    el.style.transition = 'none'
    el.style.transform  = `translateX(${dir * 100}%)`
    slideRafRef.current = requestAnimationFrame(() => {
      el.style.transition = `transform 220ms ${SLIDE_EASE}`
      el.style.transform  = 'translateX(0%)'
    })
    return () => cancelAnimationFrame(slideRafRef.current)
  }, [current])

  // ── Index sync on (re)open ─────────────────────────────────────────────────
  useEffect(() => {
    if (isOpen) {
      setCurrent(Math.max(0, Math.min(index, items.length - 1)))
      if (imgRef.current) imgRef.current.style.transform = ''
      scaleRef.current = 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, index])

  // ── Navigation ────────────────────────────────────────────────────────────
  const goTo = useCallback((next: number) => {
    setCurrent((prev) => {
      const target = ((next % items.length) + items.length) % items.length
      if (target !== prev) {
        const forward = next > prev || (prev === items.length - 1 && next === 0)
        directionRef.current = forward ? 1 : -1
        haptic('select')
      }
      return target
    })
    // Reset image transform immediately on nav.
    if (imgRef.current) imgRef.current.style.transform = ''
    scaleRef.current = 1
  }, [items.length])

  const goPrev = useCallback(() => goTo(current - 1), [current, goTo])
  const goNext = useCallback(() => goTo(current + 1), [current, goTo])

  // ── Keyboard nav + scroll lock ─────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (hasMultiple && e.key === 'ArrowLeft')  { e.preventDefault(); goPrev() }
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

  // ── Close ──────────────────────────────────────────────────────────────────
  const closeLightbox = useCallback(() => {
    if (imgRef.current) imgRef.current.style.transform = ''
    scaleRef.current = 1
    pinchStartRef.current = null
    onClose()
  }, [onClose])

  // ── Image touch handlers (zero React renders during gesture) ───────────────
  // All mutations go straight to imgRef.current.style — no setState.
  // Only goTo / onClose / scale reset touch state at gesture commit.

  const applyImgTransform = useCallback((dx: number, dy: number, sc: number) => {
    if (!imgRef.current) return
    imgRef.current.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${sc})`
  }, [])

  const handleTouchStart = useCallback((e: TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 1) {
      touchStartXRef.current = e.touches[0]?.clientX ?? 0
      touchStartYRef.current = e.touches[0]?.clientY ?? 0
      dragXRef.current = 0
      dragYRef.current = 0
      axisRef.current = null
      pinchStartRef.current = null
    } else if (e.touches.length === 2) {
      pinchStartRef.current = touchDistance(e.touches[0], e.touches[1])
      pinchScaleRef.current = scaleRef.current
    }
  }, [])

  const handleTouchMove = useCallback((e: TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && pinchStartRef.current !== null) {
      const next = touchDistance(e.touches[0], e.touches[1])
      const newScale = Math.min(4, Math.max(1, pinchScaleRef.current * (next / pinchStartRef.current)))
      applyImgTransform(dragXRef.current, dragYRef.current, newScale)
      scaleRef.current = newScale
      return
    }
    if (e.touches.length !== 1 || scaleRef.current > 1.05) return
    const dx = (e.touches[0]?.clientX ?? 0) - touchStartXRef.current
    const dy = (e.touches[0]?.clientY ?? 0) - touchStartYRef.current
    if (axisRef.current === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      axisRef.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
    }
    if (axisRef.current === 'horizontal' && hasMultiple) {
      dragXRef.current = dx
      applyImgTransform(dx, 0, 1)
    } else if (axisRef.current === 'vertical' && dy > 0) {
      const clampedY = Math.min(160, dy)
      dragYRef.current = clampedY
      applyImgTransform(0, clampedY, 1)
    }
  }, [hasMultiple, applyImgTransform])

  const handleTouchEnd = useCallback(() => {
    const dx = dragXRef.current
    const dy = dragYRef.current

    if (axisRef.current === 'horizontal' && hasMultiple) {
      if (dx < -SWIPE_NAV_THRESHOLD) {
        goNext()
      } else if (dx > SWIPE_NAV_THRESHOLD) {
        goPrev()
      } else {
        // Spring back — CSS transition snap to origin.
        if (imgRef.current) {
          imgRef.current.style.transition = `transform 200ms ${SLIDE_EASE}`
          imgRef.current.style.transform  = `translate3d(0,0,0) scale(${scaleRef.current})`
          imgRef.current.addEventListener('transitionend', () => {
            if (imgRef.current) imgRef.current.style.transition = ''
          }, { once: true })
        }
      }
    } else if (axisRef.current === 'vertical' && dy > SWIPE_CLOSE_THRESHOLD && scaleRef.current <= 1.05) {
      closeLightbox()
      return
    } else {
      // Snap back.
      if (imgRef.current) {
        imgRef.current.style.transition = `transform 200ms ${SLIDE_EASE}`
        imgRef.current.style.transform  = `translate3d(0,0,0) scale(${scaleRef.current})`
        imgRef.current.addEventListener('transitionend', () => {
          if (imgRef.current) imgRef.current.style.transition = ''
        }, { once: true })
      }
    }

    dragXRef.current = 0
    dragYRef.current = 0
    axisRef.current = null
    pinchStartRef.current = null
  }, [hasMultiple, goNext, goPrev, closeLightbox])

  const handleDoubleClick = useCallback(() => {
    const next = scaleRef.current > 1 ? 1 : 2
    scaleRef.current = next
    if (imgRef.current) {
      imgRef.current.style.transition = `transform 200ms ${SLIDE_EASE}`
      imgRef.current.style.transform  = `translate3d(0,0,0) scale(${next})`
      imgRef.current.addEventListener('transitionend', () => {
        if (imgRef.current) imgRef.current.style.transition = ''
      }, { once: true })
    }
  }, [])

  const handleImageClick = useCallback(() => {
    const now = Date.now()
    if (now - lastTapRef.current < 300) handleDoubleClick()
    lastTapRef.current = now
  }, [handleDoubleClick])

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!isOpen || !active) return null

  return createPortal(
    <div
      ref={overlayRef}
      className="mobile-safe-overlay fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80"
      // opacity starts at 0, useLayoutEffect rAF sets it to 1 — CSS transition fires
      style={{ opacity: 0, transition: 'opacity 150ms ease-out' }}
      onClick={closeLightbox}
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
    >
      {/* ── Top action bar ──────────────────────────────────────────────────── */}
      <div
        className="absolute right-[max(1rem,env(safe-area-inset-right,0px))] top-[max(1rem,env(safe-area-inset-top,0px))] z-10 flex items-center gap-2 [[data-mobile-shell='ios']_&]:top-[max(4rem,calc(env(safe-area-inset-top)+1rem))]"
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
        className="flex w-full flex-1 items-center justify-center overflow-hidden px-2 sm:px-14"
      >
        <div
          ref={slideRef}
          className="flex w-full items-center justify-center"
          style={{ willChange: 'transform' }}
        >
          {active.type === 'image' && (
            <FileLightboxImage
              item={active}
              imgRef={imgRef}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onDoubleClick={handleDoubleClick}
              onClick={handleImageClick}
            />
          )}
          {active.type === 'video'  && <FileLightboxVideo   item={active} />}
          {active.type === 'audio'  && <FileLightboxAudio   item={active} />}
          {active.type === 'pdf'    && <FileLightboxPdf     item={active} />}
          {active.type === 'text'   && <FileLightboxText    item={active} />}
          {active.type === 'file'   && <FileLightboxGeneric item={active} />}
        </div>
      </div>

      {/* ── Bottom bar: filename + counter + dots ────────────────────────────── */}
      <div
        className="z-10 flex w-full shrink-0 flex-col items-center gap-2 pb-[max(1.25rem,env(safe-area-inset-bottom,1.25rem))] pt-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Filename */}
        {active.name && (
          <p className="max-w-[80vw] break-words text-center text-sm text-(--color-text-muted)">
            {active.name}
          </p>
        )}

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

      {/* ── Mobile swipe hint (single-item, first open only) ─────────────────── */}
      {hasMultiple && (
        <p className="pointer-events-none absolute bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] left-1/2 -translate-x-1/2 text-xs text-(--color-text-muted)/60 sm:hidden">
          Swipe to navigate
        </p>
      )}
    </div>,
    document.body,
  )
}
