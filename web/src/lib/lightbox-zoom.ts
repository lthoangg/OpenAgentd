/**
 * The lightbox's zoom, as Photos does it: an image grows out of the
 * thumbnail that opened it and shrinks back into it on close (to the
 * thumbnail of the image shown then, if the reader paged).
 *
 * The thumbnail is found by its ``src`` among the page's images, so no
 * opener has to hand its rect over; one that is off screen or missing means
 * no zoom (the lightbox just fades). Reduced motion never zooms.
 */
import { cssEasing, DURATIONS_S, EASINGS, prefersReducedMotion } from '@/lib/motion'

function visible(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0
    && rect.bottom > 0 && rect.right > 0
    && rect.top < window.innerHeight && rect.left < window.innerWidth
}

/** The on-screen thumbnail showing ``src``, outside the lightbox. */
export function findThumbnail(src: string): HTMLImageElement | null {
  if (typeof document === 'undefined' || !src) return null
  for (const img of Array.from(document.querySelectorAll('img'))) {
    if (img.closest('[data-lightbox]')) continue
    if (img.getAttribute('src') !== src && img.currentSrc !== src && img.src !== src) continue
    if (visible(img.getBoundingClientRect())) return img
  }
  return null
}

/** The transform that lays ``img`` over ``thumb`` (centre on centre, one scale). */
function overThumb(img: HTMLElement, thumb: HTMLElement): string | null {
  const from = thumb.getBoundingClientRect()
  const to = img.getBoundingClientRect()
  if (!visible(from) || !(to.width > 0 && to.height > 0)) return null
  const dx = from.left + from.width / 2 - (to.left + to.width / 2)
  const dy = from.top + from.height / 2 - (to.top + to.height / 2)
  // One scale (the geometric mean of the two), so the image never squashes
  // when the thumbnail crops it to another shape.
  const scale = Math.sqrt((from.width / to.width) * (from.height / to.height))
  return `translate(${dx}px, ${dy}px) scale(${scale})`
}

function canZoom(img: HTMLElement): boolean {
  return typeof img.animate === 'function' && !prefersReducedMotion()
}

/** Grow ``img`` out of the thumbnail showing ``src``; false when there is none. */
export function zoomInFrom(img: HTMLElement, src: string): boolean {
  if (!canZoom(img)) return false
  const thumb = findThumbnail(src)
  const start = thumb && overThumb(img, thumb)
  if (!start) return false
  img.animate(
    [{ transform: start, opacity: 0.6 }, { transform: 'none', opacity: 1 }],
    { duration: DURATIONS_S.base * 1000, easing: cssEasing(EASINGS.out) },
  ).finished.catch(() => {})
  return true
}

/** Shrink ``img`` back into the thumbnail showing ``src`` as the lightbox fades. */
export function zoomOutTo(img: HTMLElement, src: string): boolean {
  if (!canZoom(img)) return false
  const thumb = findThumbnail(src)
  const end = thumb && overThumb(img, thumb)
  if (!end) return false
  img.animate(
    [{ transform: getComputedStyle(img).transform || 'none' }, { transform: end }],
    { duration: DURATIONS_S.fast * 1000, easing: cssEasing(EASINGS.inOut), fill: 'forwards' },
  ).finished.catch(() => {})
  return true
}
