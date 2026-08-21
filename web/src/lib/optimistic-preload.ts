let scheduled = false

/**
 * Warm the Markdown renderer in the background so its first real render is
 * instant.
 *
 * Dynamic ``import()`` is memoized by the module registry, so kicking these
 * off here means the later ``React.lazy`` / on-demand imports resolve from
 * the already-loaded modules. Imports stay dynamic on purpose: a static
 * import in this eagerly-loaded module would hoist the renderers into the
 * startup bundle.
 *
 * **Only Markdown is warmed.** Mermaid (274 kB) and PDF.js (417 kB) used to be
 * warmed here too, which cost every launch ~691 kB of parse and module
 * evaluation — a quarter of all the JS this app runs at startup — for features
 * most sessions never touch. In the packaged desktop/mobile shells the assets
 * are embedded in the binary, so there is no download to get ahead of: the
 * entire cost of a warm-up is CPU and memory on the user's device. Markdown
 * earns that cost because essentially every session renders a message;
 * a diagram or a PDF preview does not, and both already load on demand fast
 * enough from a local asset protocol.
 *
 * Work is deferred to browser idle time (``timeout: 3000`` bounds the wait
 * so the warm-up still happens on a busy main thread), with a plain timer
 * fallback for WebViews lacking ``requestIdleCallback``.
 */
export function preloadHeavyRenderers(): void {
  if (scheduled) return
  scheduled = true

  const run = () => {
    void import('@/utils/markdown').catch(() => {
      // A failed warm-up is not an error — the real import will retry.
    })
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
