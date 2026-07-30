import { preloadMarkdownRenderer } from '@/utils/LazyMarkdownBlock'
import { preloadMermaid } from '@/utils/MermaidBlock'
import { loadPdfjs } from '@/lib/pdfjs-loader'

let isPreloaded = false

export interface PreloadOptions {
  /** Force immediate execution without waiting for requestIdleCallback. Defaults to false. */
  immediate?: boolean
}

/**
 * Optimistically preloads heavy dynamic import chunks (Markdown renderer,
 * Mermaid diagram engine, PDF.js preview engine) in the background.
 *
 * Starts in the background during browser idle time (or via timer) so that
 * whenever the user opens the app (even on the home page), heavy rendering
 * dependencies are loaded, parsed, and cached before they are needed.
 */
export function preloadHeavyRenderers(options?: PreloadOptions): Promise<void> {
  if (isPreloaded) return Promise.resolve()
  isPreloaded = true

  const executePreload = () => {
    return Promise.allSettled([
      preloadMarkdownRenderer(),
      preloadMermaid(),
      loadPdfjs(),
    ]).then(() => undefined)
  }

  if (options?.immediate) {
    return executePreload()
  }

  return new Promise((resolve) => {
    const run = () => {
      void executePreload().then(resolve)
    }

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      window.requestIdleCallback(run, { timeout: 3000 })
    } else {
      setTimeout(run, 500)
    }
  })
}

/** Reset internal preload tracking state for test isolation. */
export function resetPreloadStateForTest(): void {
  isPreloaded = false
}
