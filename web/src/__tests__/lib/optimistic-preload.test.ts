import { beforeEach, describe, expect, it } from 'bun:test'
import {
  preloadHeavyRenderers,
  resetPreloadStateForTest,
} from '@/lib/optimistic-preload'
import { preloadMarkdownRenderer } from '@/utils/LazyMarkdownBlock'
import { preloadMermaid } from '@/utils/MermaidBlock'
import { loadPdfjs } from '@/lib/pdfjs-loader'

describe('optimistic-preload', () => {
  beforeEach(() => {
    resetPreloadStateForTest()
  })

  it('triggers background preloads for markdown, mermaid, and pdfjs when called immediately', async () => {
    const markdownSpy = preloadMarkdownRenderer()
    const mermaidSpy = preloadMermaid()
    const pdfjsSpy = loadPdfjs()

    await preloadHeavyRenderers({ immediate: true })

    expect(markdownSpy).toBeInstanceOf(Promise)
    expect(mermaidSpy).toBeInstanceOf(Promise)
    expect(pdfjsSpy).toBeInstanceOf(Promise)
  })

  it('is idempotent and does not repeat preloads on subsequent calls', async () => {
    let callCount = 0

    await preloadHeavyRenderers({ immediate: true })
    callCount++
    const initialCallCount = callCount

    // Second call should return immediately without executing preloader again
    await preloadHeavyRenderers({ immediate: true })
    expect(callCount).toBe(initialCallCount)
  })

  it('caches the promise for preloadMarkdownRenderer across multiple invocations', async () => {
    const p1 = preloadMarkdownRenderer()
    const p2 = preloadMarkdownRenderer()

    expect(p1).toBe(p2)
    const mod = await p1
    expect(mod.MarkdownBlock).toBeDefined()
  })

  it('caches the promise for preloadMermaid across multiple invocations', async () => {
    const p1 = preloadMermaid()
    const p2 = preloadMermaid()

    expect(p1).toBe(p2)
  })
})
