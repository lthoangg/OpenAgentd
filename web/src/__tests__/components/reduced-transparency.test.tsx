/**
 * With "reduce transparency" on, frosted surfaces turn opaque and drop their
 * blur (the `reduce-transparency:` variant in index.css).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { FileLightbox } from '@/components/FileLightbox'

afterEach(cleanup)

describe('reduced transparency', () => {
  it('defines the variant on the OS preference', () => {
    const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')
    expect(css).toContain('@custom-variant reduce-transparency (@media (prefers-reduced-transparency: reduce));')
  })

  it('keeps the lightbox arrows opaque and makes the counter opaque under the preference', () => {
    const items = [
      { type: 'image' as const, src: '/a.png', name: 'a.png' },
      { type: 'image' as const, src: '/b.png', name: 'b.png' },
    ]
    render(<FileLightbox items={items} index={0} isOpen onClose={() => {}} />)

    for (const button of screen.getAllByRole('button', { name: /previous|next/i })) {
      // Floating over the image: an opaque card fill and a shadow, no border, no blur to drop.
      const classes = button.className.split(' ')
      expect(classes).toEqual(expect.arrayContaining(['bg-(--bg-card)', 'shadow-(--shadow-depth)']))
      expect(classes).not.toContain('border')
      expect(classes).not.toContain('backdrop-blur')
    }
    expect(screen.getByText('1 / 2').className.split(' ')).toEqual(expect.arrayContaining(['reduce-transparency:bg-(--bg-card)', 'reduce-transparency:backdrop-blur-none']))
  })
})
