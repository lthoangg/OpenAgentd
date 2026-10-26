/**
 * Full-size image viewers decode off the main thread, so opening a large
 * screenshot does not stall scrolling or the pan/zoom gesture.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { FileLightbox } from '@/components/FileLightbox'
import { FilePreviewContent } from '@/components/FileViewerPanel'
import { AttachmentTabView } from '@/components/WorkspacePanel/AttachmentTabView'
import type { WorkspaceFileInfo } from '@/api/types'

afterEach(cleanup)

describe('image viewers', () => {
  it('decodes the lightbox image asynchronously and keeps it undraggable', () => {
    render(<FileLightbox items={[{ type: 'image', src: 'shot.png', name: 'Shot' }]} index={0} isOpen onClose={() => {}} />)
    const img = screen.getByRole('img', { name: 'Shot' })
    expect(img.getAttribute('decoding')).toBe('async')
    expect(img.getAttribute('draggable')).toBe('false')
  })

  it('decodes a workspace image preview asynchronously', () => {
    const file: WorkspaceFileInfo = { path: 'docs/shot.png', name: 'shot.png', size: 10, mtime: 1, mime: 'image/png' }
    render(<FilePreviewContent workspace="/repo" file={file} />)
    expect(screen.getByRole('img', { name: 'shot.png' }).getAttribute('decoding')).toBe('async')
  })

  it('decodes an attachment tab image asynchronously', () => {
    render(<AttachmentTabView item={{ type: 'image', src: '/uploads/shot.png', name: 'upload.png' }} />)
    expect(screen.getByRole('img', { name: 'upload.png' }).getAttribute('decoding')).toBe('async')
  })
})
