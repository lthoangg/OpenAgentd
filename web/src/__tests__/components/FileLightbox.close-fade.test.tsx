/**
 * Closing the lightbox fades it out over ``fast`` instead of cutting it:
 * it stays on screen, inert and transparent, then unmounts.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { FileLightbox } from '@/components/FileLightbox'

afterEach(cleanup)

const items = [{ type: 'image' as const, src: 'https://example.com/a.png', name: 'a.png' }]
const lightbox = () => document.querySelector<HTMLElement>('[data-lightbox]')

describe('FileLightbox — close', () => {
  it('fades out, inert and hidden from assistive tech, before it unmounts', async () => {
    const { rerender } = render(<FileLightbox items={items} isOpen onClose={() => {}} labelMode="image" />)
    expect(lightbox()?.getAttribute('role')).toBe('dialog')

    rerender(<FileLightbox items={items} isOpen={false} onClose={() => {}} labelMode="image" />)
    const leaving = lightbox()
    expect(leaving).not.toBeNull()
    // Gone for assistive tech at once; only the pixels fade.
    expect(leaving!.getAttribute('role')).toBeNull()
    expect(leaving!.getAttribute('aria-hidden')).toBe('true')
    expect(leaving!.style.opacity).toBe('0')
    expect(leaving!.hasAttribute('inert')).toBe(true)

    await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(lightbox()).toBeNull()
  })
})
