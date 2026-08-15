import { loadPdfjs } from '@/lib/pdfjs-loader'

let scheduled = false

/**
 * Warm the heavy dynamic-import chunks (the Markdown renderer, the Mermaid
 * diagram engine, and the PDF.js viewer) in the background so their first
 * real render is instant.
 *
 * Dynamic ``import()`` is memoized by the module registry, so kicking these
 * off here means the later ``React.lazy`` / on-demand imports resolve from
 * the already-loaded modules. Imports stay dynamic on purpose: a static
 * import in this eagerly-loaded module would hoist the renderers into the
 * startup bundle.
 *
 * Work is deferred to browser idle time (``timeout: 3000`` bounds the wait
 * so the warm-up still happens on a busy main thread), with a plain timer
 * fallback for WebViews lacking ``requestIdleCallback``.
 */
export function preloadHeavyRenderers(): void {
  if (scheduled) return
  scheduled = true

  const run = () => {
    void Promise.allSettled([
      import('@/utils/markdown'),
      import('mermaid'),
      loadPdfjs(),
    ])
  }

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 3000 })
  } else {
    setTimeout(run, 500)
  }
}

/** Reset scheduling state for test isolation. */
export function resetPreloadStateForTest(): void {
  scheduled = false
}
