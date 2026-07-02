/**
 * PdfThumbnail — renders the first page of a PDF as a static raster image.
 *
 * Used for "treat a PDF like an image" previews (file viewer panel, preview
 * strip cards). Rendering client-side with pdf.js works identically on every
 * platform — including iOS/Android, where the browser has no native PDF
 * plugin for `<embed>` to delegate to — so this is also what backs the
 * compact preview-strip thumbnails. The full multi-page lightbox viewer is
 * `PdfDocumentViewer`, which shares the same pdf.js loader.
 */

import { useEffect, useRef, useState } from 'react'
import { File, Loader2 } from 'lucide-react'
import type { RenderTask } from 'pdfjs-dist'
import { loadPdfjs } from '@/lib/pdfjs-loader'

type Status = 'loading' | 'ready' | 'error'

interface PdfThumbnailProps {
  src: string
  /** Applied to the wrapping element (sizing/border/etc). */
  className?: string
  /** Applied to the <canvas> once rendered (defaults to filling the wrapper). */
  canvasClassName?: string
}

export function PdfThumbnail({ src, className, canvasClassName }: PdfThumbnailProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState<Status>('loading')

  useEffect(() => {
    let cancelled = false
    let renderTask: RenderTask | null = null
    setStatus('loading')

    loadPdfjs()
      .then((pdfjs) => pdfjs.getDocument({ url: src }).promise)
      .then((pdf) => pdf.getPage(1))
      .then(async (page) => {
        if (cancelled) return
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (!canvas || !ctx) return

        // "Contain" the page within the wrapper's box on whichever axis is
        // tighter — a wrapper with no explicit size (only max-w/h-full caps)
        // reports a ~0 clientWidth/Height here, which would otherwise render
        // a near-invisible thumbnail. Callers must give the wrapper a real
        // width/height (e.g. `h-full w-full` of a sized parent) for this to
        // produce a properly sized render.
        const wrapper = wrapperRef.current
        const targetWidth = wrapper?.clientWidth || 300
        const targetHeight = wrapper?.clientHeight || 0
        const baseViewport = page.getViewport({ scale: 1 })
        const dpr = window.devicePixelRatio || 1
        let scale = (targetWidth / baseViewport.width) * dpr
        if (targetHeight > 0) {
          const heightScale = (targetHeight / baseViewport.height) * dpr
          scale = Math.min(scale, heightScale)
        }
        const viewport = page.getViewport({ scale })

        canvas.width = Math.max(1, Math.round(viewport.width))
        canvas.height = Math.max(1, Math.round(viewport.height))
        canvas.style.width = `${viewport.width / dpr}px`
        canvas.style.height = `${viewport.height / dpr}px`

        renderTask = page.render({ canvasContext: ctx, viewport, canvas })
        await renderTask.promise
        if (!cancelled) setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })

    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [src])

  return (
    <div ref={wrapperRef} className={className}>
      {status === 'loading' && (
        <div className="flex h-full w-full items-center justify-center">
          <Loader2 size={16} className="animate-spin text-(--color-text-subtle)" />
        </div>
      )}
      {status === 'error' && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-(--color-text-subtle)">
          <File size={20} />
          <span className="text-[10px]">Couldn't render preview</span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={`${canvasClassName ?? 'max-h-full max-w-full'} ${status === 'ready' ? '' : 'hidden'}`}
      />
    </div>
  )
}
