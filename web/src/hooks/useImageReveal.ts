/**
 * useImageReveal — an image fades in once it has loaded and decoded, rather
 * than painting in from the top as its bytes arrive (or popping in whole).
 *
 * Spread ``revealProps`` on the <img> (with the ``oa-img-reveal`` class it
 * carries) and call ``reveal`` from its ``onLoad`` and ``onError``. An image
 * already complete when it mounts (the browser had it cached) shows at once.
 * Leave it off an <img> that draws its own loading placeholder (the
 * placeholder would fade with it). A new ``src`` hides and fades again.
 */
import { type SyntheticEvent, useCallback, useState } from 'react'

export function useImageReveal(src: string | undefined) {
  const [revealedSrc, setRevealedSrc] = useState<string | undefined | null>(null)
  const revealed = revealedSrc === src
  const ref = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) setRevealedSrc(src)
  }, [src])
  // ``load`` fires once the bytes are in; ``decode()`` waits for the bitmap
  // too, so the fade never starts on a frame that is still rasterising.
  const reveal = useCallback((e?: SyntheticEvent<HTMLImageElement>) => {
    const img = e?.currentTarget
    const show = () => setRevealedSrc(src)
    if (e?.type === 'load' && img && typeof img.decode === 'function') {
      img.decode().then(show, show)
      return
    }
    show()
  }, [src])
  return {
    ref,
    reveal,
    revealProps: { 'data-revealed': revealed ? '' : undefined, className: 'oa-img-reveal' },
  }
}
