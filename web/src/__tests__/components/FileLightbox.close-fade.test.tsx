/**
 * Closing the lightbox fades it out over ``fast`` instead of cutting it:
 * it stays on screen, inert and transparent, then unmounts.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { FileLightbox } from '@/components/FileLightbox'

afterEach(cleanup)

const items = [{ type: 'image' as const, src: 'https://example.com/a.png', name: 'a.png' }]
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')

describe('FileLightbox — close', () => {
  it('fades out, inert, before it unmounts', async () => {
    const { rerender } = render(<FileLightbox items={items} isOpen onClose={() => {}} labelMode="image" />)
    expect(dialog()).not.toBeNull()

    rerender(<FileLightbox items={items} isOpen={false} onClose={() => {}} labelMode="image" />)
    const leaving = dialog()
    expect(leaving).not.toBeNull()
    expect(leaving!.style.opacity).toBe('0')
    expect(leaving!.hasAttribute('inert')).toBe(true)

    await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(dialog()).toBeNull()
  })
})
