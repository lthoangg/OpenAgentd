/**
 * Full-screen image lightbox.
 *
 * Shared by ``ImageAttachment`` (user-uploaded thumbnails) and ``MarkdownBlock``
 * (assistant-rendered inline images) so both get identical UX: click to open,
 * click the backdrop or press Esc to close, portal-rendered so ancestor
 * ``overflow``/``transform`` never clips the overlay.
 */

import { useEffect, useRef, useState, type ReactNode, type TouchEvent, type Touch as ReactTouch } from 'react'
import { createPortal } from 'react-dom'
import { Download, X } from 'lucide-react'

interface ImageLightboxProps {
  src: string
  alt: string
  isOpen: boolean
  onClose: () => void
}

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
        className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg bg-(--bg-card) text-(--color-text) transition-colors hover:bg-(--bg-key) focus-visible:ring-2 focus-visible:ring-(--color-text) focus-visible:outline-none"
        aria-label={label}
      >
        {icon}
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute top-full right-0 mt-2 whitespace-nowrap rounded-md bg-(--bg-key) px-2 py-1 text-xs text-(--color-text) opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {tooltip}
      </span>
    </div>
  )
}

function distance(a: Touch | ReactTouch, b: Touch | ReactTouch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

export function ImageLightbox({ src, alt, isOpen, onClose }: ImageLightboxProps) {
  const [scale, setScale] = useState(1)
  const [translateY, setTranslateY] = useState(0)
  const touchStartYRef = useRef(0)
  const pinchStartDistanceRef = useRef<number | null>(null)
  const lastTapRef = useRef(0)

  // Escape key handler + body-scroll lock while open.
  useEffect(() => {
    if (!isOpen) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = previousOverflow
    }
  }, [isOpen, onClose])

  const closeLightbox = () => {
    setScale(1)
    setTranslateY(0)
    pinchStartDistanceRef.current = null
    onClose()
  }

  const handleTouchStart = (event: TouchEvent) => {
    if (event.touches.length === 1) {
      touchStartYRef.current = event.touches[0]?.clientY ?? 0
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
      const deltaY = (event.touches[0]?.clientY ?? 0) - touchStartYRef.current
      if (deltaY > 0) setTranslateY(Math.min(160, deltaY))
    }
  }

  const handleTouchEnd = () => {
    if (translateY > 80 && scale <= 1.05) {
      closeLightbox()
      return
    }
    setTranslateY(0)
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
    const filename = filenameFromSrc(src, alt)
    try {
      // Fetch as blob so the browser honors the `download` attribute even
      // for cross-origin or same-origin URLs that lack Content-Disposition.
      const response = await fetch(src)
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
      a.href = src
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
          src={src}
          alt={alt}
          className="max-h-[75vh] max-w-[75vw] rounded-lg object-contain shadow-2xl transition-transform duration-150"
          style={{ transform: `translateY(${translateY}px) scale(${scale})` }}
          onClick={handleImageClick}
        />
        {alt && (
          <p className="mt-4 text-center text-sm text-(--color-text-muted)">
            {alt}
          </p>
        )}
      </div>
    </div>,
    document.body,
  )
}
