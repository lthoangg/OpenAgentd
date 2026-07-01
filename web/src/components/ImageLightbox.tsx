/**
 * Full-screen image lightbox — backward-compat wrapper around FileLightbox.
 *
 * All existing callers (ImageAttachment, WorkspaceFilesPanel, markdown.tsx)
 * continue to pass ``src`` / ``alt`` / ``images`` and get identical behaviour.
 * The gallery now supports mixed file types via FileLightbox internally.
 */

import { FileLightbox, type FileLightboxItem } from './FileLightbox'

interface GalleryImage {
  src: string
  alt?: string
}

interface ImageLightboxProps {
  src: string
  alt: string
  isOpen: boolean
  onClose: () => void
  images?: GalleryImage[]
  index?: number
}

export function ImageLightbox({ src, alt, isOpen, onClose, images, index }: ImageLightboxProps) {
  const items: FileLightboxItem[] = images && images.length > 0
    ? images.map((img) => ({ type: 'image' as const, src: img.src, name: img.alt ?? '' }))
    : [{ type: 'image' as const, src, name: alt }]

  return (
    <FileLightbox
      items={items}
      index={index ?? Math.max(0, items.findIndex((item) => item.src === src))}
      isOpen={isOpen}
      onClose={onClose}
      labelMode="image"
    />
  )
}
