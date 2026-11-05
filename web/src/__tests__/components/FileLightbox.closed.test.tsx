/**
 * Every markdown image and every user bubble with attachments mounts a
 * closed FileLightbox, so a closed one must not register its keyboard
 * shortcuts or layer. Counted through a mock of the keyboard hooks (own
 * file: `mock.module` is global to the worker).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useEffect } from 'react'

let liveShortcuts = 0
mock.module('@/lib/keyboard/hooks', () => ({
  useShortcut: () => {
    useEffect(() => {
      liveShortcuts++
      return () => {
        liveShortcuts--
      }
    }, [])
  },
  useKeyLayer: () => ({ current: null }),
}))
mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { cleanup, render, waitFor } from '@testing-library/react'
import { FileLightbox } from '@/components/FileLightbox'

afterEach(cleanup)

const items = [{ type: 'image' as const, src: 'https://example.com/a.png', name: 'a.png' }]

describe('FileLightbox when closed', () => {
  it('registers no shortcuts', () => {
    render(
      <>
        <FileLightbox items={items} isOpen={false} onClose={() => {}} />
        <FileLightbox items={items} isOpen={false} onClose={() => {}} />
        <FileLightbox items={items} isOpen={false} onClose={() => {}} />
      </>,
    )
    expect(liveShortcuts).toBe(0)
  })

  it('registers its shortcuts while open and drops them on close', async () => {
    const { rerender } = render(<FileLightbox items={items} isOpen onClose={() => {}} />)
    expect(liveShortcuts).toBeGreaterThan(0)
    rerender(<FileLightbox items={items} isOpen={false} onClose={() => {}} />)
    // It fades out over ``fast`` (its keys are off at once), then unmounts.
    await waitFor(() => expect(liveShortcuts).toBe(0))
  })
})
