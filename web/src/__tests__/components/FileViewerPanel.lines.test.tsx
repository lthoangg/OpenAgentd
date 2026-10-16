/**
 * Long files: lines sit in blocks the browser can skip while offscreen, and
 * dragging a selection renders only the lines whose selection changed.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { FilePreviewContent } from '@/components/FileViewerPanel'
import type { WorkspaceFileInfo } from '@/api/types'

const originalFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

async function renderFile(lines: number, onRender?: (actual: number, base: number) => void) {
  const text = Array.from({ length: lines }, (_, i) => `const value${i} = ${i}`).join('\n')
  globalThis.fetch = mock(async () => new Response(text)) as unknown as typeof fetch
  const file: WorkspaceFileInfo = { path: 'src/big.ts', name: 'big.ts', size: text.length, mtime: 1, mime: 'text/plain' }
  const view = render(
    <Profiler id="viewer" onRender={(_id, _phase, actual, base) => onRender?.(actual, base)}>
      <FilePreviewContent workspace="/w" file={file} />
    </Profiler>,
  )
  await waitFor(() => expect(view.container.querySelector(`[data-line="${lines}"]`)).not.toBeNull())
  return view
}

const gutter = (container: HTMLElement, line: number) => container.querySelector(`[data-line="${line}"] button[aria-label="Select line ${line}"]`)!

describe('FilePreviewContent — long files', () => {
  it('groups lines into blocks the browser can skip while offscreen', async () => {
    const { container } = await renderFile(450)
    const blocks = [...container.querySelectorAll('[data-line-block]')]
    expect(blocks.map((b) => b.querySelectorAll('[data-line]').length)).toEqual([200, 200, 50])
    for (const block of blocks) expect(block.classList.contains('oa-line-block')).toBe(true)
  })

  it('renders only a small part of a long file while a selection is dragged', async () => {
    const commits: Array<[number, number]> = []
    const { container } = await renderFile(2000, (actual, base) => commits.push([actual, base]))
    fireEvent.mouseDown(gutter(container, 100))
    commits.length = 0
    for (let line = 101; line <= 110; line++) act(() => { fireEvent.mouseOver(gutter(container, line)) })
    expect(container.querySelectorAll('[data-line].bg-\\(--bg-key\\)').length).toBe(11)
    // Median over the steps: one GC pause under a loaded parallel run can
    // inflate a single small commit. Typically 0.02-0.04; 0.86 when every
    // line re-rendered.
    const ratios = commits.map(([actual, base]) => actual / base).sort((a, b) => a - b)
    expect(ratios[Math.floor(ratios.length / 2)]).toBeLessThan(0.25)
  })

  it('shows a large file as plain lines first, then highlighted', async () => {
    // Over SYNC_HIGHLIGHT_BYTES: highlighted off the render path (the test
    // runtime has no Worker, so the deferred main-thread fallback runs).
    const lines = 4000
    const text = Array.from({ length: lines }, (_, i) => `const value${i} = ${i}`).join('\n')
    expect(text.length).toBeGreaterThan(64 * 1024)
    globalThis.fetch = mock(async () => new Response(text)) as unknown as typeof fetch
    const file: WorkspaceFileInfo = { path: 'src/huge.ts', name: 'huge.ts', size: text.length, mtime: 1, mime: 'text/plain' }
    const { container } = render(<FilePreviewContent workspace="/w" file={file} />)
    await waitFor(() => expect(container.querySelector(`[data-line="${lines}"]`)).not.toBeNull())
    await waitFor(() => expect(container.querySelector('[data-line="1"] span[class]')).not.toBeNull())
    expect(container.querySelectorAll('[data-line]').length).toBe(lines)
  })
})
