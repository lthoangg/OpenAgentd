/**
 * Natural sizes of images the transcript has shown, so a later render of the
 * same image (a session switch, a remount, the reader scrolling back to a
 * lazy one) reserves its box before the pixels arrive instead of growing
 * from 0px and pushing everything below it. In memory only; capped.
 */
import { useCallback, useState, type SyntheticEvent } from 'react'

export interface ImageSize {
  width: number
  height: number
}

const MAX_ENTRIES = 500
const sizes = new Map<string, ImageSize>()

export function knownImageSize(src: string): ImageSize | undefined {
  return sizes.get(src)
}

export function rememberImageSize(src: string, width: number, height: number): void {
  if (!(width > 0 && height > 0)) return
  sizes.delete(src)
  sizes.set(src, { width, height })
  if (sizes.size > MAX_ENTRIES) sizes.delete(sizes.keys().next().value as string)
}

/**
 * Box props for an ``<img>``: the remembered ``width``/``height`` (pair them
 * with ``h-auto``), and ``pending`` until the first load, while the caller
 * holds a placeholder box.
 */
export function useImageBox(src: string | undefined) {
  const known = src ? knownImageSize(src) : undefined
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const onLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget
    if (src) rememberImageSize(src, img.naturalWidth, img.naturalHeight)
    setLoadedSrc(src ?? null)
  }, [src])
  return {
    width: known?.width,
    height: known?.height,
    pending: !known && loadedSrc !== src,
    onLoad,
  }
}
