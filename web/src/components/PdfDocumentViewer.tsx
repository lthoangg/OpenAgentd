import { useCallback, useEffect, useRef, useState } from 'react'
import { File, Loader2 } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { loadPdfjs } from '@/lib/pdfjs-loader'

type Status = 'loading' | 'ready' | 'error'

interface PdfDocumentViewerProps {
  src: string
  /** Applied to the outer (relative-positioned) wrapper — controls overall size. */
  className?: string
}

const MAX_PAGE_RENDER_WIDTH = 900
const MAX_DPR = 2
const INITIAL_PAGES = 2
const noop = () => {}

function PdfPage({
  document,
  pageNumber,
  container,
  onRendered,
  onError,
}: {
  document: PDFDocumentProxy
  pageNumber: number
  container: HTMLDivElement | null
  onRendered: () => void
  onError: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    let task: RenderTask | null = null
    let pageToClean: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null

    async function render() {
      const page = await document.getPage(pageNumber)
      pageToClean = page
      if (cancelled) return
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return

      const baseViewport = page.getViewport({ scale: 1 })
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      const targetWidth = Math.min(container?.clientWidth || MAX_PAGE_RENDER_WIDTH, MAX_PAGE_RENDER_WIDTH)
      const viewport = page.getViewport({ scale: (targetWidth / baseViewport.width) * dpr })
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))
      canvas.style.width = `${viewport.width / dpr}px`
      canvas.style.height = `${viewport.height / dpr}px`

      task = page.render({ canvasContext: ctx, viewport, canvas })
      await task.promise
      if (!cancelled) onRendered()
    }

    render().catch(() => {
      if (!cancelled) onError()
    })
    return () => {
      cancelled = true
      task?.cancel()
      pageToClean?.cleanup?.()
    }
  }, [container, document, onError, onRendered, pageNumber])

  return <canvas ref={canvasRef} className="block rounded-sm bg-white shadow-sm" />
}

/**
 * Multi-page PDF reader that only rasterizes pages near the viewport. The
 * fixed-size placeholders keep native scroll geometry stable while the
 * IntersectionObserver requests pages on demand.
 */
export function PdfDocumentViewer({ src, className }: PdfDocumentViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set())

  useEffect(() => {
    let cancelled = false
    let loadingTask: PDFDocumentLoadingTask | null = null
    setStatus('loading')
    setDocument(null)
    setPageCount(0)
    setRenderedPages(new Set())

    async function load() {
      const pdfjs = await loadPdfjs()
      loadingTask = pdfjs.getDocument({ url: src })
      const nextDocument = await loadingTask.promise
      if (cancelled) {
        await loadingTask.destroy?.()
        return
      }
      setDocument(nextDocument)
      setPageCount(nextDocument.numPages)
      setRenderedPages(new Set(Array.from({ length: Math.min(INITIAL_PAGES, nextDocument.numPages) }, (_, index) => index + 1)))
    }

    load().catch(() => {
      if (!cancelled) setStatus('error')
    })
    return () => {
      cancelled = true
      if (loadingTask) void loadingTask.destroy?.()
    }
  }, [src])

  useEffect(() => {
    const container = scrollRef.current
    if (!container || !pageCount || !('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver((entries) => {
      const visiblePages = entries
        .filter((entry) => entry.isIntersecting)
        .map((entry) => Number((entry.target as HTMLElement).dataset.pdfPage))
        .filter(Boolean)
      if (visiblePages.length) {
        setRenderedPages((current) => {
          const next = new Set(current)
          visiblePages.forEach((page) => next.add(page))
          return next
        })
      }
    }, { root: container, rootMargin: '800px 0px' })
    container.querySelectorAll('[data-pdf-page]').forEach((page) => observer.observe(page))
    return () => observer.disconnect()
  }, [pageCount])

  const markReady = useCallback(() => setStatus('ready'), [])
  const markError = useCallback(() => setStatus('error'), [])

  return (
    <div className={`relative ${className ?? ''}`} onClick={(e) => e.stopPropagation()}>
      <div ref={scrollRef} role="list" aria-label="PDF pages" className="flex h-full w-full flex-col items-center gap-3 overflow-x-hidden overflow-y-auto overscroll-contain p-3" style={{ touchAction: 'pan-y' }}>
        {Array.from({ length: pageCount }, (_, index) => {
          const pageNumber = index + 1
          return (
            <div
              key={pageNumber}
              data-pdf-page={pageNumber}
              role="listitem"
              aria-label={`Page ${pageNumber} of ${pageCount}`}
              className="flex justify-center"
              style={{ width: '100%', maxWidth: `${MAX_PAGE_RENDER_WIDTH}px`, aspectRatio: '8.5 / 11' }}
            >
              {document && renderedPages.has(pageNumber) && <PdfPage document={document} pageNumber={pageNumber} container={scrollRef.current} onRendered={pageNumber === 1 ? markReady : noop} onError={pageNumber === 1 ? markError : noop} />}
            </div>
          )
        })}
      </div>
      {status === 'loading' && <div role="status" aria-busy="true" className="pointer-events-none absolute inset-0 flex items-center justify-center"><Loader2 size={20} className="animate-spin text-(--color-text-subtle)" /><span className="sr-only">Loading PDF</span></div>}
      {status === 'error' && <div role="alert" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-(--color-text-muted)"><File size={28} /><p className="text-sm">Couldn't render this PDF</p></div>}
    </div>
  )
}
