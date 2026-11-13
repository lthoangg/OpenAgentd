/**
 * terminal-font — the terminal's fixed font stack and size.
 */
import { describe, expect, it } from 'bun:test'
import {
  BUNDLED_ICONS_FAMILY,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from '@/lib/terminal-font'

describe('TERMINAL_FONT_FAMILY', () => {
  it('starts with the Nerd Font guesses, MesloLGS NF first', () => {
    expect(TERMINAL_FONT_FAMILY.startsWith('"MesloLGS NF", ')).toBe(true)
    expect(TERMINAL_FONT_FAMILY).toContain('"JetBrains Mono Variable"')
  })

  it('carries the bundled icons family once, after the guesses and before the generic tail (prompt icons on mobile)', () => {
    const bundled = TERMINAL_FONT_FAMILY.indexOf(`"${BUNDLED_ICONS_FAMILY}"`)
    expect(TERMINAL_FONT_FAMILY.split(`"${BUNDLED_ICONS_FAMILY}"`)).toHaveLength(2)
    expect(bundled).toBeGreaterThan(TERMINAL_FONT_FAMILY.indexOf('"JetBrains Mono Variable"'))
    expect(bundled).toBeLessThan(TERMINAL_FONT_FAMILY.indexOf('ui-monospace'))
    expect(TERMINAL_FONT_FAMILY.endsWith('monospace')).toBe(true)
  })

  it('is 13 px', () => {
    expect(TERMINAL_FONT_SIZE).toBe(13)
  })
})
