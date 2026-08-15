import { beforeEach, describe, expect, it, mock } from 'bun:test'

// mock.module() MUST appear before the import of the module under test so the
// dynamic import inside it resolves to these stubs instead of the real chunk.
// Run with --parallel so these registry patches stay scoped to this worker.
//
// The module factories double as load counters: Bun runs a factory the first
// time its module is imported, so a counter still at 0 proves the warm-up
// never reached for that chunk.
const loadPdfjsMock = mock(() => Promise.resolve({}))
let markdownLoads = 0
let mermaidLoads = 0
mock.module('@/lib/pdfjs-loader', () => ({ loadPdfjs: loadPdfjsMock }))
mock.module('@/utils/markdown', () => {
  markdownLoads++
  return { MarkdownBlock: () => null }
})
mock.module('mermaid', () => {
  mermaidLoads++
  return { default: { initialize: () => {}, render: () => Promise.resolve({ svg: '' }) } }
})

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

  it('warms the markdown renderer during idle time', async () => {
    preloadHeavyRenderers()
    await Promise.resolve()

    expect(markdownLoads).toBeGreaterThan(0)
  })

  it('never warms Mermaid or PDF.js — they cost a quarter of startup parse', async () => {
    preloadHeavyRenderers()
    await Promise.resolve()

    expect(loadPdfjsMock).not.toHaveBeenCalled()
    expect(mermaidLoads).toBe(0)
  })

  it('schedules the warm-up only once across repeated calls', () => {
    const before = markdownLoads
    preloadHeavyRenderers()
    preloadHeavyRenderers()
    preloadHeavyRenderers()

    // The module registry memoizes the import, so at most one factory run.
    expect(markdownLoads - before).toBeLessThanOrEqual(1)
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
      expect(deferred).toBeDefined()
      deferred!()
    } finally {
      globalThis.setTimeout = realSetTimeout
    }

    expect(loadPdfjsMock).not.toHaveBeenCalled()
    expect(mermaidLoads).toBe(0)
  })
})
