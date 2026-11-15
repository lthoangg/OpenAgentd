/**
 * An open text file follows the file on disk: when its listing entry says it
 * changed (a newer mtime or another size), the content is read again, with
 * no Refresh button to press.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { FilePreviewContent } from '@/components/FileViewerPanel'
import type { WorkspaceFileInfo } from '@/api/types'

const FILE: WorkspaceFileInfo = { path: 'notes.txt', name: 'notes.txt', size: 13, mtime: 1, mime: 'text/plain' }
const originalFetch = globalThis.fetch
let body = 'first version'
let reads = 0

beforeEach(() => {
  body = 'first version'
  reads = 0
  globalThis.fetch = mock(async () => { reads += 1; return new Response(body) }) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('FilePreviewContent — a file that changes on disk', () => {
  it('reads the file again when its mtime moves, keeping the old text on screen meanwhile', async () => {
    const view = render(<FilePreviewContent workspace="/repo" file={FILE} />)
    await screen.findByText(/first version/)
    expect(reads).toBe(1)

    body = 'second version'
    view.rerender(<FilePreviewContent workspace="/repo" file={{ ...FILE, mtime: 2 }} />)
    // No loading state in between: the shown text is replaced in place.
    expect(screen.getByText(/first version/)).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(/second version/) !== null).toBe(true))
    expect(reads).toBe(2)
  })

  it('does not read again when the listing reloads with the same file', async () => {
    const view = render(<FilePreviewContent workspace="/repo" file={FILE} />)
    await screen.findByText(/first version/)

    view.rerender(<FilePreviewContent workspace="/repo" file={{ ...FILE }} />)
    await waitFor(() => expect(screen.queryByText(/first version/) !== null).toBe(true))
    expect(reads).toBe(1)
  })
})
