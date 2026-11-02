/**
 * Reduced motion snaps changes; it must not give every element a
 * transition. An element that declares none has `transition-property: all`,
 * so any non-zero duration there (the common 0.01ms reset) turned every
 * style change into a transition, inherited visibility included: a popover
 * shown and then focused (the run picker's search) still read as hidden to
 * WebKit, and the focus was dropped.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')

function reducedMotionReset(): string {
  const match = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{([^}]*)\}/)
  return match?.[1] ?? ''
}

describe('prefers-reduced-motion reset (index.css)', () => {
  it('turns transitions off rather than shortening them for every element', () => {
    const reset = reducedMotionReset()
    expect(reset).toContain('transition-duration: 0s !important;')
    expect(reset).not.toMatch(/transition-duration:\s*0\.01ms/)
  })

  it('still ends animations at once', () => {
    expect(reducedMotionReset()).toContain('animation-duration: 0.01ms !important;')
  })
})
