/**
 * Full-screen image lightbox.
 *
 * Shared by ``ImageAttachment`` (user-uploaded thumbnails) and ``MarkdownBlock``
 * (assistant-rendered inline images) so both get identical UX: click to open,
 * click the backdrop or press Esc to close, portal-rendered so ancestor
 * ``overflow``/``transform`` never clips the overlay.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent, type Touch as ReactTouch } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react'
import { haptic } from '@/lib/haptics'

interface GalleryImage {
  src: string
  alt?: string
}

interface ImageLightboxProps {
  src: string
  alt: string
  isOpen: boolean
  onClose: () => void
  /**
   * Optional gallery. When provided (length > 1), the lightbox shows
   * prev/next chevrons, supports ←/→ keys, and horizontal swipe between
   * images. ``index`` selects the initial image; falls back to matching
   * ``src``. Single-image callers omit this entirely.
   */
  images?: GalleryImage[]
  index?: number
}

/** px of horizontal travel that commits a prev/next navigation. */
const NAV_SWIPE_THRESHOLD = 64

/**
 * Derive a sensible filename from the image source.
 *
 * Handles absolute/relative URLs and ``data:`` URIs. Falls back to a
 * timestamped default when nothing useful can be extracted.
 */
function filenameFromSrc(src: string, alt: string): string {
  // data: URI — pull mime subtype for extension.
  if (src.startsWith('data:')) {
    const match = /^data:([^;,]+)/.exec(src)
    const ext = match?.[1]?.split('/')[1]?.split('+')[0] ?? 'png'
    const base = alt?.trim() ? alt.trim().replace(/[^\w.-]+/g, '_') : `image-${Date.now()}`
    return `${base}.${ext}`
  }
  try {
    const url = new URL(src, window.location.origin)
    const last = url.pathname.split('/').filter(Boolean).pop()
    if (last && last.includes('.')) return last
    if (last) return `${last}.png`
  } catch {
    // fall through
  }
  return `image-${Date.now()}.png`
}

/**
 * Icon button with a CSS-only tooltip.
 *
 * Uses a ``group`` wrapper so the tooltip fades in on hover/focus without
 * needing a ``TooltipProvider`` (not wired up globally in the app yet).
 */
