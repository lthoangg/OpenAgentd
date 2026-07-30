import { beforeEach, describe, expect, it, mock } from 'bun:test'

// mock.module() MUST appear before the import of the module under test so the
// dynamic imports inside it resolve to these stubs instead of the real heavy
// chunks (markdown pulls KaTeX CSS, mermaid is ~1 MB). Run with --parallel so
// these registry patches stay scoped to this file's worker.
const loadPdfjsMock = mock(() => Promise.resolve({}))
mock.module('@/lib/pdfjs-loader', () => ({ loadPdfjs: loadPdfjsMock }))
mock.module('@/utils/markdown', () => ({ MarkdownBlock: () => null }))
mock.module('mermaid', () => ({ default: { initialize: () => {}, render: () => Promise.resolve({ svg: '' }) } }))

import { preloadHeavyRenderers, resetPreloadStateForTest } from '@/lib/optimistic-preload'

describe('preloadHeavyRenderers', () => {
  beforeEach(() => {
    resetPreloadStateForTest()
    loadPdfjsMock.mockClear()
    // Deterministic idle scheduling: run the callback synchronously.
    ;(window as unknown as Record<string, unknown>).requestIdleCallback = (cb: IdleRequestCallback) => {
      cb({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline)
      return 1
    }
  })

  it('kicks off the heavy-renderer warm-up during idle time', () => {
    preloadHeavyRenderers()

    expect(loadPdfjsMock).toHaveBeenCalledTimes(1)
  })

  it('schedules the warm-up only once across repeated calls', () => {
    preloadHeavyRenderers()
    preloadHeavyRenderers()
    preloadHeavyRenderers()

    expect(loadPdfjsMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to a timer when requestIdleCallback is unavailable', () => {
    delete (window as unknown as Record<string, unknown>).requestIdleCallback

    // Capture the deferred callback instead of sleeping through the 500ms timer.
    const realSetTimeout = globalThis.setTimeout
    let deferred: (() => void) | undefined
    globalThis.setTimeout = ((fn: () => void) => {
      deferred = fn
      return 0
    }) as unknown as typeof setTimeout
    try {
      preloadHeavyRenderers()
      expect(loadPdfjsMock).not.toHaveBeenCalled()
      expect(deferred).toBeDefined()
      deferred!()
      expect(loadPdfjsMock).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })
})
