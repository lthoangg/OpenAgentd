import { describe, expect, it } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { Seal, Wordmark } from '@/components/brand/Logo'
import { LOGO } from '@/lib/brand/logo-data'

describe('Seal', () => {
  it('is a named image when titled, with the generated outlines', () => {
    render(<Seal size={40} title="OpenAgentd" />)
    const svg = screen.getByRole('img', { name: 'OpenAgentd' })
    expect(svg.getAttribute('width')).toBe('40')
    expect(svg.querySelector('path')?.getAttribute('d')).toBe(LOGO.seal.disc)
    const dot = svg.querySelector('circle')
    expect(dot?.getAttribute('r')).toBe(String(LOGO.seal.dot.r))
    expect(dot?.getAttribute('fill')).toBe('var(--logo-signal)')
  })

  it('is decorative without a title', () => {
    const { container } = render(<Seal />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('role')).toBeNull()
  })

  it('pulses the dot only when asked', () => {
    const { container, rerender } = render(<Seal />)
    expect(container.querySelector('.oa-seal-pulse')).toBeNull()
    rerender(<Seal pulse />)
    expect(container.querySelector('circle')?.classList.contains('oa-seal-pulse')).toBe(true)
  })
})

describe('Wordmark', () => {
  it('draws every letter, the open A, and the dot', () => {
    render(<Wordmark height={20} title="OpenAgentd" />)
    const svg = screen.getByRole('img', { name: 'OpenAgentd' })
    expect(svg.querySelectorAll('path')).toHaveLength(LOGO.letters.length + 1)
    expect(svg.querySelectorAll('circle')).toHaveLength(1)
    expect(svg.getAttribute('viewBox')).toBe(LOGO.viewBox.join(' '))
  })
})