function LightboxIconButton({
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
        onClick={onClick}
        className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-(--color-text) transition-colors hover:bg-(--bg-key) focus-visible:ring-2 focus-visible:ring-(--color-text) focus-visible:outline-none"
        aria-label={label}
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

function distance(a: Touch | ReactTouch, b: Touch | ReactTouch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

export function ImageLightbox({ src, alt, isOpen, onClose, images, index }: ImageLightboxProps) {
  // Gallery state. When ``images`` is omitted we treat the single
  // ``src``/``alt`` as a one-item gallery so the rest of the component has
  // a uniform shape.
  const gallery: GalleryImage[] = images && images.length > 0 ? images : [{ src, alt }]
  const initialIndex = (() => {
    if (typeof index === 'number' && index >= 0 && index < gallery.length) return index
    const bySrc = gallery.findIndex((img) => img.src === src)
    return bySrc >= 0 ? bySrc : 0
  })()

  const [current, setCurrent] = useState(initialIndex)
  const [scale, setScale] = useState(1)
  const [translateY, setTranslateY] = useState(0)
  const [translateX, setTranslateX] = useState(0)
  const touchStartXRef = useRef(0)
  const touchStartYRef = useRef(0)
  const axisRef = useRef<'horizontal' | 'vertical' | null>(null)
  const pinchStartDistanceRef = useRef<number | null>(null)
  const lastTapRef = useRef(0)

  const hasGallery = gallery.length > 1
  const active = gallery[current] ?? gallery[0]
  const activeSrc = active.src
  const activeAlt = active.alt ?? ''

  // Reset to the requested image whenever the lightbox (re)opens.
  useEffect(() => {
    if (isOpen) {
      setCurrent(initialIndex)
      setScale(1)
      setTranslateX(0)
      setTranslateY(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const goTo = useCallback((next: number) => {
    setCurrent((prev) => {
      const target = (next + gallery.length) % gallery.length
      if (target !== prev) haptic('select')
      return target
    })
    setScale(1)
    setTranslateX(0)
    setTranslateY(0)
  }, [gallery.length])

  const goPrev = useCallback(() => goTo(current - 1), [current, goTo])
  const goNext = useCallback(() => goTo(current + 1), [current, goTo])

  // Escape key handler + arrow-key gallery nav + body-scroll lock.
  useEffect(() => {
    if (!isOpen) return

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (hasGallery && e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
      else if (hasGallery && e.key === 'ArrowRight') { e.preventDefault(); goNext() }
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKey)

    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = previousOverflow
    }
  }, [isOpen, onClose, hasGallery, goPrev, goNext])

  const closeLightbox = () => {
    setScale(1)
    setTranslateY(0)
    setTranslateX(0)
    pinchStartDistanceRef.current = null
    onClose()
  }

  const handleTouchStart = (event: TouchEvent) => {
    if (event.touches.length === 1) {
      touchStartXRef.current = event.touches[0]?.clientX ?? 0
      touchStartYRef.current = event.touches[0]?.clientY ?? 0
      axisRef.current = null
      pinchStartDistanceRef.current = null
      return
    }
    if (event.touches.length >= 2) {
      pinchStartDistanceRef.current = distance(event.touches[0], event.touches[1])
    }
  }

  const handleTouchMove = (event: TouchEvent) => {
    if (event.touches.length >= 2 && pinchStartDistanceRef.current) {
      const nextDistance = distance(event.touches[0], event.touches[1])
      const ratio = nextDistance / pinchStartDistanceRef.current
      setScale(Math.min(4, Math.max(1, ratio)))
      return
    }
    if (event.touches.length === 1 && scale <= 1.05) {
      const deltaX = (event.touches[0]?.clientX ?? 0) - touchStartXRef.current
      const deltaY = (event.touches[0]?.clientY ?? 0) - touchStartYRef.current

      // Lock axis on first significant move: horizontal → gallery nav,
      // vertical (downward) → swipe-to-close.
      if (axisRef.current === null && (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8)) {
        axisRef.current = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical'
      }

      if (axisRef.current === 'horizontal' && hasGallery) {
        setTranslateX(deltaX)
      } else if (axisRef.current === 'vertical' && deltaY > 0) {
        setTranslateY(Math.min(160, deltaY))
      }
    }
  }

  const handleTouchEnd = () => {
    if (axisRef.current === 'horizontal' && hasGallery) {
      if (translateX <= -NAV_SWIPE_THRESHOLD) goNext()
      else if (translateX >= NAV_SWIPE_THRESHOLD) goPrev()
      else setTranslateX(0)
      axisRef.current = null
      pinchStartDistanceRef.current = null
      return
    }
    if (translateY > 80 && scale <= 1.05) {
      closeLightbox()
      return
    }
    setTranslateY(0)
    setTranslateX(0)
    axisRef.current = null
    pinchStartDistanceRef.current = null
  }

  const handleDoubleClick = () => {
    setScale((current) => (current > 1 ? 1 : 2))
  }

  const handleImageClick = () => {
    const now = Date.now()
    if (now - lastTapRef.current < 300) handleDoubleClick()
    lastTapRef.current = now
  }

  const handleDownload = async () => {
    const filename = filenameFromSrc(activeSrc, activeAlt)
    try {
      // Fetch as blob so the browser honors the `download` attribute even
      // for cross-origin or same-origin URLs that lack Content-Disposition.
      const response = await fetch(activeSrc)
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
    } catch {
      // Fallback: direct link (may navigate instead of download for cross-origin).
      const a = document.createElement('a')
      a.href = activeSrc
      a.download = filename
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
  }

  if (!isOpen) return null

  return createPortal(
    <div
      className="mobile-safe-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-200"
      onClick={closeLightbox}
      role="dialog"
      aria-modal="true"
      aria-label="Image lightbox"
    >
      {/* Action buttons — stopPropagation so clicking them doesn't close the overlay. */}
      <div
        className="absolute right-[max(1rem,env(safe-area-inset-right,0px))] top-[max(1rem,env(safe-area-inset-top,0px))] flex items-center gap-2 [[data-mobile-shell='ios']_&]:top-[max(4rem,calc(env(safe-area-inset-top)+1rem))]"
        onClick={(e) => e.stopPropagation()}
      >
        <LightboxIconButton
          onClick={handleDownload}
          icon={<Download size={20} />}
          label="Download image"
          tooltip="Download"
        />
        <LightboxIconButton
          onClick={closeLightbox}
          icon={<X size={20} />}
          label="Close lightbox"
          tooltip="Close (Esc)"
        />
      </div>

      {/* Prev / next chevrons — only for galleries. Hidden on the smallest
          screens where horizontal swipe is the primary affordance. */}
      {hasGallery && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); goPrev() }}
            aria-label="Previous image"
            className="absolute left-[max(0.5rem,env(safe-area-inset-left,0px))] top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-(--color-border) bg-(--bg-card)/80 text-(--color-text) backdrop-blur transition-colors hover:bg-(--bg-key) sm:flex"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); goNext() }}
            aria-label="Next image"
            className="absolute right-[max(0.5rem,env(safe-area-inset-right,0px))] top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-(--color-border) bg-(--bg-card)/80 text-(--color-text) backdrop-blur transition-colors hover:bg-(--bg-key) sm:flex"
          >
            <ChevronRight size={22} />
          </button>
          <div
            className="absolute bottom-[max(1rem,env(safe-area-inset-bottom,0px))] left-1/2 z-10 -translate-x-1/2 rounded-full border border-(--color-border) bg-(--bg-card)/80 px-3 py-1 font-mono text-xs text-(--color-text-muted) backdrop-blur"
            aria-live="polite"
          >
            {current + 1} / {gallery.length}
          </div>
        </>
      )}

      {/* Image container — stops backdrop-click propagation so a click on
          the image itself doesn't close the overlay. */}
      <div
        className="flex max-h-[75vh] max-w-[75vw] touch-none flex-col items-center justify-center"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onDoubleClick={handleDoubleClick}
      >
        <img
          key={activeSrc}
          src={activeSrc}
          alt={activeAlt}
          className="max-h-[75vh] max-w-[75vw] rounded-sm object-contain shadow-2xl transition-transform duration-150"
          style={{ transform: `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})` }}
          onClick={handleImageClick}
        />
        {activeAlt && (
          <p className="mt-4 text-center text-sm text-(--color-text-muted)">
            {activeAlt}
          </p>
        )}
      </div>
    </div>,
    document.body,
  )
}
