/**
 * PdfDocumentViewer — full multi-page PDF reader for the lightbox.
 *
 * Renders every page to its own <canvas> with pdf.js and stacks them in a
 * plain, natively-scrollable column — like a real document reader, not a
 * single flat "PDF as an image" preview (that's what `PdfThumbnail` is for,
 * in the file-viewer panel and preview-strip cards).
 *
 * Deliberately has *no* custom touch-gesture code. Scrolling is 100% native
 * and vertical-only (`overflow-y-auto overflow-x-hidden` + `touch-action:
 * pan-y`); the lightbox shell skips its own swipe-to-navigate/swipe-to-close
 * handling entirely while a PDF is active (see `activeTypeRef` in
 * FileLightbox.tsx) so there's nothing for this component to fight with or
 * isolate itself from.
 *
 * pdf.js is used (not `<embed>`/`<iframe>`) because mobile browsers have no
 * built-in inline PDF renderer for either element — they hand the file off
 * to a separate viewer or downloads app instead of showing it in the page.
 * Canvas rendering works identically everywhere.
 *
 * Pages render eagerly, in order — simple and sufficient for the
 * attachment/workspace-file-sized documents this targets. Not virtualized;
 * a document with hundreds of pages would benefit from that, but it's not
 * the common case here.
 */

import { useEffect, useRef, useState } from 'react'
import { File, Loader2 } from 'lucide-react'
import type { RenderTask } from 'pdfjs-dist'
import { loadPdfjs } from '@/lib/pdfjs-loader'

type Status = 'loading' | 'ready' | 'error'

interface PdfDocumentViewerProps {
  src: string
  /** Applied to the outer (relative-positioned) wrapper — controls overall size. */
  className?: string
}

/** Cap per-page render width so huge desktop viewports don't rasterize at
 *  wasteful resolution — pages are centered below this width. */
const MAX_PAGE_RENDER_WIDTH = 900

export function PdfDocumentViewer({ src, className }: PdfDocumentViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('loading')

  useEffect(() => {
    let cancelled = false
    const renderTasks: RenderTask[] = []
    const container = scrollRef.current
    container?.replaceChildren()
    setStatus('loading')

    async function run() {
      const pdfjs = await loadPdfjs()
      const doc = await pdfjs.getDocument({ url: src }).promise
      if (cancelled) return

      const dpr = window.devicePixelRatio || 1
      const targetWidth = Math.min(container?.clientWidth || MAX_PAGE_RENDER_WIDTH, MAX_PAGE_RENDER_WIDTH)

      for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        if (cancelled) return
        const page = await doc.getPage(pageNum)
        if (cancelled) return

        const baseViewport = page.getViewport({ scale: 1 })
        const scale = (targetWidth / baseViewport.width) * dpr
        const viewport = page.getViewport({ scale })

        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(viewport.width))
        canvas.height = Math.max(1, Math.round(viewport.height))
        canvas.style.width = `${viewport.width / dpr}px`
        canvas.style.height = `${viewport.height / dpr}px`
        canvas.className = 'block rounded-sm bg-white shadow-sm'
        canvas.setAttribute('aria-label', `Page ${pageNum} of ${doc.numPages}`)
        container?.appendChild(canvas)

        const ctx = canvas.getContext('2d')
        if (!ctx) continue
        const task = page.render({ canvasContext: ctx, viewport, canvas })
        renderTasks.push(task)
        await task.promise
        if (cancelled) return
        if (pageNum === 1) setStatus('ready')
      }
    }

    run().catch(() => {
      if (!cancelled) setStatus('error')
    })

    return () => {
      cancelled = true
      renderTasks.forEach((task) => task.cancel())
    }
  }, [src])

  return (
    <div className={`relative ${className ?? ''}`} onClick={(e) => e.stopPropagation()}>
      <div
        ref={scrollRef}
        className="flex h-full w-full flex-col items-center gap-3 overflow-x-hidden overflow-y-auto overscroll-contain p-3"
        style={{ touchAction: 'pan-y' }}
      />
      {status === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin text-(--color-text-subtle)" />
        </div>
      )}
      {status === 'error' && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-(--color-text-muted)">
          <File size={28} />
          <p className="text-sm">Couldn't render this PDF</p>
        </div>
      )}
    </div>
  )
}
