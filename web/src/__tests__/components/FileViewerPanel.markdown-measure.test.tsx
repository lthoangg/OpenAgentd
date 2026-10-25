import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { FilePreviewContent } from '@/components/FileViewerPanel'
import type { WorkspaceFileInfo } from '@/api/types'

const originalFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('FilePreviewContent — rendered markdown', () => {
  it('sets prose in the reading column, so lines keep a readable measure', async () => {
    globalThis.fetch = mock(async () => new Response('# Notes\n\nA paragraph.')) as unknown as typeof fetch
    const file: WorkspaceFileInfo = { path: 'docs/notes.md', name: 'notes.md', size: 24, mtime: 1, mime: 'text/markdown' }
    const { container } = render(<FilePreviewContent workspace="/w" file={file} markdownView="rendered" />)

    await waitFor(() => expect(container.querySelector('.oa-prose')).not.toBeNull())
    const column = container.querySelector('.oa-prose')?.closest('.oa-reading')
    // Same column as the Plan tab: max-w-3xl, 88ch in a maximized dock.
    expect(column?.className.split(' ')).toEqual(expect.arrayContaining(['oa-reading', 'mx-auto', 'max-w-3xl']))
  })
})
