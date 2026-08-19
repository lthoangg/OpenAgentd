import { useState } from 'react'
import { X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ImageLightbox } from './ImageLightbox'

interface ImageAttachmentProps {
  src: string
  alt?: string
  onRemove?: () => void
  /** If true, show a remove button (for pending attachments) */
  removable?: boolean
  /**
   * Sibling images for the lightbox gallery. When provided with length > 1,
   * opening this thumbnail lets the user swipe / arrow between all of them.
   * ``galleryIndex`` is this image's position within ``gallery``.
   */
  gallery?: { src: string; alt?: string }[]
  galleryIndex?: number
  /**
   * If true, render the thumbnail at a compact size (160×160) suitable for
   * a horizontal preview strip next to an input bar. The full-size lightbox
   * preview on click is unchanged. Defaults to false (200×200).
   */
  compact?: boolean
}

export function ImageAttachment({ src, alt = 'Image', onRemove, removable, compact = false, gallery, galleryIndex }: ImageAttachmentProps) {
  const [imageError, setImageError] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  // Compact variant: used in the input-bar preview strip so tall images
  // don't dominate vertical space. The lightbox (on click) is unaffected.
  const sizeClass = compact
    ? 'max-h-[160px] max-w-[160px]'
    : 'max-h-[200px] max-w-[200px]'
  const errorSizeClass = compact ? 'h-[160px] w-[160px]' : 'h-[200px] w-[200px]'

  if (imageError) {
    return (
      <div className={`flex ${errorSizeClass} items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-xs text-(--color-text-muted)`}>
        Failed to load image
      </div>
    )
  }

  return (
    <>
      <div className="group relative inline-block">
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          className="overflow-hidden rounded-sm text-left focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none"
          aria-label={`Open ${alt} preview`}
        >
          <img
            src={src}
            alt={alt}
            loading="lazy"
            decoding="async"
            onError={() => setImageError(true)}
            className={`${sizeClass} object-cover`}
          />
        </button>
        {removable && onRemove && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove()
                  }}
                  className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-(--color-text-muted) shadow-sm opacity-100 transition-colors hover:border-(--color-border-strong) hover:text-(--color-text) md:-right-1.5 md:-top-1.5 md:h-4 md:w-4 md:opacity-0 md:group-hover:opacity-100"
                  aria-label="Remove image"
                >
                  <X size={12} className="md:h-2.5 md:w-2.5" />
                </button>
              }
            />
            <TooltipContent>Remove</TooltipContent>
          </Tooltip>
        )}
      </div>

      <ImageLightbox
        src={src}
        alt={alt}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        images={gallery && gallery.length > 1 ? gallery : undefined}
        index={galleryIndex}
      />
    </>
  )
}
